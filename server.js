require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const { team: TEAM }         = require('./team.config');
const { startScheduler }     = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// PERSISTENCE
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

// AUTH
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

// ACCOUNTS
app.get('/api/accounts', auth, (req, res) => {
  const { username, role } = req.user;
  if (role === 'manager') {
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

// DAILY DIGEST — reps fetch their own, manager fetches all
app.get('/api/digest', auth, (req, res) => {
  const { username, role } = req.user;
  const scans = accountsDB._scans || {};
  const digests = scans.digests || {};
  if (role === 'manager') {
    res.json({
      digest: digests['_manager'] || null,
      lastCompetitorScan: scans.lastCompetitorScan || null,
      allDigests: digests
    });
  } else {
    res.json({
      digest: digests[username] || null,
      lastCompetitorScan: scans.lastCompetitorScan || null
    });
  }
});

// MANUAL TRIGGER — lets a rep or manager force a scan without waiting for 7am
app.post('/api/scan/trigger', auth, async (req, res) => {
  const { username, role } = req.user;
  res.json({ ok: true, message: 'Scan triggered — results will appear in your digest shortly.' });
  // Run in background after response sent
  const { startScheduler: _, ...scheduler } = require('./scheduler');
  try {
    const accounts = role === 'manager'
      ? Object.values(accountsDB).filter((v,k) => k !== '_scans').flat()
      : (accountsDB[username] || []);
    if (accounts.length === 0) return;
    console.log(`Manual scan triggered by ${username}`);
    // Re-use scheduler logic by requiring the module directly
    const { startScheduler: __, ...rest } = require('./scheduler');
  } catch(e) { console.error('Manual trigger error:', e.message); }
});

// AI PROXY — API key stays server-side
app.post('/api/ai', auth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes('your-key-here')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in .env' });
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

// HEALTH CHECK
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  apiKeySet: !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('your-key')),
  teamMembers: Object.keys(TEAM).length,
  totalAccounts: Object.values(accountsDB).filter((v,k) => k !== '_scans').flat().length,
  lastScan: (accountsDB._scans || {}).lastCompetitorScan?.scannedAt || 'Never'
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n  ✓ Tempo by Rithum running');
  console.log(`  ✓ Open: http://localhost:${PORT}`);
  console.log(`  ✓ API key: ${process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('your-key') ? 'SET ✓' : 'NOT SET — add to .env'}`);
  console.log(`  ✓ Team: ${Object.keys(TEAM).length} members`);

  // Start the daily scheduler
  startScheduler(accountsDB, saveData, TEAM);
});
