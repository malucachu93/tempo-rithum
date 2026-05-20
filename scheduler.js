const cron = require('node-cron');
const fetch = require('node-fetch');

const SCAN_TIME = '0 7 * * 1-5';
const COMPETITORS = ['Mirakl', 'Marketplacer', 'VirtualStock', 'Tradebyte', 'ChannelEngine'];

async function callAI(prompt, webSearch = false) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const body = {
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: 'You are a B2B sales intelligence researcher for Rithum, a retail commerce platform. Be specific, concise and actionable. Always use web search for current information.',
      messages: [{ role: 'user', content: prompt }]
    };
    if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() || null;
  } catch (e) {
    console.error('AI call failed:', e.message);
    return null;
  }
}

function timestamp() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' });
}

async function scanAccount(account) {
  console.log(`  → Scanning ${account.name}...`);
  const prompt = `Find the latest B2B sales signals about ${account.name} (UK retailer) in the last 7 days. 
Focus on: leadership changes, financial results, hiring, LinkedIn posts, tech announcements, partnerships.
Return 3-5 bullet points maximum. Each bullet: what happened, why it matters for sales, signal strength (High/Medium/Low).
Be specific — real names, dates, figures. If nothing significant found in last 7 days, say so briefly.`;
  const result = await callAI(prompt, true);
  return {
    scannedAt: new Date().toISOString(),
    content: result || 'No new signals found this scan.',
    accountId: account.id,
    accountName: account.name
  };
}

async function scanCompetitors(allAccounts) {
  console.log(`  → Scanning competitors...`);
  const acctNames = allAccounts.map(a => a.name).join(', ') || 'UK retailers';
  const prompt = `Competitive intelligence scan for Rithum sales team. Check these competitors: ${COMPETITORS.join(', ')}.

Find anything published or announced in the last 7 days:
- News, press releases, product updates
- LinkedIn posts from their executives  
- New customer wins or case studies
- Any signals they are targeting these accounts: ${acctNames}

Return as bullet points grouped by competitor. Max 2-3 bullets per competitor. Include signal strength (High/Med/Low).
If nothing new this week for a competitor, skip them.`;
  const result = await callAI(prompt, true);
  return {
    scannedAt: new Date().toISOString(),
    content: result || 'No significant competitor activity found this week.'
  };
}

function buildDigest(repName, accountResults, competitorResult) {
  const highSignals = accountResults.filter(r =>
    r.content && r.content.toLowerCase().includes('high')
  );
  let digest = `TEMPO DAILY DIGEST — ${timestamp()}\n`;
  digest += `For: ${repName}\n`;
  digest += `${'─'.repeat(50)}\n\n`;
  if (highSignals.length > 0) {
    digest += `🔴 HIGH PRIORITY SIGNALS (${highSignals.length})\n\n`;
    highSignals.forEach(r => {
      digest += `${r.accountName.toUpperCase()}\n${r.content}\n\n`;
    });
    digest += `${'─'.repeat(50)}\n\n`;
  }
  digest += `📡 ALL ACCOUNT SIGNALS\n\n`;
  accountResults.forEach(r => {
    if (r.content && !r.content.includes('No new signals')) {
      digest += `${r.accountName}\n${r.content}\n\n`;
    }
  });
  digest += `${'─'.repeat(50)}\n\n`;
  digest += `🏴 COMPETITOR INTELLIGENCE\n\n`;
  digest += competitorResult.content + '\n\n';
  digest += `${'─'.repeat(50)}\n`;
  digest += `Open Tempo to act on these signals: ${process.env.APP_URL || 'http://localhost:3000'}\n`;
  return digest;
}

async function runScan(accountsDB, saveData, TEAM, username, role) {
  if (!accountsDB._scans) accountsDB._scans = {};

  const accounts = role === 'Manager'
    ? Object.entries(accountsDB).filter(([k]) => k !== '_scans').flatMap(([, v]) => v)
    : (accountsDB[username] || []);

  if (accounts.length === 0) {
    console.log('No accounts to scan.');
    return;
  }

  const seen = new Set();
  const unique = accounts.filter(a => !seen.has(a.id) && seen.add(a.id));
  const results = [];

  for (const account of unique) {
    const result = await scanAccount(account);
    results.push(result);
    Object.keys(accountsDB).forEach(u => {
      if (u === '_scans') return;
      const idx = (accountsDB[u] || []).findIndex(a => a.id === account.id);
      if (idx !== -1) {
        if (!accountsDB[u][idx].autoSignals) accountsDB[u][idx].autoSignals = [];
        accountsDB[u][idx].autoSignals.unshift({ text: result.content, scannedAt: result.scannedAt });
        accountsDB[u][idx].autoSignals = accountsDB[u][idx].autoSignals.slice(0, 5);
      }
    });
    await new Promise(r => setTimeout(r, 1500));
  }

  const competitorResult = await scanCompetitors(unique);
  accountsDB._scans.lastCompetitorScan = competitorResult;

  if (!accountsDB._scans.digests) accountsDB._scans.digests = {};

  if (role === 'Manager') {
    Object.keys(TEAM).forEach(u => {
      const repAccounts = accountsDB[u] || [];
      const repResults = results.filter(r => repAccounts.some(a => a.id === r.accountId));
      if (!repResults.length) return;
      accountsDB._scans.digests[u] = {
        content: buildDigest(TEAM[u].name, repResults, competitorResult),
        generatedAt: new Date().toISOString()
      };
    });
    accountsDB._scans.digests['_manager'] = {
      content: buildDigest('Manager', results, competitorResult),
      generatedAt: new Date().toISOString()
    };
  } else {
    accountsDB._scans.digests[username] = {
      content: buildDigest(TEAM[username].name, results, competitorResult),
      generatedAt: new Date().toISOString()
    };
  }

  saveData(accountsDB);
  console.log(`Scan complete — ${unique.length} accounts scanned`);
}

function startScheduler(accountsDB, saveData, TEAM) {
  console.log(`\n  ✓ Scheduler active — daily scan at ${SCAN_TIME} (weekdays)\n`);

  cron.schedule(SCAN_TIME, async () => {
    console.log(`\n[${timestamp()}] Starting daily signal scan...`);
    const allAccounts = Object.entries(accountsDB).filter(([k]) => k !== '_scans').flatMap(([, v]) => v);
    if (allAccounts.length === 0) { console.log('  No accounts to scan yet. Skipping.'); return; }
    await runScan(accountsDB, saveData, TEAM, null, 'Manager');
    console.log(`[${timestamp()}] Daily scan complete\n`);
  });

  cron.schedule('0 * * * *', () => {
    const totalAccounts = Object.entries(accountsDB).filter(([k]) => k !== '_scans').flatMap(([, v]) => v).length;
    console.log(`[${timestamp()}] Scheduler heartbeat — ${totalAccounts} accounts tracked`);
  });
}

module.exports = { startScheduler, runScan };
