const $ = (id) => document.getElementById(id);
let pollTimer = null;

function getUserId() {
  return ($('userId').value || 'default').trim();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function setStatus(status) {
  const dot = $('statusDot');
  const text = $('statusText');
  dot.className = 'dot';
  const map = {
    connected: ['connected', 'Connected'],
    qr: ['qr', 'Scan QR'],
    authenticated: ['qr', 'Authenticating…'],
    initializing: ['qr', 'Initializing…'],
    disconnected: ['disconnected', 'Disconnected'],
    not_started: ['', 'Not started'],
  };
  const [cls, label] = map[status] || ['', status || 'Unknown'];
  if (cls) dot.classList.add(cls);
  text.textContent = label;
}

function showQr(qr) {
  const img = $('qrImage');
  const ph = $('qrPlaceholder');
  if (qr) {
    img.src = qr;
    img.style.display = 'block';
    ph.style.display = 'none';
  } else {
    img.style.display = 'none';
    ph.style.display = 'block';
  }
}

async function startSession() {
  const userId = getUserId();
  $('connHint').textContent = 'Starting session…';
  setStatus('initializing');
  const { data } = await api('/api/start-session', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  setStatus(data.status);
  if (data.qr) {
    showQr(data.qr);
    $('connHint').textContent = 'Scan this QR with WhatsApp on your phone.';
  } else if (data.status === 'connected') {
    showQr(null);
    $('connHint').textContent = 'Already connected.';
  } else {
    $('connHint').textContent = 'Waiting for QR…';
  }
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const userId = getUserId();
    const { data } = await api(`/api/status/${encodeURIComponent(userId)}`);
    setStatus(data.status);
    if (data.status === 'connected') {
      showQr(null);
      $('connHint').textContent = 'Connected to WhatsApp.';
    } else if (data.status === 'qr') {
      // refresh QR if it rotated
      const r = await api('/api/start-session', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      if (r.data.qr) showQr(r.data.qr);
    }
  }, 4000);
}

async function logout() {
  const userId = getUserId();
  await api('/api/logout', { method: 'POST', body: JSON.stringify({ userId }) });
  if (pollTimer) clearInterval(pollTimer);
  setStatus('disconnected');
  showQr(null);
  $('connHint').textContent = 'Session ended.';
}

async function sendMessage() {
  const userId = getUserId();
  const number = $('number').value.trim();
  const message = $('message').value.trim();
  $('sendOut').textContent = 'Sending…';
  const { data, status } = await api('/api/send-message', {
    method: 'POST',
    body: JSON.stringify({ userId, number, message }),
  });
  $('sendOut').textContent = `HTTP ${status}\n` + JSON.stringify(data, null, 2);
}

async function fetchChats() {
  const userId = getUserId();
  const list = $('chatsList');
  list.innerHTML = '<div class="item">Loading…</div>';
  const { data } = await api(`/api/chats?userId=${encodeURIComponent(userId)}`);
  if (!data.chats || !data.chats.length) {
    list.innerHTML = `<div class="item">${data.error || 'No chats.'}</div>`;
    return;
  }
  list.innerHTML = data.chats
    .map(
      (c) => `
      <div class="item">
        <div class="name">${escapeHtml(c.name || 'Unknown')} ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : ''}</div>
        <div class="text">${escapeHtml(c.lastMessage || '')}</div>
      </div>`
    )
    .join('');
}

async function fetchUnread() {
  const userId = getUserId();
  const list = $('unreadList');
  list.innerHTML = '<div class="item">Loading…</div>';
  const { data } = await api(`/api/unread?userId=${encodeURIComponent(userId)}`);
  if (!data.messages || !data.messages.length) {
    list.innerHTML = `<div class="item">${data.error || 'No unread messages.'}</div>`;
    return;
  }
  list.innerHTML = data.messages
    .map(
      (m) => `
      <div class="item">
        <div class="name">${escapeHtml(m.senderName || 'Unknown')}</div>
        <div class="meta">${escapeHtml(m.senderNumber || '')}</div>
        <div class="text">${escapeHtml(m.text || '')}</div>
      </div>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

$('startBtn').addEventListener('click', startSession);
$('logoutBtn').addEventListener('click', logout);
$('sendBtn').addEventListener('click', sendMessage);
$('chatsBtn').addEventListener('click', fetchChats);
$('unreadBtn').addEventListener('click', fetchUnread);

// initial status check
(async () => {
  const { data } = await api(`/api/status/${encodeURIComponent(getUserId())}`);
  setStatus(data.status || 'not_started');
})();
