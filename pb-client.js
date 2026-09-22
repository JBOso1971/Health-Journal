/* pb-client.js — W2: the journal's PocketBase client, with native auth (W2_Build_Brief_v1.md §2.3).
 *
 * No DOM and no globals: fetch, storage and the clock are passed in, so the Node harness
 * (tests/) runs the REAL module. Loaded by index.html before the app script; exported for
 * Node at the tail. EVERY request the app makes goes through send() -- index.html carries
 * no fetch of its own (tests/test_shell.mjs holds that).
 *
 * Contract:
 *   - The token is held under localStorage['pb_auth'] as {token, id, email}. The password
 *     is never stored, never returned, never logged.
 *   - A data call with NO usable token (absent, unparseable, or past its exp) is NOT sent:
 *     it answers {error:{status:401}} and calls onAuthLost. Measured 2026-09-22 on the box
 *     (PB 0.39.4): an invalid token is treated as a GUEST, so once the rules close a list
 *     answers 200 with zero rows -- the server cannot be relied on to say "signed out", and
 *     an empty-looking journal is exactly what G-W2-4 forbids.
 *   - A 401 or 403 from the server clears the token and calls onAuthLost. A 400/404 does
 *     not: those are validation and rule non-match (MEMORY §4C), not a lost session.
 *   - refresh() clears the token only on a REFUSAL (401/403/404). Offline or a 5xx keeps it:
 *     a phone in a basement is not signed out.
 */
var PBClient = (function () {
  'use strict';

  var AUTH_KEY = 'pb_auth';
  var AUTH_COLLECTION = 'users';
  var RECORDS = '/api/collections/journal_entries/records';
  var REFUSED = [401, 403];            // a data call answering these has lost its session
  var REFRESH_REFUSED = [401, 403, 404]; // auth-refresh answering these: the token is dead

  // The exp claim (seconds) of a PocketBase JWT, or null when it cannot be read.
  function tokenExp(token) {
    if (typeof token !== 'string') return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var claims = JSON.parse(atob(b64));
      return (typeof claims.exp === 'number' && isFinite(claims.exp)) ? claims.exp : null;
    } catch (e) { return null; }
  }

  function create(opts) {
    var url = opts.url, doFetch = opts.fetch, storage = opts.storage;
    var now = opts.now || function () { return Date.now(); };
    var onAuthLost = opts.onAuthLost || function () {};
    var st = { reason: null };   // why the last session ended: 'expired' | 'refused' | 'signed out'

    function readAuth() {
      try {
        var a = JSON.parse(storage.getItem(AUTH_KEY));
        return (a && typeof a.token === 'string' && a.token) ? a : null;
      } catch (e) { return null; }
    }
    function writeAuth(a) { try { storage.setItem(AUTH_KEY, JSON.stringify(a)); } catch (e) {} }
    function clearAuth() { try { storage.removeItem(AUTH_KEY); } catch (e) {} }

    // The held auth if it is usable now, else null (an expired one is cleared on the way).
    function usableAuth() {
      var a = readAuth();
      if (!a) return null;
      var exp = tokenExp(a.token);
      if (exp === null || exp * 1000 <= now()) { clearAuth(); st.reason = 'expired'; return null; }
      return a;
    }
    function lose(reason) { clearAuth(); st.reason = reason; onAuthLost(reason); }

    function authHeaders(extra) {
      var h = Object.assign({}, extra || {});
      var a = readAuth();
      if (a) h.Authorization = a.token;
      return h;
    }

    // One door for every request: status + parsed body, never a throw.
    async function send(method, path, body, extra) {
      var init = { method: method, headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
      if (body !== undefined) init.body = JSON.stringify(body);
      if (extra && extra.keepalive) init.keepalive = true;
      try {
        var res = await doFetch(url + path, init);
        var json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        return { status: res.status, ok: res.ok, json: json };
      } catch (e) { return { status: 0, ok: false, json: { message: String(e) } }; }
    }

    // A journal call: refused locally with no usable token; a server refusal ends the session.
    async function data(method, path, body, pick) {
      if (!usableAuth()) { onAuthLost(st.reason || 'signed out'); return { data: null, error: { status: 401, message: 'signed out -- sign in again' } }; }
      var r = await send(method, path, body);
      if (!r.ok) {
        if (REFUSED.indexOf(r.status) >= 0) lose('refused');
        var err = (r.json && typeof r.json === 'object') ? r.json : {};
        return { data: null, error: { status: r.status, message: err.message || ('request failed (' + r.status + ')'), data: err.data } };
      }
      try { return { data: pick(r.json), error: null }; }
      catch (e) { return { data: null, error: { status: r.status, message: 'unreadable response (' + r.status + ')' } }; }
    }

    return {
      state: st,
      authHeaders: authHeaders,
      signedIn: function () { return !!usableAuth(); },
      identity: function () { var a = usableAuth(); return a ? (a.email || a.id) : null; },

      async signIn(identity, password) {
        var r = await send('POST', '/api/collections/' + AUTH_COLLECTION + '/auth-with-password',
                           { identity: identity, password: password });
        if (!r.ok || !r.json || typeof r.json.token !== 'string' || !r.json.record) {
          return { error: { status: r.status, message: (r.json && r.json.message) || 'sign-in failed' } };
        }
        writeAuth({ token: r.json.token, id: r.json.record.id, email: r.json.record.email || null });
        st.reason = null;
        return { error: null };
      },
      async refresh() {
        if (!usableAuth()) return { error: { status: 401, message: 'signed out' } };
        var r = await send('POST', '/api/collections/' + AUTH_COLLECTION + '/auth-refresh');
        if (r.ok && r.json && typeof r.json.token === 'string' && r.json.record) {
          writeAuth({ token: r.json.token, id: r.json.record.id, email: r.json.record.email || null });
          return { error: null };
        }
        if (REFRESH_REFUSED.indexOf(r.status) >= 0) { lose('refused'); return { error: { status: r.status, message: 'session refused -- sign in again' } }; }
        return { error: { status: r.status, message: 'refresh unavailable (kept signed in)' } };   // offline / 5xx
      },
      signOut: function () { clearAuth(); st.reason = 'signed out'; },

      list: function (params) {
        return data('GET', RECORDS + '?' + new URLSearchParams(params).toString(), undefined, function (j) { return j.items; });
      },
      get: function (id) { return data('GET', RECORDS + '/' + id, undefined, function (j) { return j; }); },
      insert: function (record) { return data('POST', RECORDS, record, function (j) { return j; }); },
      update: function (id, record) { return data('PATCH', RECORDS + '/' + id, record, function (j) { return j; }); },
      remove: async function (id) { var r = await data('DELETE', RECORDS + '/' + id, undefined, function () { return null; }); return { error: r.error }; },
      // Page teardown: a keepalive PATCH that outlives the page, through the same door (so it carries the token).
      flush: function (id, record) {
        if (!usableAuth()) return;
        send('PATCH', RECORDS + '/' + id, record, { keepalive: true });
      },
    };
  }

  return { AUTH_KEY: AUTH_KEY, tokenExp: tokenExp, create: create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PBClient;
