/*
 * popup.js - manual control panel.
 *
 * Talks to the same background gateway as the content script (so auth, the
 * cache and pending-event retries are all shared) and renders from the cache.
 * Edits write through the server; the shared cache then live-updates both the
 * popup and any open mitmachim.top tab via chrome.storage.onChanged.
 */
(function () {
  'use strict';

  const KEYS = {
    CACHE: 'likesQuotaCache',
    TOKEN: 'MTLQ_AUTH_TOKEN',
    API_BASE: 'MTLQ_API_BASE_URL',
    DEV_USER: 'MTLQ_DEV_QUOTA_USER',
  };
  const DEFAULT_LIMIT = 20;

  const $ = (id) => document.getElementById(id);

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload: payload || {} }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: { code: 'EXTENSION_ERROR', message: chrome.runtime.lastError.message } });
          return;
        }
        resolve(res || { ok: false, error: { code: 'NO_RESPONSE', message: 'no response' } });
      });
    });
  }

  function getLocal(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function setLocal(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  // ---- rendering -----------------------------------------------------------

  function setBadge(status) {
    const b = $('sync-badge');
    b.className = 'badge';
    if (status === 'synced') { b.classList.add('badge-synced'); b.textContent = 'מסונכרן'; }
    else if (status === 'offline') { b.classList.add('badge-offline'); b.textContent = 'לא מסונכרן'; }
    else if (status === 'error') { b.classList.add('badge-error'); b.textContent = 'לא מסונכרן'; }
    else { b.classList.add('badge-loading'); b.textContent = 'טוען...'; }
  }

  function render(state) {
    if (!state) { setBadge('loading'); return; }
    const limit = state.dailyLimit || DEFAULT_LIMIT;
    const today = Math.max(0, Math.min(Number(state.likesToday) || 0, limit));
    const perUser = state.perUserLimit || 6;

    $('today-count').textContent = today + '/' + limit;
    $('remaining').textContent = Math.max(0, limit - today);

    const fill = $('bar-fill');
    fill.style.width = (limit ? (today / limit) * 100 : 0) + '%';
    fill.classList.toggle('full', today >= limit);

    if (!$('manual-input').matches(':focus')) $('manual-input').value = today;

    // target users list
    const list = $('targets-list');
    const tu = state.targetUsers || {};
    const entries = Object.entries(tu);
    if (!entries.length) {
      list.innerHTML = '<li class="empty">אין עדיין נתונים</li>';
    } else {
      entries.sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
      // Build the rows as nodes (never via innerHTML with user data) to avoid
      // any HTML injection from forum usernames.
      list.innerHTML = entries.map(([, info]) => {
        const maxed = ((info && info.count) || 0) >= perUser ? 'maxed' : '';
        return '<li class="' + maxed + '"><span class="name"></span>' +
          '<span class="count"></span></li>';
      }).join('');
      Array.from(list.children).forEach((li, i) => {
        const [uid, info] = entries[i];
        const name = (info && info.username) || ('משתמש ' + uid);
        const count = (info && info.count) || 0;
        li.querySelector('.name').textContent = name;
        li.querySelector('.count').textContent = count + '/' + perUser;
      });
    }

    setBadge(state.syncStatus || 'synced');
  }

  function flash(text, ok) {
    const m = $('msg');
    m.hidden = false;
    m.className = 'msg ' + (ok ? 'ok' : 'err');
    m.textContent = text;
    setTimeout(() => { m.hidden = true; }, 2600);
  }

  function applyResult(res, okText) {
    if (res && res.ok) {
      render(res.data);
      flash(okText, true);
      // nudge any open forum tab to refresh immediately too
      try { chrome.runtime.sendMessage({ type: 'MTLQ_CACHE_UPDATED', state: res.data }); } catch (e) { /* ignore */ }
    } else {
      const code = (res && res.error && res.error.code) || 'ERROR';
      const message = (res && res.error && res.error.message) || 'הפעולה נכשלה';
      if (code === 'UNAUTHORIZED') flash('לא מחובר - בדוק טוקן בהגדרות מתקדמות', false);
      else flash(message, false);
      if (res && res.data) render(res.data);
    }
  }

  // ---- actions -------------------------------------------------------------

  async function init() {
    setBadge('loading');

    // 1) instant paint from cache
    const cached = await send('MTLQ_GET_CACHE');
    if (cached && cached.ok && cached.data) render(cached.data);

    // 2) prefill advanced settings
    const s = await getLocal([KEYS.API_BASE, KEYS.TOKEN, KEYS.DEV_USER]);
    $('api-base').value = s[KEYS.API_BASE] || '';
    $('token').value = s[KEYS.TOKEN] || '';
    $('dev-user').value = s[KEYS.DEV_USER] || '';

    // 3) refresh from server
    const today = await send('MTLQ_GET_TODAY');
    if (today && today.data) render(today.data);

    // 4) live updates while popup is open
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEYS.CACHE] && changes[KEYS.CACHE].newValue) {
        render(changes[KEYS.CACHE].newValue);
      }
    });

    wireButtons();
  }

  function wireButtons() {
    $('btn-set-20').addEventListener('click', async () => {
      applyResult(await send('MTLQ_SET', { likesToday: 20, reason: 'manual-popup' }), 'הוגדר ל־20');
    });

    $('btn-reset').addEventListener('click', async () => {
      applyResult(await send('MTLQ_RESET', { reason: 'manual-reset' }), 'אופס ל־0');
    });

    $('btn-save').addEventListener('click', async () => {
      let n = parseInt($('manual-input').value, 10);
      if (isNaN(n)) n = 0;
      n = Math.max(0, Math.min(20, n));
      $('manual-input').value = n;
      applyResult(await send('MTLQ_SET', { likesToday: n, reason: 'manual-popup' }), 'נשמר: ' + n);
    });

    $('btn-save-settings').addEventListener('click', async () => {
      const apiBase = $('api-base').value.trim().replace(/\/+$/, '');
      const token = $('token').value.trim();
      const devUser = $('dev-user').value.trim();
      await setLocal({
        [KEYS.API_BASE]: apiBase || undefined,
        [KEYS.TOKEN]: token,
        [KEYS.DEV_USER]: devUser,
      });
      flash('ההגדרות נשמרו', true);
      const today = await send('MTLQ_GET_TODAY');
      if (today && today.data) render(today.data);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
