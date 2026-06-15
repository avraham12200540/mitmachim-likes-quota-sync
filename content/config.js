/*
 * config.js - single source of truth for tunable values and DOM selectors.
 *
 * Everything that is likely to need adjusting when mitmachim.top changes its
 * markup lives here, so the rest of the code never has to be touched.
 *
 * Content scripts share one isolated "world", so every module hangs off the
 * same window.MTLQ namespace (load order is defined in manifest.json).
 */
(function () {
  'use strict';

  const NS = (window.MTLQ = window.MTLQ || {});

  NS.config = {
    // --- server ---
    // Default API origin. Can be overridden at runtime via chrome.storage.local
    // (key STORAGE_API_BASE) without rebuilding the extension - see the popup.
    API_BASE_URL: 'https://api.extsync.com',
    API_PREFIX: '/api/likes-quota',

    // --- quota limits (display defaults; the SERVER is the source of truth) ---
    DAILY_LIMIT: 20,
    PER_USER_LIMIT: 6,

    // --- timing ---
    POLL_INTERVAL_MS: 15000, // pull fresh state every 15s to sync across machines
    LIKE_SETTLE_MS: 700,     // wait after a click before reading the new liked-state
    DEDUPE_WINDOW_MS: 2000,  // ignore repeat clicks on the same post within this window

    // --- misc ---
    DEBUG: false,            // flip to true (or set storage MTLQ_DEBUG=true) for verbose logs
    MIN_WIDTH_PX: 1024,      // below this viewport width the widget hides itself (CSS too)

    // --- chrome.storage keys ---
    STORAGE_CACHE: 'likesQuotaCache',
    STORAGE_TOKEN: 'MTLQ_AUTH_TOKEN',
    STORAGE_API_BASE: 'MTLQ_API_BASE_URL',
    STORAGE_DEV_USER: 'MTLQ_DEV_QUOTA_USER',
    STORAGE_DEBUG: 'MTLQ_DEBUG',

    // --- postMessage type used between the page-probe and the content script ---
    PROBE_REQUEST: 'MT_LIKES_USER_REQUEST',
    PROBE_RESPONSE: 'MT_LIKES_USER_DATA',

    /*
     * SELECTORS - adjust these if mitmachim.top / NodeBB markup differs.
     * Each list is tried in order; the first match wins.
     */
    selectors: {
      // A click anywhere inside one of these counts as a "like button" click.
      likeButton: [
        '[component="post/upvote"]',
        '[data-action="upvote"]',
        '.upvote',
        '.post-vote',
        '.votes .up',
        '.fa-thumbs-up',
        '.fa-heart',
      ],
      // The post container an event bubbled up from.
      post: [
        '[data-pid]',
        '[component="post"]',
        '.post-row',
        '.topic-post',
      ],
      // Attributes to read the numeric post id from (first present wins).
      postIdAttrs: ['data-pid', 'data-post-id', 'data-id'],
      // Attributes that may hold the author's numeric uid / slug on the post.
      authorUidAttrs: ['data-uid'],
      authorSlugAttrs: ['data-userslug'],
      // A link to the author's profile inside the post.
      authorLink: 'a[href*="/user/"], a[href*="/uid/"], [itemprop="author"] a',
      // Class/aria hints that mean "this post is currently liked by me".
      likedClassHints: ['upvoted', 'voted', 'active', 'btn-primary', 'text-primary', 'liked'],
    },
  };

  // --- tiny debug logger (silent unless DEBUG) -----------------------------
  NS._debug = NS.config.DEBUG;
  NS.log = function () {
    if (NS._debug) console.log.apply(console, ['[MTLQ]'].concat([].slice.call(arguments)));
  };
  NS.warn = function () {
    if (NS._debug) console.warn.apply(console, ['[MTLQ]'].concat([].slice.call(arguments)));
  };
})();
