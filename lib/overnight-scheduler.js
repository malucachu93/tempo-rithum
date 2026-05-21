/**
 * Overnight Scheduler — Tempo by Rithum
 *
 * Staggered cron jobs run 11pm–5am to pre-populate dashboard cache
 * so all data is ready by 8am login. Results stored in accountsDB._cache.
 *
 * Schedule:
 *   11:00pm  — scanAllAccounts()       signal scans + memory updates
 *   12:30am  — generateMorningBriefs() per-rep + manager brief
 *   02:00am  — generateCompetitorIntel() competitor analysis
 *   03:30am  — generateOutreachPlans()  outreach prioritisation
 *   05:00am  — generateDashboardSummary() aggregate manager view
 */

'use strict';

const cron  = require('node-cron');
const fetch = require('node-fetch');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function log(msg) {
  console.log(`[${ts()}] [overnight] ${msg}`);
}

async function callAI(prompt, webSearch = false, maxTokens = 800) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes('your-key')) return null;
  try {
    const body = {
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      system: 'You are a B2B sales intelligence researcher for Rithum, a retail commerce platform. Be specific, concise and actionable.',
      messages: [{ role: 'user', content: prompt }]
    };
    if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.error) { log(`AI error: ${JSON.stringify(d.error)}`); return null; }
    return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() || null;
  } catch (e) {
    log(`AI call failed: ${e.message}`);
    return null;
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Cache helpers ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function initCache(accountsDB) {
  if (!accountsDB._cache) accountsDB._cache = {};
}

function setCache(accountsDB, type, data) {
  initCache(accountsDB);
  const now = new Date();
  accountsDB._cache[type] = {
    data,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CACHE_TTL_MS).toISOString()
  };
}

function getCache(accountsDB, type) {
  const entry = (accountsDB._cache || {})[type];
  if (!entry) return null;
  if (new Date(entry.expires_at) < new Date()) return null; // stale
  return entry;
}

// ─── Scan log helpers ──────────────────────────────────────────────────────────

function initLog(accountsDB) {
  if (!accountsDB._scanLog) accountsDB._scanLog = [];
}

function startLog(accountsDB, scanType) {
  initLog(accountsDB);
  const entry = {
    id: Date.now(),
    scan_type: scanType,
    started_at: new Date().toISOString(),
    completed_at: null,
    status: 'running',
    error_message: null,
    accounts_processed: 0
  };
  accountsDB._scanLog.unshift(entry);
  accountsDB._scanLog = accountsDB._scanLog.slice(0, 100); // keep last 100
  return entry;
}

function finishLog(entry, status, accountsProcessed = 0, errorMessage = null) {
  entry.completed_at = new Date().toISOString();
  entry.status = status;
  entry.accounts_processed = accountsProcessed;
  entry.error_message = errorMessage;
}

// ─── Job 1 — 11pm: Scan all accounts ──────────────────────────────────────────

async function scanAllAccounts(accountsDB, saveData, TEAM) {
  log('Starting scanAllAccounts...');
  const logEntry = startLog(accountsDB, 'account_scans');
  saveData(accountsDB);

  try {
    const allAccounts = Object.entries(accountsDB)
      .filter(([k]) => !k.startsWith('_'))
      .flatMap(([, v]) => v);

    const seen = new Set();
    const unique = allAccounts.filter(a => a && a.id && !seen.has(a.id) && seen.add(a.id));

    if (unique.length === 0) {
      log('No accounts to scan.');
      finishLog(logEntry, 'completed', 0);
      saveData(accountsDB);
      return;
    }

    log(`Scanning ${unique.length} accounts...`);
    const results = [];

    for (const account of unique) {
      try {
        log(`  → ${account.name}`);
        const prompt = `Find the latest B2B sales signals about ${account.name} (UK retailer) in the last 7 days.
Focus on: leadership changes, financial results, hiring, LinkedIn posts, tech announcements, partnerships.
Return 3-5 bullet points maximum. Each bullet: what happened, why it matters for sales, signal strength (High/Medium/Low).
Be specific — real names, dates, figures. If nothing significant found in last 7 days, say so briefly.`;
        const content = await callAI(prompt, true, 600);
        const result = {
          scannedAt: new Date().toISOString(),
          content: content || 'No new signals found this scan.',
          accountId: account.id,
          accountName: account.name
        };
        results.push(result);

        // Write signal back to each rep's account record
        Object.keys(accountsDB).forEach(u => {
          if (u.startsWith('_')) return;
          const idx = (accountsDB[u] || []).findIndex(a => a.id === account.id);
          if (idx !== -1) {
            if (!accountsDB[u][idx].autoSignals) accountsDB[u][idx].autoSignals = [];
            accountsDB[u][idx].autoSignals.unshift({ text: result.content, scannedAt: result.scannedAt });
            accountsDB[u][idx].autoSignals = accountsDB[u][idx].autoSignals.slice(0, 5);
          }
        });
      } catch (e) {
        log(`  ✗ Failed scanning ${account.name}: ${e.message}`);
      }
      await delay(2000); // rate-limit buffer
    }

    // Store scan results in cache for dashboard use
    setCache(accountsDB, 'signals', {
      results,
      scannedAt: new Date().toISOString(),
      accountCount: unique.length
    });

    finishLog(logEntry, 'completed', unique.length);
    saveData(accountsDB);
    log(`scanAllAccounts complete — ${unique.length} accounts processed.`);
  } catch (e) {
    log(`scanAllAccounts FAILED: ${e.message}`);
    finishLog(logEntry, 'failed', 0, e.message);
    saveData(accountsDB);
  }
}

// ─── Job 2 — 12:30am: Generate morning briefs ─────────────────────────────────

async function generateMorningBriefs(accountsDB, saveData, TEAM) {
  log('Starting generateMorningBriefs...');
  const logEntry = startLog(accountsDB, 'brief');
  saveData(accountsDB);

  try {
    const COMPETITORS = ['Mirakl', 'Marketplacer', 'VirtualStock', 'Tradebyte', 'ChannelEngine'];
    const competitorScan = (accountsDB._scans || {}).lastCompetitorScan;
    const briefs = {};
    let processed = 0;

    const repUsernames = Object.keys(TEAM).filter(u => {
      const role = (TEAM[u].role || '').toLowerCase();
      return role !== 'manager';
    });

    for (const username of repUsernames) {
      const repAccounts = accountsDB[username] || [];
      if (repAccounts.length === 0) continue;

      try {
        log(`  → Brief for ${TEAM[username].name}`);
        const acctSummaries = repAccounts.map(a => {
          const latestSignal = a.autoSignals && a.autoSignals[0]
            ? a.autoSignals[0].text.substring(0, 200)
            : (a.pain || 'No recent signals');
          return `${a.name} [${a.status || 'cold'}]: ${latestSignal}`;
        }).join('\n');

        const prompt = `Generate a morning sales brief for ${TEAM[username].name} at Rithum.

Their accounts and latest signals:
${acctSummaries}

${competitorScan ? `Competitor intelligence:\n${competitorScan.content.substring(0, 400)}` : ''}

Format:
## Top priorities today (top 3 accounts to focus on, with specific reason)
## High-signal accounts (accounts with High-strength signals)
## Recommended actions (3 specific outreach actions for today)
## Competitor watch (any competitor activity relevant to their accounts)

Be specific, use real account names, keep it under 400 words.`;

        const content = await callAI(prompt, false, 1000);
        briefs[username] = {
          content: content || 'Brief generation failed — check signals tab for latest data.',
          generatedAt: new Date().toISOString()
        };
        processed++;
      } catch (e) {
        log(`  ✗ Brief failed for ${username}: ${e.message}`);
      }
      await delay(3000);
    }

    // Manager brief
    try {
      log('  → Manager brief');
      const allAccounts = Object.entries(accountsDB)
        .filter(([k]) => !k.startsWith('_'))
        .flatMap(([u, accts]) => accts.map(a => ({ ...a, repName: (TEAM[u] || {}).name || u })));

      const teamSummary = allAccounts.slice(0, 20).map(a => {
        const sig = a.autoSignals && a.autoSignals[0]
          ? a.autoSignals[0].text.substring(0, 120)
          : (a.pain || '');
        return `${a.name} (${a.repName}) [${a.status || 'cold'}]: ${sig}`;
      }).join('\n');

      const mgrPrompt = `Generate a manager morning brief for the Rithum EMEA sales team.

Team accounts summary:
${teamSummary}

${competitorScan ? `Competitor intelligence:\n${competitorScan.content.substring(0, 400)}` : ''}

Format:
## Team pulse (overall pipeline health in 2 sentences)
## Hot accounts (top 5 accounts with highest urgency across the team)
## Competitor alerts (any competitor activity needing immediate response)
## Manager actions (3 things the manager should do today)
## Rep coaching points (one specific coaching point per rep)

Be direct. Use real names. Under 500 words.`;

      const mgrContent = await callAI(mgrPrompt, false, 1200);
      briefs['_manager'] = {
        content: mgrContent || 'Manager brief generation failed.',
        generatedAt: new Date().toISOString()
      };
    } catch (e) {
      log(`  ✗ Manager brief failed: ${e.message}`);
    }

    // Persist briefs into existing _scans.digests structure (for /api/digest compatibility)
    if (!accountsDB._scans) accountsDB._scans = {};
    if (!accountsDB._scans.digests) accountsDB._scans.digests = {};
    Object.assign(accountsDB._scans.digests, briefs);

    // Also store in cache
    setCache(accountsDB, 'brief', { briefs, generatedAt: new Date().toISOString() });

    finishLog(logEntry, 'completed', processed);
    saveData(accountsDB);
    log(`generateMorningBriefs complete — ${processed} rep briefs generated.`);
  } catch (e) {
    log(`generateMorningBriefs FAILED: ${e.message}`);
    finishLog(logEntry, 'failed', 0, e.message);
    saveData(accountsDB);
  }
}

// ─── Job 3 — 2am: Generate competitor intel ───────────────────────────────────

async function generateCompetitorIntel(accountsDB, saveData, TEAM) {
  log('Starting generateCompetitorIntel...');
  const logEntry = startLog(accountsDB, 'competitors');
  saveData(accountsDB);

  try {
    const COMPETITORS = ['Mirakl', 'Marketplacer', 'VirtualStock', 'Tradebyte', 'ChannelEngine'];
    const allAccounts = Object.entries(accountsDB)
      .filter(([k]) => !k.startsWith('_'))
      .flatMap(([, v]) => v);
    const acctNames = [...new Set(allAccounts.map(a => a.name))].join(', ') || 'UK retailers';

    const prompt = `Competitive intelligence scan for Rithum sales team. Check these competitors: ${COMPETITORS.join(', ')}.

Find anything published or announced in the last 7 days:
- News, press releases, product updates
- LinkedIn posts from their executives
- New customer wins or case studies
- Any signals they are targeting these accounts: ${acctNames}

Return as bullet points grouped by competitor. Max 3 bullets per competitor. Include signal strength (High/Med/Low).
If nothing new this week for a competitor, skip them.
End with a "Deal interception alerts" section for any accounts they appear to be actively targeting.`;

    const content = await callAI(prompt, true, 1000);
    const result = {
      scannedAt: new Date().toISOString(),
      content: content || 'No significant competitor activity found this week.'
    };

    // Store in existing _scans structure for backward compatibility
    if (!accountsDB._scans) accountsDB._scans = {};
    accountsDB._scans.lastCompetitorScan = result;

    // Also store in cache
    setCache(accountsDB, 'competitors', result);

    finishLog(logEntry, 'completed', COMPETITORS.length);
    saveData(accountsDB);
    log('generateCompetitorIntel complete.');
  } catch (e) {
    log(`generateCompetitorIntel FAILED: ${e.message}`);
    finishLog(logEntry, 'failed', 0, e.message);
    saveData(accountsDB);
  }
}

// ─── Job 4 — 3:30am: Generate outreach plans ──────────────────────────────────

async function generateOutreachPlans(accountsDB, saveData, TEAM) {
  log('Starting generateOutreachPlans...');
  const logEntry = startLog(accountsDB, 'outreach');
  saveData(accountsDB);

  try {
    const plans = {};
    let processed = 0;

    const repUsernames = Object.keys(TEAM).filter(u => {
      const role = (TEAM[u].role || '').toLowerCase();
      return role !== 'manager';
    });

    for (const username of repUsernames) {
      const repAccounts = accountsDB[username] || [];
      if (repAccounts.length === 0) continue;

      try {
        log(`  → Outreach plan for ${TEAM[username].name}`);
        const acctList = repAccounts.map(a => {
          const sig = a.autoSignals && a.autoSignals[0]
            ? a.autoSignals[0].text.substring(0, 150)
            : (a.pain || 'No recent signals');
          const lastOutreach = a.lastOutreachDate
            ? `${Math.floor((Date.now() - new Date(a.lastOutreachDate)) / 86400000)}d ago`
            : 'never';
          return `${a.name} [${a.status || 'cold'}] last outreach: ${lastOutreach} | signal: ${sig}`;
        }).join('\n');

        const prompt = `Create a prioritised outreach plan for ${TEAM[username].name} (Rithum EMEA sales).

Their accounts:
${acctList}

RWOS rules: Subject 1-4 words lower case. First 5-6 words hook on THEIR world. 100 words max. CTA = interest not time. Never start with I.

Provide:
## This week's priority order (ranked 1-${Math.min(repAccounts.length, 8)}, with one-line reason each)
## Top 3 outreach actions (specific account, specific angle, specific channel, 2-sentence opener)
## Accounts to re-engage (overdue 30+ days — fresh angle suggestion)
## Accounts to hold (why and when to revisit)

Be specific. Use real account names. RWOS-compliant openers only.`;

        const content = await callAI(prompt, false, 1200);
        plans[username] = {
          content: content || 'Outreach plan generation failed.',
          generatedAt: new Date().toISOString()
        };
        processed++;
      } catch (e) {
        log(`  ✗ Outreach plan failed for ${username}: ${e.message}`);
      }
      await delay(3000);
    }

    setCache(accountsDB, 'outreach', { plans, generatedAt: new Date().toISOString() });

    finishLog(logEntry, 'completed', processed);
    saveData(accountsDB);
    log(`generateOutreachPlans complete — ${processed} plans generated.`);
  } catch (e) {
    log(`generateOutreachPlans FAILED: ${e.message}`);
    finishLog(logEntry, 'failed', 0, e.message);
    saveData(accountsDB);
  }
}

// ─── Job 5 — 5am: Generate dashboard summary ──────────────────────────────────

async function generateDashboardSummary(accountsDB, saveData, TEAM) {
  log('Starting generateDashboardSummary...');
  const logEntry = startLog(accountsDB, 'summary');
  saveData(accountsDB);

  try {
    const allAccounts = Object.entries(accountsDB)
      .filter(([k]) => !k.startsWith('_'))
      .flatMap(([u, accts]) => accts.map(a => ({
        ...a,
        repUsername: u,
        repName: (TEAM[u] || {}).name || u
      })));

    const open   = allAccounts.filter(a => ['open', 'nurture', 'eu'].includes(a.status));
    const cold   = allAccounts.filter(a => a.status === 'cold');
    const won    = allAccounts.filter(a => a.status === 'won');
    const rising = allAccounts.filter(a => a.intentScore === 'rising');
    const overdue = allAccounts.filter(a => {
      if (!a.lastOutreachDate) return false;
      return Math.floor((Date.now() - new Date(a.lastOutreachDate)) / 86400000) > 30;
    });

    const teamCtx = Object.keys(TEAM)
      .filter(u => (TEAM[u].role || '').toLowerCase() !== 'manager')
      .map(u => {
        const accts = accountsDB[u] || [];
        const openC = accts.filter(a => ['open', 'nurture', 'eu'].includes(a.status)).length;
        const ovdC  = accts.filter(a => {
          if (!a.lastOutreachDate) return false;
          return Math.floor((Date.now() - new Date(a.lastOutreachDate)) / 86400000) > 30;
        }).length;
        return `${TEAM[u].name}: ${accts.length} accounts, ${openC} open opps, ${ovdC} overdue`;
      }).join('\n');

    const prompt = `Generate an executive dashboard summary for the Rithum EMEA sales manager.

Team stats:
- Total accounts: ${allAccounts.length}
- Open opportunities: ${open.length}
- Cold targets: ${cold.length}
- Customers: ${won.length}
- Rising intent: ${rising.length}
- Overdue (30d+): ${overdue.length}

Per rep:
${teamCtx}

Top rising intent accounts: ${rising.slice(0, 5).map(a => `${a.name} (${a.repName})`).join(', ') || 'none'}
Overdue accounts: ${overdue.slice(0, 5).map(a => `${a.name} (${a.repName})`).join(', ') || 'none'}

Provide:
## Pipeline health (2-sentence assessment)
## Biggest opportunities this week (top 3 with reasoning)
## Risk accounts (top 3 most at risk of going cold)
## Team performance snapshot (one line per rep)
## Manager's top 5 actions today

Be direct. Data-driven. Under 400 words.`;

    const content = await callAI(prompt, false, 1200);
    const summary = {
      content: content || 'Dashboard summary generation failed.',
      stats: {
        totalAccounts: allAccounts.length,
        openOpps: open.length,
        coldTargets: cold.length,
        customers: won.length,
        risingIntent: rising.length,
        overdue: overdue.length
      },
      generatedAt: new Date().toISOString()
    };

    setCache(accountsDB, 'dashboard_summary', summary);

    finishLog(logEntry, 'completed', allAccounts.length);
    saveData(accountsDB);
    log('generateDashboardSummary complete.');
  } catch (e) {
    log(`generateDashboardSummary FAILED: ${e.message}`);
    finishLog(logEntry, 'failed', 0, e.message);
    saveData(accountsDB);
  }
}

// ─── Scheduler bootstrap ──────────────────────────────────────────────────────

function startOvernightScheduler(accountsDB, saveData, TEAM) {
  log('Overnight scheduler initialising...');

  // Job 1 — 11:00pm every night
  cron.schedule('0 23 * * *', async () => {
    log('=== JOB 1: scanAllAccounts (11pm) ===');
    try { await scanAllAccounts(accountsDB, saveData, TEAM); }
    catch (e) { log(`Job 1 uncaught error: ${e.message}`); }
  }, { timezone: 'Europe/London' });

  // Job 2 — 12:30am every night
  cron.schedule('30 0 * * *', async () => {
    log('=== JOB 2: generateMorningBriefs (12:30am) ===');
    try { await generateMorningBriefs(accountsDB, saveData, TEAM); }
    catch (e) { log(`Job 2 uncaught error: ${e.message}`); }
  }, { timezone: 'Europe/London' });

  // Job 3 — 2:00am every night
  cron.schedule('0 2 * * *', async () => {
    log('=== JOB 3: generateCompetitorIntel (2am) ===');
    try { await generateCompetitorIntel(accountsDB, saveData, TEAM); }
    catch (e) { log(`Job 3 uncaught error: ${e.message}`); }
  }, { timezone: 'Europe/London' });

  // Job 4 — 3:30am every night
  cron.schedule('30 3 * * *', async () => {
    log('=== JOB 4: generateOutreachPlans (3:30am) ===');
    try { await generateOutreachPlans(accountsDB, saveData, TEAM); }
    catch (e) { log(`Job 4 uncaught error: ${e.message}`); }
  }, { timezone: 'Europe/London' });

  // Job 5 — 5:00am every night
  cron.schedule('0 5 * * *', async () => {
    log('=== JOB 5: generateDashboardSummary (5am) ===');
    try { await generateDashboardSummary(accountsDB, saveData, TEAM); }
    catch (e) { log(`Job 5 uncaught error: ${e.message}`); }
  }, { timezone: 'Europe/London' });

  log('Overnight scheduler active — jobs at 11pm, 12:30am, 2am, 3:30am, 5am (Europe/London)');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  startOvernightScheduler,
  // Exported individually so server.js can expose manual-trigger endpoints
  scanAllAccounts,
  generateMorningBriefs,
  generateCompetitorIntel,
  generateOutreachPlans,
  generateDashboardSummary,
  getCache,
  setCache
};
