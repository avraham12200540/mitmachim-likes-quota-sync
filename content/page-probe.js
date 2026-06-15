/*
 * page-probe.js - runs in the PAGE's main world (not the isolated content
 * script world), so it can read NodeBB's `window.app` / `ajaxify` objects that
 * are invisible to the content script.
 *
 * It only ever READS public NodeBB state and posts it back via window.postMessage.
 * It never mutates the page, never performs likes, never touches the network.
 */
(function () {
  'use strict';

  var REQUEST = 'MT_LIKES_USER_REQUEST';
  var RESPONSE = 'MT_LIKES_USER_DATA';

  function readUser() {
    try {
      var app = window.app || {};
      var user = app.user || {};
      var uid = user.uid;
      // NodeBB uses uid 0 for guests / not-logged-in.
      if (!uid || Number(uid) <= 0) {
        return { loggedIn: false };
      }
      return {
        loggedIn: true,
        forumUserId: String(uid),
        username: user.username || null,
        userslug: user.userslug || null,
      };
    } catch (e) {
      return { loggedIn: false, error: String(e && e.message || e) };
    }
  }

  function readTopicId() {
    try {
      var data = (window.ajaxify && window.ajaxify.data) || {};
      if (data.tid) return String(data.tid);
    } catch (e) { /* ignore */ }
    return null;
  }

  function respond() {
    var payload = readUser();
    payload.topicId = readTopicId();
    payload.__mtlq = true;
    window.postMessage({ type: RESPONSE, payload: payload }, window.location.origin);
  }

  // Answer explicit requests from the content script.
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.type !== REQUEST) return;
    respond();
  });

  // Re-push on every NodeBB ajaxify navigation so the content script learns the
  // new topic id (and user, if it changed) without a full page reload.
  try {
    if (window.$ && typeof window.$ === 'function' && window.ajaxify) {
      window.$(window).on('action:ajaxify.end', function () {
        // small delay so ajaxify.data is fully populated
        setTimeout(respond, 50);
      });
    }
  } catch (e) { /* ignore */ }

  // Also push once on load (covers the common "already logged in" case fast).
  respond();
})();
