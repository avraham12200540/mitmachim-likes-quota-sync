/*
 * vote-interceptor.js - runs in the PAGE's main world.
 *
 * NodeBB casts votes through a REST call: PUT /api/v3/posts/<pid>/vote (and
 * DELETE to un-vote). This observer wraps fetch + XMLHttpRequest to watch those
 * calls and their RESPONSES, then reports the outcome to the content script via
 * postMessage. It only READS - it never changes the request, never votes.
 *
 * Reported event (type MT_VOTE_EVENT):
 *   { pid, method: 'PUT'|'DELETE', status, message, delta }
 *   - status 200            -> the vote/un-vote registered
 *   - status 400 + message  -> the forum rejected it (e.g. daily-limit message)
 */
(function () {
  'use strict';

  var TYPE = 'MT_VOTE_EVENT';
  var VOTE_RE = /\/api\/v3\/posts\/(\d+)\/vote/;

  function report(detail) {
    try {
      detail.type = TYPE;
      detail.__mtlq = true;
      window.postMessage(detail, window.location.origin);
    } catch (e) { /* ignore */ }
  }

  function parseDelta(body) {
    try { return JSON.parse(body || '{}').delta; } catch (e) { return undefined; }
  }
  function parseMessage(text) {
    try {
      var j = JSON.parse(text);
      return (j && j.status && j.status.message) || '';
    } catch (e) { return ''; }
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var promise = origFetch.apply(this, arguments);
      var m = VOTE_RE.exec(url || '');
      if (m && (method === 'PUT' || method === 'DELETE')) {
        var pid = m[1];
        var body = (init && typeof init.body === 'string') ? init.body : '';
        promise.then(function (res) {
          var status = res.status;
          res.clone().text().then(function (t) {
            report({ pid: pid, method: method, status: status, message: parseMessage(t), delta: parseDelta(body) });
          }).catch(function () {
            report({ pid: pid, method: method, status: status, message: '', delta: parseDelta(body) });
          });
        }).catch(function () { /* network error - ignore */ });
      }
      return promise;
    };
  }

  // ---- XMLHttpRequest (fallback) ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mtlq = { method: (method || '').toUpperCase(), url: url || '' };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var info = this.__mtlq;
    if (info && VOTE_RE.test(info.url) && (info.method === 'PUT' || info.method === 'DELETE')) {
      var self = this;
      this.addEventListener('loadend', function () {
        var m = VOTE_RE.exec(info.url);
        report({
          pid: m && m[1], method: info.method, status: self.status,
          message: parseMessage(self.responseText), delta: parseDelta(typeof body === 'string' ? body : ''),
        });
      });
    }
    return origSend.apply(this, arguments);
  };
})();
