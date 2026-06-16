/*
 * content.js - orchestrator. Wires user + detector + api + widget together,
 * owns the polling loop, and reacts to NodeBB ajaxify navigation, tab focus,
 * and cross-context cache changes (popup edits).
 *
 * Everything here is idempotent: initOnce() and ensureWidgetExists() can run
 * many times (ajaxify re-renders, MutationObserver ticks) without duplicating
 * listeners or DOM nodes.
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});
  const cfg = NS.config;

  let initialized = false;
  let pollTimer = null;
  let observer = null;
  let loggedIn = false;
  let refreshing = false;
  let currentState = null; // latest meter state, read synchronously by the detector

  // ---- state plumbing -----------------------------------------------------

  function renderFromState(state) {
    if (!state) return;
    currentState = state;
    if (!loggedIn) { NS.widget.setDisabled(); return; }
    NS.widget.ensure();
    NS.widget.render(state);
  }

  async function pullToday(reason, fresh) {
    if (!loggedIn || refreshing) return;
    refreshing = true;
    try {
      const user = NS.user.getCached();
      const cached = await NS.api.getCachedState();
      if (cached && cached.ok && cached.data) {
        renderFromState(Object.assign({}, cached.data));
      }
      // The server derives today's count from the forum (no click-counting).
      const res = await NS.api.getTodayState(user, !!fresh);
      if (res && res.ok && res.data) {
        renderFromState(res.data);
      } else if (res && res.error) {
        const last = (cached && cached.data) || {};
        renderFromState(Object.assign({}, last, { syncStatus: last.likesToday != null ? 'error' : 'offline' }));
        NS.warn('getToday failed', res.error, '(', reason, ')');
      }
    } catch (e) {
      NS.warn('pullToday threw', e);
    } finally {
      refreshing = false;
    }
  }

  // ---- widget lifecycle ---------------------------------------------------

  function ensureWidgetExists() {
    if (!loggedIn) {
      NS.widget.setDisabled();
      return;
    }
    NS.widget.ensure();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      // cheap guard: only act if our node vanished
      if (!document.getElementById(NS.widget.ROOT_ID)) ensureWidgetExists();
    });
    try {
      observer.observe(document.body, { childList: true, subtree: false });
    } catch (e) { NS.warn('observer failed', e); }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') pullToday('poll');
    }, cfg.POLL_INTERVAL_MS);
  }

  // ---- reactions ----------------------------------------------------------

  function onUserUpdate(user) {
    const nowLoggedIn = !!(user && user.forumUserId);
    const changed = nowLoggedIn !== loggedIn;
    loggedIn = nowLoggedIn;

    if (!loggedIn) {
      NS.widget.setDisabled();
      return;
    }
    ensureWidgetExists();
    // On login or navigation, resync from the server.
    pullToday(changed ? 'login' : 'navigation');
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') pullToday('focus');
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes[cfg.STORAGE_CACHE]) {
      const next = changes[cfg.STORAGE_CACHE].newValue;
      if (next) renderFromState(next);
    }
  }

  function onRuntimeMessage(msg) {
    // popup asks the page to refresh immediately after a manual change
    if (msg && msg.type === 'MTLQ_CACHE_UPDATED' && msg.state) {
      renderFromState(msg.state);
    } else if (msg && msg.type === 'MTLQ_FORCE_REFRESH') {
      pullToday('popup');
    }
  }

  // ---- init ---------------------------------------------------------------

  function initOnce() {
    if (initialized) return;
    initialized = true;
    NS.log('init');

    NS.user.init();
    NS.user.onUpdate(onUserUpdate);

    NS.detector.init({
      getState: () => currentState,
      // After a real like/un-like, re-sync from the forum (fresh, bypass cache).
      onActivity: () => pullToday('like', true),
      // A new like was blocked at the limit - tell the user on the widget.
      onBlocked: (kind, info) => { try { NS.widget.flashBlocked(kind, info); } catch (e) { /* ignore */ } },
    });

    document.addEventListener('visibilitychange', onVisibilityChange, false);
    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) { /* ignore */ }
    try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (e) { /* ignore */ }

    startObserver();
    startPolling();

    // First resolve of the user (in case the probe's initial push was missed).
    NS.user.get().then((user) => onUserUpdate(user));
  }

  // Run now (document_idle) and stay resilient to late DOM/body availability.
  if (document.body) {
    initOnce();
  } else {
    document.addEventListener('DOMContentLoaded', initOnce, { once: true });
  }
})();
