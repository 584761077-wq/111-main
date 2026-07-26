'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('web-push');

const PORT = Number(process.env.MCP_PORT || process.env.PORT || 8787);
const API_TOKEN = process.env.MCP_API_TOKEN || '';
const DATA_DIR = process.env.MCP_DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'server-config.json');
const BACKGROUND_FILE = path.join(DATA_DIR, 'background-state.json');
const startedAt = Date.now();
const CREDENTIAL_SECRET = process.env.MCP_CREDENTIAL_SECRET || API_TOKEN;
const VAPID_SUBJECT = process.env.MCP_VAPID_SUBJECT || 'mailto:admin@localhost';

fs.mkdirSync(DATA_DIR, { recursive: true });

const database = new DatabaseSync(path.join(DATA_DIR, 'mcp.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS background_snapshots (
    chat_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    context_limit INTEGER NOT NULL,
    payload TEXT NOT NULL,
    last_run_at INTEGER,
    consecutive_runs INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS background_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    FOREIGN KEY(chat_id) REFERENCES background_snapshots(chat_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS delivery_events (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    FOREIGN KEY(message_id) REFERENCES background_messages(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS secure_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, created_at TEXT NOT NULL, last_success_at TEXT);
`);

function encryptSecret(value) {
  if (!CREDENTIAL_SECRET) throw new Error('服务器未配置 MCP_CREDENTIAL_SECRET');
  const key = crypto.scryptSync(CREDENTIAL_SECRET, 'ephone-mcp-credentials-v1', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}

function decryptSecret(payload) {
  const parsed = JSON.parse(payload);
  const key = crypto.scryptSync(CREDENTIAL_SECRET, 'ephone-mcp-credentials-v1', 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8'));
}

function getOrCreateVapidKeys() {
  const row = database.prepare("SELECT value FROM secure_settings WHERE key = 'vapid_keys'").get();
  if (row) return decryptSecret(row.value);
  const keys = webpush.generateVAPIDKeys();
  database.prepare('INSERT INTO secure_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('vapid_keys', encryptSecret(keys), new Date().toISOString());
  return keys;
}

const vapidKeys = getOrCreateVapidKeys();
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

function migrateBackgroundJson() {
  if (!fs.existsSync(BACKGROUND_FILE)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(BACKGROUND_FILE, 'utf8'));
    const insertSnapshot = database.prepare(`
      INSERT OR IGNORE INTO background_snapshots
      (chat_id, name, enabled, context_limit, payload, last_run_at, consecutive_runs, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = database.prepare(`
      INSERT OR IGNORE INTO background_messages (id, chat_id, role, type, content, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvent = database.prepare(`
      INSERT OR IGNORE INTO delivery_events (id, message_id, chat_id, created_at, acknowledged_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    database.exec('BEGIN');
    for (const snapshot of Object.values(legacy.snapshots || {})) {
      insertSnapshot.run(snapshot.chatId, snapshot.name || '未命名角色', snapshot.enabled === false ? 0 : 1,
        snapshot.contextLimit || 10, JSON.stringify(snapshot), snapshot.lastRunAt || null,
        snapshot.consecutiveRuns || 0, snapshot.syncedAt || new Date().toISOString());
    }
    for (const event of legacy.events || []) {
      if (!event.message || !legacy.snapshots?.[event.chatId]) continue;
      insertMessage.run(event.message.id, event.chatId, event.message.role || 'assistant', event.message.type || 'text',
        String(event.message.content || ''), event.message.timestamp || Date.now(), event.message.source || 'mcp-background');
      insertEvent.run(event.id, event.message.id, event.chatId, event.createdAt || new Date().toISOString(), event.acknowledgedAt || null);
    }
    database.exec('COMMIT');
    fs.renameSync(BACKGROUND_FILE, `${BACKGROUND_FILE}.migrated`);
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    console.error('迁移旧后台数据失败', error);
  }
}

migrateBackgroundJson();

async function sendPush(payload) {
  const rows = database.prepare('SELECT endpoint, subscription FROM push_subscriptions').all();
  for (const row of rows) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify(payload), { TTL: 3600 });
      database.prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?').run(new Date().toISOString(), row.endpoint);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
      } else {
        console.error('Web Push 发送失败', error.message);
      }
    }
  }
}

async function generateBackgroundMessage(row) {
  const credentialRow = database.prepare("SELECT value FROM secure_settings WHERE key = 'background_api'").get();
  if (!credentialRow) return;
  const credential = decryptSecret(credentialRow.value);
  const snapshot = JSON.parse(row.payload);
  const systemPrompt = `你正在扮演角色“${row.name}”。\n角色人设：${snapshot.persona || '未设置'}\n用户人设：${snapshot.userPersona || '未设置'}\n请结合对话上下文，生成一条自然的主动消息。不要提及后台、定时器、服务器或系统。只输出消息正文。`;
  const history = (snapshot.history || []).map(item => ({ role: ['user', 'assistant', 'system'].includes(item.role) ? item.role : 'user', content: String(item.content || '') }));
  const baseUrl = credential.baseUrl.replace(/\/v1\/?$/, '');
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.apiKey}` },
    body: JSON.stringify({ model: credential.model, messages: [{ role: 'system', content: systemPrompt }, ...history], temperature: credential.temperature || 0.9, max_tokens: 500 }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `AI API 请求失败（${response.status}）`);
  const content = String(data.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('AI API 未返回消息内容');
  const now = Date.now();
  const message = { id: crypto.randomUUID(), role: 'assistant', type: 'text', content, timestamp: now, source: 'mcp-background' };
  const eventId = crypto.randomUUID();
  snapshot.history = [...(snapshot.history || []), message].slice(-row.context_limit);
  database.exec('BEGIN');
  try {
    database.prepare('INSERT INTO background_messages (id, chat_id, role, type, content, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, row.chat_id, message.role, message.type, message.content, now, message.source);
    database.prepare('INSERT INTO delivery_events (id, message_id, chat_id, created_at) VALUES (?, ?, ?, ?)')
      .run(eventId, message.id, row.chat_id, new Date(now).toISOString());
    database.prepare('UPDATE background_snapshots SET payload=?, last_run_at=?, consecutive_runs=consecutive_runs+1 WHERE chat_id=?')
      .run(JSON.stringify(snapshot), now, row.chat_id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  await sendPush({ title: row.name || 'EPhone', body: content, tag: `mcp-${row.chat_id}`, data: { chatId: row.chat_id, eventId } });
}

let schedulerRunning = false;
async function runScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    const rows = database.prepare('SELECT * FROM background_snapshots WHERE enabled = 1').all();
    for (const row of rows) {
      const snapshot = JSON.parse(row.payload);
      const cooldown = Math.max(1, Number(snapshot.actionCooldownMinutes) || 15) * 60000;
      if (row.last_run_at && now - row.last_run_at < cooldown) continue;
      if (Math.random() >= 0.20) continue;
      try { await generateBackgroundMessage(row); } catch (error) { console.error(`角色 ${row.name} 后台生成失败`, error.message); }
    }
  } finally {
    schedulerRunning = false;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided.length !== API_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_TOKEN));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function sanitizeConfig(value) {
  return {
    name: String(value.name || '').trim().slice(0, 80),
    backendUrl: String(value.backendUrl || '').trim().slice(0, 500),
    host: String(value.host || '').trim().slice(0, 255),
    port: Math.min(65535, Math.max(1, Number(value.port) || 22)),
    username: String(value.username || '').trim().slice(0, 80),
    allowProxy: value.allowProxy === true,
    syncData: value.syncData === true,
    enableJobs: value.enableJobs === true,
    updatedAt: new Date().toISOString()
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'ephone-mcp',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
    });
  }

  if (!isAuthorized(req)) return json(res, 401, { ok: false, error: 'API Token 无效' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const config = getConfig();
      return json(res, 200, {
        ok: true,
        configured: Boolean(config),
        state: config ? 'configured' : 'waiting_for_config',
        configUpdatedAt: config?.updatedAt || null
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/server-config') {
      return json(res, 200, { ok: true, config: getConfig() });
    }

    if (req.method === 'POST' && url.pathname === '/api/server-config') {
      const config = sanitizeConfig(await readBody(req));
      if (!config.host) return json(res, 400, { ok: false, error: '请填写 VPS IP 或域名' });
      if (!config.username) return json(res, 400, { ok: false, error: '请填写 SSH 用户名' });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
      return json(res, 200, { ok: true, config });
    }

    if (req.method === 'POST' && url.pathname === '/api/deploy/preflight') {
      const input = sanitizeConfig(await readBody(req));
      const checks = [
        { id: 'host', ok: Boolean(input.host), message: input.host ? '服务器地址已填写' : '缺少服务器地址' },
        { id: 'port', ok: input.port >= 1 && input.port <= 65535, message: `SSH 端口：${input.port}` },
        { id: 'username', ok: Boolean(input.username), message: input.username ? 'SSH 用户名已填写' : '缺少 SSH 用户名' }
      ];
      return json(res, checks.every(item => item.ok) ? 200 : 400, {
        ok: checks.every(item => item.ok),
        ready: checks.every(item => item.ok),
        checks,
        note: '当前为部署预检，不会发起 SSH 连接。'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/background/credentials') {
      const body = await readBody(req);
      const credential = {
        baseUrl: String(body.baseUrl || '').trim().replace(/\/$/, ''),
        apiKey: String(body.apiKey || ''),
        model: String(body.model || '').trim(),
        temperature: Number(body.temperature) || 0.9
      };
      if (!credential.baseUrl || !credential.apiKey || !credential.model) {
        return json(res, 400, { ok: false, error: '后台 API 地址、Key 和模型不能为空' });
      }
      database.prepare(`INSERT INTO secure_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .run('background_api', encryptSecret(credential), new Date().toISOString());
      return json(res, 200, { ok: true, hasCredential: true, model: credential.model, baseUrl: credential.baseUrl });
    }

    if (req.method === 'GET' && url.pathname === '/api/background/credentials/status') {
      const row = database.prepare("SELECT value, updated_at FROM secure_settings WHERE key = 'background_api'").get();
      if (!row) return json(res, 200, { ok: true, hasCredential: false });
      const credential = decryptSecret(row.value);
      return json(res, 200, { ok: true, hasCredential: true, baseUrl: credential.baseUrl, model: credential.model, updatedAt: row.updated_at });
    }

    if (req.method === 'GET' && url.pathname === '/api/push/vapid-public-key') {
      return json(res, 200, { ok: true, publicKey: vapidKeys.publicKey });
    }

    if (req.method === 'POST' && url.pathname === '/api/push/subscriptions') {
      const subscription = await readBody(req);
      if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return json(res, 400, { ok: false, error: 'Push Subscription 无效' });
      }
      database.prepare(`INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription`)
        .run(subscription.endpoint, JSON.stringify(subscription), new Date().toISOString());
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/background/snapshots') {
      const body = await readBody(req);
      const incoming = Array.isArray(body.snapshots) ? body.snapshots : [];
      const selectExisting = database.prepare('SELECT last_run_at, consecutive_runs FROM background_snapshots WHERE chat_id = ?');
      const upsert = database.prepare(`
        INSERT INTO background_snapshots (chat_id, name, enabled, context_limit, payload, last_run_at, consecutive_runs, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled,
          context_limit=excluded.context_limit, payload=excluded.payload, synced_at=excluded.synced_at
      `);
      const syncedAt = new Date().toISOString();
      database.exec('BEGIN');
      try {
        for (const item of incoming) {
          const chatId = String(item.chatId || '');
          if (!chatId) continue;
          const contextLimit = Math.min(1000, Math.max(1, Number(item.contextLimit) || 10));
          const snapshot = { ...item, chatId, contextLimit, history: Array.isArray(item.history) ? item.history.slice(-contextLimit) : [], syncedAt };
          const existing = selectExisting.get(chatId);
          upsert.run(chatId, snapshot.name || '未命名角色', snapshot.enabled === false ? 0 : 1, contextLimit,
            JSON.stringify(snapshot), existing?.last_run_at || item.lastActionTimestamp || null, existing?.consecutive_runs || 0, syncedAt);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return json(res, 200, { ok: true, saved: incoming.length, updatedAt: syncedAt });
    }

    if (req.method === 'GET' && url.pathname === '/api/background/status') {
      const snapshots = database.prepare('SELECT * FROM background_snapshots ORDER BY synced_at DESC').all().map(row => {
        const payload = JSON.parse(row.payload);
        return { chatId: row.chat_id, name: row.name, enabled: Boolean(row.enabled), contextLimit: row.context_limit,
          contextCount: payload.history?.length || 0, lastRunAt: row.last_run_at, consecutiveRuns: row.consecutive_runs, syncedAt: row.synced_at };
      });
      const pendingEvents = database.prepare('SELECT COUNT(*) AS count FROM delivery_events WHERE acknowledged_at IS NULL').get().count;
      return json(res, 200, { ok: true, snapshots, pendingEvents });
    }

    if (req.method === 'GET' && url.pathname === '/api/background/events') {
      const rows = database.prepare(`SELECT e.id event_id, e.chat_id, e.created_at event_created_at, e.acknowledged_at,
        m.id message_id, m.role, m.type, m.content, m.created_at, m.source FROM delivery_events e
        JOIN background_messages m ON m.id = e.message_id WHERE e.acknowledged_at IS NULL ORDER BY m.created_at`).all();
      const events = rows.map(row => ({ id: row.event_id, type: 'single_chat_message', chatId: row.chat_id,
        message: { id: row.message_id, role: row.role, type: row.type, content: row.content, timestamp: row.created_at, source: row.source },
        createdAt: row.event_created_at, acknowledgedAt: row.acknowledged_at }));
      return json(res, 200, { ok: true, events });
    }

    const ackMatch = url.pathname.match(/^\/api\/background\/events\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      const result = database.prepare('UPDATE delivery_events SET acknowledged_at = ? WHERE id = ?').run(new Date().toISOString(), decodeURIComponent(ackMatch[1]));
      if (!result.changes) return json(res, 404, { ok: false, error: '事件不存在' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/background/test-trigger') {
      const body = await readBody(req);
      const row = database.prepare('SELECT * FROM background_snapshots WHERE chat_id = ?').get(String(body.chatId || ''));
      if (!row) return json(res, 404, { ok: false, error: '角色后台副本不存在，请先同步' });
      const snapshot = JSON.parse(row.payload);
      const now = Date.now();
      const content = String(body.content || `这是 ${row.name || '角色'} 的第 ${Number(row.consecutive_runs) + 1} 次后台测试消息。`);
      const message = { id: crypto.randomUUID(), role: 'assistant', type: 'text', content, timestamp: now, source: 'mcp-background' };
      const event = { id: crypto.randomUUID(), type: 'single_chat_message', chatId: row.chat_id, message, createdAt: new Date(now).toISOString(), acknowledgedAt: null };
      snapshot.history = [...(snapshot.history || []), message].slice(-row.context_limit);
      database.exec('BEGIN');
      try {
        database.prepare('INSERT INTO background_messages (id, chat_id, role, type, content, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(message.id, row.chat_id, message.role, message.type, message.content, message.timestamp, message.source);
        database.prepare('INSERT INTO delivery_events (id, message_id, chat_id, created_at) VALUES (?, ?, ?, ?)')
          .run(event.id, message.id, row.chat_id, event.createdAt);
        database.prepare('UPDATE background_snapshots SET payload = ?, last_run_at = ?, consecutive_runs = consecutive_runs + 1 WHERE chat_id = ?')
          .run(JSON.stringify(snapshot), now, row.chat_id);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return json(res, 200, { ok: true, event, contextCount: snapshot.history.length, consecutiveRuns: Number(row.consecutive_runs) + 1 });
    }

    return json(res, 404, { ok: false, error: '接口不存在' });
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message || '请求处理失败' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EPhone MCP backend listening on http://0.0.0.0:${PORT}`);
  if (!API_TOKEN) console.warn('MCP_API_TOKEN 未设置，仅建议本地测试使用。');
});

const schedulerInterval = setInterval(runScheduler, 60 * 1000);
schedulerInterval.unref();

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
