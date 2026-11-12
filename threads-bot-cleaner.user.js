// ==UserScript==
// @name         Threads Bot-Cleaner
// @namespace    https://github.com/DieDaddelecke/threads-bot-cleaner
// @author       DieDaddelecke
// @homepageURL  https://github.com/DieDaddelecke/threads-bot-cleaner
// @supportURL   https://github.com/DieDaddelecke/threads-bot-cleaner/issues
// @updateURL    https://raw.githubusercontent.com/DieDaddelecke/threads-bot-cleaner/main/threads-bot-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/DieDaddelecke/threads-bot-cleaner/main/threads-bot-cleaner.user.js
// @license      MIT
// @version      0.8.1
// @description  Bot-Follower auf Threads finden, prüfen und gedrosselt blockieren / Find, review and throttled-block bot followers on Threads.
// @match        https://www.threads.com/*
// @match        https://www.threads.net/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

/*
 * Funktionsweise
 * 1. Das Script liest die Anfragen mit, die die Threads-Weboberfläche selbst schickt.
 * 2. Lernschritt 1: Du öffnest die Follower-Liste deines Profils und scrollst etwas → die
 *    Follower-Abfrage wird gemerkt.
 * 3. „Follower scannen“ lädt damit alle Follower und bewertet sie (Bot-Score).
 * 4. Lernschritt 2: Du blockst einen Bot einmal per Hand → die Block-Aktion wird gemerkt.
 * 5. Danach blockt das Script per Klick oder Bulk, gedrosselt über eine Warteschlange.
 * Sitzungs-Tokens (fb_dtsg, lsd …) werden NIE gespeichert, nur im Speicher der offenen Seite gehalten.
 */

(function () {
  'use strict';

  const W = window;
  if (W.__TBC__) return;

  const VERSION = '0.8.1';
  const NS = 'tbc:';
  const PH = '__TBC_TARGET__';
  const API_RE = /\/(api\/)?graphql|\/api\/v1\//i;
  const TOKEN_KEYS = ['fb_dtsg', 'lsd', 'jazoest'];
  const META_PARAM_RE = /^(doc_id|__.*|fb_.*|jazoest|lsd|server_timestamps|variables|av|dpr)$/;
  const DEFAULT_PIC_RE = /44884218_345707102882519_2446069589734326272_n|anonymous_profile|default_profile/i;
  const SPAM_RE = /(crypto|bitcoin|\bbtc\b|forex|trading|investor|onlyfans|giveaway|airdrop|\bnft\b|sugar ?(daddy|mommy|baby)|dm me|whatsapp|telegram|cash ?app|💰|📈|🔞)/i;
  const DEFAULTS = { threshold: 50, minDelay: 20, maxDelay: 40, dailyLimit: 100, autoResume: true, autoCheck: true, checkParallel: 3, checkDelay: 1, skipClear: true };

  /* ---------------------------------------------------------------- storage */

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { console.warn('[TBC] Speichern fehlgeschlagen', k, e); }
    },
  };

  const S = {
    settings: Object.assign({}, DEFAULTS, store.get('settings', {})),
    followerTpl: store.get('followerTpl', null),
    blockTpl: store.get('blockTpl', null),
    users: store.get('users', {}),
    whitelist: new Set(store.get('whitelist', [])),
    blocked: store.get('blocked', {}),
    failed: store.get('failed', {}),
    queue: store.get('queue', []),
    queueActive: store.get('queueActive', false),
    stats: store.get('stats', { day: '', count: 0 }),
    pausedUntil: store.get('pausedUntil', 0),
    lastScan: store.get('lastScan', null),
    prevScanTs: store.get('prevScanTs', 0),
    log: store.get('log', []),
    tokens: {},
    captured: [],
    selected: new Set(),
    filter: { q: '', onlySus: true, onlyNew: false, showDone: false },
    running: false,
    scanning: false,
    stopScan: false,
    scanInfo: '',
    checking: false,
    stopCheck: false,
    checkInfo: '',
    nextAt: 0,
    warnedOtherProfile: false,
    resumeTimer: null,
  };

  const saveUsersSoon = debounce(() => store.set('users', S.users), 800);

  function persist(...keys) {
    for (const k of keys) {
      if (k === 'whitelist') store.set(k, [...S.whitelist]);
      else if (k === 'users') saveUsersSoon();
      else store.set(k, S[k]);
    }
  }

  /* ---------------------------------------------------------------- helpers */

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function nextMidnight() { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime() + Math.round(rand(5, 35) * 60e3); }
  function fmtTime(ts) {
    return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtN(n) { return n == null ? '–' : n >= 10000 ? Math.round(n / 1000) + 'k' : String(n); }
  function absUrl(u) { try { return new URL(u, location.href).toString(); } catch (e) { return String(u); } }
  function shortUrl(u) { try { return new URL(u).pathname; } catch (e) { return String(u).split('?')[0]; } }
  function currentProfile() {
    const m = location.pathname.match(/^\/@([^/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }
  function safeJSON(s) { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } }
  function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  function isJsonBody(b) { return typeof b === 'string' && /^\s*[{[]/.test(b); }
  function jazoest(t) { let s = 0; for (let i = 0; i < t.length; i++) s += t.charCodeAt(i); return '2' + s; }

  function log(msg, level) {
    S.log.push({ t: Date.now(), m: msg, l: level || 'info' });
    if (S.log.length > 150) S.log.splice(0, S.log.length - 150);
    persist('log');
    console.log('[TBC]', msg);
    UI.dirty('log');
  }

  function parseJSONLoose(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.replace(/^\s*for\s*\(;;\);/, '').trim();
    if (!t) return null;
    const one = safeJSON(t);
    if (one) return one;
    const out = [];
    for (const line of t.split(/\r?\n/)) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      const j = safeJSON(l);
      if (j) out.push(j);
    }
    if (!out.length) return null;
    return out.length === 1 ? out[0] : { __multi: out };
  }

  function walk(root, visit, maxNodes) {
    const limit = maxNodes || 60000;
    const stack = [root];
    const seen = new Set();
    let n = 0;
    while (stack.length && n++ < limit) {
      const o = stack.pop();
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      if (visit(o) === false) continue;
      const keys = Object.keys(o);
      for (let i = keys.length - 1; i >= 0; i--) {
        const v = o[keys[i]];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }

  /* ------------------------------------------------------- request hooks */

  const origFetch = W.fetch ? W.fetch.bind(W) : null;

  function bodyToString(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const p = new URLSearchParams();
      for (const [k, v] of body.entries()) if (typeof v === 'string') p.append(k, v);
      return p.toString();
    }
    return '';
  }

  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { o[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) h.forEach(([k, v]) => { o[String(k).toLowerCase()] = v; });
    else for (const k of Object.keys(h)) o[k.toLowerCase()] = h[k];
    return o;
  }

  if (origFetch) {
    W.fetch = function (input, init) {
      let url = '';
      let method = 'GET';
      let headers = {};
      let bodyP = Promise.resolve('');
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url; method = input.method; headers = headersToObj(input.headers);
          if (!(init && init.body) && method !== 'GET' && method !== 'HEAD') bodyP = input.clone().text().catch(() => '');
        } else {
          url = String(input);
        }
        if (init) {
          if (init.method) method = init.method;
          if (init.headers) headers = Object.assign(headers, headersToObj(init.headers));
          if (init.body != null) bodyP = Promise.resolve(bodyToString(init.body));
        }
      } catch (e) { /* ignore */ }
      const p = origFetch(input, init);
      if (url && API_RE.test(url)) {
        p.then((res) => Promise.all([res.clone().text(), bodyP]).then(([text, body]) => {
          onCaptured({ url: absUrl(url), method: String(method).toUpperCase(), headers, body: body || '' }, res.status, text);
        })).catch(() => {});
      }
      return p;
    };
  }

  if (W.XMLHttpRequest) {
    const XP = W.XMLHttpRequest.prototype;
    const xOpen = XP.open; const xSend = XP.send; const xSet = XP.setRequestHeader;
    XP.open = function (m, u) {
      this.__tbc = { method: String(m).toUpperCase(), url: String(u), headers: {} };
      return xOpen.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      if (this.__tbc) this.__tbc.headers[String(k).toLowerCase()] = v;
      return xSet.apply(this, arguments);
    };
    XP.send = function (body) {
      const meta = this.__tbc;
      if (meta && API_RE.test(meta.url)) {
        meta.body = bodyToString(body);
        this.addEventListener('load', () => {
          try {
            let text = '';
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            onCaptured({ url: absUrl(meta.url), method: meta.method, headers: meta.headers, body: meta.body }, this.status, text);
          } catch (e) { console.warn('[TBC] xhr', e); }
        });
      }
      return xSend.apply(this, arguments);
    };
  }

  function onCaptured(req, status, text) {
    try {
      const p = req.body && !isJsonBody(req.body) ? new URLSearchParams(req.body) : null;
      if (p && p.get('fb_dtsg')) {
        S.tokens.fb_dtsg = p.get('fb_dtsg');
        S.tokens.jazoest = p.get('jazoest') || jazoest(S.tokens.fb_dtsg);
      }
      if (p && p.get('lsd')) S.tokens.lsd = p.get('lsd');
      if (req.headers['x-fb-lsd']) S.tokens.lsd = req.headers['x-fb-lsd'];

      const fname = req.headers['x-fb-friendly-name'] || (p && p.get('fb_api_req_friendly_name')) || '';
      S.captured.unshift({
        t: Date.now(), method: req.method, url: req.url, friendly: fname, status, req,
        text: text && text.length < 3e6 ? text : '',
      });
      if (S.captured.length > 40) S.captured.length = 40;

      if (isFollowerReq(req, fname)) handleFollowerResponse(req, fname, text, false);
      if (isBlockReq(req, fname)) handleBlockRequest(req, fname, status, text, false);
      UI.dirty('setup', 'debug');
    } catch (e) {
      console.warn('[TBC] capture', e);
    }
  }

  function scrapeTokensFromHtml() {
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const d = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || html.match(/"dtsg":\{"token":"([^"]+)"/);
      const l = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
      if (d && !S.tokens.fb_dtsg) { S.tokens.fb_dtsg = d[1]; S.tokens.jazoest = jazoest(d[1]); }
      if (l && !S.tokens.lsd) S.tokens.lsd = l[1];
      UI.dirty('setup');
    } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------- templates */

  function makeTemplate(req, fname) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (/^(cookie|content-length|host|origin|referer|user-agent)$/.test(k)) continue;
      headers[k] = (k === 'x-fb-lsd' || k === 'x-csrftoken') ? '' : v; // Tokens nicht speichern
    }
    let body = req.body || '';
    const form = !!body && !isJsonBody(body);
    const tokenKeys = [];
    if (form) {
      const p = new URLSearchParams(body);
      for (const k of TOKEN_KEYS) if (p.has(k)) { tokenKeys.push(k); p.delete(k); }
      body = p.toString();
    }
    return { url: req.url, method: req.method || 'POST', headers, body, form, tokenKeys, friendly: fname || '', learnedAt: Date.now() };
  }

  function getVars(tpl) {
    if (tpl.form) return safeJSON(new URLSearchParams(tpl.body).get('variables'));
    if (isJsonBody(tpl.body)) {
      const b = safeJSON(tpl.body);
      if (!b || b.variables == null) return null;
      return typeof b.variables === 'string' ? safeJSON(b.variables) : b.variables;
    }
    try { return safeJSON(new URL(tpl.url).searchParams.get('variables')); } catch (e) { return null; }
  }

  function withVars(tpl, vars) {
    const t = Object.assign({}, tpl);
    if (tpl.form) {
      const p = new URLSearchParams(tpl.body); p.set('variables', JSON.stringify(vars)); t.body = p.toString();
    } else if (isJsonBody(tpl.body)) {
      const b = safeJSON(tpl.body);
      b.variables = typeof b.variables === 'string' ? JSON.stringify(vars) : vars;
      t.body = JSON.stringify(b);
    } else {
      const u = new URL(tpl.url); u.searchParams.set('variables', JSON.stringify(vars)); t.url = u.toString();
    }
    return t;
  }

  async function replay(tpl) {
    if (!origFetch) throw new Error('fetch nicht verfügbar');
    const headers = Object.assign({}, tpl.headers);
    if ('x-csrftoken' in headers) {
      const csrf = getCookie('csrftoken');
      if (csrf) headers['x-csrftoken'] = csrf; else delete headers['x-csrftoken'];
    }
    if ('x-fb-lsd' in headers) {
      if (!S.tokens.lsd) return { ok: false, status: 0, text: '', json: null, notoken: true };
      headers['x-fb-lsd'] = S.tokens.lsd;
    }
    let body = tpl.body;
    if (tpl.form && tpl.tokenKeys && tpl.tokenKeys.length) {
      const p = new URLSearchParams(body);
      for (const k of tpl.tokenKeys) {
        let v = S.tokens[k];
        if (!v && k === 'jazoest' && S.tokens.fb_dtsg) v = jazoest(S.tokens.fb_dtsg);
        if (!v) return { ok: false, status: 0, text: '', json: null, notoken: true };
        p.set(k, v);
      }
      body = p.toString();
    }
    const init = { method: tpl.method || 'POST', headers, credentials: 'include' };
    if (init.method !== 'GET' && init.method !== 'HEAD') init.body = body;
    const res = await origFetch(tpl.url, init);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: parseJSONLoose(text) };
  }

  function hasErrors(j) {
    const check = (x) => x && Array.isArray(x.errors) && x.errors.length > 0 && !x.data;
    return j.__multi ? j.__multi.some(check) : check(j);
  }

  function classify(res) {
    if (res.notoken) return 'notoken';
    const t = (res.text || '').slice(0, 20000).toLowerCase();
    const j = res.json;
    const failish = !res.ok || !!(j && (j.status === 'fail' || hasErrors(j)));
    if (res.status === 429) return 'ratelimit';
    if (failish && /feedback_required|rate.?limit|too many|try again later|wait a few minutes|spam|checkpoint|challenge_required/.test(t)) return 'ratelimit';
    if (res.status === 401 || res.status === 403 || (failish && /login_required|not logged|please log in|csrf/.test(t))) return 'auth';
    if (!res.ok) return 'http';
    if (failish) return 'apierror';
    if (!j) return 'nojson';
    return 'ok';
  }

  /* ------------------------------------------------ follower extraction */

  function isFollowerReq(req, fname) {
    return /follower/i.test(fname) || /\/friendships\/\d+\/followers/i.test(req.url);
  }

  function findUser(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.username === 'string') return node;
    let f = null;
    walk(node, (o) => {
      if (f) return false;
      if (typeof o.username === 'string' && (o.pk != null || o.id != null || o.pk_id != null)) { f = o; return false; }
      return true;
    }, 300);
    return f;
  }

  function normUser(u) {
    if (!u || typeof u.username !== 'string') return null;
    const pk = u.pk != null ? u.pk : (u.pk_id != null ? u.pk_id : null);
    const gid = u.id != null ? u.id : null;
    const id = String(pk != null ? pk : (gid != null ? gid : ''));
    if (!id) return null;
    const pic = u.profile_pic_url || (u.hd_profile_pic_versions && u.hd_profile_pic_versions[0] && u.hd_profile_pic_versions[0].url) || '';
    let bio = null;
    if (typeof u.biography === 'string') bio = u.biography;
    else if (u.text_app_biography && typeof u.text_app_biography === 'object') {
      const parts = [];
      walk(u.text_app_biography, (o) => { if (typeof o.plaintext === 'string') parts.push(o.plaintext); return true; }, 500);
      bio = parts.join('');
    }
    const fs = u.friendship_status || null;
    const out = {
      id,
      pk: pk != null ? String(pk) : null,
      gid: gid != null ? String(gid) : null,
      username: u.username,
      name: u.full_name || '',
      pic,
      anonPic: u.has_anonymous_profile_picture === true || (!!pic && DEFAULT_PIC_RE.test(pic)) || ('profile_pic_url' in u && !u.profile_pic_url),
      verified: !!(u.is_verified || u.text_post_app_is_verified),
      private: !!(u.text_post_app_is_private != null ? u.text_post_app_is_private : u.is_private),
      followers: num(u.follower_count),
      following: num(u.following_count),
      posts: num(u.text_post_app_thread_count != null ? u.text_post_app_thread_count : u.thread_count),
      bio,
      links: Array.isArray(u.bio_links) ? u.bio_links.length : null,
      iFollow: fs ? !!fs.following : null,
    };
    return out;
  }

  function extractPage(json) {
    const roots = json && json.__multi ? json.__multi : [json];
    const raw = [];
    let cursor = null; let hasNext = null; let mode = null;
    for (const r of roots) {
      if (!r || typeof r !== 'object') continue;
      if (Array.isArray(r.users)) {
        raw.push(...r.users);
        mode = 'rest';
        if (r.next_max_id != null && r.next_max_id !== '') { cursor = String(r.next_max_id); hasNext = true; } else hasNext = false;
        continue;
      }
      walk(r, (o) => {
        if (Array.isArray(o.edges) && (o.page_info || o.pageInfo)) {
          const pi = o.page_info || o.pageInfo;
          for (const e of o.edges) { const u = findUser(e && (e.node || e)); if (u) raw.push(u); }
          const c = pi.end_cursor != null ? pi.end_cursor : pi.endCursor;
          const h = pi.has_next_page != null ? pi.has_next_page : pi.hasNextPage;
          if (c != null) cursor = c;
          if (h != null) hasNext = !!h;
          mode = 'relay';
          return false;
        }
        return true;
      });
    }
    const users = raw.map(normUser).filter(Boolean);
    return { users, cursor, hasNext, mode };
  }

  function mergeUsers(list, seenSet) {
    const now = Date.now();
    let added = 0;
    for (const nu of list) {
      if (!nu) continue;
      const old = S.users[nu.id];
      if (old) {
        for (const k of Object.keys(nu)) if (nu[k] !== null && nu[k] !== undefined) old[k] = nu[k];
        old.gone = false;
      } else {
        nu.firstSeen = now; nu.gone = false;
        S.users[nu.id] = nu;
        added++;
      }
      if (seenSet) seenSet.add(nu.id);
    }
    persist('users');
    UI.dirty('table');
    return added;
  }

  function detectPaging(tpl, page) {
    if (page.mode === 'rest') return { mode: 'rest', key: 'max_id', hasKey: true };
    const vars = getVars(tpl);
    if (!vars || typeof vars !== 'object') return { mode: 'relay', key: 'after', hasKey: false };
    const key = ['after', 'cursor', 'end_cursor', 'max_id'].find((k) => Object.prototype.hasOwnProperty.call(vars, k));
    return { mode: 'relay', key: key || 'after', hasKey: !!key };
  }

  function handleFollowerResponse(req, fname, text, manual) {
    const json = parseJSONLoose(text);
    if (!json) return false;
    const page = extractPage(json);
    if (!page.users.length) return false;
    const prof = currentProfile();
    const cur = S.followerTpl;
    if (!manual && cur && cur.profile && prof && prof !== cur.profile) {
      if (!S.warnedOtherProfile) {
        log('Follower-Liste von @' + prof + ' ignoriert (gelernt ist @' + cur.profile + ').', 'warn');
        S.warnedOtherProfile = true;
      }
      return false;
    }
    mergeUsers(page.users);
    const tpl = makeTemplate(req, fname);
    tpl.profile = prof || (cur && cur.profile) || null;
    tpl.paging = detectPaging(tpl, page);
    const curPaging = !!(cur && cur.paging && cur.paging.hasKey);
    const better = manual || !cur
      || (tpl.paging.hasKey && !curPaging)
      || (cur.friendly === tpl.friendly && cur.url === tpl.url && (tpl.paging.hasKey || !curPaging));
    if (better) {
      const isNew = !cur || manual || cur.friendly !== tpl.friendly || curPaging !== tpl.paging.hasKey;
      S.followerTpl = tpl;
      persist('followerTpl');
      if (isNew) {
        log('Follower-Abfrage gelernt (' + (tpl.friendly || shortUrl(tpl.url)) + ')' +
          (tpl.paging.hasKey ? ' – bereit zum Scannen.' : ' – Blättern noch unklar, bitte in der Liste weiter nach unten scrollen.'), 'ok');
      }
    }
    return true;
  }

  function buildFollowerReq(tpl, cursor) {
    const pg = tpl.paging || {};
    if (pg.mode === 'rest') {
      const u = new URL(tpl.url);
      if (cursor) u.searchParams.set('max_id', cursor); else u.searchParams.delete('max_id');
      return Object.assign({}, tpl, { url: u.toString() });
    }
    const vars = getVars(tpl);
    if (!vars || typeof vars !== 'object') return tpl;
    const key = pg.key || 'after';
    if (cursor) vars[key] = cursor;
    else if (Object.prototype.hasOwnProperty.call(vars, key)) vars[key] = null;
    return withVars(tpl, vars);
  }

  /* ------------------------------------------------------------ scoring */

  function looksRandom(username) {
    const letters = username.toLowerCase().replace(/[^a-z]/g, '');
    if (letters.length < 6) return false;
    const vowels = (letters.match(/[aeiouy]/g) || []).length;
    return vowels / letters.length < 0.2 || /[bcdfghjklmnpqrstvwxz]{5,}/.test(letters);
  }

  function translit(s, umlautAsE) {
    let t = String(s || '').toLowerCase();
    t = umlautAsE ? t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue') : t.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u');
    return t.replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // „Max Mustermann“ ↔ max.mustermann / maxmustermann / max_mustermann – typisches Muster von Bot-Farmen
  function nameSchema(u) {
    const parts = (u.name || '').trim().split(/\s+/);
    if (parts.length !== 2 || !parts.every((p) => /^\p{Lu}\p{Ll}+(-\p{Lu}\p{Ll}+)?$/u.test(p))) return false;
    const un = (u.username || '').toLowerCase().replace(/[._\d]/g, '');
    return [true, false].some((e) => translit(parts.join(''), e).replace(/[^a-z]/g, '') === translit(un, e).replace(/[^a-z]/g, ''));
  }

  function score(u) {
    if (u.verified) return { s: 0, r: ['verifiziert'] };
    if (u.iFollow) return { s: 0, r: ['du folgst zurück'] };
    const r = [];
    let s = 0;
    const name = u.username || '';
    const digits = (name.match(/\d/g) || []).length;
    if (u.anonPic) { s += 30; r.push('kein Bild'); }
    if (/\d{4,}$/.test(name)) { s += 20; r.push('Ziffern hinten'); }
    else if (digits >= 4) { s += 12; r.push(digits + ' Ziffern'); }
    if (/^\d{3,}/.test(name)) { s += 10; r.push('Ziffern vorne'); }
    if (looksRandom(name)) { s += 12; r.push('Zufallsname'); }
    if (!u.name) { s += 8; r.push('kein Name'); }
    else if (nameSchema(u)) { s += 10; r.push('Vorname.Nachname'); }
    if (u.posts === 0) { s += 25; r.push('keine Posts'); }
    if (u.followers != null) {
      if (u.followers === 0) { s += 20; r.push('0 Follower'); }
      else if (u.followers < 5) { s += 12; r.push('<5 Follower'); }
      if (u.following != null && u.following > 300 && u.followers * 20 < u.following) { s += 15; r.push('folgt vielen'); }
    }
    if (u.bio === '') {
      if (u.links === 0) { s += 10; r.push('Bio leer'); } else { s += 5; r.push('Bio leer'); }
    }
    if (SPAM_RE.test((u.name || '') + ' ' + (u.bio || '') + ' ' + name)) { s += 20; r.push('Spam'); }
    if (u.private) {
      s += 10; r.push('privat');
      const empty = u.posts === 0 || u.posts == null; // bei privaten Konten sind Beiträge meist nicht sichtbar
      if (empty && u.followers != null && u.followers < 5) { s += 15; r.push('privat & leer'); }
      else if (u.posts === 0) { s += 10; r.push('privat, 0 Posts'); }
    } else if (u.postsHidden) { r.push('Posts unsichtbar'); }
    if (!u.checkedAt) r.push('ungeprüft');
    return { s: Math.min(100, s), r };
  }

  /* ---------------------------------------------- profile check (enrich) */

  // Liest die öffentliche Profilseite (dieselbe, die du im Browser siehst) – keine interne API.
  function parseProfileHtml(html, username) {
    const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    const uname = String(username).toLowerCase();
    let m; let user = null; let posts = null; let lastPost = null; let hidden = false;
    while ((m = re.exec(html))) {
      const txt = m[1];
      const isProfile = !user && txt.includes('follower_count') && txt.toLowerCase().includes('"username":"' + uname + '"');
      const isThreads = txt.includes('ProfileThreadsTab');
      if (!isProfile && !isThreads) continue;
      const j = safeJSON(txt);
      if (!j) continue;
      if (isProfile) {
        walk(j, (o) => {
          if (user) return false;
          if (typeof o.username === 'string' && o.username.toLowerCase() === uname && 'follower_count' in o) { user = o; return false; }
          return true;
        });
      }
      if (isThreads) {
        walk(j, (o) => {
          if (o.mediaData && Array.isArray(o.mediaData.edges)) posts = (posts || 0) + o.mediaData.edges.length;
          if (Array.isArray(o.errors) && o.errors.some((e) => e && Array.isArray(e.path) && e.path.includes('mediaData'))) hidden = true;
          if (typeof o.taken_at === 'number') lastPost = Math.max(lastPost || 0, o.taken_at * 1000);
          return true;
        });
      }
    }
    return { user, posts, lastPost, hidden };
  }

  async function fetchProfile(username) {
    const res = await origFetch('/@' + encodeURIComponent(username), {
      credentials: 'include', headers: { accept: 'text/html,application/xhtml+xml' },
    });
    if (res.status === 429) return { rate: true, status: 429 };
    if (!res.ok) return { error: true, status: res.status };
    return parseProfileHtml(await res.text(), username);
  }

  async function sleepUnless(ms, stopFn) {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopFn()) await sleep(500);
  }

  async function checkProfiles(onlyIds) {
    if (S.checking) return;
    S.checking = true; S.stopCheck = false;
    const st = S.settings;
    const maxAge = 14 * 864e5;
    let skipped = 0;
    const ids = (onlyIds || Object.keys(S.users)).filter((id) => {
      const u = S.users[id];
      if (!u || isDone(id) || u.verified || u.iFollow) return false;
      if (onlyIds) return true;
      if (u.gone || (u.checkedAt && Date.now() - u.checkedAt <= maxAge)) return false;
      // Eindeutige Bots (Score ≥ 80 schon ohne Prüfung) brauchen keinen Seitenabruf
      if (st.skipClear && score(u).s >= 80) { skipped++; return false; }
      return true;
    });
    ids.sort((a, b) => score(S.users[b]).s - score(S.users[a]).s);
    const total = ids.length;
    let done = 0; let ok = 0; let errs = 0; let pauseUntil = 0; let aborted = false;
    const t0 = Date.now();

    const handle = (u, r) => {
      if (r.error || !r.user) {
        errs++;
        u.checkFail = (u.checkFail || 0) + 1;
        if (errs >= 8 && errs > done / 2) { aborted = true; log('Profil-Prüfung: zu viele Fehler (HTTP ' + (r.status || '?') + ') – abgebrochen.', 'err'); }
        return;
      }
      const nu = normUser(r.user);
      if (nu) for (const k of Object.keys(nu)) if (k !== 'id' && nu[k] !== null && nu[k] !== undefined) u[k] = nu[k];
      if (r.posts !== null) u.posts = r.posts;
      u.postsHidden = !!r.hidden && r.posts === null;
      if (r.lastPost) u.lastPost = r.lastPost;
      u.checkedAt = Date.now();
      u.checkFail = 0;
      ok++;
    };

    const worker = async () => {
      while (ids.length && !S.stopCheck && !aborted) {
        if (Date.now() < pauseUntil) { await sleepUnless(pauseUntil - Date.now(), () => S.stopCheck); continue; }
        const id = ids.shift();
        const u = S.users[id];
        let r;
        try { r = await fetchProfile(u.username); } catch (e) { r = { error: true, status: 0 }; }
        if (r.rate) {
          ids.unshift(id); // später nochmal
          if (Date.now() >= pauseUntil) { pauseUntil = Date.now() + 10 * 60e3; log('Meta bremst beim Profil-Prüfen – 10 Min. Pause, danach geht es weiter.', 'warn'); }
          continue;
        }
        handle(u, r);
        done++;
        const rate = done / Math.max(1, (Date.now() - t0) / 60000);
        const rest = Math.round((total - done) / Math.max(rate, 1));
        S.checkInfo = 'Profile prüfen: ' + done + '/' + total + ' · ' + Math.round(rate) + '/Min. · noch ca. ' + rest + ' Min.';
        persist('users');
        UI.dirty('bar', 'table');
        await sleep(rand(0.6, 1.4) * Math.max(0.2, st.checkDelay) * 1000);
      }
    };

    const n = Math.min(Math.max(1, Math.round(st.checkParallel || 1)), 6, Math.max(1, total));
    await Promise.all(Array.from({ length: n }, (_, k) => sleep(k * 300).then(worker)));

    S.checking = false; S.checkInfo = '';
    persist('users');
    if (total > 1 || errs) {
      log('Profil-Prüfung: ' + ok + ' geprüft' + (skipped ? ', ' + skipped + ' eindeutige übersprungen' : '') +
        (errs ? ', ' + errs + ' nicht abrufbar' : '') + ' · ' + countSuspicious() + ' verdächtig.', ok ? 'ok' : 'warn');
    }
    UI.dirty('bar', 'table');
  }


  function isDone(id) { return !!S.blocked[id] || S.whitelist.has(id); }

  function filteredRows() {
    const th = S.settings.threshold;
    const F = S.filter;
    const qset = new Set(S.queue);
    const q = F.q.trim().toLowerCase().replace(/^@/, '');
    const rows = [];
    for (const id of Object.keys(S.users)) {
      const u = S.users[id];
      if (!F.showDone && (isDone(id) || u.gone)) continue;
      const sc = score(u);
      if (F.onlySus && sc.s < th && !qset.has(id)) continue;
      if (F.onlyNew && !(u.firstSeen > S.prevScanTs)) continue;
      if (q && !(u.username.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q))) continue;
      rows.push([u, sc]);
    }
    rows.sort((a, b) => b[1].s - a[1].s || a[0].username.localeCompare(b[0].username));
    return rows;
  }

  function countSuspicious() {
    let n = 0;
    for (const id of Object.keys(S.users)) {
      const u = S.users[id];
      if (!u.gone && !isDone(id) && score(u).s >= S.settings.threshold) n++;
    }
    return n;
  }

  /* -------------------------------------------------------------- scan */

  async function scan() {
    if (S.scanning) return;
    if (!S.followerTpl) { log('Erst Lernschritt 1: Follower-Liste deines Profils öffnen und etwas scrollen.', 'warn'); return; }
    S.scanning = true; S.stopScan = false; S.scanInfo = 'Scan startet …';
    UI.dirty('bar');
    const seen = new Set();
    const scanStart = Date.now();
    let cursor = null; let pages = 0; let complete = false; let added = 0;
    try {
      while (!S.stopScan) {
        const res = await replay(buildFollowerReq(S.followerTpl, cursor));
        const c = classify(res);
        if (c === 'notoken') { S.scanInfo = 'Warte auf Sitzungs-Tokens …'; UI.dirty('bar'); await sleep(3000); continue; }
        if (c !== 'ok') { log('Scan-Fehler: ' + c + ' (HTTP ' + res.status + ').', 'err'); break; }
        const pg = extractPage(res.json);
        const before = seen.size;
        added += mergeUsers(pg.users, seen);
        pages++;
        S.scanInfo = 'Seite ' + pages + ' · ' + seen.size + ' Follower geladen';
        UI.dirty('bar');
        if (seen.size === before) {
          if (pages === 1) log('Die Antwort enthielt keine Follower – Lernschritt 1 wiederholen.', 'warn');
          else log('Blättern liefert nur Bekanntes – Follower-Abfrage evtl. neu lernen (weiter scrollen).', 'warn');
          break;
        }
        if (!pg.hasNext || !pg.cursor) { complete = true; break; }
        if (pg.cursor === cursor) { log('Blättern hängt (gleicher Cursor) – Scan beendet.', 'warn'); break; }
        cursor = pg.cursor;
        await sleep(rand(1500, 3500));
      }
    } catch (e) {
      log('Scan-Fehler: ' + e.message, 'err');
    }
    if (complete) {
      const stillThere = [];
      for (const id of Object.keys(S.users)) {
        const u = S.users[id];
        if (!seen.has(id)) u.gone = true;
        else if (S.blocked[id]) stillThere.push(u.username);
      }
      if (stillThere.length) {
        log(stillThere.length + ' als blockiert markierte Konten folgen dir noch (z. B. @' + stillThere.slice(0, 3).join(', @') +
          '). Block-Aktion ggf. neu lernen.', 'warn');
      }
      S.prevScanTs = S.lastScan ? S.lastScan.ts : 0;
      S.lastScan = { ts: scanStart, count: seen.size };
      persist('users', 'lastScan', 'prevScanTs');
      log('Scan fertig: ' + seen.size + ' Follower, ' + added + ' neu, ' + countSuspicious() + ' verdächtig.', 'ok');
      if (S.settings.autoCheck) setTimeout(() => checkProfiles(), 1500);
    } else if (S.stopScan) {
      log('Scan gestoppt nach ' + seen.size + ' Followern.', 'warn');
    }
    S.scanning = false; S.scanInfo = '';
    UI.dirty('bar', 'table', 'setup');
  }

  /* -------------------------------------------------------- block learn */

  function isBlockReq(req, fname) {
    if ((req.method || 'GET') === 'GET') return false;
    const s = (fname + ' ' + req.url).toLowerCase();
    return /block/.test(s) && !/unblock|blocked_?(list|accounts|users)|blocklist|blocking_?status|block_?status/.test(s);
  }

  function idHaystack(tpl) {
    let path = '';
    try { path = decodeURIComponent(new URL(tpl.url).pathname); } catch (e) { /* ignore */ }
    const vars = getVars(tpl);
    let extra = '';
    if (tpl.form) {
      for (const [k, v] of new URLSearchParams(tpl.body)) if (!META_PARAM_RE.test(k)) extra += k + '=' + v + '\n';
    } else if (isJsonBody(tpl.body) && !vars) {
      extra = tpl.body;
    }
    return path + '\n' + (vars ? JSON.stringify(vars) : '') + '\n' + extra;
  }

  function containsId(hay, v) {
    return new RegExp('(^|\\D)' + String(v).replace(/[^\w]/g, '\\$&') + '(?!\\d)').test(hay);
  }

  function replaceId(s, v) {
    if (!s) return s;
    return s.replace(new RegExp('(^|\\D)' + String(v).replace(/[^\w]/g, '\\$&') + '(?!\\d)', 'g'), '$1' + PH);
  }

  // Ersetzt die Ziel-ID in den *dekodierten* Werten (URL-Kodierung wie %22 würde sonst die Ziffern-Grenze stören).
  function placeTarget(tpl, value) {
    const t = Object.assign({}, tpl);
    try {
      const u = new URL(tpl.url);
      u.pathname = replaceId(decodeURIComponent(u.pathname), value);
      const q = new URLSearchParams();
      for (const [k, v] of u.searchParams) q.append(k, META_PARAM_RE.test(k) && k !== 'variables' ? v : replaceId(v, value));
      u.search = q.toString();
      t.url = u.toString().split(encodeURIComponent(PH)).join(PH);
    } catch (e) { t.url = replaceId(tpl.url, value); }
    if (tpl.form) {
      const p = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(tpl.body)) p.append(k, META_PARAM_RE.test(k) && k !== 'variables' ? v : replaceId(v, value));
      t.body = p.toString();
    } else {
      t.body = replaceId(tpl.body, value);
    }
    return t;
  }

  function findTarget(tpl, manual) {
    const hay = idHaystack(tpl);
    const own = getCookie('ds_user_id');
    const hits = new Map();
    for (const id of Object.keys(S.users)) {
      const u = S.users[id];
      for (const f of ['pk', 'gid']) {
        const v = u[f];
        if (v && v !== own && containsId(hay, v)) { hits.set(id, { userId: id, field: f, value: v, username: u.username }); break; }
      }
    }
    if (hits.size === 1) return [...hits.values()][0];
    const cands = [...new Set(hay.match(/\d{6,21}/g) || [])].filter((x) => x !== own);
    if (hits.size === 0 && cands.length === 1) return { userId: null, field: 'pk', value: cands[0], username: null };
    if (manual && cands.length) {
      const pick = W.prompt('Welche ID gehört zum blockierten Konto?\n' + cands.join('\n'), cands[0]);
      if (pick && cands.includes(pick.trim())) {
        const v = pick.trim();
        const hit = [...hits.values()].find((h) => h.value === v);
        return hit || { userId: null, field: 'pk', value: v, username: null };
      }
    }
    return null;
  }

  function handleBlockRequest(req, fname, status, text, manual) {
    if (status < 200 || status >= 300) return false;
    const res = { ok: true, status, text, json: parseJSONLoose(text) };
    if (!manual && classify(res) !== 'ok') {
      log('Block-Anfrage erkannt, aber die Antwort war ein Fehler – nicht gelernt.', 'warn');
      return false;
    }
    const raw = makeTemplate(req, fname);
    const found = findTarget(raw, manual);
    if (!found) {
      log('Block-Aktion erkannt, aber das Zielkonto ist unklar. Erst „Follower scannen“, dann einen Bot aus der Liste per Hand blockieren.', 'warn');
      return false;
    }
    const tpl = placeTarget(raw, found.value);
    if (!(tpl.url + tpl.body).includes(PH)) { log('Block-Aktion: Ziel-ID nicht ersetzbar – nicht gelernt.', 'err'); return false; }
    tpl.idField = found.field;
    tpl.sample = found.username ? '@' + found.username : found.value;
    S.blockTpl = tpl;
    persist('blockTpl');
    if (found.userId) {
      S.blocked[found.userId] = Date.now();
      S.queue = S.queue.filter((x) => x !== found.userId);
      persist('blocked', 'queue');
    }
    log('Block-Aktion gelernt (' + (tpl.friendly || shortUrl(tpl.url)) + ') – Testkonto ' + tpl.sample + '.', 'ok');
    UI.dirty('setup', 'table', 'queue');
    return true;
  }

  function fillTarget(tpl, u) {
    const v = String((tpl.idField && u[tpl.idField]) || u.pk || u.id);
    return Object.assign({}, tpl, { url: tpl.url.split(PH).join(v), body: (tpl.body || '').split(PH).join(v) });
  }

  /* -------------------------------------------------------------- queue */

  function rollDay() {
    if (S.stats.day !== today()) { S.stats = { day: today(), count: 0 }; persist('stats'); }
  }

  function enqueue(ids, front) {
    let n = 0;
    const qset = new Set(S.queue);
    const list = front ? [...ids].reverse() : ids;
    for (const id of list) {
      if (isDone(id) || qset.has(id)) continue;
      if (front) S.queue.unshift(id); else S.queue.push(id);
      qset.add(id); n++;
    }
    persist('queue');
    UI.dirty('queue', 'table');
    return n;
  }

  function startQueue() {
    if (!S.blockTpl) { log('Erst Lernschritt 2: einen Bot einmal per Hand blockieren.', 'warn'); return; }
    S.queueActive = true;
    persist('queueActive');
    runQueue();
  }

  function pauseQueue() {
    S.queueActive = false; S.running = false;
    clearTimeout(S.resumeTimer);
    persist('queueActive');
    log('Warteschlange pausiert.');
    UI.dirty('queue');
  }

  function scheduleResume(extraMs) {
    clearTimeout(S.resumeTimer);
    if (!S.queueActive || !S.queue.length) return;
    const delay = Math.max(0, S.pausedUntil - Date.now()) + (extraMs || 5000);
    S.resumeTimer = setTimeout(() => { if (S.queueActive && !S.running) runQueue(); }, delay);
  }

  async function waitMs(ms) {
    S.nextAt = Date.now() + ms;
    while (S.running && Date.now() < S.nextAt) { await sleep(500); UI.dirty('queue'); }
    S.nextAt = 0;
  }

  async function runQueue() {
    if (S.running) return;
    S.running = true;
    UI.dirty('queue');
    let errStreak = 0; let tokenWaits = 0; let keepActive = true;
    while (S.running && S.queue.length) {
      if (Date.now() < S.pausedUntil) { log('Pausiert bis ' + fmtTime(S.pausedUntil) + ' – geht dann automatisch weiter.', 'warn'); break; }
      rollDay();
      if (S.stats.count >= S.settings.dailyLimit) {
        S.pausedUntil = nextMidnight(); persist('pausedUntil');
        log('Tageslimit (' + S.settings.dailyLimit + ') erreicht – weiter ab ' + fmtTime(S.pausedUntil) + '.', 'warn');
        break;
      }
      const id = S.queue[0];
      const u = S.users[id] || { id, pk: id, username: id };
      if (isDone(id)) { S.queue.shift(); persist('queue'); continue; }

      let res;
      try { res = await replay(fillTarget(S.blockTpl, u)); } catch (e) { res = { ok: false, status: 0, text: String(e), json: null }; }
      const c = classify(res);

      if (c === 'ok') {
        S.blocked[id] = Date.now(); S.queue.shift(); S.stats.count++;
        errStreak = 0; tokenWaits = 0;
        persist('blocked', 'queue', 'stats');
        log('Blockiert: @' + u.username, 'ok');
      } else if (c === 'notoken') {
        if (++tokenWaits > 24) { log('Keine Sitzungs-Tokens – bitte die Threads-Seite neu laden.', 'err'); keepActive = false; break; }
        await sleep(5000);
        continue;
      } else if (c === 'ratelimit') {
        S.pausedUntil = Date.now() + 24 * 3600e3; persist('pausedUntil');
        log('Meta bremst (HTTP ' + res.status + ') – automatische Pause bis ' + fmtTime(S.pausedUntil) + '.', 'err');
        break;
      } else if (c === 'auth') {
        log('Sitzung ungültig (HTTP ' + res.status + ') – Seite neu laden, ggf. neu einloggen.', 'err');
        keepActive = false;
        break;
      } else {
        errStreak++;
        S.failed[id] = (S.failed[id] || 0) + 1;
        log('Fehler beim Blocken von @' + u.username + ' (' + c + ', HTTP ' + res.status + ').', 'err');
        if (S.failed[id] >= 2) { S.queue.shift(); log('@' + u.username + ' nach 2 Fehlversuchen übersprungen.', 'warn'); }
        persist('failed', 'queue');
        if (errStreak >= 3) {
          log('3 Fehler in Folge – Warteschlange gestoppt. Block-Aktion evtl. neu lernen (siehe Diagnose).', 'err');
          keepActive = false;
          break;
        }
      }
      UI.dirty('queue', 'table');
      if (S.queue.length && S.running) await waitMs(rand(S.settings.minDelay, S.settings.maxDelay) * 1000);
    }
    const wasRunning = S.running;
    S.running = false; S.nextAt = 0;
    if (!keepActive) { S.queueActive = false; persist('queueActive'); }
    if (!S.queue.length && S.queueActive) {
      S.queueActive = false; persist('queueActive');
      log('Warteschlange abgearbeitet.', 'ok');
    }
    if (wasRunning && S.queueActive) scheduleResume(rand(2, 10) * 60e3);
    UI.dirty('queue', 'table');
  }

  /* ----------------------------------------------------------------- UI */

  const CSS = `
  :host { all: initial;
    --bg: #f2f1ee; --raised: #faf9f7; --sunken: #e9e8e4; --ink: #101014; --muted: #1010149e; --faint: #1010146b;
    --line: #10101429; --line-strong: #10101466; --accent: #2d81ff; --accent-ink: #1659c4; --danger: #b3261e;
    --f-head: Archivo, "Archivo Fallback", "Helvetica Neue", Arial, sans-serif;
    --f-body: Inter, "Inter Fallback", system-ui, -apple-system, "Segoe UI", sans-serif;
    --f-mono: "Geist Mono", "Geist Mono Fallback", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  * { box-sizing: border-box; border-radius: 0 !important; font-family: var(--f-body); }
  .mono, button, .tag, .new, summary, thead th, .lbl, .tok, .more, .fab, header .ver { font-family: var(--f-mono); }

  .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; background: var(--ink); color: var(--bg); border: 0;
    padding: 12px 16px; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; cursor: pointer;
    box-shadow: 4px 4px 0 var(--accent); }
  .fab:hover { box-shadow: 2px 2px 0 var(--accent); transform: translate(2px, 2px); }
  .fab .badge { background: var(--accent); color: #fff; padding: 2px 6px; margin-left: 10px; letter-spacing: .04em; }

  .panel { position: fixed; top: 14px; right: 14px; bottom: 74px; width: min(1240px, calc(100vw - 28px)); z-index: 2147483647;
    background: var(--bg); color: var(--ink); border: .5px solid var(--line-strong); box-shadow: 10px 10px 0 rgba(16,16,20,.06);
    display: flex; flex-direction: column; font-size: 13.5px; overflow: hidden;
    background-image: repeating-linear-gradient(0deg, #10101408 0 1px, transparent 1px 3px); }
  .panel[hidden] { display: none; }
  .grip { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 3; }
  .grip::after { content: ''; position: absolute; left: 2px; top: 50%; width: 2px; height: 48px; margin-top: -24px; background: var(--line-strong); }
  .grip:hover::after, .grip.drag::after { background: var(--accent); }

  header { display: flex; align-items: stretch; border-bottom: .5px solid var(--line-strong); background: var(--raised); min-height: 54px; }
  header .mark { display: flex; align-items: center; justify-content: center; width: 54px; background: var(--ink); color: var(--bg);
    font-family: var(--f-head); font-weight: 800; font-size: 22px; }
  header b { display: flex; align-items: center; padding: 0 18px; font-family: var(--f-head); font-weight: 620; font-size: 22px; letter-spacing: -.03em; border-right: .5px solid var(--line); }
  header .ver { display: flex; align-items: center; padding: 0 16px; color: var(--muted); font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; }
  header .x { margin-left: auto; border: 0; border-left: .5px solid var(--line); width: 54px; font-size: 16px; background: transparent; }
  header .x:hover { background: var(--ink); color: var(--bg); }

  .body { overflow-y: auto; padding: 18px 22px 22px; display: flex; flex-direction: column; gap: 14px; }
  .body > * { flex-shrink: 0; }
  .lbl { font-size: 10.5px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: var(--muted);
    display: flex; align-items: center; gap: 10px; margin-top: 4px; }
  .lbl::after { content: ''; flex: 1; height: .5px; background: var(--line-strong); }
  .lbl em { font-style: normal; color: var(--ink); }
  section { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

  .setup { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: .5px solid var(--line-strong); background: var(--raised); }
  .step { display: flex; gap: 12px; align-items: flex-start; line-height: 1.5; padding: 12px 14px; }
  .step + .step { border-left: .5px solid var(--line); }
  .step .n { flex: 0 0 auto; font-family: var(--f-mono); font-size: 11px; font-weight: 700; padding: 2px 6px; border: .5px solid var(--line-strong); color: var(--muted); }
  .step.ok .n { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .tok { grid-column: 1 / -1; border-top: .5px solid var(--line); padding: 7px 14px; color: var(--muted); font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; }
  @media (max-width: 760px) { .setup { grid-template-columns: 1fr; } .step + .step { border-left: 0; border-top: .5px solid var(--line); } }

  button { background: var(--raised); color: var(--ink); border: .5px solid var(--line-strong); padding: 9px 13px; font-size: 11px; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
  button:hover:not([disabled]) { border-color: var(--ink); background: var(--sunken); }
  button[disabled] { opacity: .35; cursor: default; }
  button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  button.primary:hover:not([disabled]) { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
  button.danger:hover:not([disabled]) { background: #8f1d17; }
  button.link { background: none; border: none; color: var(--accent-ink); padding: 0 4px; font-family: var(--f-body); font-size: 12.5px; font-weight: 500;
    letter-spacing: 0; text-transform: none; text-decoration: underline; text-underline-offset: 3px; }
  button.link:hover:not([disabled]) { background: none; color: var(--accent); }
  button.sm { padding: 3px 8px; font-size: 9.5px; margin-left: 4px; }
  input[type=search], input[type=number] { background: var(--raised); color: var(--ink); border: .5px solid var(--line-strong); padding: 8px 10px; font-size: 13px; outline: none; }
  input[type=search]:focus, input[type=number]:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  input[type=number] { width: 84px; font-family: var(--f-mono); }
  input[type=checkbox], input[type=range] { accent-color: var(--ink); }
  label { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); }
  .thv { font-family: var(--f-mono); }
  .muted { color: var(--muted); }

  .queue { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 12px 14px; border: .5px solid var(--line-strong);
    background: var(--raised); border-left: 2px solid var(--accent); }
  .queue > div:last-child { grid-column: 2; grid-row: 1 / span 2; }

  .tablewrap { border: .5px solid var(--line-strong); background: var(--raised); overflow: auto; height: 46vh; min-height: 220px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { position: sticky; top: 0; background: var(--ink); color: var(--bg); text-align: left; font-weight: 600; padding: 9px 8px; font-size: 10px;
    letter-spacing: .14em; text-transform: uppercase; z-index: 1; }
  td { padding: 4px 8px; border-top: .5px solid var(--line); vertical-align: middle; }
  tbody tr:first-child td { border-top: none; }
  tr.gone { opacity: .45; }
  tbody tr { user-select: none; cursor: default; } tbody tr:hover td { background: var(--bg); }
  tbody td.who, tbody td.who * { user-select: text; }
  tbody tr:has(input[data-sel]:checked) td { background: #2d81ff14; }
  tbody tr:has(input[data-sel]:checked) td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
  .av { width: 24px; height: 24px; object-fit: cover; background: var(--sunken); display: block; border: .5px solid var(--line); }
  .who a { color: var(--ink); text-decoration: none; font-family: var(--f-head); font-weight: 620; font-size: 13px; letter-spacing: -.01em; line-height: 1.25; }
  .who a:hover { color: var(--accent-ink); }
  .sub { color: var(--muted); font-size: 11px; line-height: 1.25; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .new { background: var(--accent); color: #fff; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; padding: 1px 5px; margin-left: 6px; vertical-align: 2px; }
  .sc { display: inline-block; min-width: 34px; text-align: center; padding: 1px 5px; font-family: var(--f-mono); font-size: 13px; font-weight: 700; }
  .sc.hi { background: var(--danger); color: #fff; } .sc.mid { background: #f2b33d; color: var(--ink); } .sc.lo { background: var(--sunken); color: var(--muted); }
  .sc.top { background: #7a120d; color: #fff; }
  .why { line-height: 1.5; }
  .chip { display: inline-block; background: var(--bg); border: .5px solid var(--line); color: var(--ink); padding: 0 6px; margin: 0 4px 0 0; font-size: 11px; white-space: nowrap; line-height: 16px; }
  .chip.dim { color: var(--faint); border-style: dashed; background: transparent; }
  .who { min-width: 170px; }
  td.av-td { width: 34px; } td.sc-td { width: 48px; } td.cb { width: 28px; }
  .num { color: var(--muted); font-family: var(--f-mono); font-size: 12px; white-space: nowrap; text-align: center; }
  .act { white-space: nowrap; text-align: right; padding-right: 12px; }
  .tag { border: .5px solid var(--ink); padding: 2px 6px; font-size: 9.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .tag.ok { background: var(--ink); color: var(--bg); } .tag.q { border-color: var(--accent); color: var(--accent-ink); }
  .empty { text-align: center; color: var(--muted); padding: 32px; font-family: var(--f-head); font-size: 16px; }
  .more { color: var(--muted); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; padding: 2px 0; }
  details { border: .5px solid var(--line); background: var(--raised); padding: 0; }
  summary { cursor: pointer; color: var(--ink); font-weight: 700; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; list-style: none; padding: 11px 14px; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '+'; display: inline-block; width: 18px; color: var(--accent); }
  details[open] summary::before { content: '−'; }
  details[open] summary { border-bottom: .5px solid var(--line); }
  details > :not(summary) { margin-left: 14px; margin-right: 14px; }
  details > :last-child { margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; margin-top: 12px; }
  pre.log { white-space: pre-wrap; margin-top: 10px; max-height: 200px; overflow: auto; font: 12px/1.65 var(--f-mono); color: var(--ink); }
  .l-ok { color: var(--ink); } .l-warn { color: #8a5a00; } .l-err { color: var(--danger); font-weight: 600; }
  .cap { margin-top: 8px; font: 12px var(--f-mono); display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow: auto; }
  .cap code { color: var(--muted); font-family: var(--f-mono); }
  .warnbox { border: .5px solid var(--danger); color: var(--danger); padding: 5px 10px; }
  /* Anpassung an die Panel-Breite (nicht ans Fenster) */
  .body { container-type: inline-size; container-name: pnl; }
  td.why { white-space: nowrap; overflow: hidden; width: 100%; max-width: 0; }
  .why-in { overflow: hidden;
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent); }
  .chip.more-chip, .nums-inline { display: none; }
  .nums-inline { color: var(--muted); font-family: var(--f-mono); font-size: 10px; margin-top: 0; line-height: 1.3; }
  .act button.sm { min-width: 0; }
  @container pnl (max-width: 980px) {
    .why .chip.x { display: none; } .why .chip.m2 { display: inline-block; color: var(--muted); }
  }
  @container pnl (max-width: 820px) {
    td.av-td, th.av-th { display: none; }
    td.num, th.num-th { display: none; } .nums-inline { display: block; }
    .who { min-width: 0; } .sub { max-width: 160px; }
  }
  @container pnl (max-width: 640px) {
    .why .chip.x2, .why .chip.m2 { display: none !important; } .why .chip.m1 { display: inline-block; color: var(--muted); }
    td, thead th { padding-left: 5px; padding-right: 5px; }
    .act button.sm { padding: 5px 6px; font-size: 9.5px; letter-spacing: .06em; margin-left: 2px; }
    .setup { grid-template-columns: 1fr; } .step + .step { border-left: 0; border-top: .5px solid var(--line); }
    .queue { grid-template-columns: 1fr; } .queue > div:last-child { grid-column: 1; grid-row: auto; }
    header b { font-size: 18px; padding: 0 12px; } header .ver { display: none; }
  }
  @container pnl (max-width: 480px) {
    td.why, th.why-th { display: none; }
    .who .nums-inline::before { content: attr(data-why); display: block; color: var(--ink); font-family: var(--f-body); font-size: 11px; white-space: normal; }
  }
  `;

  const SKELETON = `
  <button class="fab" data-act="toggle">Bots<span class="badge" hidden></span></button>
  <div class="panel" hidden>
    <div class="grip" title="Ziehen = Breite ändern · Doppelklick = Standardbreite"></div>
    <header><span class="mark">@</span><b>Threads Bot-Cleaner</b><span class="ver">v${VERSION}</span><button class="x" data-act="toggle">✕</button></header>
    <div class="body">
      <div class="lbl"><em>01</em> / Einrichtung</div>
      <section class="setup"></section>
      <div class="lbl"><em>02</em> / Follower</div>
      <section class="bar"></section>
      <section class="filters">
        <label>Schwelle <input type="range" min="0" max="100" step="5" data-set="threshold"> <b class="thv"></b></label>
        <input type="search" placeholder="@name suchen" data-filter="q">
        <label><input type="checkbox" data-filter="onlySus"> nur Verdächtige</label>
        <label><input type="checkbox" data-filter="onlyNew"> nur neue</label>
        <label><input type="checkbox" data-filter="showDone"> Erledigte zeigen</label>
      </section>
      <section class="bulk">
        <button data-act="selsus">Alle Verdächtigen auswählen</button>
        <button data-act="selnone">Auswahl leeren</button>
        <button class="danger" data-act="blocksel">Ausgewählte blockieren (<span class="seln">0</span>)</button>
        <button data-act="wlsel">Ausgewählte als echt markieren</button>
      </section>
      <div class="lbl"><em>03</em> / Verdächtige Konten</div>
      <div class="tablewrap"><table>
        <thead><tr><th class="cb"><input type="checkbox" data-selall title="Sichtbare auswählen"></th><th class="av-th"></th><th>Konto</th><th>Score</th><th class="why-th">Gründe</th><th class="num-th" title="Posts / Follower / Folgt" style="text-align:center;white-space:nowrap">Posts · Fol. · Folgt</th><th></th></tr></thead>
        <tbody></tbody></table></div>
      <div class="more"></div>
      <div class="lbl"><em>04</em> / Warteschlange</div>
      <section class="queue"></section>
      <details class="settings"><summary>Einstellungen</summary>
        <div class="grid">
          <label>Pause min (s) <input type="number" min="5" data-set="minDelay"></label>
          <label>Pause max (s) <input type="number" min="5" data-set="maxDelay"></label>
          <label>Tageslimit <input type="number" min="1" data-set="dailyLimit"></label>
          <label><input type="checkbox" data-set="autoResume"> nach Neuladen fortsetzen</label>
          <label><input type="checkbox" data-set="autoCheck"> nach Scan Profile prüfen</label>
          <label>Profile parallel <input type="number" min="1" max="6" data-set="checkParallel"></label>
          <label>Pause Profil (s) <input type="number" min="0.2" step="0.1" data-set="checkDelay"></label>
          <label><input type="checkbox" data-set="skipClear"> eindeutige Bots (≥ 80) nicht prüfen</label>
        </div>
        <p class="muted">Tipp: Zeile anklicken = auswählen, Shift + Klick = alles dazwischen.</p>
        <p class="muted">Die Warteschlange läuft nur, solange ein Threads-Tab offen ist. Konservative Werte senken das Risiko von Aktionssperren.</p>
      </details>
      <details class="logbox" open><summary>Protokoll</summary><pre class="log"></pre></details>
      <details class="debug"><summary>Diagnose</summary>
        <p class="muted">Zuletzt mitgelesene Anfragen. Falls etwas nicht automatisch erkannt wurde, kannst du es hier manuell zuordnen.</p>
        <div class="cap"></div>
        <p><button data-act="copydebug">Diagnose-Info kopieren</button> <button class="danger" data-act="resetall">Alles zurücksetzen</button></p>
      </details>
    </div>
  </div>`;

  const UI = {
    host: null, root: null, open: false, parts: new Set(), timer: null, visibleIds: [],
    q(sel) { return this.root ? this.root.querySelector(sel) : null; },

    dirty(...p) {
      p.forEach((x) => this.parts.add(x));
      if (!this.root || this.timer) return;
      this.timer = setTimeout(() => { this.timer = null; this.render(); }, 200);
    },

    mount() {
      if (this.host) { if (!document.documentElement.contains(this.host)) document.documentElement.appendChild(this.host); return; }
      this.host = document.createElement('div');
      this.host.id = 'tbc-host';
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = '<style>' + CSS + '</style>' + SKELETON;
      document.documentElement.appendChild(this.host);
      this.bind();
      this.bindResize();
      this.syncInputs();
      this.dirty('all');
      setInterval(() => this.mount(), 3000);
    },

    syncInputs() {
      const st = S.settings;
      this.root.querySelectorAll('[data-set]').forEach((el) => {
        const k = el.dataset.set;
        if (el.type === 'checkbox') el.checked = !!st[k]; else el.value = st[k];
      });
      this.root.querySelectorAll('[data-filter]').forEach((el) => {
        const k = el.dataset.filter;
        if (el.type === 'checkbox') el.checked = !!S.filter[k]; else el.value = S.filter[k];
      });
      this.q('.thv').textContent = st.threshold;
    },

    bind() {
      this.root.addEventListener('click', (e) => {
        // Auswahl: Checkbox oder Klick auf die Zeile; mit Shift den Bereich seit dem letzten Klick
        const row = e.target.closest('tbody tr');
        if (row && !e.target.closest('button, a')) {
          const cb = row.querySelector('input[data-sel]');
          if (cb) {
            if (e.target !== cb) cb.checked = !cb.checked;
            this.selectRange(cb, e.shiftKey);
            return;
          }
        }
        const b = e.target.closest('[data-act],[data-block],[data-wl],[data-unwl],[data-unq],[data-capf],[data-capb],[data-chk]');
        if (!b) return;
        const d = b.dataset;
        if (d.block) { enqueue([d.block], true); startQueue(); return; }
        if (d.chk) { if (S.checking) log('Profil-Prüfung läuft bereits.', 'warn'); else checkProfiles([d.chk]); return; }
        if (d.wl) { S.whitelist.add(d.wl); S.selected.delete(d.wl); persist('whitelist'); this.dirty('table'); return; }
        if (d.unwl) { S.whitelist.delete(d.unwl); persist('whitelist'); this.dirty('table'); return; }
        if (d.unq) { S.queue = S.queue.filter((x) => x !== d.unq); persist('queue'); this.dirty('queue', 'table'); return; }
        if (d.capf) {
          const c = S.captured[+d.capf];
          if (c && !handleFollowerResponse(c.req, c.friendly, c.text, true)) log('In dieser Antwort wurden keine Follower gefunden.', 'warn');
          this.dirty('setup'); return;
        }
        if (d.capb) {
          const c = S.captured[+d.capb];
          if (c) handleBlockRequest(c.req, c.friendly, c.status, c.text, true);
          return;
        }
        switch (d.act) {
          case 'toggle':
            this.open = !this.open;
            this.q('.panel').hidden = !this.open;
            if (this.open) this.dirty('all');
            break;
          case 'scan': scan(); break;
          case 'stopscan': S.stopScan = true; break;
          case 'check': checkProfiles(); break;
          case 'stopcheck': S.stopCheck = true; break;
          case 'selsus': {
            const th = S.settings.threshold; const qset = new Set(S.queue);
            for (const [u, sc] of filteredRows()) if (sc.s >= th && !isDone(u.id) && !qset.has(u.id)) S.selected.add(u.id);
            this.dirty('table'); break;
          }
          case 'selnone': S.selected.clear(); this.dirty('table'); break;
          case 'blocksel': {
            if (!S.selected.size) break;
            const n = enqueue([...S.selected]);
            S.selected.clear();
            log(n + ' Konten in die Warteschlange gelegt.');
            startQueue();
            break;
          }
          case 'wlsel':
            for (const id of S.selected) S.whitelist.add(id);
            S.queue = S.queue.filter((x) => !S.whitelist.has(x));
            S.selected.clear();
            persist('whitelist', 'queue');
            this.dirty('table', 'queue');
            break;
          case 'qstart': startQueue(); break;
          case 'qpause': pauseQueue(); break;
          case 'qclear': S.queue = []; persist('queue'); this.dirty('queue', 'table'); break;
          case 'unpause': S.pausedUntil = 0; persist('pausedUntil'); this.dirty('queue'); break;
          case 'resetf': S.followerTpl = null; S.warnedOtherProfile = false; persist('followerTpl'); log('Follower-Abfrage zurückgesetzt.'); this.dirty('setup', 'bar'); break;
          case 'resetb': S.blockTpl = null; persist('blockTpl'); log('Block-Aktion zurückgesetzt.'); this.dirty('setup', 'queue'); break;
          case 'copydebug': copyDebug(); break;
          case 'resetall':
            if (W.confirm('Alle gespeicherten Daten des Bot-Cleaners löschen (Follower, Whitelist, Warteschlange, gelernte Anfragen)?')) {
              Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k));
              location.reload();
            }
            break;
          default: break;
        }
      });

      this.root.addEventListener('change', (e) => {
        const t = e.target; const d = t.dataset;
        if (d.sel) {
          /* über click → selectRange */
        } else if ('selall' in d) {
          for (const id of this.visibleIds) { if (t.checked) S.selected.add(id); else S.selected.delete(id); }
          this.dirty('table');
        } else if (d.set) {
          const k = d.set;
          S.settings[k] = t.type === 'checkbox' ? t.checked : Math.max(Number(t.min) || 0, Number(t.value) || DEFAULTS[k]);
          if (S.settings.maxDelay < S.settings.minDelay) S.settings.maxDelay = S.settings.minDelay;
          persist('settings');
          this.syncInputs();
          this.dirty('table', 'queue');
        } else if (d.filter && t.type === 'checkbox') {
          S.filter[d.filter] = t.checked;
          this.dirty('table');
        }
      });

      this.root.addEventListener('input', (e) => {
        const t = e.target; const d = t.dataset;
        if (d.set === 'threshold') {
          S.settings.threshold = Number(t.value);
          this.q('.thv').textContent = t.value;
          persist('settings');
          this.dirty('table');
        } else if (d.filter === 'q') {
          S.filter.q = t.value;
          this.dirty('table');
        }
      });
    },

    applyWidth() {
      const p = this.q('.panel');
      const w = S.settings.panelWidth;
      p.style.width = w ? Math.min(Math.max(480, w), W.innerWidth - 28) + 'px' : '';
    },

    bindResize() {
      const grip = this.q('.grip');
      const panel = this.q('.panel');
      this.applyWidth();
      W.addEventListener('resize', () => this.applyWidth());
      grip.addEventListener('dblclick', () => { delete S.settings.panelWidth; persist('settings'); this.applyWidth(); });
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        grip.classList.add('drag');
        const right = W.innerWidth - panel.getBoundingClientRect().right;
        const move = (ev) => {
          const w = Math.min(Math.max(480, W.innerWidth - ev.clientX - right), W.innerWidth - 28);
          panel.style.width = w + 'px';
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.classList.remove('drag');
          S.settings.panelWidth = Math.round(panel.getBoundingClientRect().width);
          persist('settings');
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up, { once: true });
        grip.addEventListener('pointercancel', up, { once: true });
      });
    },

    selectRange(cb, shift) {
      const all = [...this.root.querySelectorAll('tbody input[data-sel]')];
      const idx = all.indexOf(cb);
      const last = this.lastSel ? all.findIndex((x) => x.dataset.sel === this.lastSel) : -1;
      const targets = shift && last >= 0 ? all.slice(Math.min(idx, last), Math.max(idx, last) + 1) : [cb];
      for (const x of targets) {
        x.checked = cb.checked;
        if (cb.checked) S.selected.add(x.dataset.sel); else S.selected.delete(x.dataset.sel);
      }
      this.lastSel = cb.dataset.sel;
      this.q('.seln').textContent = S.selected.size;
    },

    render() {
      if (!this.root) return;
      const parts = this.parts; this.parts = new Set();
      const all = parts.has('all');
      if (all || parts.has('table') || parts.has('queue')) {
        const badge = this.q('.fab .badge');
        const n = S.queue.length || countSuspicious();
        badge.hidden = !n;
        badge.textContent = S.queue.length ? '⏳ ' + S.queue.length : n;
      }
      if (!this.open) { parts.forEach((p) => this.parts.add(p)); return; }
      if (all || parts.has('setup')) this.renderSetup();
      if (all || parts.has('bar') || parts.has('setup')) this.renderBar();
      if (all || parts.has('queue')) this.renderQueue();
      if (all || parts.has('table')) this.renderTable();
      if (all || parts.has('log')) this.renderLog();
      if (all || parts.has('debug')) this.renderDebug();
    },

    renderSetup() {
      const f = S.followerTpl; const b = S.blockTpl;
      const tok = !!(S.tokens.fb_dtsg || S.tokens.lsd);
      const nUsers = Object.keys(S.users).length;
      this.q('.setup').innerHTML =
        '<div class="step ' + (f ? 'ok' : '') + '"><span class="n">1</span><div><b>Follower-Abfrage:</b> ' +
        (f
          ? '✓ gelernt' + (f.profile ? ' auf @' + esc(f.profile) : '') +
            (f.paging && f.paging.hasKey ? '' : ' <span class="muted">(Blättern unklar – in der Liste weiter scrollen)</span>') +
            ' <button class="link" data-act="resetf">zurücksetzen</button>'
          : 'Öffne <b>dein eigenes</b> Profil → tippe auf „Follower“ und scrolle in der Liste ein Stück nach unten.') +
        '</div></div>' +
        '<div class="step ' + (b ? 'ok' : '') + '"><span class="n">2</span><div><b>Block-Aktion:</b> ' +
        (b
          ? '✓ gelernt (Test: ' + esc(b.sample) + ') <button class="link" data-act="resetb">zurücksetzen</button>'
          : nUsers
            ? 'Öffne das Profil eines eindeutigen Bots aus der Liste unten → „…“ → <b>Blockieren</b> → bestätigen.'
            : 'Nach Schritt 1 und dem ersten Scan: einen eindeutigen Bot einmal per Hand blockieren.') +
        '</div></div>' +
        '<div class="tok">Sitzung: ' + (tok ? '✓ bereit' : '… warte auf Tokens (Seite kurz scrollen)') + '</div>';
    },

    renderBar() {
      const ls = S.lastScan;
      this.q('.bar').innerHTML =
        '<button class="primary" data-act="scan" ' + (S.followerTpl && !S.scanning ? '' : 'disabled') + '>Follower scannen</button>' +
        (S.scanning ? '<button data-act="stopscan">Scan stoppen</button>' : '') +
        (S.checking
          ? '<button data-act="stopcheck">Prüfung stoppen</button>'
          : '<button data-act="check" ' + (Object.keys(S.users).length && !S.scanning ? '' : 'disabled') + ' title="Ruft die Profilseiten langsam ab: Follower, Posts, Bio, Links">Profile prüfen</button>') +
        '<span class="muted">' + esc(S.checkInfo || S.scanInfo || (ls ? 'Letzter Scan: ' + fmtTime(ls.ts) + ' · ' + ls.count + ' Follower' : 'Noch kein Scan')) + '</span>';
    },

    renderQueue() {
      rollDay();
      const st = S.settings;
      const paused = Date.now() < S.pausedUntil;
      const avg = (st.minDelay + st.maxDelay) / 2;
      const left = Math.max(0, st.dailyLimit - S.stats.count);
      let eta = '';
      if (S.queue.length) {
        if (S.queue.length <= left && !paused) eta = 'ca. ' + Math.max(1, Math.round(S.queue.length * avg / 60)) + ' Min.';
        else eta = 'ca. ' + (1 + Math.ceil(Math.max(0, S.queue.length - left) / st.dailyLimit)) + ' Tage (Tageslimit)';
      }
      let state;
      if (S.running) state = S.nextAt ? 'läuft – nächster Block in ' + Math.max(0, Math.ceil((S.nextAt - Date.now()) / 1000)) + ' s' : 'läuft …';
      else if (paused) state = 'pausiert bis ' + fmtTime(S.pausedUntil) + ' <button class="link" data-act="unpause">Pause aufheben</button>';
      else state = S.queue.length ? 'gestoppt' : 'leer';
      this.q('.queue').innerHTML =
        '<div><b>Warteschlange:</b> ' + S.queue.length + ' · heute ' + S.stats.count + '/' + st.dailyLimit +
        ' blockiert · insgesamt ' + Object.keys(S.blocked).length + '</div>' +
        '<div class="muted">Status: ' + state + (eta ? ' · Rest ' + eta : '') + '</div>' +
        '<div>' +
        (S.running
          ? '<button data-act="qpause">Pausieren</button>'
          : '<button class="primary" data-act="qstart" ' + (S.queue.length && S.blockTpl ? '' : 'disabled') + '>Starten</button>') +
        ' <button data-act="qclear" ' + (S.queue.length ? '' : 'disabled') + '>Leeren</button>' +
        (!S.blockTpl && S.queue.length ? ' <span class="warnbox">Erst Lernschritt 2 ausführen.</span>' : '') +
        '</div>';
    },

    renderTable() {
      const th = S.settings.threshold;
      const qset = new Set(S.queue);
      const rows = filteredRows();
      const LIMIT = 500;
      const shown = rows.slice(0, LIMIT);
      this.visibleIds = shown.map(([u]) => u.id).filter((id) => !isDone(id) && !qset.has(id));
      const prev = S.prevScanTs;
      const html = shown.map(([u, sc]) => {
        const id = u.id;
        const lvl = sc.s >= 80 && sc.s >= th ? 'top' : sc.s >= th ? 'hi' : sc.s >= th - 20 ? 'mid' : 'lo';
        let act;
        if (S.blocked[id]) act = '<span class="tag ok">blockiert</span>';
        else if (S.whitelist.has(id)) act = '<span class="tag">echt</span><button class="link" data-unwl="' + esc(id) + '" title="rückgängig">↺</button>';
        else if (qset.has(id)) act = '<span class="tag q">wartet</span><button class="link" data-unq="' + esc(id) + '" title="aus Warteschlange">✕</button>';
        else act = '<button class="sm danger" data-block="' + esc(id) + '">Blocken</button><button class="sm" data-wl="' + esc(id) + '">Echt</button>';
        const canSel = !isDone(id) && !qset.has(id);
        return '<tr class="' + (u.gone ? 'gone' : '') + '">' +
          '<td class="cb">' + (canSel ? '<input type="checkbox" data-sel="' + esc(id) + '"' + (S.selected.has(id) ? ' checked' : '') + '>' : '') + '</td>' +
          '<td class="av-td">' + (u.pic ? '<img class="av" loading="lazy" src="' + esc(u.pic) + '">' : '<div class="av"></div>') + '</td>' +
          '<td class="who"><a href="/@' + encodeURIComponent(u.username) + '" target="_blank" rel="noopener">@' + esc(u.username) + '</a>' +
          (prev && u.firstSeen > prev ? '<span class="new">neu</span>' : '') +
          (u.name ? '<div class="sub">' + esc(u.name) + '</div>' : '') +
          '<div class="nums-inline" data-why="' + esc(sc.r.slice(0, 3).join(' · ')) + '">' +
          (u.posts == null ? (u.postsHidden ? '🔒' : '?') : fmtN(u.posts)) + ' Posts · ' + fmtN(u.followers) + ' Fol.' +
          (u.checkedAt ? '' : ' · <button class="link" data-chk="' + esc(id) + '">prüfen</button>') + '</div></td>' +
          '<td class="sc-td"><span class="sc ' + lvl + '">' + sc.s + '</span></td>' +
          '<td class="why" title="' + esc(sc.r.join(' · ')) + '"><div class="why-in">' + sc.r.map((x, k) => '<span class="chip' + (x === 'ungeprüft' ? ' dim' : '') +
            (k >= 1 ? ' x2' : '') + (k >= 2 ? ' x' : '') + '">' + esc(x) + '</span>').join('') +
            (sc.r.length > 2 ? '<span class="chip more-chip m2">+' + (sc.r.length - 2) + '</span>' : '') +
            (sc.r.length > 1 ? '<span class="chip more-chip m1">+' + (sc.r.length - 1) + '</span>' : '') + '</div></td>' +
          '<td class="num">' + (u.posts == null ? (u.postsHidden ? '🔒' : '?') : fmtN(u.posts) + (u.posts >= 10 ? '+' : '')) + ' · ' + fmtN(u.followers) + ' · ' + fmtN(u.following) +
          (u.checkedAt ? '' : '<br><button class="link" data-chk="' + esc(id) + '">prüfen</button>') + '</td>' +
          '<td class="act">' + act + '</td></tr>';
      }).join('');
      const nUsers = Object.keys(S.users).length;
      this.q('tbody').innerHTML = html ||
        '<tr><td colspan="7" class="empty">' + (nUsers ? 'Keine Treffer für diesen Filter.' : 'Noch keine Follower geladen.') + '</td></tr>';
      this.q('.more').textContent = (rows.length > LIMIT ? 'Zeige ' + LIMIT + ' von ' + rows.length + ' – Filter eingrenzen. ' : rows.length + ' Konten angezeigt · ') +
        nUsers + ' Follower bekannt · ' + countSuspicious() + ' verdächtig';
      this.q('.seln').textContent = S.selected.size;
      const sa = this.q('[data-selall]');
      if (sa) sa.checked = this.visibleIds.length > 0 && this.visibleIds.every((id) => S.selected.has(id));
    },

    renderLog() {
      this.q('.log').innerHTML = S.log.slice(-80).reverse().map((l) =>
        '<span class="l-' + l.l + '">' + fmtTime(l.t) + '  ' + esc(l.m) + '</span>').join('\n') || '<span class="muted">Noch keine Einträge.</span>';
    },

    renderDebug() {
      const d = this.q('.debug');
      if (!d.open) return;
      this.q('.cap').innerHTML = S.captured.map((c, i) =>
        '<div><code>' + esc(c.method) + ' ' + c.status + '</code> ' + esc(c.friendly || shortUrl(c.url)) +
        ' <button class="link" data-capf="' + i + '">als Follower-Abfrage</button>' +
        (c.method !== 'GET' ? '<button class="link" data-capb="' + i + '">als Block-Aktion</button>' : '') + '</div>'
      ).join('') || '<span class="muted">Noch nichts mitgelesen.</span>';
    },
  };

  function sanitizeTpl(t) {
    if (!t) return null;
    let varKeys = null;
    try { const v = getVars(t); varKeys = v && typeof v === 'object' ? Object.keys(v) : null; } catch (e) { /* ignore */ }
    return {
      path: shortUrl(t.url), method: t.method, friendly: t.friendly, form: t.form, tokenKeys: t.tokenKeys,
      headers: Object.keys(t.headers || {}), varKeys, paging: t.paging || null, idField: t.idField || null,
      hasPlaceholder: ((t.url || '') + (t.body || '')).includes(PH),
    };
  }

  function copyDebug() {
    const info = {
      version: VERSION, ua: navigator.userAgent, path: location.pathname,
      tokens: { fb_dtsg: !!S.tokens.fb_dtsg, lsd: !!S.tokens.lsd, jazoest: !!S.tokens.jazoest },
      users: Object.keys(S.users).length, blocked: Object.keys(S.blocked).length, queue: S.queue.length,
      followerTpl: sanitizeTpl(S.followerTpl), blockTpl: sanitizeTpl(S.blockTpl),
      captured: S.captured.map((c) => ({ m: c.method, s: c.status, path: shortUrl(c.url), f: c.friendly })),
      log: S.log.slice(-30).map((l) => l.l + ': ' + l.m),
    };
    const txt = JSON.stringify(info, null, 2);
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => log('Diagnose-Info kopiert (ohne Tokens und ohne IDs).', 'ok'))
      .catch(() => { console.log('[TBC] Diagnose', txt); log('Kopieren nicht möglich – Diagnose steht in der Browser-Konsole.', 'warn'); });
  }

  /* --------------------------------------------------------------- init */

  function init() {
    UI.mount();
    scrapeTokensFromHtml();
    rollDay();
    if (S.settings.autoResume && S.queueActive && S.queue.length) {
      log('Setze Warteschlange fort (' + S.queue.length + ' offen) …');
      scheduleResume(15000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  W.addEventListener('load', scrapeTokensFromHtml, { once: true });

  W.__TBC__ = {
    version: VERSION, state: S, score, extractPage, normUser, makeTemplate, findTarget, fillTarget, classify,
    buildFollowerReq, handleFollowerResponse, handleBlockRequest, scan, runQueue, enqueue,
    checkProfiles, parseProfileHtml, nameSchema,
  };
})();
