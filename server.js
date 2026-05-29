'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const BOT_WEBHOOK_URL =
  process.env.BOT_WEBHOOK_URL ||
  'https://aura-3-1.lovable.app/api/public/hook/7ad79749c1c234153f3ac5638a1be375f5c0';

// Chrome executable detection (prefer system Chrome to avoid bundled download).
const CHROME_PATH =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  undefined;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * In-memory session store.
 * userId -> { client, status, qr, ready, info, lastError }
 * status: 'initializing' | 'qr' | 'authenticated' | 'connected' | 'disconnected'
 */
const sessions = new Map();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function postWebhook(payload) {
  if (!BOT_WEBHOOK_URL) return;
  try {
    const res = await fetch(BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    log(`Webhook -> ${payload.event} (status ${res.status})`);
  } catch (err) {
    log(`Webhook error for "${payload.event}":`, err.message);
  }
}

function buildClient(userId) {
  const puppeteer = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  if (CHROME_PATH) puppeteer.executablePath = CHROME_PATH;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer,
  });

  client.on('qr', async (qr) => {
    try {
      const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
      const session = sessions.get(userId);
      if (session) {
        session.qr = dataUrl;
        session.status = 'qr';
      }
      log(`QR generated for "${userId}"`);
    } catch (err) {
      log('QR encode error:', err.message);
    }
  });

  client.on('authenticated', () => {
    const session = sessions.get(userId);
    if (session) session.status = 'authenticated';
    log(`Authenticated "${userId}"`);
  });

  client.on('ready', async () => {
    const session = sessions.get(userId);
    if (session) {
      session.status = 'connected';
      session.ready = true;
      session.qr = null;
      session.info = client.info || null;
    }
    log(`Client ready "${userId}"`);
    await postWebhook({
      event: 'connected',
      message: 'WhatsApp Account successfully connected to Telegram!',
      userId,
    });
  });

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      const contact = await msg.getContact();
      const senderName =
        contact.pushname || contact.name || contact.verifiedName || msg._data.notifyName || 'Unknown';
      const senderNumber = contact.number || (msg.from || '').replace(/@c\.us$/, '');
      await postWebhook({
        event: 'new_message',
        senderName,
        senderNumber,
        text: msg.body || '',
        userId,
      });
    } catch (err) {
      log('message handler error:', err.message);
    }
  });

  client.on('disconnected', async (reason) => {
    const session = sessions.get(userId);
    if (session) {
      session.status = 'disconnected';
      session.ready = false;
    }
    log(`Disconnected "${userId}":`, reason);
    await postWebhook({
      event: 'disconnected',
      message: 'WhatsApp session ended.',
      });
  });

  client.on('auth_failure', (m) => {
    const session = sessions.get(userId);
    if (session) {
      session.status = 'disconnected';
      session.lastError = m;
    }
    log(`Auth failure "${userId}":`, m);
  });

  return client;
}

function getOrCreateSession(userId) {
  let session = sessions.get(userId);
  if (session) return session;
  const client = buildClient(userId);
  session = {
    client,
    status: 'initializing',
    qr: null,
    ready: false,
    info: null,
    lastError: null,
  };
  sessions.set(userId, session);
  client.initialize().catch((err) => {
    session.status = 'disconnected';
    session.lastError = err.message;
    log(`initialize() error "${userId}":`, err.message);
  });
  return session;
}

function waitForQrOrReady(session, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (session.qr || session.ready || session.status === 'connected') {
        return resolve();
      }
      if (Date.now() - start > timeoutMs) return resolve();
      setTimeout(tick, 400);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------------

// POST /api/start-session  { userId }
app.post('/api/start-session', async (req, res) => {
  const userId = (req.body && req.body.userId) || 'default';
  try {
    const session = getOrCreateSession(userId);
    if (session.ready || session.status === 'connected') {
      return res.json({ success: true, userId, status: 'connected', qr: null });
    }
    await waitForQrOrReady(session);
    return res.json({
      success: true,
      userId,
      status: session.status,
      qr: session.qr || null,
    });
  } catch (err) {
    log('start-session error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/status/:userId
app.get('/api/status/:userId', (req, res) => {
  const userId = req.params.userId || 'default';
  const session = sessions.get(userId);
  if (!session) {
    return res.json({ success: true, userId, status: 'not_started', connected: false });
  }
  return res.json({
    success: true,
    userId,
    status: session.status,
    connected: session.status === 'connected',
    me: session.info && session.info.wid ? session.info.wid.user : null,
  });
});

// Resolve a recipient (contact name OR phone number) to a WhatsApp chat id.
// Returns { chatId, label } or throws with a helpful message.
async function resolveRecipient(client, recipient) {
  const raw = String(recipient).trim();
  const digits = raw.replace(/[^0-9]/g, '');
  const looksLikeNumber = digits.length >= 7 && /^[+\d][\d\s()+-]*$/.test(raw);

  // Treat as a raw phone number. Use getNumberId so WhatsApp resolves the
  // correct serialized id (avoids the "No LID for user" error on newer WA Web).
  if (looksLikeNumber) {
    const numberId = await client.getNumberId(digits);
    if (!numberId) {
      throw new Error(`${digits} is not registered on WhatsApp`);
    }
    return { chatId: numberId._serialized, label: digits };
  }

  // Otherwise resolve by name against chats, then contacts (case-insensitive).
  const needle = raw.toLowerCase();
  const chats = await client.getChats();
  let match = chats.find((c) => (c.name || '').toLowerCase() === needle);
  if (!match) match = chats.find((c) => (c.name || '').toLowerCase().includes(needle));
  if (match) {
    return { chatId: match.id._serialized, label: match.name };
  }

  const contacts = await client.getContacts();
  let contact = contacts.find(
    (c) => ((c.name || c.pushname || '').toLowerCase() === needle)
  );
  if (!contact) {
    contact = contacts.find((c) =>
      ((c.name || c.pushname || '').toLowerCase().includes(needle)) && c.id && c.id.user
    );
  }
  if (contact) {
    return { chatId: contact.id._serialized, label: contact.name || contact.pushname };
  }

  throw new Error(`No contact or chat matching "${raw}" was found`);
}

// POST /api/send-message  { userId, recipient | number | name, message }
app.post('/api/send-message', async (req, res) => {
  const body = req.body || {};
  const userId = body.userId || 'default';
  const message = body.message;
  const recipient = body.recipient || body.name || body.number;
  if (!recipient || !message) {
    return res.status(400).json({ success: false, error: 'recipient (name or number) and message are required' });
  }
  const session = sessions.get(userId);
  if (!session || session.status !== 'connected') {
    return res.status(409).json({ success: false, error: 'Session not connected' });
  }
  try {
    const { chatId, label } = await resolveRecipient(session.client, recipient);
    const sent = await session.client.sendMessage(chatId, String(message));
    return res.json({
      success: true,
      to: label,
      chatId,
      id: sent.id ? sent.id._serialized : null,
    });
  } catch (err) {
    log('send-message error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/contacts?userId=  -> names + numbers for autocomplete
app.get('/api/contacts', async (req, res) => {
  const userId = req.query.userId || 'default';
  const session = sessions.get(userId);
  if (!session || session.status !== 'connected') {
    return res.status(409).json({ success: false, error: 'Session not connected' });
  }
  try {
    const seen = new Set();
    const out = [];
    const chats = await session.client.getChats();
    for (const chat of chats) {
      const name = chat.name;
      if (!name) continue;
      const id = chat.id._serialized;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        name,
        id,
        number: chat.isGroup ? null : (chat.id.user || null),
        isGroup: chat.isGroup,
      });
    }
    try {
      const contacts = await session.client.getContacts();
      for (const c of contacts) {
        if (!c.isMyContact || !c.id || c.id.server !== 'c.us') continue;
        const id = c.id._serialized;
        if (seen.has(id)) continue;
        const name = c.name || c.pushname;
        if (!name) continue;
        seen.add(id);
        out.push({ name, id, number: c.id.user || c.number || null, isGroup: false });
      }
    } catch (_) {}
    out.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ success: true, count: out.length, contacts: out });
  } catch (err) {
    log('contacts error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/unread?userId=
app.get('/api/unread', async (req, res) => {
  const userId = req.query.userId || 'default';
  const session = sessions.get(userId);
  if (!session || session.status !== 'connected') {
    return res.status(409).json({ success: false, error: 'Session not connected' });
  }
  try {
    const chats = await session.client.getChats();
    const unread = [];
    for (const chat of chats) {
      if (chat.unreadCount > 0) {
        const messages = await chat.fetchMessages({ limit: chat.unreadCount });
        for (const msg of messages) {
          if (msg.fromMe) continue;
          let senderName = chat.name || 'Unknown';
          let senderNumber = (msg.from || '').replace(/@c\.us$/, '');
          try {
            const contact = await msg.getContact();
            senderName = contact.pushname || contact.name || senderName;
            senderNumber = contact.number || senderNumber;
          } catch (_) {}
          unread.push({
            chatName: chat.name,
            senderName,
            senderNumber,
            text: msg.body || '',
            timestamp: msg.timestamp,
          });
        }
      }
    }
    return res.json({ success: true, count: unread.length, messages: unread });
  } catch (err) {
    log('unread error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chats?userId=
app.get('/api/chats', async (req, res) => {
  const userId = req.query.userId || 'default';
  const session = sessions.get(userId);
  if (!session || session.status !== 'connected') {
    return res.status(409).json({ success: false, error: 'Session not connected' });
  }
  try {
    const chats = await session.client.getChats();
    const list = chats.slice(0, 30).map((chat) => ({
      name: chat.name,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      lastMessage: chat.lastMessage ? chat.lastMessage.body : null,
    }));
    return res.json({ success: true, count: list.length, chats: list });
  } catch (err) {
    log('chats error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/logout  { userId }
app.post('/api/logout', async (req, res) => {
  const userId = (req.body && req.body.userId) || 'default';
  const session = sessions.get(userId);
  if (!session) {
    return res.json({ success: true, userId, status: 'not_started' });
  }
  try {
    try {
      await session.client.logout();
    } catch (_) {}
    await session.client.destroy();
    sessions.delete(userId);
    await postWebhook({ event: 'disconnected', message: 'WhatsApp session ended.' });
    return res.json({ success: true, userId, status: 'disconnected' });
  } catch (err) {
    log('logout error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ success: true, uptime: process.uptime(), sessions: sessions.size });
});

app.listen(PORT, () => {
  log(`WhatsApp REST API listening on http://localhost:${PORT}`);
  log(`Webhook target: ${BOT_WEBHOOK_URL}`);
});
