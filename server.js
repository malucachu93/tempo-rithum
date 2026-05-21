require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const { team: TEAM }     = require('./team.config');
const { startScheduler, runScan } = require('./scheduler');
const {
  startOvernightScheduler,
  getCacheEntry,
  upsertCache,
  getPool,
} = require('./lib/overnight-scheduler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');

function loadData() {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.error('Error loading data:', e.message); return {}; }
}

function saveData(data) {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch(e) { console.error('Error saving data:', e.message); }
}

let accountsDB = loadData();

const sessions = {};
function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2); }

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = TEAM[username];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid username or password' });
  const token = makeToken();
  sessions[token] = { username, name: user.name, role: user.role };
  res.json({ token, name: user.name, role: user.role, username });
});

function auth(req, res, next) {
  const session = sessions[req.headers['x-token']];
  if (!session) return res.status(401).json({ error: 'Unauthorised' });
  req.user = session;
  next();
}

app.get('/api/accounts', auth, (req, res) => {
  const { username, role } = req.user;
  if (role === 'Manager') {
    const all = {};
    Object.keys(TEAM).forEach(u => { all[u] = accountsDB[u] || []; });
    res.json({ all, teamInfo: TEAM });
  } else {
    res.json({ accounts: accountsDB[username] || [] });
  }
});

app.post('/api/accounts', auth, (req, res) => {
  const { username } = req.user;
  const account = { ...req.body, id: makeToken(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!accountsDB[username]) accountsDB[username] = [];
  accountsDB[username].push(account);
  saveData(accountsDB);
  res.json(account);
});

app.put('/api/accounts/:id', auth, (req, res) => {
  const { username } = req.user;
  const accounts = accountsDB[username] || [];
  const idx = accounts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Account not found' });
  accounts[idx] = { ...accounts[idx], ...req.body, updatedAt: new Date().toISOString() };
  saveData(accountsDB);
  res.json(accounts[idx]);
});

app.delete('/api/accounts/:id', auth, (req, res) => {
  const { username } = req.user;
  if (!accountsDB[username]) return res.status(404).json({ error: 'Not found' });
  accountsDB[username] = accountsDB[username].filter(a => a.id !== req.params.id);
  saveData(accountsDB);
  res.json({ ok: true });
});

app.get('/api/digest', auth, async (req, res) => {
  const { username, role } = req.user;
  const scans = accountsDB._scans || {};
  const digests = scans.digests || {};

  // Check overnight cache first
  const cacheKey = role === 'Manager' ? '_manager' : username;
  try {
    const cached = await getCacheEntry(cacheKey, 'brief');
    if (cached) {
      return res.json({
        digest: { content: cached.data.content, generatedAt: cached.data.generatedAt },
        lastCompetitorScan: scans.lastCompetitorScan || null,
        cached: true,
        cacheGeneratedAt: cached.generated_at,
        ...(role === 'Manager' ? { allDigests: digests } : {}),
      });
    }
  } catch (e) {
    // Cache unavailable — fall through to legacy path
  }

  // Fall back to legacy file-based digest
  if (role === 'Manager') {
    res.json({ digest: digests['_manager'] || null, lastCompetitorScan: scans.lastCompetitorScan || null, allDigests: digests, cached: false });
  } else {
    res.json({ digest: digests[username] || null, lastCompetitorScan: scans.lastCompetitorScan || null, cached: false });
  }
});

app.post('/api/scan/trigger', auth, async (req, res) => {
  const { username, role } = req.user;
  res.json({ ok: true, message: 'Scan triggered — results will appear in your digest shortly.' });
  try {
    await runScan(accountsDB, saveData, TEAM, username, role);
  } catch(e) { console.error('Manual trigger error:', e.message); }
});

app.post('/api/ai', auth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes('your-key-here')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard cache endpoints ────────────────────────────────────────────────

// Returns which sections are cached and fresh for the logged-in user.
app.get('/api/dashboard/status', auth, async (req, res) => {
  const { username, role } = req.user;
  const cacheKey = role === 'Manager' ? '_manager' : username;
  const sections = ['signals', 'brief', 'competitors', 'outreach', 'summary'];
  const status = {};

  for (const section of sections) {
    try {
      const key = ['competitors', 'summary'].includes(section) ? '_team' : cacheKey;
      const cached = await getCacheEntry(
        section === 'summary' ? '_manager' : key,
        section
      );
      if (cached) {
        status[section] = {
          cached: true,
          generatedAt: cached.generated_at,
          expiresAt: cached.expires_at,
        };
      } else {
        status[section] = { cached: false };
      }
    } catch (e) {
      status[section] = { cached: false, error: e.message };
    }
  }

  // Fetch job statuses
  const jobStatuses = {};
  for (const job of sections) {
    try {
      const db = getPool();
      if (db) {
        const { rows } = await db.query(
          `SELECT data, generated_at FROM dashboard_cache
           WHERE account_id = '_job_status' AND data_type = $1 LIMIT 1`,
          [job]
        );
        jobStatuses[job] = rows[0]
          ? { ...rows[0].data, recordedAt: rows[0].generated_at }
          : { status: 'never_run' };
      }
    } catch (e) {
      jobStatuses[job] = { status: 'unknown' };
    }
  }

  res.json({ sections: status, jobs: jobStatuses, user: username, role });
});

// Admin endpoint — full cache status (no auth restriction beyond being logged in)
app.get('/api/admin/cache-status', auth, async (req, res) => {
  const db = getPool();
  if (!db) {
    return res.json({ available: false, reason: 'DATABASE_URL not configured' });
  }
  try {
    const { rows } = await db.query(
      `SELECT account_id, data_type, generated_at, expires_at,
              (expires_at > NOW()) AS fresh
       FROM dashboard_cache
       WHERE account_id != '_job_status'
       ORDER BY generated_at DESC`
    );
    const { rows: jobs } = await db.query(
      `SELECT data_type AS job, data, generated_at
       FROM dashboard_cache
       WHERE account_id = '_job_status'
       ORDER BY generated_at DESC`
    );
    res.json({
      available: true,
      entries: rows,
      jobs: jobs.map(j => ({ job: j.job, ...j.data, recordedAt: j.generated_at })),
      totalEntries: rows.length,
      freshEntries: rows.filter(r => r.fresh).length,
    });
  } catch (e) {
    res.status(500).json({ available: false, error: e.message });
  }
});

// Cached signals for a specific account
app.get('/api/dashboard/signals/:accountId', auth, async (req, res) => {
  try {
    const cached = await getCacheEntry(req.params.accountId, 'signals');
    if (cached) {
      return res.json({ data: cached.data, cached: true, generatedAt: cached.generated_at });
    }
    res.json({ data: null, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cached outreach plan for the logged-in rep
app.get('/api/dashboard/outreach', auth, async (req, res) => {
  const { username, role } = req.user;
  const key = role === 'Manager' ? '_manager' : username;
  try {
    const cached = await getCacheEntry(key, 'outreach');
    if (cached) {
      return res.json({ data: cached.data, cached: true, generatedAt: cached.generated_at });
    }
    res.json({ data: null, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cached competitor intel
app.get('/api/dashboard/competitors', auth, async (req, res) => {
  try {
    const cached = await getCacheEntry('_team', 'competitors');
    if (cached) {
      return res.json({ data: cached.data, cached: true, generatedAt: cached.generated_at });
    }
    res.json({ data: null, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cached manager summary
app.get('/api/dashboard/summary', auth, async (req, res) => {
  try {
    const cached = await getCacheEntry('_manager', 'summary');
    if (cached) {
      return res.json({ data: cached.data, cached: true, generatedAt: cached.generated_at });
    }
    res.json({ data: null, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  apiKeySet: !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('your-key')),
  teamMembers: Object.keys(TEAM).length,
  totalAccounts: Object.entries(accountsDB).filter(([k]) => k !== '_scans').flatMap(([,v]) => v).length,
  lastScan: (accountsDB._scans || {}).lastCompetitorScan?.scannedAt || 'Never'
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n  ✓ Tempo by Rithum running');
  console.log(`  ✓ Open: http://localhost:${PORT}`);
  console.log(`  ✓ API key: ${process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('your-key') ? 'SET ✓' : 'NOT SET'}`);
  console.log(`  ✓ Team: ${Object.keys(TEAM).length} members`);
  startScheduler(accountsDB, saveData, TEAM);
  startOvernightScheduler(accountsDB, saveData, TEAM);
});
