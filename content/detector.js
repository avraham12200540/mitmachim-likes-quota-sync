/*
 * detector.js - two jobs, both built on a single delegated click listener:
 *
 *  1) ENFORCE: when the meter is already at the daily limit (or the per-user
 *     limit for this post's author), block a NEW like before it reaches the
 *     forum and tell the user. Un-likes are never blocked. This is safe because
 *     the meter is derived from the forum and can only undercount, so "at the
 *     limit" means the forum is really at the limit too.
 *
 *  2) REFRESH: after any real (non-blocked) like/un-like click, ask the
 *     orchestrator to re-sync from the forum. We do NOT count clicks anymore -
 *     the server derives the true count from the user's forum upvote list.
 *
 * API: MTLQ.detector.init({ getState, onActivity, onBlocked })
 *   getState()  -> latest meter state {likesToday, dailyLimit, perUserLimit, targetUsers}
 *   onActivity()-> called shortly after a real click so the page re-syncs
 *   onBlocked(kind, info) -> kind is 'daily' | 'peruser'
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});
  const cfg = NS.config;
  const sel = cfg.selectors;

  let started = false;
  let getState = () => null;
  let onActivity = () => {};
  let onBlocked = () => {};

  const recentByPost = new Map(); // postId -> ts (throttle refresh bursts)

  function matchesAny(el, list) {
    if (!el || !el.closest) return null;
    for (const s of list) {
      const hit = el.closest(s);
      if (hit) return hit;
    }
    return null;
  }

  const isLikeButton = (el) => matchesAny(el, sel.likeButton);
  const findPostElement = (el) => matchesAny(el, sel.post);

  function getPostId(postEl) {
    if (!postEl) return null;
    for (const a of sel.postIdAttrs) {
      const v = postEl.getAttribute && postEl.getAttribute(a);
      if (v) return String(v);
    }
    const nested = postEl.querySelector && postEl.querySelector('[data-pid]');
    return nested ? String(nested.getAttribute('data-pid')) : null;
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
    out.targetUserId =
      readAttr(postEl, sel.authorUidAttrs) ||
      (postEl.querySelector && readAttr(postEl.querySelector('[data-uid]'), ['data-uid'])) ||
      null;
    let slug = readAttr(postEl, sel.authorSlugAttrs);
    const link = postEl.querySelector && postEl.querySelector(sel.authorLink);
    if (link) {
      const href = link.getAttribute('href') || '';
      const ms = href.match(/\/user\/([^/?#]+)/);
      const mu = href.match(/\/uid\/(\d+)/);
      if (!slug && ms) slug = decodeURIComponent(ms[1]);
      if (!out.targetUserId && mu) out.targetUserId = mu[1];
      const txt = (link.textContent || '').trim();
      if (txt) out.targetUsername = txt;
    }
    if (!out.targetUsername && slug) out.targetUsername = slug;
    return out;
  }

  function isPostLiked(postEl, buttonEl) {
    const candidates = [];
    if (buttonEl) candidates.push(buttonEl);
    if (postEl && postEl.querySelector) {
      for (const s of sel.likeButton) {
        const f = postEl.querySelector(s);
        if (f) candidates.push(f);
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

  function throttled(postId) {
    const now = Date.now();
    if (now - (recentByPost.get(postId) || 0) < cfg.DEDUPE_WINDOW_MS) return false;
    recentByPost.set(postId, now);
    if (recentByPost.size > 200) {
      for (const [k, t] of recentByPost) {
        if (now - t > cfg.DEDUPE_WINDOW_MS * 5) recentByPost.delete(k);
      }
    }
    return true;
  }

  function handleClick(event) {
    let btn;
    try { btn = isLikeButton(event.target); } catch (e) { return; }
    if (!btn) return;

    const postEl = findPostElement(btn);
    if (!postEl) return;

    let alreadyLiked = false;
    try { alreadyLiked = isPostLiked(postEl, btn); } catch (e) { /* assume not */ }

    // Only NEW likes are subject to limits; un-likes always pass through.
    if (!alreadyLiked) {
      const st = getState() || {};
      const limit = st.dailyLimit || cfg.DAILY_LIMIT;
      const today = Number(st.likesToday) || 0;
      if (today >= limit) {
        event.preventDefault();
        event.stopImmediatePropagation();
        NS.log('blocked: daily limit', today, '/', limit);
        try { onBlocked('daily', { limit }); } catch (e) { /* ignore */ }
        return;
      }
      const perUser = st.perUserLimit || cfg.PER_USER_LIMIT;
      const target = getTargetUser(postEl);
      const tu = (st.targetUsers && target.targetUserId && st.targetUsers[target.targetUserId]) || null;
      if (tu && Number(tu.count) >= perUser) {
        event.preventDefault();
        event.stopImmediatePropagation();
        NS.log('blocked: per-user limit', target.targetUserId);
        try { onBlocked('peruser', { perUser, username: target.targetUsername || (tu && tu.username) }); } catch (e) { /* ignore */ }
        return;
      }
    }

    // Real activity (like or un-like): let the forum process it, then re-sync.
    const postId = getPostId(postEl) || ('el-' + Math.random().toString(36).slice(2));
    if (!throttled(postId)) return;
    setTimeout(() => { try { onActivity(); } catch (e) { /* ignore */ } }, cfg.LIKE_SETTLE_MS);
  }

  NS.detector = {
    init(handlers) {
      handlers = handlers || {};
      if (typeof handlers.getState === 'function') getState = handlers.getState;
      if (typeof handlers.onActivity === 'function') onActivity = handlers.onActivity;
      if (typeof handlers.onBlocked === 'function') onBlocked = handlers.onBlocked;
      if (started) return;
      started = true;
      document.addEventListener('click', handleClick, true); // capture: block before NodeBB
      NS.log('detector started (enforce + refresh)');
    },
    _internals: { isLikeButton, findPostElement, getPostId, getTargetUser, isPostLiked },
  };
})();
