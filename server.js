const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_FILE = path.join(__dirname, 'sync.log');

function log(tag, data) {
  const line = `[${new Date().toISOString()}] [${tag}] ${JSON.stringify(data)}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// Request logger middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    log('REQ', { method: req.method, path: req.path });
  }
  next();
});

const SR_BASE = 'https://api.boomtechinc.com';
const SR_APP  = 'https://app.boomtechinc.com';
const APOLLO_BASE = 'https://api.apollo.io';

// ── Safe JSON parser ─────────────────────────────────────────────────────────
async function safeJson(r) {
  const text = await r.text();
  log('RAW_RESPONSE', { status: r.status, url: r.url, body: text.slice(0, 500) });
  if (!text) throw new Error(`Empty response from SalesRobot (HTTP ${r.status})`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`SalesRobot returned non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`); }
}

// ── SalesRobot: list LinkedIn accounts ──────────────────────────────────────
app.post('/api/salesrobot/accounts', async (req, res) => {
  const { srKey } = req.body;
  if (!srKey) return res.status(400).json({ error: 'Missing srKey' });
  try {
    const r = await fetch(
      `${SR_BASE}/api/linkedinAccounts?page=1&size=50&searchTerm=&sort=id,desc`,
      { headers: { 'X-API-KEY': srKey, 'Content-Type': 'application/json' } }
    );
    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    log('ACCOUNTS_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── SalesRobot: list ALL campaigns (paginated) for a LinkedIn account ─────────
app.post('/api/salesrobot/campaigns', async (req, res) => {
  const { srKey, linkedinAccountUuid } = req.body;
  if (!srKey || !linkedinAccountUuid) return res.status(400).json({ error: 'Missing params' });
  try {
    let page = 1;
    const pageSize = 50;
    let allCampaigns = [];
    let totalPages = 1;

    do {
      const r = await fetch(
        `${SR_APP}/api/campaigns?linkedinAccountUuid=${linkedinAccountUuid}&page=${page}&size=${pageSize}`,
        { headers: { 'X-API-KEY': srKey, 'Content-Type': 'application/json' } }
      );
      const data = await safeJson(r);
      if (!r.ok) return res.status(r.status).json(data);

      const campaigns = data.data?.data || [];
      allCampaigns = allCampaigns.concat(campaigns);

      // Log all unique statuses on first page so we can see what values the API actually uses
      if (page === 1) {
        const statusSummary = campaigns.reduce((acc, c) => {
          acc[c.campaignStatus] = (acc[c.campaignStatus] || 0) + 1;
          return acc;
        }, {});
        log('CAMPAIGN_STATUSES', { page, totalElements: data.data?.totalElements, statusSummary });
      }

      const totalElements = data.data?.totalElements || 0;
      totalPages = Math.ceil(totalElements / pageSize);
      page++;
    } while (page <= totalPages && page <= 10); // cap at 500 campaigns

    log('CAMPAIGNS_FETCHED', { totalFetched: allCampaigns.length });
    res.json({ success: true, data: { data: allCampaigns } });
  } catch (e) {
    log('CAMPAIGNS_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Apollo: fetch open LinkedIn tasks ────────────────────────────────────────
app.post('/api/apollo/tasks', async (req, res) => {
  const { apolloKey } = req.body;
  if (!apolloKey) return res.status(400).json({ error: 'Missing apolloKey' });
  try {
    const r = await fetch(`${APOLLO_BASE}/api/v1/tasks/search`, {
      method: 'POST',
      headers: {
        'x-api-key': apolloKey,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        task_types: [
          'linkedin_step_message',
          'linkedin_step_connect',
          'linkedin_step_other',
        ],
        open_factor_names: ['task_types'],
        per_page: 100,
        page: 1,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SalesRobot: add a single prospect to a campaign (via add-from-csv) ───────
// Uses the prospectData array format which supports arbitrary custom columns.
app.post('/api/salesrobot/add-prospect', async (req, res) => {
  const { srKey, linkedinAccountUuid, campaignUuid, prospect } = req.body;
  if (!srKey || !linkedinAccountUuid || !campaignUuid || !prospect) {
    return res.status(400).json({ error: 'Missing params' });
  }
  if (!prospect.profileUrl) {
    log('SKIP', { reason: 'no_linkedin_url', name: prospect.fullName, email: prospect.emailId });
    return res.status(400).json({ error: 'Prospect must have a LinkedIn profileUrl' });
  }

  const fields = [
    { name: 'profileUrl',   value: prospect.profileUrl   || '' },
    { name: 'firstName',    value: prospect.firstName    || '' },
    { name: 'lastName',     value: prospect.lastName     || '' },
    { name: 'fullName',     value: prospect.fullName     || '' },
    { name: 'emailId',      value: prospect.emailId      || '' },
    { name: 'jobTitle',     value: prospect.jobTitle     || '' },
    { name: 'companyName',  value: prospect.companyName  || '' },
  ];
  if (prospect.customMessage) {
    fields.push({ name: 'customMessage', value: prospect.customMessage });
  }

  const payload = {
    prospectData: fields.map(f => ({ name: f.name, values: [f.value] })),
    dontAddIfInAnotherLinkedinAccountForMyUser: true,
  };

  log('ADD_PROSPECT', { campaignUuid, linkedinAccountUuid, prospect: payload });

  try {
    const r = await fetch(
      `${SR_BASE}/api/add-from-csv?linkedinAccountUuid=${linkedinAccountUuid}&campaignUuid=${campaignUuid}`,
      {
        method: 'POST',
        headers: { 'X-API-KEY': srKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await safeJson(r);
    log('SR_RESPONSE', { status: r.status, body: data });
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    log('SR_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Logs viewer ──────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  try {
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '(no logs yet)';
    // Return last 200 lines
    const lines = content.trim().split('\n').slice(-200);
    res.json({ lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Apollo → SalesRobot sync running on http://localhost:${PORT}`));
