/*
 * user.js - resolves the logged-in NodeBB user.
 *
 * Content scripts run in an isolated world and usually cannot see the page's
 * `window.app`. We therefore inject page-probe.js into the page's main world
 * and exchange data over window.postMessage with a unique message type.
 *
 * Public API:
 *   MTLQ.user.get()      -> Promise<{forumUserId, username, userslug} | null>
 *   MTLQ.user.getCached()-> the last resolved user (or null), synchronously
 *   MTLQ.user.refresh()  -> force a re-probe
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});
  const cfg = NS.config;

  let lastUser = null;          // {forumUserId, username, userslug} | null
  let lastTopicId = null;
  let probeInjected = false;
  const waiters = [];           // pending get() resolvers
  const subscribers = [];       // onUpdate listeners (fired on every probe response)

  function injectProbe() {
    if (probeInjected) return;
    probeInjected = true;
    try {
      const url = chrome.runtime.getURL('content/page-probe.js');
      const s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      NS.warn('probe inject failed', e);
    }
  }

  function handleMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== cfg.PROBE_RESPONSE || !data.payload || !data.payload.__mtlq) return;

    const p = data.payload;
    if (p.topicId) lastTopicId = p.topicId;

    if (p.loggedIn && p.forumUserId) {
      lastUser = {
        forumUserId: String(p.forumUserId),
        username: p.username || null,
        userslug: p.userslug || null,
      };
    } else {
      lastUser = null;
    }
    NS.log('user resolved', lastUser);

    // Flush anyone waiting on get().
    while (waiters.length) {
      try { waiters.shift()(lastUser); } catch (e) { /* ignore */ }
    }
    // Notify navigation/update subscribers (used to re-mount widget + resync).
    for (const cb of subscribers) {
      try { cb(lastUser, lastTopicId); } catch (e) { /* ignore */ }
    }
  }

  function requestProbe() {
    try {
      window.postMessage({ type: cfg.PROBE_REQUEST }, window.location.origin);
    } catch (e) { /* ignore */ }
  }

  NS.user = {
    init() {
      window.addEventListener('message', handleMessage, false);
      injectProbe();
      requestProbe();
    },

    getCached() {
      return lastUser;
    },

    getTopicId() {
      return lastTopicId;
    },

    refresh() {
      requestProbe();
    },

    // Subscribe to every resolved probe response (login + each ajaxify navigation).
    onUpdate(cb) {
      if (typeof cb === 'function') subscribers.push(cb);
    },

    // Resolve the current user, waiting briefly for the probe if needed.
    get(timeoutMs = 1500) {
      if (lastUser) return Promise.resolve(lastUser);
      injectProbe();
      requestProbe();
      return new Promise((resolve) => {
        let done = false;
        const finish = (u) => { if (!done) { done = true; resolve(u); } };
        waiters.push(finish);
        setTimeout(() => finish(lastUser), timeoutMs);
      });
    },
  };
})();
