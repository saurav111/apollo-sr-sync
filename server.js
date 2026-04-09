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

const APOLLO_BASE    = 'https://api.apollo.io';
const UNIPILE_DSN    = 'api4.unipile.com:13477';
const UNIPILE_KEY    = 'unBu0CqB.ukGhV7E79Du/7RjpicQaS919vaSkpK0qmEnNWp5ydPU=';

async function safeJson(r) {
  const text = await r.text();
  log('RAW_RESPONSE', { status: r.status, url: r.url, body: text.slice(0, 500) });
  if (!text) throw new Error(`Empty response (HTTP ${r.status})`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Non-JSON response (HTTP ${r.status}): ${text.slice(0, 200)}`); }
}

function unipileBase(dsn) {
  if (dsn.startsWith('http')) return dsn.replace(/\/$/, '');
  return `https://${dsn}`;
}

function extractLinkedInIdentifier(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1].replace(/\/$/, '') : null;
}

// Build multipart/form-data body without external deps
function buildFormData(fields) {
  const boundary = '----UnipileBoundary' + Math.random().toString(36).slice(2);
  const parts = Object.entries(fields).map(([key, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}`
  );
  const body = parts.join('\r\n') + `\r\n--${boundary}--`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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

// ── Unipile: list connected accounts ─────────────────────────────────────────
app.post('/api/unipile/accounts', async (req, res) => {
  // dsn and apiKey are hardcoded server-side
  const dsn = UNIPILE_DSN, apiKey = UNIPILE_KEY;
  try {
    const r = await fetch(`${unipileBase(dsn)}/api/v1/accounts`, {
      headers: { 'X-API-KEY': apiKey, 'accept': 'application/json' },
    });
    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    log('UNIPILE_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Unipile: generate hosted auth URL to connect LinkedIn ─────────────────────
app.post('/api/unipile/connect-url', async (req, res) => {
  // dsn and apiKey are hardcoded server-side
  const dsn = UNIPILE_DSN, apiKey = UNIPILE_KEY;
  const expiresOn = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  try {
    const r = await fetch(`${unipileBase(dsn)}/api/v1/hosted/accounts/link`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'create',
        providers: ['LINKEDIN'],
        api_url: unipileBase(dsn),
        expiresOn,
      }),
    });
    const data = await safeJson(r);
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    log('UNIPILE_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Unipile: send connection request ─────────────────────────────────────────
// Step 1: resolve LinkedIn URL → provider_id
// Step 2: POST /api/v1/users/invite
app.post('/api/unipile/send-invite', async (req, res) => {
  const { accountId, linkedinUrl, message } = req.body;
  const dsn = UNIPILE_DSN, apiKey = UNIPILE_KEY;
  if (!dsn || !apiKey || !accountId || !linkedinUrl) {
    return res.status(400).json({ error: 'Missing params' });
  }
  const identifier = extractLinkedInIdentifier(linkedinUrl);
  if (!identifier) return res.status(400).json({ error: 'Could not parse LinkedIn URL' });

  log('SEND_INVITE', { identifier, accountId, message: (message || '').slice(0, 100) });

  try {
    const base = unipileBase(dsn);

    // Resolve profile
    const profileR = await fetch(
      `${base}/api/v1/users/${encodeURIComponent(identifier)}?account_id=${accountId}`,
      { headers: { 'X-API-KEY': apiKey, 'accept': 'application/json' } }
    );
    const profile = await safeJson(profileR);
    if (!profileR.ok) return res.status(profileR.status).json({ error: profile.message || 'Profile lookup failed' });

    const providerId = profile.provider_id;
    if (!providerId) return res.status(400).json({ error: 'No provider_id returned for this profile' });
    log('PROFILE_RESOLVED', { identifier, providerId });

    // Send invite
    const inviteR = await fetch(`${base}/api/v1/users/invite`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: providerId, account_id: accountId, message: message || '' }),
    });
    const inviteData = await safeJson(inviteR);
    log('INVITE_RESPONSE', { status: inviteR.status, body: inviteData });
    if (!inviteR.ok) return res.status(inviteR.status).json(inviteData);
    res.json({ success: true, ...inviteData });
  } catch (e) {
    log('UNIPILE_ERROR', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── Unipile: send direct message ──────────────────────────────────────────────
// Step 1: resolve LinkedIn URL → provider_id
// Step 2: POST /api/v1/chats (new chat with that person)
app.post('/api/unipile/send-message', async (req, res) => {
  const { accountId, linkedinUrl, message } = req.body;
  const dsn = UNIPILE_DSN, apiKey = UNIPILE_KEY;
  if (!dsn || !apiKey || !accountId || !linkedinUrl) {
    return res.status(400).json({ error: 'Missing params' });
  }
  const identifier = extractLinkedInIdentifier(linkedinUrl);
  if (!identifier) return res.status(400).json({ error: 'Could not parse LinkedIn URL' });

  log('SEND_MESSAGE', { identifier, accountId, message: (message || '').slice(0, 100) });

  try {
    const base = unipileBase(dsn);

    // Resolve profile
    const profileR = await fetch(
      `${base}/api/v1/users/${encodeURIComponent(identifier)}?account_id=${accountId}`,
      { headers: { 'X-API-KEY': apiKey, 'accept': 'application/json' } }
    );
    const profile = await safeJson(profileR);
    if (!profileR.ok) return res.status(profileR.status).json({ error: profile.message || 'Profile lookup failed' });

    const providerId = profile.provider_id;
    if (!providerId) return res.status(400).json({ error: 'No provider_id returned for this profile' });
    log('PROFILE_RESOLVED', { identifier, providerId });

    // Send message via multipart/form-data
    const { body, contentType } = buildFormData({
      account_id: accountId,
      text: message || '',
      attendees_ids: providerId,
    });
    const msgR = await fetch(`${base}/api/v1/chats`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'accept': 'application/json', 'content-type': contentType },
      body,
    });
    const msgData = await safeJson(msgR);
    log('MESSAGE_RESPONSE', { status: msgR.status, body: msgData });
    if (!msgR.ok) return res.status(msgR.status).json(msgData);
    res.json({ success: true, ...msgData });
  } catch (e) {
    log('UNIPILE_ERROR', { error: e.message });
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
app.listen(PORT, () => console.log(`Apollo → Unipile sync running on http://localhost:${PORT}`));
