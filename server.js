const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_FILE      = path.join(__dirname, 'sync.log');
const HISTORY_FILE  = path.join(__dirname, 'history.json');
const PROFILES_FILE = path.join(__dirname, 'profiles.json');

function log(tag, data) {
  const line = `[${new Date().toISOString()}] [${tag}] ${JSON.stringify(data)}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

// ── Apollo: get current user ID ──────────────────────────────────────────────
async function getApolloUserId(apolloKey) {
  const r = await fetch(`${APOLLO_BASE}/api/v1/users/me`, {
    headers: { 'x-api-key': apolloKey, 'Content-Type': 'application/json' },
  });
  const data = await safeJson(r);
  if (!r.ok) throw new Error(data.message || data.error || `Apollo /me failed (HTTP ${r.status})`);
  const userId = data.user?.id || data.id;
  if (!userId) throw new Error('Could not determine Apollo user ID from /me response');
  log('APOLLO_ME', { userId, name: data.user?.name || data.name });
  return userId;
}

// ── Apollo: fetch open LinkedIn tasks (all pages, current user only) ─────────
app.post('/api/apollo/tasks', async (req, res) => {
  const { apolloKey } = req.body;
  if (!apolloKey) return res.status(400).json({ error: 'Missing apolloKey' });
  try {
    // Identify the current user so we only fetch their tasks
    const userId = await getApolloUserId(apolloKey);

    const PER_PAGE = 100;
    const MAX_PAGES = 20;
    let page = 1, allTasks = [], totalPages = 1;

    do {
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
          user_ids: [userId],
          per_page: PER_PAGE,
          page,
        }),
      });
      const data = await safeJson(r);
      if (!r.ok) return res.status(r.status).json(data);

      const tasks = data.tasks || [];
      allTasks = allTasks.concat(tasks);
      totalPages = data.pagination?.total_pages || 1;
      log('APOLLO_TASKS_PAGE', { page, fetched: tasks.length, totalPages });
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    log('APOLLO_TASKS_TOTAL', { total: allTasks.length });
    res.json({ tasks: allTasks, pagination: { total: allTasks.length } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Apollo: mark a task complete (soft-fail) ─────────────────────────────────
app.patch('/api/apollo/tasks/:id/complete', async (req, res) => {
  const { apolloKey } = req.body;
  const { id } = req.params;
  if (!apolloKey || !id) return res.status(400).json({ success: false, error: 'Missing params' });
  try {
    const r = await fetch(`${APOLLO_BASE}/api/v1/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'x-api-key': apolloKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    const text = await r.text();
    log('APOLLO_TASK_COMPLETE', { id, status: r.status, body: text.slice(0, 200) });
    if (r.ok) return res.json({ success: true });
    // Try alternate field if first attempt returned 422
    if (r.status === 422) {
      const r2 = await fetch(`${APOLLO_BASE}/api/v1/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'x-api-key': apolloKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ complete: true }),
      });
      const text2 = await r2.text();
      log('APOLLO_TASK_COMPLETE_RETRY', { id, status: r2.status, body: text2.slice(0, 200) });
      return res.json({ success: r2.ok, error: r2.ok ? undefined : text2.slice(0, 100) });
    }
    res.json({ success: false, error: text.slice(0, 100) });
  } catch (e) {
    log('APOLLO_TASK_COMPLETE_ERROR', { id, error: e.message });
    res.json({ success: false, error: e.message }); // always 200, soft-fail
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
    const text = await r.text();
    log('SR_RESPONSE', { status: r.status, url: r.url, body: text.slice(0, 200) });

    if (!r.ok) {
      let errData;
      try { errData = JSON.parse(text); } catch { errData = { error: text || `HTTP ${r.status}` }; }
      return res.status(r.status).json(errData);
    }

    let data = {};
    try { data = JSON.parse(text); } catch { /* plain "Ok" is fine */ }
    res.json({ success: true, message: text, ...data });
  } catch (e) {
    log('SR_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Profiles ─────────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  const profiles = readJson(PROFILES_FILE, []);
  // Mask keys — only return last 4 chars for display
  const masked = profiles.map(p => ({
    id: p.id,
    name: p.name,
    apolloKeyHint:  p.apolloKey  ? '…' + p.apolloKey.slice(-4)  : '',
    srKeyHint:      p.srKey      ? '…' + p.srKey.slice(-4)       : '',
    webhookUuidHint: p.webhookUuid ? '…' + p.webhookUuid.slice(-4) : '',
  }));
  res.json({ profiles: masked });
});

app.post('/api/profiles', (req, res) => {
  const { name, apolloKey, srKey, webhookUuid } = req.body;
  if (!name || !apolloKey || !srKey || !webhookUuid) {
    return res.status(400).json({ error: 'name, apolloKey, srKey, webhookUuid are all required' });
  }
  const profiles = readJson(PROFILES_FILE, []);
  const id = 'p' + Date.now();
  profiles.push({ id, name: name.trim(), apolloKey, srKey, webhookUuid });
  writeJson(PROFILES_FILE, profiles);
  log('PROFILE_SAVED', { id, name: name.trim() });
  res.json({ success: true, id, name: name.trim() });
});

app.get('/api/profiles/:id/keys', (req, res) => {
  const profiles = readJson(PROFILES_FILE, []);
  const p = profiles.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json({ apolloKey: p.apolloKey, srKey: p.srKey, webhookUuid: p.webhookUuid });
});

app.delete('/api/profiles/:id', (req, res) => {
  let profiles = readJson(PROFILES_FILE, []);
  const before = profiles.length;
  profiles = profiles.filter(p => p.id !== req.params.id);
  if (profiles.length === before) return res.status(404).json({ error: 'Profile not found' });
  writeJson(PROFILES_FILE, profiles);
  log('PROFILE_DELETED', { id: req.params.id });
  res.json({ success: true });
});

// ── Sync History ──────────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const runs = readJson(HISTORY_FILE, []);
  res.json({ runs: runs.slice().reverse().slice(0, 100) });
});

app.post('/api/history', (req, res) => {
  const { profileName, linkedinAccountName, connectCampaign, messageCampaign, results } = req.body;
  if (!results) return res.status(400).json({ error: 'Missing results' });
  const runs = readJson(HISTORY_FILE, []);
  const succeeded = results.filter(r => r.success).length;
  const run = {
    id: 'h' + Date.now(),
    timestamp: new Date().toISOString(),
    profileName: profileName || 'Unknown',
    linkedinAccountName: linkedinAccountName || '',
    connectCampaign: connectCampaign || '',
    messageCampaign: messageCampaign || '',
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    details: results,
  };
  runs.push(run);
  writeJson(HISTORY_FILE, runs);
  log('HISTORY_SAVED', { id: run.id, total: run.total, succeeded, failed: run.failed });
  res.json({ success: true, id: run.id });
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
