/*
 * service-worker.js - the extension's single API gateway.
 *
 * Why everything funnels through here:
 *  - In MV3, content-script fetches are bound by the page's CORS policy; the
 *    background SW (with host_permissions) can call the API cross-origin.
 *  - It keeps the auth token out of the content script (no secrets on the page).
 *  - It is the one place that writes the shared cache + retries failed events.
 *
 * The cache (chrome.storage.local key "likesQuotaCache") is the cross-context
 * sync bus: content script and popup both render from it and listen for changes.
 */

// Defaults mirror content/config.js. The popup can override API base + token.
const DEFAULTS = {
  API_BASE_URL: 'https://api.extsync.com',
  API_PREFIX: '/api/likes-quota',
  DAILY_LIMIT: 20,
  PER_USER_LIMIT: 6,
};

const KEYS = {
  CACHE: 'likesQuotaCache',
  TOKEN: 'MTLQ_AUTH_TOKEN',
  API_BASE: 'MTLQ_API_BASE_URL',
  PENDING: 'MTLQ_PENDING',
  DEV_USER: 'MTLQ_DEV_QUOTA_USER',
  DEBUG: 'MTLQ_DEBUG',
};

// ---- storage helpers -------------------------------------------------------

function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setLocal(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function debugOn() {
  const s = await getLocal(KEYS.DEBUG);
  return !!s[KEYS.DEBUG];
}
async function log(...args) {
  if (await debugOn()) console.log('[MTLQ-bg]', ...args);
}

async function getConfig() {
  const s = await getLocal([KEYS.TOKEN, KEYS.API_BASE, KEYS.DEV_USER]);
  return {
    apiBase: (s[KEYS.API_BASE] || DEFAULTS.API_BASE_URL).replace(/\/+$/, ''),
    prefix: DEFAULTS.API_PREFIX,
    token: s[KEYS.TOKEN] || '',
    devUser: s[KEYS.DEV_USER] || '',
  };
}

// Read the user's mitmachim.top NodeBB session cookie (httpOnly - only the
// cookies API can see it). The server forwards it to NodeBB /api/self to verify
// the forum identity, so no ExtSync token is needed for a logged-in forum user.
const FORUM_COOKIE = { url: 'https://mitmachim.top/', name: 'express.sid' };

function getForumCookie() {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get(FORUM_COOKIE, (c) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(c && c.value ? c.value : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function b64utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// ---- networking ------------------------------------------------------------

function buildUrl(apiBase, prefix, path, query) {
  let url = apiBase + prefix + path;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    if (qs) url += '?' + qs;
  }
  return url;
}

/*
 * Returns one of:
 *   { ok: true, data }
 *   { ok: false, error: { code, message }, status }
 */
async function apiFetch(path, { method = 'GET', body = null, query = null } = {}) {
  const cfg = await getConfig();
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  // Primary identity: the verified forum login (server confirms it with NodeBB).
  const forumCookie = await getForumCookie();
  if (forumCookie) headers['X-Forum-Session'] = b64utf8(forumCookie);
  // Optional fallback: an ExtSync token (admin / when not logged into the forum).
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
  // DEV-ONLY: ignored by the server in production (gated behind a flag there).
  if (cfg.devUser) headers['X-Dev-Quota-User'] = cfg.devUser;

  const url = buildUrl(cfg.apiBase, cfg.prefix, path, query);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    await log('network error', url, String(e));
    return { ok: false, error: { code: 'NETWORK_ERROR', message: String(e) }, status: 0 };
  }

  let json = null;
  try { json = await res.json(); } catch (e) { /* may be empty */ }

  if (!res.ok || (json && json.ok === false)) {
    const err = (json && json.error) || { code: 'HTTP_' + res.status, message: 'Request failed' };
    await log('api error', res.status, err);
    return { ok: false, error: err, status: res.status };
  }
  return { ok: true, data: json || {}, status: res.status };
}

// ---- cache -----------------------------------------------------------------

function toCache(serverState, syncStatus) {
  const s = serverState || {};
  return {
    date: s.date || null,
    likesToday: typeof s.likesToday === 'number' ? s.likesToday : 0,
    dailyLimit: s.dailyLimit || DEFAULTS.DAILY_LIMIT,
    perUserLimit: s.perUserLimit || DEFAULTS.PER_USER_LIMIT,
    targetUsers: s.targetUsers || {},
    updatedAt: s.updatedAt || new Date().toISOString(),
    syncStatus: syncStatus || 'synced',
  };
}

async function writeCache(serverState, syncStatus) {
  const cache = toCache(serverState, syncStatus);
  await setLocal({ [KEYS.CACHE]: cache });
  return cache;
}

async function markCacheStatus(syncStatus) {
  const s = await getLocal(KEYS.CACHE);
  const cache = s[KEYS.CACHE] || toCache(null, syncStatus);
  cache.syncStatus = syncStatus;
  await setLocal({ [KEYS.CACHE]: cache });
  return cache;
}

// ---- pending event queue (offline resilience) ------------------------------

async function enqueuePending(ev) {
  const s = await getLocal(KEYS.PENDING);
  const list = s[KEYS.PENDING] || [];
  // de-dupe by clientEventId
  if (!list.some((e) => e.clientEventId && e.clientEventId === ev.clientEventId)) {
    list.push(ev);
    await setLocal({ [KEYS.PENDING]: list });
  }
}

async function flushPending() {
  const s = await getLocal(KEYS.PENDING);
  let list = s[KEYS.PENDING] || [];
  if (!list.length) return;
  const remaining = [];
  for (const ev of list) {
    const path = ev.action === 'increment' ? '/increment' : '/decrement';
    const res = await apiFetch(path, { method: 'POST', body: ev.body });
    if (res.ok) {
      await writeCache(res.data, 'synced');
    } else if (res.error && (res.error.code === 'DUPLICATE_EVENT')) {
      // already counted server-side; drop it
    } else if (res.status === 0) {
      remaining.push(ev); // still offline, keep for next time
    } else {
      // a real validation/auth error - drop so we don't loop forever
      await log('dropping pending event after server error', res.error);
    }
  }
  await setLocal({ [KEYS.PENDING]: remaining });
}

// ---- action handlers -------------------------------------------------------

function forumQuery(forumUser) {
  if (!forumUser) return null;
  return {
    forumUserId: forumUser.forumUserId,
    username: forumUser.username,
    userslug: forumUser.userslug,
  };
}

async function handleGetToday(payload) {
  await flushPending(); // opportunistic retry on every poll
  const query = forumQuery(payload && payload.forumUser) || {};
  if (payload && payload.fresh) query.fresh = 1; // bypass the server's short forum cache
  const res = await apiFetch('/today', { query });
  if (res.ok) {
    const cache = await writeCache(res.data, 'synced');
    return { ok: true, data: cache };
  }
  const cache = await markCacheStatus(res.status === 0 ? 'offline' : 'error');
  return { ok: false, error: res.error, data: cache };
}

async function handleMutation(action, payload) {
  const path = action === 'increment' ? '/increment' : '/decrement';
  const body = {
    postId: payload.postId,
    topicId: payload.topicId,
    targetUserId: payload.targetUserId,
    targetUsername: payload.targetUsername,
    clientEventId: payload.clientEventId,
    createdAt: payload.createdAt,
    forumUser: payload.forumUser || null,
  };
  const res = await apiFetch(path, { method: 'POST', body });
  if (res.ok) {
    const cache = await writeCache(res.data, 'synced');
    return { ok: true, data: cache };
  }
  // Network failure -> queue for retry. Server-side rejections are NOT queued.
  if (res.status === 0) {
    await enqueuePending({ action, clientEventId: payload.clientEventId, body });
    const cache = await markCacheStatus('offline');
    return { ok: false, error: res.error, data: cache };
  }
  const cache = await markCacheStatus('error');
  return { ok: false, error: res.error, data: cache };
}

async function handleSet(payload) {
  const res = await apiFetch('/set', {
    method: 'POST',
    body: { likesToday: payload.likesToday, reason: payload.reason || 'manual', forumUser: payload.forumUser || null },
  });
  if (res.ok) return { ok: true, data: await writeCache(res.data, 'synced') };
  return { ok: false, error: res.error, data: await markCacheStatus(res.status === 0 ? 'offline' : 'error') };
}

async function handleReset(payload) {
  const res = await apiFetch('/reset', {
    method: 'POST',
    body: { reason: (payload && payload.reason) || 'manual-reset', forumUser: (payload && payload.forumUser) || null },
  });
  if (res.ok) return { ok: true, data: await writeCache(res.data, 'synced') };
  return { ok: false, error: res.error, data: await markCacheStatus(res.status === 0 ? 'offline' : 'error') };
}

async function handleGetCache() {
  const s = await getLocal(KEYS.CACHE);
  return { ok: true, data: s[KEYS.CACHE] || null };
}

// ---- message routing -------------------------------------------------------

const ROUTES = {
  MTLQ_GET_TODAY: (p) => handleGetToday(p),
  MTLQ_INCREMENT: (p) => handleMutation('increment', p),
  MTLQ_DECREMENT: (p) => handleMutation('decrement', p),
  MTLQ_SET: (p) => handleSet(p),
  MTLQ_RESET: (p) => handleReset(p),
  MTLQ_GET_CACHE: () => handleGetCache(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const route = msg && ROUTES[msg.type];
  if (!route) return false;
  Promise.resolve(route(msg.payload || {}))
    .then((result) => sendResponse(result))
    .catch((e) => sendResponse({ ok: false, error: { code: 'INTERNAL_ERROR', message: String(e) } }));
  return true; // keep the message channel open for the async response
});

// Seed defaults on install so the popup has something to show immediately.
chrome.runtime.onInstalled.addListener(async () => {
  const s = await getLocal([KEYS.API_BASE]);
  if (!s[KEYS.API_BASE]) await setLocal({ [KEYS.API_BASE]: DEFAULTS.API_BASE_URL });
});
