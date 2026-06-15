/*
 * api.js - the content-script side of the API.
 *
 * In Manifest V3 a content script's fetch() is bound by the page's CORS rules,
 * so all network calls are delegated to the background service worker (which,
 * with host_permissions, can call the API cross-origin). This module is a thin,
 * promise-friendly wrapper over chrome.runtime.sendMessage.
 *
 * Every response is normalized to: { ok: boolean, data?, error?: {code,message} }
 *
 * Public API:
 *   MTLQ.api.getTodayState(forumUser)
 *   MTLQ.api.incrementLike(payload)
 *   MTLQ.api.decrementLike(payload)
 *   MTLQ.api.setLikesToday(n, reason)
 *   MTLQ.api.resetLikesToday(reason)
 *   MTLQ.api.getCachedState()   -> last cache stored by the SW (or null)
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload: payload || {} }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: { code: 'EXTENSION_ERROR', message: err.message } });
            return;
          }
          resolve(res || { ok: false, error: { code: 'NO_RESPONSE', message: 'no response' } });
        });
      } catch (e) {
        resolve({ ok: false, error: { code: 'EXTENSION_ERROR', message: String(e) } });
      }
    });
  }

  NS.api = {
    getTodayState(forumUser) {
      return send('MTLQ_GET_TODAY', { forumUser: forumUser || null });
    },
    incrementLike(payload) {
      return send('MTLQ_INCREMENT', payload);
    },
    decrementLike(payload) {
      return send('MTLQ_DECREMENT', payload);
    },
    setLikesToday(likesToday, reason) {
      return send('MTLQ_SET', { likesToday, reason: reason || 'manual' });
    },
    resetLikesToday(reason) {
      return send('MTLQ_RESET', { reason: reason || 'manual-reset' });
    },
    getCachedState() {
      return send('MTLQ_GET_CACHE', {});
    },
  };
})();
