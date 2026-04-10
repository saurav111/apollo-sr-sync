const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_FILE         = path.join(__dirname, 'sync.log');
const HISTORY_FILE     = path.join(__dirname, 'history.json');
const PROFILES_FILE    = path.join(__dirname, 'profiles.json');
const SYNCED_FILE      = path.join(__dirname, 'synced_tasks.json');

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

const LINKEDIN_TASK_TYPES = new Set(['linkedin_step_message', 'linkedin_step_connect', 'linkedin_step_other']);

// ── Apollo: detect org users from tasks (for user picker) ────────────────────
// Fetches one page of tasks (all types), collects unique user_ids, resolves
// each to a name/email via GET /api/v1/users/:id, returns a list to pick from.
app.post('/api/apollo/detect-users', async (req, res) => {
  const { apolloKey } = req.body;
  if (!apolloKey) return res.status(400).json({ error: 'Missing apolloKey' });
  try {
    // Fetch one page of tasks (no type filter — maximise chance of hitting all users)
    const r = await fetch(`${APOLLO_BASE}/api/v1/tasks/search`, {
      method: 'POST',
      headers: { 'x-api-key': apolloKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ per_page: 100, page: 1 }),
    });
    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json(data);

    // Collect unique user_ids from tasks
    const userIds = [...new Set((data.tasks || []).map(t => t.user_id).filter(Boolean))];
    log('APOLLO_DETECT_USERS', { uniqueUserIds: userIds.length });

    if (!userIds.length) return res.json({ users: [] });

    // Resolve each user_id to name + email
    const users = await Promise.all(userIds.map(async (id) => {
      try {
        const ur = await fetch(`${APOLLO_BASE}/api/v1/users/${id}`, {
          headers: { 'x-api-key': apolloKey, 'Content-Type': 'application/json' },
        });
        const udata = await ur.json();
        const u = udata.user || udata;
        return { id, name: u.name || u.first_name || id, email: u.email || '' };
      } catch {
        return { id, name: id, email: '' };
      }
    }));

    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Apollo: fetch open LinkedIn tasks (all pages, specific user) ──────────────
app.post('/api/apollo/tasks', async (req, res) => {
  const { apolloKey, apolloUserId } = req.body;
  if (!apolloKey) return res.status(400).json({ error: 'Missing apolloKey' });
  if (!apolloUserId) return res.status(400).json({ error: 'Missing apolloUserId — select your user in profile setup' });
  try {
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
          task_types: [...LINKEDIN_TASK_TYPES],
          open_factor_names: ['task_types', 'user_ids'],
          user_ids: [apolloUserId],
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

    // Post-filter: safety net for type and ownership
    const filtered = allTasks.filter(t => LINKEDIN_TASK_TYPES.has(t.type) && t.user_id === apolloUserId);
    log('APOLLO_TASKS_TOTAL', { raw: allTasks.length, afterFilter: filtered.length, apolloUserId });
    res.json({ tasks: filtered, pagination: { total: filtered.length } });
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

// ── Profiles (password-protected) ────────────────────────────────────────────
// GET /api/profiles — returns id + name only (no keys, no hints)
app.get('/api/profiles', (req, res) => {
  const profiles = readJson(PROFILES_FILE, []);
  res.json({ profiles: profiles.map(p => ({ id: p.id, name: p.name })) });
});

// POST /api/profiles — create profile with bcrypt-hashed password
app.post('/api/profiles', async (req, res) => {
  const { name, apolloKey, srKey, webhookUuid, password, apolloUserId, apolloUserName } = req.body;
  if (!name || !apolloKey || !srKey || !webhookUuid || !password) {
    return res.status(400).json({ error: 'name, apolloKey, srKey, webhookUuid, and password are all required' });
  }
  const profiles = readJson(PROFILES_FILE, []);
  const id = 'p' + Date.now();
  const passwordHash = bcrypt.hashSync(password, 10);
  profiles.push({ id, name: name.trim(), apolloKey, srKey, webhookUuid, passwordHash, apolloUserId: apolloUserId || null, apolloUserName: apolloUserName || null });
  writeJson(PROFILES_FILE, profiles);
  log('PROFILE_SAVED', { id, name: name.trim(), apolloUserId });
  res.json({ success: true, id, name: name.trim() });
});

// POST /api/profiles/:id/unlock — verify password and return keys
app.post('/api/profiles/:id/unlock', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const profiles = readJson(PROFILES_FILE, []);
  const p = profiles.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (!bcrypt.compareSync(password, p.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  log('PROFILE_UNLOCKED', { id: p.id, name: p.name });
  res.json({ apolloKey: p.apolloKey, srKey: p.srKey, webhookUuid: p.webhookUuid, apolloUserId: p.apolloUserId || null, apolloUserName: p.apolloUserName || null });
});

// DELETE /api/profiles/:id — requires password to confirm
app.delete('/api/profiles/:id', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required to delete' });
  let profiles = readJson(PROFILES_FILE, []);
  const p = profiles.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  if (!bcrypt.compareSync(password, p.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  profiles = profiles.filter(x => x.id !== req.params.id);
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

// ── Auto-sync ─────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let autoSyncStatus = {}; // { [profileId]: { lastRun, lastCount, running } }

// Configure auto-sync for a profile (enable/disable + store campaign settings)
app.post('/api/profiles/:id/autosync', (req, res) => {
  const { enable, connectCampaignName, messageCampaignName, linkedinAccountUuid, linkedinAccountName } = req.body;
  let profiles = readJson(PROFILES_FILE, []);
  const idx = profiles.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Profile not found' });

  if (enable) {
    if (!connectCampaignName || !messageCampaignName || !linkedinAccountUuid) {
      return res.status(400).json({ error: 'connectCampaignName, messageCampaignName, linkedinAccountUuid required to enable' });
    }
    profiles[idx] = { ...profiles[idx], autoSync: true, connectCampaignName, messageCampaignName, linkedinAccountUuid, linkedinAccountName: linkedinAccountName || '' };
    log('AUTOSYNC_ENABLED', { id: req.params.id, connectCampaignName, messageCampaignName });
  } else {
    profiles[idx] = { ...profiles[idx], autoSync: false };
    log('AUTOSYNC_DISABLED', { id: req.params.id });
  }

  writeJson(PROFILES_FILE, profiles);
  res.json({ success: true, autoSync: profiles[idx].autoSync });
});

// Status of auto-sync runs
app.get('/api/autosync/status', (req, res) => {
  const profiles = readJson(PROFILES_FILE, []);
  const status = profiles
    .filter(p => p.autoSync)
    .map(p => ({
      id: p.id,
      name: p.name,
      connectCampaignName: p.connectCampaignName,
      messageCampaignName: p.messageCampaignName,
      ...( autoSyncStatus[p.id] || { lastRun: null, lastCount: 0, running: false }),
    }));
  res.json({ status });
});

// Core auto-sync logic for one profile
async function runAutoSyncForProfile(profile) {
  if (autoSyncStatus[profile.id]?.running) return; // already running
  autoSyncStatus[profile.id] = { ...autoSyncStatus[profile.id], running: true };
  log('AUTOSYNC_START', { profileId: profile.id, name: profile.name });

  try {
    const userId = profile.apolloUserId;
    if (!userId) {
      log('AUTOSYNC_SKIP', { profileId: profile.id, reason: 'no apolloUserId set — open profile and select your user' });
      autoSyncStatus[profile.id] = { lastRun: new Date().toISOString(), lastCount: 0, running: false, error: 'Apollo user not selected — unlock profile to set' };
      return;
    }
    const PER_PAGE = 100, MAX_PAGES = 20;
    let page = 1, allTasks = [], totalPages = 1;
    do {
      const r = await fetch(`${APOLLO_BASE}/api/v1/tasks/search`, {
        method: 'POST',
        headers: { 'x-api-key': profile.apolloKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({
          task_types: [...LINKEDIN_TASK_TYPES],
          open_factor_names: ['task_types', 'user_ids'],
          user_ids: [userId],
          per_page: PER_PAGE,
          page,
        }),
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.message || data.error || `Apollo tasks failed (HTTP ${r.status})`);
      allTasks = allTasks.concat(data.tasks || []);
      totalPages = data.pagination?.total_pages || 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    // Post-filter: only LinkedIn types owned by this user
    allTasks = allTasks.filter(t => LINKEDIN_TASK_TYPES.has(t.type) && t.user_id === userId);

    // Filter out already-synced task IDs
    const synced = new Set(readJson(SYNCED_FILE, []));
    const newTasks = allTasks.filter(t => t.contact?.linkedin_url && !synced.has(t.id));
    log('AUTOSYNC_NEW_TASKS', { profileId: profile.id, total: allTasks.length, newCount: newTasks.length });

    if (!newTasks.length) {
      autoSyncStatus[profile.id] = { lastRun: new Date().toISOString(), lastCount: 0, running: false };
      return;
    }

    // 4. Push each new task to SalesRobot
    const results = [];
    for (const task of newTasks) {
      const contact       = task.contact || {};
      const name          = contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.linkedin_url;
      const taskType      = task.type || '';
      const customMessage = task.standalone_outreach_task_message?.body_text || '';
      const campaignName  = taskType.includes('connect') ? profile.connectCampaignName : profile.messageCampaignName;

      const payload = {
        campaignName,
        profileUrl:  contact.linkedin_url,
        firstName:   contact.first_name   || '',
        lastName:    contact.last_name    || '',
        emailId:     contact.email        || '',
        jobTitle:    contact.title        || '',
        companyName: contact.organization_name || '',
      };
      if (customMessage) payload.customColumns = JSON.stringify({ customMessage });

      const webhookUrl = `${SR_WEBHOOK}/${profile.webhookUuid}/campaign/addProspect`;
      try {
        const r = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const text = await r.text();
        const success = r.ok;
        results.push({ taskId: task.id, name, taskType, success, error: success ? undefined : text.slice(0, 100) });
        if (success) {
          synced.add(task.id);
          // Mark complete in Apollo (soft-fail)
          fetch(`${APOLLO_BASE}/api/v1/tasks/${task.id}`, {
            method: 'PATCH',
            headers: { 'x-api-key': profile.apolloKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed' }),
          }).catch(() => {});
        }
      } catch (e) {
        results.push({ taskId: task.id, name, taskType, success: false, error: e.message });
      }
    }

    // 5. Persist synced IDs
    writeJson(SYNCED_FILE, [...synced]);

    // 6. Write history entry
    const succeeded = results.filter(r => r.success).length;
    const runs = readJson(HISTORY_FILE, []);
    runs.push({
      id: 'h' + Date.now(),
      timestamp: new Date().toISOString(),
      profileName: profile.name,
      linkedinAccountName: profile.linkedinAccountName || '',
      connectCampaign: profile.connectCampaignName,
      messageCampaign: profile.messageCampaignName,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      details: results,
      auto: true,
    });
    writeJson(HISTORY_FILE, runs);

    autoSyncStatus[profile.id] = { lastRun: new Date().toISOString(), lastCount: results.length, running: false };
    log('AUTOSYNC_DONE', { profileId: profile.id, name: profile.name, synced: succeeded, failed: results.length - succeeded });
  } catch (e) {
    log('AUTOSYNC_ERROR', { profileId: profile.id, error: e.message });
    autoSyncStatus[profile.id] = { lastRun: new Date().toISOString(), lastCount: 0, running: false, error: e.message };
  }
}

// Poll loop
async function runAutoSync() {
  const profiles = readJson(PROFILES_FILE, []);
  const active = profiles.filter(p => p.autoSync);
  if (active.length) log('AUTOSYNC_POLL', { activeProfiles: active.length });
  for (const profile of active) {
    await runAutoSyncForProfile(profile);
  }
}

setInterval(runAutoSync, POLL_INTERVAL_MS);
// Also run once 60s after startup (give server time to fully start)
setTimeout(runAutoSync, 60_000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Apollo → SalesRobot sync running on http://localhost:${PORT}`));
