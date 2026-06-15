/*
 * detector.js - detects when the user (un)likes a post and reports it.
 *
 * Strategy: a single delegated click listener (capture phase) on document.
 * We never count a like optimistically - we read the liked-state BEFORE the
 * click and again after a short settle delay, and only report a change if the
 * forum actually accepted it. This keeps us correct even when the forum blocks
 * the action (e.g. daily limit reached).
 *
 * Public API:
 *   MTLQ.detector.init(onEvent)
 *     onEvent({ action:'increment'|'decrement', postId, topicId,
 *               targetUserId, targetUsername, clientEventId, createdAt })
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});
  const cfg = NS.config;
  const sel = cfg.selectors;

  let started = false;
  let onEvent = function () {};

  // Per-post throttle so a rapid double-click on the same post fires once.
  const recentByPost = new Map(); // postId -> timestamp

  // ---- helpers ------------------------------------------------------------

  function matchesAny(el, selectorList) {
    if (!el || !el.closest) return null;
    for (const s of selectorList) {
      const hit = el.closest(s);
      if (hit) return hit;
    }
    return null;
  }

  function isLikeButton(el) {
    return matchesAny(el, sel.likeButton);
  }

  function findPostElement(el) {
    return matchesAny(el, sel.post);
  }

  function getPostId(postEl) {
    if (!postEl) return null;
    for (const attr of sel.postIdAttrs) {
      const v = postEl.getAttribute && postEl.getAttribute(attr);
      if (v) return String(v);
    }
    // Fallback: a nested element carrying the pid.
    const nested = postEl.querySelector && postEl.querySelector('[data-pid]');
    if (nested) return String(nested.getAttribute('data-pid'));
    return null;
  }

  function getTopicId() {
    // 1) the page-probe (ajaxify.data.tid) is the most reliable source.
    const fromProbe = NS.user && NS.user.getTopicId && NS.user.getTopicId();
    if (fromProbe) return String(fromProbe);
    // 2) the URL: /topic/<tid>/slug
    const m = location.pathname.match(/\/topic\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  function readAttr(el, attrs) {
    if (!el || !el.getAttribute) return null;
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v) return String(v);
    }
    return null;
  }

  function getTargetUser(postEl) {
    const out = { targetUserId: null, targetUsername: null };
    if (!postEl) return out;

    // numeric uid on the post or a nested header element
    out.targetUserId =
      readAttr(postEl, sel.authorUidAttrs) ||
      (postEl.querySelector && readAttr(postEl.querySelector('[data-uid]'), ['data-uid'])) ||
      null;

    // slug / username
    let slug = readAttr(postEl, sel.authorSlugAttrs);
    let link = postEl.querySelector && postEl.querySelector(sel.authorLink);
    if (link) {
      const href = link.getAttribute('href') || '';
      const ms = href.match(/\/user\/([^/?#]+)/);
      const mu = href.match(/\/uid\/(\d+)/);
      if (!slug && ms) slug = decodeURIComponent(ms[1]);
      if (!out.targetUserId && mu) out.targetUserId = mu[1];
      if (!out.targetUsername) {
        const txt = (link.textContent || '').trim();
        if (txt) out.targetUsername = txt;
      }
    }
    if (!out.targetUsername && slug) out.targetUsername = slug;
    return out;
  }

  // Is this post currently liked by me? Best-effort across NodeBB themes.
  function isPostLiked(postEl, buttonEl) {
    const candidates = [];
    if (buttonEl) candidates.push(buttonEl);
    if (postEl && postEl.querySelector) {
      for (const s of sel.likeButton) {
        const found = postEl.querySelector(s);
        if (found) candidates.push(found);
      }
    }
    for (const c of candidates) {
      if (!c) continue;
      if (c.getAttribute && c.getAttribute('aria-pressed') === 'true') return true;
      const cls = (c.className && c.className.toString && c.className.toString()) || '';
      const hay = (cls + ' ' + ((c.parentElement && c.parentElement.className) || '')).toLowerCase();
      for (const hint of sel.likedClassHints) {
        if (hay.indexOf(hint) !== -1) return true;
      }
    }
    return false;
  }

  function reLocateButton(postEl) {
    if (!postEl || !postEl.querySelector) return null;
    for (const s of sel.likeButton) {
      const found = postEl.querySelector(s);
      if (found) return found;
    }
    return null;
  }

  function throttledPost(postId) {
    const now = Date.now();
    const prev = recentByPost.get(postId) || 0;
    if (now - prev < cfg.DEDUPE_WINDOW_MS) return false;
    recentByPost.set(postId, now);
    // light cleanup
    if (recentByPost.size > 200) {
      for (const [k, t] of recentByPost) {
        if (now - t > cfg.DEDUPE_WINDOW_MS * 5) recentByPost.delete(k);
      }
    }
    return true;
  }

  // ---- main click handler -------------------------------------------------

  function handleLikeClick(event) {
    let btn;
    try {
      btn = isLikeButton(event.target);
    } catch (e) { return; }
    if (!btn) return;

    const postEl = findPostElement(btn);
    if (!postEl) { NS.warn('like click without a post element'); return; }

    const postId = getPostId(postEl);
    if (!postId) { NS.warn('could not resolve postId'); return; }

    if (!throttledPost(postId)) { NS.log('throttled duplicate click', postId); return; }

    const before = isPostLiked(postEl, btn);
    const topicId = getTopicId();
    const target = getTargetUser(postEl);

    // Let NodeBB process the vote (DOM may re-render), then compare.
    setTimeout(() => {
      let after;
      try {
        const freshBtn = reLocateButton(postEl) || btn;
        after = isPostLiked(postEl, freshBtn);
      } catch (e) {
        NS.warn('post-click read failed', e);
        return;
      }

      let action = null;
      if (!before && after) action = 'increment';
      else if (before && !after) action = 'decrement';

      if (!action) { NS.log('no liked-state change for', postId); return; }

      const payload = {
        action,
        postId: String(postId),
        topicId: topicId ? String(topicId) : null,
        targetUserId: target.targetUserId ? String(target.targetUserId) : null,
        targetUsername: target.targetUsername || null,
        clientEventId: (crypto.randomUUID && crypto.randomUUID()) ||
          ('ev-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
        createdAt: new Date().toISOString(),
      };
      NS.log('detected', payload);
      try { onEvent(payload); } catch (e) { NS.warn('onEvent failed', e); }
    }, cfg.LIKE_SETTLE_MS);
  }

  NS.detector = {
    init(handler) {
      if (typeof handler === 'function') onEvent = handler;
      if (started) return;
      started = true;
      // capture=true so we still see the click even if the theme stops propagation.
      document.addEventListener('click', handleLikeClick, true);
      NS.log('detector started');
    },
    // exposed for testing / debugging
    _internals: { isLikeButton, findPostElement, getPostId, getTopicId, getTargetUser, isPostLiked },
  };
})();
