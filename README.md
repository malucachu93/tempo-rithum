# Rithum Team Outreach Platform

A team-wide AI-powered outreach tool built around the Rithum Way of Selling (RWOS).
Each rep manages their own book of business. The manager sees everything.

---

## Quick start (5 minutes)

### Step 1 — Install Node.js
Download and install from https://nodejs.org (choose the LTS version)

### Step 2 — Unzip this folder
Unzip `rithum-team.zip` anywhere on your computer

### Step 3 — Add your Anthropic API key
Open the `.env` file in a text editor and replace the placeholder:
```
ANTHROPIC_API_KEY=sk-ant-api03-YOUR-REAL-KEY-HERE
```
Get your key at https://console.anthropic.com → API Keys → Create Key

### Step 4 — Set up your team
Open `team.config.js` and replace the example entries with your real team:
```js
team: {
  sarah:   { name: 'Sarah Johnson',  role: 'manager', password: 'ChooseAPassword' },
  james:   { name: 'James Murphy',   role: 'rep',     password: 'ChooseAPassword' },
  priya:   { name: 'Priya Sharma',   role: 'rep',     password: 'ChooseAPassword' },
  // ... add all 6 team members
}
```

### Step 5 — Install and run
Open Terminal (Mac) or Command Prompt (Windows), navigate to the folder, then:
```
npm install
npm start
```

### Step 6 — Open in browser
Go to http://localhost:3000

---

## Sharing with your team

### Option A — Run on one computer, share on your local network
After `npm start`, your team can access it at `http://YOUR-IP-ADDRESS:3000`
Find your IP: on Mac run `ifconfig | grep inet`, on Windows run `ipconfig`

### Option B — Deploy to Railway (free, public URL, 5 minutes)
1. Create a free account at https://railway.app
2. Click "New Project" → "Deploy from GitHub repo"
   OR use the Railway CLI: `npm install -g @railway/cli && railway up`
3. Add environment variable: `ANTHROPIC_API_KEY = your-key`
4. Railway gives you a public URL — share it with your team

### Option C — Deploy to Render (free tier)
1. Create account at https://render.com
2. New → Web Service → connect your folder
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env var: `ANTHROPIC_API_KEY`

---

## Team credentials (defaults — change before sharing)

| Username | Password    | Role    |
|----------|-------------|---------|
| manager  | rithum2025  | Manager |
| rep1     | rithum2025  | Rep     |
| rep2     | rithum2025  | Rep     |
| rep3     | rithum2025  | Rep     |
| rep4     | rithum2025  | Rep     |
| rep5     | rithum2025  | Rep     |

**Change all passwords in `team.config.js` before sharing with your team.**

---

## What each role sees

**Reps** — their own accounts only. Full outreach engine: sequences, signals,
contact finder, RWOS checker, reply handler, subject A/B, ideas scratchpad, notes.

**Manager** — everything. All reps' accounts in a pipeline view, team signals
scanner, and a dashboard showing each rep's book of business.

---

## Data storage
Account data is saved in `data/accounts.json`. Back this file up regularly.
If you deploy to Railway or Render, attach a persistent volume to preserve data.

---

## Cost
Approximately £0.01–0.02 per sequence generation. A typical day of heavy use
across 6 reps costs under £1 total.
