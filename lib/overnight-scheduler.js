/**
 * lib/overnight-scheduler.js
 *
 * Five staggered overnight cron jobs that pre-generate all dashboard data
 * so every rep arrives at 8am to a fully-populated dashboard.
 *
 * Schedule (all times UK / Europe/London):
 *   11:00 pm  — Signal scan for every account
 *   12:30 am  — Morning brief per rep
 *    2:00 am  — Competitor intelligence
 *    3:30 am  — Outreach plans
 *    5:00 am  — Manager dashboard summary
 *
 * Data is stored in the `dashboard_cache` Postgres table:
 *   CREATE TABLE IF NOT EXISTS dashboard_cache (
 *     id          SERIAL PRIMARY KEY,
 *     account_id  VARCHAR(255),
 *     data_type   VARCHAR(50),   -- 'signals' | 'brief' | 'competitors' | 'outreach' | 'summary'
 *     data        JSONB,
 *     generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *     expires_at  TIMESTAMP,
 *     UNIQUE(account_id, data_type)
 *   );
 */

'use strict';

const cron  = require('node-cron');
const fetch = require('node-fetch');
const { Pool } = require('pg');

// ─── Postgres pool ────────────────────────────────────────────────────────────
// Reads DATABASE_URL from the environment (set by Railway / .env).
let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.warn('[overnight] DATABASE_URL not set — cache jobs will be skipped.');
      return null;
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

// ─── Bootstrap the cache table ────────────────────────────────────────────────
async function ensureTable() {
  const db = getPool();
  if (!db) return false;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS dashboard_cache (
        id           SERIAL PRIMARY KEY,
        account_id   VARCHAR(255),
        data_type    VARCHAR(50),
        data         JSONB,
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at   TIMESTAMP,
        UNIQUE(account_id, data_type)
      )
    `);
    return true;
  } catch (e) {
    console.error('[overnight] Failed to create dashboard_cache table:', e.message);
    return false;
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
async function upsertCache(accountId, dataType, data) {
  const db = getPool();
  if (!db) return;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24 h
  await db.query(
    `INSERT INTO dashboard_cache (account_id, data_type, data, generated_at, expires_at)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (account_id, data_type)
     DO UPDATE SET data = EXCLUDED.data,
                   generated_at = EXCLUDED.generated_at,
                   expires_at   = EXCLUDED.expires_at`,
    [accountId, dataType, JSON.stringify(data), expiresAt]
  );
}

async function getCacheEntry(accountId, dataType) {
  const db = getPool();
  if (!db) return null;
  const { rows } = await db.query(
    `SELECT * FROM dashboard_cache
     WHERE account_id = $1 AND data_type = $2
       AND expires_at > NOW()
     LIMIT 1`,
    [accountId, dataType]
  );
  return rows[0] || null;
}

async function getJobTimestamp(jobName) {
  const db = getPool();
  if (!db) return null;
  const { rows } = await db.query(
    `SELECT generated_at FROM dashboard_cache
     WHERE account_id = '_job_status' AND data_type = $1
     LIMIT 1`,
    [jobName]
  );
  return rows[0] ? rows[0].generated_at : null;
}

async function setJobStatus(jobName, status) {
  const db = getPool();
  if (!db) return;
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // keep for 48 h
  await db.query(
    `INSERT INTO dashboard_cache (account_id, data_type, data, generated_at, expires_at)
     VALUES ('_job_status', $1, $2, NOW(), $3)
     ON CONFLICT (account_id, data_type)
     DO UPDATE SET data = EXCLUDED.data,
                   generated_at = EXCLUDED.generated_at,
                   expires_at   = EXCLUDED.expires_at`,
    [jobName, JSON.stringify(status), expiresAt]
  );
}

// ─── AI helper ────────────────────────────────────────────────────────────────
const COMPETITORS = ['Mirakl', 'Marketplacer', 'VirtualStock', 'Tradebyte', 'ChannelEngine'];

async function callAI(prompt, webSearch = false) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const body = {
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system:
        'You are a B2B sales intelligence researcher for Rithum, a retail commerce platform. ' +
        'Be specific, concise and actionable. Always use web search for current information.',
      messages: [{ role: 'user', content: prompt }],
    };
    if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    return (d.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim() || null;
  } catch (e) {
    console.error('[overnight] AI call failed:', e.message);
    return null;
  }
}

function ts() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Job helpers ──────────────────────────────────────────────────────────────

/**
 * Returns all unique accounts across all reps (excludes _scans key).
 */
function getAllAccounts(accountsDB) {
  return Object.entries(accountsDB)
    .filter(([k]) => k !== '_scans')
    .flatMap(([, v]) => v);
}

/**
 * Returns accounts grouped by rep username.
 */
function getAccountsByRep(accountsDB) {
  return Object.entries(accountsDB).filter(([k]) => k !== '_scans');
}

// ─── JOB 1 — 11 pm: Signal scan ──────────────────────────────────────────────
async function runSignalScan(accountsDB) {
  console.log(`\n[${ts()}] [overnight] JOB 1 — Signal scan starting...`);
  const allAccounts = getAllAccounts(accountsDB);
  if (allAccounts.length === 0) {
    console.log(`[${ts()}] [overnight] No accounts to scan. Skipping.`);
    await setJobStatus('signals', { status: 'skipped', reason: 'no accounts', completedAt: new Date().toISOString() });
    return;
  }

  // De-duplicate by account id
  const seen = new Set();
  const unique = allAccounts.filter(a => !seen.has(a.id) && seen.add(a.id));

  let succeeded = 0, failed = 0;

  for (const account of unique) {
    try {
      console.log(`  [overnight] Scanning ${account.name}...`);
      const prompt =
        `Find the latest B2B sales signals about ${account.name} (UK retailer) in the last 7 days.\n` +
        `Focus on: leadership changes, financial results, hiring, LinkedIn posts, tech announcements, partnerships.\n` +
        `Return 3-5 bullet points maximum. Each bullet: what happened, why it matters for sales, signal strength (High/Medium/Low).\n` +
        `Be specific — real names, dates, figures. If nothing significant found in last 7 days, say so briefly.`;
      const content = await callAI(prompt, true);
      await upsertCache(account.id, 'signals', {
        accountId: account.id,
        accountName: account.name,
        content: content || 'No new signals found this scan.',
        scannedAt: new Date().toISOString(),
      });
      succeeded++;
    } catch (e) {
      console.error(`  [overnight] Error scanning ${account.name}:`, e.message);
      failed++;
    }
    await delay(1500); // rate-limit buffer between accounts
  }

  await setJobStatus('signals', {
    status: 'completed',
    completedAt: new Date().toISOString(),
    accountsScanned: succeeded,
    failed,
  });
  console.log(`[${ts()}] [overnight] JOB 1 complete — ${succeeded} accounts scanned, ${failed} failed.`);
}

// ─── JOB 2 — 12:30 am: Morning brief ─────────────────────────────────────────
async function runMorningBrief(accountsDB, TEAM) {
  console.log(`\n[${ts()}] [overnight] JOB 2 — Morning brief starting...`);

  // Check that signals job ran tonight (within last 4 hours)
  const sigTs = await getJobTimestamp('signals');
  if (!sigTs || Date.now() - new Date(sigTs).getTime() > 4 * 60 * 60 * 1000) {
    console.warn(`[${ts()}] [overnight] JOB 2 — signals job not completed recently. Proceeding anyway.`);
  }

  const repEntries = getAccountsByRep(accountsDB);
  let succeeded = 0, failed = 0;

  for (const [username, accounts] of repEntries) {
    if (!accounts || accounts.length === 0) continue;
    const repInfo = TEAM[username];
    if (!repInfo) continue;

    try {
      console.log(`  [overnight] Generating brief for ${repInfo.name}...`);

      // Pull cached signals for this rep's accounts
      const signalLines = [];
      for (const acct of accounts) {
        const cached = await getCacheEntry(acct.id, 'signals');
        if (cached && cached.data && cached.data.content) {
          signalLines.push(`${acct.name}:\n${cached.data.content}`);
        }
      }

      const signalContext = signalLines.length > 0
        ? signalLines.join('\n\n')
        : 'No overnight signals available yet.';

      const acctNames = accounts.map(a => `${a.name} (${a.status || 'cold'})`).join(', ');
      const prompt =
        `Generate a morning brief for ${repInfo.name}, a B2B sales rep at Rithum.\n\n` +
        `Their accounts: ${acctNames}\n\n` +
        `Overnight signal scan results:\n${signalContext}\n\n` +
        `Format the brief as:\n` +
        `1. TOP PRIORITY TODAY (1-2 accounts with highest-signal activity)\n` +
        `2. KEY SIGNALS (bullet points per account, High/Medium/Low)\n` +
        `3. RECOMMENDED ACTIONS (3-5 specific next steps for today)\n` +
        `4. COMPETITOR WATCH (anything relevant from overnight scan)\n\n` +
        `Be specific, actionable, and concise. Use real account names.`;

      const content = await callAI(prompt, false);
      await upsertCache(username, 'brief', {
        username,
        repName: repInfo.name,
        content: content || 'Brief generation failed — check API key.',
        generatedAt: new Date().toISOString(),
      });
      succeeded++;
    } catch (e) {
      console.error(`  [overnight] Error generating brief for ${username}:`, e.message);
      failed++;
    }
    await delay(2000);
  }

  // Also generate a manager-level brief
  try {
    const allAccounts = getAllAccounts(accountsDB);
    const allSignals = [];
    for (const acct of allAccounts.slice(0, 20)) { // cap to avoid huge prompts
      const cached = await getCacheEntry(acct.id, 'signals');
      if (cached && cached.data && cached.data.content) {
        allSignals.push(`${acct.name}: ${cached.data.content.substring(0, 200)}`);
      }
    }
    const prompt =
      `Generate a manager morning brief for the Rithum sales team.\n\n` +
      `Team accounts with overnight signals:\n${allSignals.join('\n\n') || 'No signals yet.'}\n\n` +
      `Format:\n` +
      `1. TEAM HIGHLIGHTS (top 3 accounts with activity)\n` +
      `2. HIGH-PRIORITY SIGNALS (accounts needing immediate action)\n` +
      `3. TEAM ACTIONS FOR TODAY (what each rep should focus on)\n` +
      `4. RISKS & WATCH LIST\n\n` +
      `Be direct and specific.`;
    const content = await callAI(prompt, false);
    await upsertCache('_manager', 'brief', {
      content: content || 'Manager brief generation failed.',
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`  [overnight] Error generating manager brief:`, e.message);
  }

  await setJobStatus('brief', {
    status: 'completed',
    completedAt: new Date().toISOString(),
    repsProcessed: succeeded,
    failed,
  });
  console.log(`[${ts()}] [overnight] JOB 2 complete — briefs generated for ${succeeded} reps.`);
}

// ─── JOB 3 — 2 am: Competitor intelligence ───────────────────────────────────
async function runCompetitorIntel(accountsDB) {
  console.log(`\n[${ts()}] [overnight] JOB 3 — Competitor intel starting...`);

  const allAccounts = getAllAccounts(accountsDB);
  const acctNames = allAccounts.map(a => a.name).join(', ') || 'UK retailers';

  try {
    const prompt =
      `Competitive intelligence scan for Rithum sales team. Check these competitors: ${COMPETITORS.join(', ')}.\n\n` +
      `Find anything published or announced in the last 7 days:\n` +
      `- News, press releases, product updates\n` +
      `- LinkedIn posts from their executives\n` +
      `- New customer wins or case studies\n` +
      `- Any signals they are targeting these accounts: ${acctNames}\n\n` +
      `Return as bullet points grouped by competitor. Max 3 bullets per competitor. Include signal strength (High/Med/Low).\n` +
      `If nothing new this week for a competitor, skip them.`;

    const content = await callAI(prompt, true);
    await upsertCache('_team', 'competitors', {
      content: content || 'No significant competitor activity found this week.',
      scannedAt: new Date().toISOString(),
      competitors: COMPETITORS,
    });

    await setJobStatus('competitors', {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    console.log(`[${ts()}] [overnight] JOB 3 complete — competitor intel cached.`);
  } catch (e) {
    console.error(`[${ts()}] [overnight] JOB 3 failed:`, e.message);
    await setJobStatus('competitors', {
      status: 'failed',
      error: e.message,
      completedAt: new Date().toISOString(),
    });
  }
}

// ─── JOB 4 — 3:30 am: Outreach plans ─────────────────────────────────────────
async function runOutreachPlans(accountsDB, TEAM) {
  console.log(`\n[${ts()}] [overnight] JOB 4 — Outreach plans starting...`);

  const repEntries = getAccountsByRep(accountsDB);
  let succeeded = 0, failed = 0;

  for (const [username, accounts] of repEntries) {
    if (!accounts || accounts.length === 0) continue;
    const repInfo = TEAM[username];
    if (!repInfo) continue;

    try {
      console.log(`  [overnight] Generating outreach plan for ${repInfo.name}...`);
      const acctNames = accounts
        .map(a => `${a.name} (${a.status || 'cold'})`)
        .join(', ');

      // Pull signals context
      const signalContext = [];
      for (const acct of accounts.slice(0, 10)) {
        const cached = await getCacheEntry(acct.id, 'signals');
        if (cached && cached.data && cached.data.content) {
          signalContext.push(`${acct.name}: ${cached.data.content.substring(0, 150)}`);
        }
      }

      const weekPlanPrompt =
        `Create a prioritised outreach plan for this week for ${repInfo.name} at Rithum.\n\n` +
        `Accounts: ${acctNames}\n\n` +
        `Latest signals:\n${signalContext.join('\n') || 'No signals yet.'}\n\n` +
        `For each account to action this week: angle, right person, channel, 2-sentence opener. RWOS rules.\n` +
        `Prioritise by signal strength and deal stage. Max 6 accounts.`;

      const priorityPrompt =
        `Which of these accounts are most likely in an active buying cycle right now and why?\n\n` +
        `Accounts: ${acctNames}\n\n` +
        `Signals:\n${signalContext.join('\n') || 'No signals yet.'}\n\n` +
        `Rank top 5. For each: reason, urgency (days/weeks/months), specific action to take today.`;

      const [weekPlan, priority] = await Promise.all([
        callAI(weekPlanPrompt, false),
        callAI(priorityPrompt, false),
      ]);

      await upsertCache(username, 'outreach', {
        username,
        repName: repInfo.name,
        weekPlan: weekPlan || 'Outreach plan generation failed.',
        priority: priority || 'Priority analysis failed.',
        generatedAt: new Date().toISOString(),
      });
      succeeded++;
    } catch (e) {
      console.error(`  [overnight] Error generating outreach plan for ${username}:`, e.message);
      failed++;
    }
    await delay(2000);
  }

  await setJobStatus('outreach', {
    status: 'completed',
    completedAt: new Date().toISOString(),
    repsProcessed: succeeded,
    failed,
  });
  console.log(`[${ts()}] [overnight] JOB 4 complete — outreach plans for ${succeeded} reps.`);
}

// ─── JOB 5 — 5 am: Dashboard summary ─────────────────────────────────────────
async function runDashboardSummary(accountsDB, TEAM) {
  console.log(`\n[${ts()}] [overnight] JOB 5 — Dashboard summary starting...`);

  try {
    const allAccounts = getAllAccounts(accountsDB);
    const repEntries = getAccountsByRep(accountsDB);

    // Build aggregated context
    const teamStats = {
      totalAccounts: allAccounts.length,
      openOpps: allAccounts.filter(a => ['open', 'nurture', 'eu'].includes(a.status)).length,
      coldTargets: allAccounts.filter(a => a.status === 'cold').length,
      customers: allAccounts.filter(a => a.status === 'won').length,
      reps: repEntries.length,
    };

    // Gather all cached signals for context
    const highSignals = [];
    for (const acct of allAccounts.slice(0, 30)) {
      const cached = await getCacheEntry(acct.id, 'signals');
      if (cached && cached.data && cached.data.content &&
          cached.data.content.toLowerCase().includes('high')) {
        highSignals.push(`${acct.name}: ${cached.data.content.substring(0, 200)}`);
      }
    }

    const competitorCache = await getCacheEntry('_team', 'competitors');
    const competitorSummary = competitorCache
      ? competitorCache.data.content.substring(0, 500)
      : 'No competitor data yet.';

    const prompt =
      `Generate a manager dashboard summary for the Rithum sales team.\n\n` +
      `Team stats: ${teamStats.totalAccounts} accounts, ${teamStats.openOpps} open opps, ` +
      `${teamStats.customers} customers, ${teamStats.reps} reps.\n\n` +
      `High-priority signals from overnight scan:\n${highSignals.join('\n') || 'None detected.'}\n\n` +
      `Competitor intelligence summary:\n${competitorSummary}\n\n` +
      `Generate:\n` +
      `1. OVERNIGHT SUMMARY (what happened across the portfolio)\n` +
      `2. TOP 5 ACCOUNTS TO WATCH TODAY (with reasons)\n` +
      `3. TEAM ACTIONS (what each rep should prioritise)\n` +
      `4. COMPETITIVE ALERTS (anything urgent from competitor scan)\n` +
      `5. PIPELINE HEALTH (brief assessment)\n\n` +
      `Be direct, specific, and actionable. This is the first thing the manager reads at 8am.`;

    const content = await callAI(prompt, false);

    // Compile job statuses
    const jobStatuses = {};
    for (const job of ['signals', 'brief', 'competitors', 'outreach']) {
      const cached = await getCacheEntry('_job_status', job);
      jobStatuses[job] = cached ? cached.data : { status: 'unknown' };
    }

    await upsertCache('_manager', 'summary', {
      content: content || 'Summary generation failed.',
      teamStats,
      jobStatuses,
      generatedAt: new Date().toISOString(),
    });

    await setJobStatus('summary', {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    console.log(`[${ts()}] [overnight] JOB 5 complete — dashboard summary cached.`);
  } catch (e) {
    console.error(`[${ts()}] [overnight] JOB 5 failed:`, e.message);
    await setJobStatus('summary', {
      status: 'failed',
      error: e.message,
      completedAt: new Date().toISOString(),
    });
  }
}

// ─── Scheduler bootstrap ──────────────────────────────────────────────────────
function startOvernightScheduler(accountsDB, saveData, TEAM) {
  // Ensure the cache table exists on startup
  ensureTable().then(ok => {
    if (ok) console.log('  ✓ dashboard_cache table ready');
  });

  const TZ = { timezone: 'Europe/London' };

  // JOB 1 — 11:00 pm every night
  cron.schedule('0 23 * * *', async () => {
    try {
      await runSignalScan(accountsDB);
    } catch (e) {
      console.error(`[${ts()}] [overnight] JOB 1 uncaught error:`, e.message);
      await setJobStatus('signals', { status: 'failed', error: e.message, completedAt: new Date().toISOString() });
    }
  }, TZ);

  // JOB 2 — 12:30 am every night
  cron.schedule('30 0 * * *', async () => {
    try {
      await runMorningBrief(accountsDB, TEAM);
    } catch (e) {
      console.error(`[${ts()}] [overnight] JOB 2 uncaught error:`, e.message);
      await setJobStatus('brief', { status: 'failed', error: e.message, completedAt: new Date().toISOString() });
    }
  }, TZ);

  // JOB 3 — 2:00 am every night
  cron.schedule('0 2 * * *', async () => {
    try {
      await runCompetitorIntel(accountsDB);
    } catch (e) {
      console.error(`[${ts()}] [overnight] JOB 3 uncaught error:`, e.message);
      await setJobStatus('competitors', { status: 'failed', error: e.message, completedAt: new Date().toISOString() });
    }
  }, TZ);

  // JOB 4 — 3:30 am every night
  cron.schedule('30 3 * * *', async () => {
    try {
      await runOutreachPlans(accountsDB, TEAM);
    } catch (e) {
      console.error(`[${ts()}] [overnight] JOB 4 uncaught error:`, e.message);
      await setJobStatus('outreach', { status: 'failed', error: e.message, completedAt: new Date().toISOString() });
    }
  }, TZ);

  // JOB 5 — 5:00 am every night
  cron.schedule('0 5 * * *', async () => {
    try {
      await runDashboardSummary(accountsDB, TEAM);
    } catch (e) {
      console.error(`[${ts()}] [overnight] JOB 5 uncaught error:`, e.message);
      await setJobStatus('summary', { status: 'failed', error: e.message, completedAt: new Date().toISOString() });
    }
  }, TZ);

  console.log('  ✓ Overnight scheduler active:');
  console.log('      11:00 pm — Signal scan');
  console.log('      12:30 am — Morning briefs');
  console.log('       2:00 am — Competitor intel');
  console.log('       3:30 am — Outreach plans');
  console.log('       5:00 am — Dashboard summary');
}

module.exports = {
  startOvernightScheduler,
  ensureTable,
  getCacheEntry,
  upsertCache,
  getPool,
  // Exported for manual triggers / testing
  runSignalScan,
  runMorningBrief,
  runCompetitorIntel,
  runOutreachPlans,
  runDashboardSummary,
};
