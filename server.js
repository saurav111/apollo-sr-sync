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

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    log('REQ', { method: req.method, path: req.path });
  }
  next();
});

const SR_BASE    = 'https://api.boomtechinc.com';
const SR_APP     = 'https://app.boomtechinc.com';
const SR_WEBHOOK = 'https://app.salesrobot.co/public/webhooks';
const APOLLO_BASE = 'https://api.apollo.io';

async function safeJson(r) {
  const text = await r.text();
  log('RAW_RESPONSE', { status: r.status, url: r.url, body: text.slice(0, 500) });
  if (!text) throw new Error(`Empty response (HTTP ${r.status})`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Non-JSON response (HTTP ${r.status}): ${text.slice(0, 200)}`); }
}

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
        task_types: ['linkedin_step_message', 'linkedin_step_connect', 'linkedin_step_other'],
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

// ── SalesRobot: list LinkedIn accounts ───────────────────────────────────────
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
    log('SR_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── SalesRobot: list all campaigns for an account ────────────────────────────
app.post('/api/salesrobot/campaigns', async (req, res) => {
  const { srKey, linkedinAccountUuid } = req.body;
  if (!srKey || !linkedinAccountUuid) return res.status(400).json({ error: 'Missing params' });
  try {
    let page = 1, allCampaigns = [], totalPages = 1;
    const pageSize = 50;
    do {
      const r = await fetch(
        `${SR_APP}/api/campaigns?linkedinAccountUuid=${linkedinAccountUuid}&page=${page}&size=${pageSize}`,
        { headers: { 'X-API-KEY': srKey, 'Content-Type': 'application/json' } }
      );
      const data = await safeJson(r);
      if (!r.ok) return res.status(r.status).json(data);
      const campaigns = data.data?.data || [];
      allCampaigns = allCampaigns.concat(campaigns);
      totalPages = Math.ceil((data.data?.totalElements || 0) / pageSize);
      page++;
    } while (page <= totalPages && page <= 10);
    log('CAMPAIGNS_FETCHED', { total: allCampaigns.length });
    res.json({ success: true, data: { data: allCampaigns } });
  } catch (e) {
    log('SR_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── SalesRobot: add prospect to campaign via webhook ─────────────────────────
// Webhook addProspect supports customColumns as a stringified JSON object.
// Campaign steps should use {{customMessage}} to reference the passed value.
app.post('/api/salesrobot/add-prospect', async (req, res) => {
  const { webhookUuid, campaignName, prospect } = req.body;
  if (!webhookUuid || !campaignName || !prospect) {
    return res.status(400).json({ error: 'Missing params' });
  }
  if (!prospect.profileUrl) {
    log('SKIP', { reason: 'no_linkedin_url', name: prospect.fullName });
    return res.status(400).json({ error: 'Prospect must have a LinkedIn profileUrl' });
  }

  const payload = {
    campaignName,
    profileUrl:  prospect.profileUrl  || '',
    firstName:   prospect.firstName   || '',
    lastName:    prospect.lastName    || '',
    emailId:     prospect.emailId     || '',
    jobTitle:    prospect.jobTitle    || '',
    companyName: prospect.companyName || '',
  };

  if (prospect.customMessage) {
    payload.customColumns = JSON.stringify({ customMessage: prospect.customMessage });
  }

  const webhookUrl = `${SR_WEBHOOK}/${webhookUuid}/campaign/addProspect`;
  log('ADD_PROSPECT', {
    webhookUrl,
    campaignName,
    profileUrl: prospect.profileUrl,
    customMessage: (prospect.customMessage || '').slice(0, 80),
  });

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await safeJson(r);
    log('SR_RESPONSE', { status: r.status, body: data });
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ success: true, ...data });
  } catch (e) {
    log('SR_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Logs viewer ──────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  try {
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '(no logs yet)';
    const lines = content.trim().split('\n').slice(-200);
    res.json({ lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Apollo → SalesRobot sync running on http://localhost:${PORT}`));
