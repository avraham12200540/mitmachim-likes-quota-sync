/*
 * widget.js - the vertical quota meter pinned to the left edge.
 *
 * Pure view layer: it owns the DOM node and knows how to render a state object.
 * It never talks to the network. All styling lives in styles.css; this file
 * only toggles classes and sets the fill height + text.
 *
 * Public API:
 *   MTLQ.widget.ensure()        -> create the node if missing (idempotent)
 *   MTLQ.widget.render(state)    -> update fill/text/status from a state object
 *   MTLQ.widget.setDisabled(msg) -> grey, inactive look (e.g. not logged in)
 *   MTLQ.widget.remove()
 *
 * state shape: { likesToday, dailyLimit, perUserLimit, syncStatus, updatedAt }
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});
  const cfg = NS.config;

  const ROOT_ID = 'mt-likes-quota-widget';
  let lastState = null;

  function buildNode() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('dir', 'rtl');
    root.innerHTML =
      '<div class="mt-likes-quota-track">' +
      '  <div class="mt-likes-quota-fill"></div>' +
      '  <div class="mt-likes-quota-text">0/' + cfg.DAILY_LIMIT + '</div>' +
      '  <div class="mt-likes-quota-status" title=""></div>' +
      '</div>';
    return root;
  }

  function el() {
    return document.getElementById(ROOT_ID);
  }

  function ensure() {
    let node = el();
    if (node && document.body.contains(node)) return node;
    if (!document.body) return null;
    node = buildNode();
    document.body.appendChild(node);
    // Re-apply the last known state so a re-mount is not visually empty.
    if (lastState) render(lastState);
    NS.log('widget mounted');
    return node;
  }

  function render(state) {
    if (!state) return;
    lastState = state;
    const node = el();
    if (!node) return;

    const limit = state.dailyLimit || cfg.DAILY_LIMIT;
    const today = Math.max(0, Math.min(Number(state.likesToday) || 0, limit));
    const pct = limit > 0 ? (today / limit) * 100 : 0;

    const fill = node.querySelector('.mt-likes-quota-fill');
    const text = node.querySelector('.mt-likes-quota-text');
    const status = node.querySelector('.mt-likes-quota-status');

    if (fill) fill.style.height = pct + '%';
    if (text) text.textContent = today + '/' + limit;

    node.classList.remove('mt-disabled', 'mt-full', 'mt-error', 'mt-offline', 'mt-loading');

    if (today >= limit) node.classList.add('mt-full');

    const ss = state.syncStatus;
    if (ss === 'error') {
      node.classList.add('mt-error');
      if (status) status.title = 'לא מסונכרן - שגיאת שרת';
    } else if (ss === 'offline') {
      node.classList.add('mt-offline');
      if (status) status.title = 'לא מסונכרן - אין חיבור לשרת';
    } else if (ss === 'loading') {
      node.classList.add('mt-loading');
      if (status) status.title = 'טוען...';
    } else if (status) {
      status.title = 'מסונכרן';
    }

    node.setAttribute('title', 'נתת ' + today + ' מתוך ' + limit + ' לייקים היום');
  }

  function setDisabled(message) {
    const node = ensure();
    if (!node) return;
    node.classList.add('mt-disabled');
    const text = node.querySelector('.mt-likes-quota-text');
    const fill = node.querySelector('.mt-likes-quota-fill');
    if (fill) fill.style.height = '0%';
    if (text) text.textContent = '-/' + cfg.DAILY_LIMIT;
    node.setAttribute('title', message || 'יש להתחבר לפורום כדי להציג את מד הלייקים');
  }

  function remove() {
    const node = el();
    if (node) node.remove();
  }

  NS.widget = { ensure, render, setDisabled, remove, ROOT_ID };
})();
