// tests/test_pb_client.mjs — W2 S3: the journal's PocketBase client with native auth (W2_Build_Brief_v1.md §2.3),
// replayed against a FAKE fetch and a FAKE localStorage at the module seam. The REAL module (pb-client.js); the
// clock is an argument; tokens are JWT-shaped with far-future exp sentinels (CLAUDE.md §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../pb-client.js');

const URL = 'https://pb.example.invalid';
const NOW = Date.parse('2099-06-01T12:00:00Z');
const PASSWORD = 'correct horse battery staple 2099';
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (expSec, extra = {}) => b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ exp: expSec, id: 'u1', type: 'auth', ...extra }) + '.sig';
const LIVE = jwt(NOW / 1000 + 14 * 86400);           // 14 days out (Q3)
const DEAD = jwt(NOW / 1000 - 1);                    // one second past exp

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
// A scripted server: routes by method + path prefix; every request is recorded with its headers and body.
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const path = url.slice(URL.length);
    calls.push({ method: init.method || 'GET', path, headers: { ...(init.headers || {}) }, body: init.body, keepalive: !!init.keepalive });
    const key = Object.keys(routes).find(k => { const [m, p] = k.split(' '); return m === (init.method || 'GET') && path.startsWith(p); });
    const r = key ? routes[key] : { status: 404, json: { message: 'no route' } };
    const out = typeof r === 'function' ? r(init) : r;
    if (out === 'NETWORK') throw new TypeError('Failed to fetch');
    return { status: out.status, ok: out.status >= 200 && out.status < 300,
             json: async () => { if (out.json === undefined) throw new SyntaxError('no body'); return structuredClone(out.json); } };
  };
  f.calls = calls;
  return f;
}
const REC = '/api/collections/journal_entries/records';
const OPEN_ROUTES = {
  [`GET ${REC}`]: { status: 200, json: { items: [{ id: 'r1' }], totalItems: 1 } },
  [`POST ${REC}`]: { status: 200, json: { id: 'r2' } },
  [`PATCH ${REC}`]: { status: 200, json: { id: 'r1' } },
  [`DELETE ${REC}`]: { status: 204 },
};
function client({ routes = OPEN_ROUTES, token = LIVE, now = NOW, extra = {} } = {}) {
  const storage = fakeStorage(token ? { pb_auth: JSON.stringify({ token, id: 'u1', email: 'jb@example.invalid' }), ...extra } : extra);
  const fetch = fakeFetch(routes);
  const lost = [];
  const pb = P.create({ url: URL, fetch, storage, now: () => now, onAuthLost: r => lost.push(r) });
  return { pb, fetch, storage, lost };
}
// Every journal verb the client exposes, with a call that exercises it. Held to the object's own keys below.
const VERBS = {
  list: pb => pb.list({ perPage: 1 }), get: pb => pb.get('r1'), insert: pb => pb.insert({ entry_type: 'note' }),
  update: pb => pb.update('r1', { notes: 'x' }), remove: pb => pb.remove('r1'), flush: pb => pb.flush('r1', { metadata: {} }),
};
const NON_NETWORK = ['state', 'authHeaders', 'signedIn', 'identity', 'signOut', 'signIn', 'refresh'];

test('the verb inventory is derived from the client object itself, both directions (a new verb cannot ship untested)', () => {
  const keys = Object.keys(client().pb).filter(k => !NON_NETWORK.includes(k)).sort();
  assert.deepEqual(keys, Object.keys(VERBS).sort());
});

test('every journal verb carries Authorization = the held token', async () => {
  for (const [name, call] of Object.entries(VERBS)) {
    const { pb, fetch } = client();
    await call(pb);
    assert.equal(fetch.calls.length, 1, name + ' sent ' + fetch.calls.length + ' request(s)');
    assert.equal(fetch.calls[0].headers.Authorization, LIVE, name + ' did not carry the token');
  }
});

test('no token -> no request: every verb is refused locally with status 401 and the app is told (never an empty-looking journal)', async () => {
  for (const [name, call] of Object.entries(VERBS)) {
    const { pb, fetch, lost } = client({ token: null });
    const r = await call(pb);
    assert.equal(fetch.calls.length, 0, name + ' went to the network without a token');
    if (name !== 'flush') {
      assert.equal(r.error.status, 401, name);
      assert.equal(r.data ?? null, null, name + ' returned data while signed out');
      assert.equal(lost.length, 1, name + ' did not call onAuthLost');
    }
  }
});

test('an expired token (exp <= now, to the second) is treated as none and cleared; one second earlier it is live', async () => {
  const exp = NOW / 1000;
  const at = client({ token: jwt(exp) });
  assert.equal(at.pb.signedIn(), false, 'a token at exactly exp is expired');
  assert.equal(at.storage.getItem('pb_auth'), null, 'the expired token was not cleared');
  assert.equal(at.pb.state.reason, 'expired');
  const before = client({ token: jwt(exp), now: NOW - 1000 });
  assert.equal(before.pb.signedIn(), true, 'one second before exp the token is live');
  const r = await client({ token: DEAD }).pb.list({});
  assert.equal(r.error.status, 401);
});

test('an unreadable token (not a JWT, no exp) is treated as none', () => {
  for (const t of ['not.a.token', 'abc', jwt(undefined), b64u({}) + '.' + b64u({ exp: 'soon' }) + '.s']) {
    assert.equal(client({ token: t }).pb.signedIn(), false, t);
  }
});

test('a server 401 or 403 on a journal verb ends the session (token cleared, app told); 400 and 404 do not', async () => {
  for (const status of [401, 403]) {
    const { pb, storage, lost } = client({ routes: { [`GET ${REC}`]: { status, json: { message: 'nope' } } } });
    const r = await pb.list({});
    assert.equal(r.error.status, status);
    assert.equal(storage.getItem('pb_auth'), null, status + ' did not clear the token');
    assert.deepEqual(lost, ['refused']);
  }
  for (const status of [400, 404]) {   // validation / rule non-match (MEMORY §4C) -- not a lost session
    const { pb, storage, lost } = client({ routes: { [`PATCH ${REC}`]: { status, json: { message: 'bad' } } } });
    const r = await pb.update('r1', {});
    assert.equal(r.error.status, status);
    assert.ok(storage.getItem('pb_auth'), status + ' signed the user out');
    assert.equal(lost.length, 0);
  }
});

test('C-8: remove() returns the refusal, never a silent success', async () => {
  const { pb } = client({ routes: { [`DELETE ${REC}`]: { status: 403, json: { message: 'Only superusers can perform this action.' } } } });
  const r = await pb.remove('r1');
  assert.ok(r.error, 'a refused DELETE read as success');
  assert.match(r.error.message, /superusers/);
  const ok = await client().pb.remove('r1');
  assert.equal(ok.error, null, 'a 204 DELETE is a success');
});

test('offline and unreadable responses come back as errors, never a throw and never data', async () => {
  const off = client({ routes: { [`GET ${REC}`]: 'NETWORK' } });
  const r = await off.pb.list({});
  assert.equal(r.error.status, 0); assert.equal(r.data, null);
  assert.ok(off.storage.getItem('pb_auth'), 'offline signed the user out');
  const html = client({ routes: { [`GET ${REC}`]: { status: 502 } } });   // nginx HTML error page: no JSON
  const h = await html.pb.list({});
  assert.equal(h.error.status, 502);
  const empty = client({ routes: { [`GET ${REC}`]: { status: 200 } } });  // 200 with no body: unreadable, not an empty list
  const e = await empty.pb.list({});
  assert.ok(e.error, 'a 200 with no body read as data'); assert.equal(e.data, null);
});

test('signIn: POSTs identity + password to users/auth-with-password, stores {token,id,email}; the password is stored NOWHERE', async () => {
  const routes = { 'POST /api/collections/users/auth-with-password': { status: 200, json: { token: LIVE, record: { id: 'u1', email: 'jb@example.invalid' } } } };
  const { pb, fetch, storage } = client({ routes, token: null, extra: { jf: '{"id":"f1"}' } });
  const r = await pb.signIn('jb@example.invalid', PASSWORD);
  assert.equal(r.error, null);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { identity: 'jb@example.invalid', password: PASSWORD });
  assert.equal(fetch.calls[0].headers.Authorization, undefined, 'sign-in sent a stale token');
  assert.deepEqual(JSON.parse(storage.getItem('pb_auth')), { token: LIVE, id: 'u1', email: 'jb@example.invalid' });
  for (const [k, v] of storage.m) assert.ok(!String(v).includes(PASSWORD), 'the password is in localStorage[' + k + ']');
  assert.ok(!JSON.stringify(pb.state).includes(PASSWORD), 'the password is held in client state');
  assert.equal(pb.signedIn(), true);
  assert.equal(pb.identity(), 'jb@example.invalid');
});

test('signIn refused: nothing stored, the server message returned', async () => {
  const routes = { 'POST /api/collections/users/auth-with-password': { status: 400, json: { message: 'Failed to authenticate.' } } };
  const { pb, storage } = client({ routes, token: null });
  const r = await pb.signIn('jb@example.invalid', 'wrong');
  assert.equal(r.error.message, 'Failed to authenticate.');
  assert.equal(storage.getItem('pb_auth'), null);
  assert.equal(pb.signedIn(), false);
});

test('refresh: 200 stores the new token and exp does not go backwards (never asserted by string inequality, MEMORY §4C)', async () => {
  const later = jwt(NOW / 1000 + 14 * 86400 + 3);
  const routes = { 'POST /api/collections/users/auth-refresh': { status: 200, json: { token: later, record: { id: 'u1', email: 'jb@example.invalid' } } } };
  const { pb, fetch, storage } = client({ routes });
  const r = await pb.refresh();
  assert.equal(r.error, null);
  assert.equal(fetch.calls[0].headers.Authorization, LIVE, 'refresh did not present the held token');
  const held = JSON.parse(storage.getItem('pb_auth')).token;
  assert.ok(P.tokenExp(held) >= P.tokenExp(LIVE), 'exp went backwards');
  assert.equal(held, later, 'the refreshed token was not stored');
});

test('refresh: a refusal (401/403/404) clears the token; offline or a 5xx KEEPS it (a phone in a basement is not signed out)', async () => {
  for (const status of [401, 403, 404]) {
    const { pb, storage, lost } = client({ routes: { 'POST /api/collections/users/auth-refresh': { status, json: { message: 'x' } } } });
    await pb.refresh();
    assert.equal(storage.getItem('pb_auth'), null, status + ' kept a dead token');
    assert.deepEqual(lost, ['refused'], String(status));
  }
  for (const out of ['NETWORK', { status: 500, json: {} }, { status: 502 }]) {
    const { pb, storage, lost } = client({ routes: { 'POST /api/collections/users/auth-refresh': out } });
    const r = await pb.refresh();
    assert.ok(r.error);
    assert.ok(storage.getItem('pb_auth'), JSON.stringify(out) + ' signed the user out');
    assert.equal(lost.length, 0);
  }
  const none = client({ token: null });
  await none.pb.refresh();
  assert.equal(none.fetch.calls.length, 0, 'refresh with no token went to the network');
});

test('signOut clears pb_auth and ONLY pb_auth: the active fast, the capture checkpoint and the slots survive', () => {
  const drafts = { jf: '{"id":"f1"}', hr_session: '{"v":2}', hr_session_other: '{}', hr_session_discarded: '{}', sup_doses: '{}', custom_sups: '[]' };
  const { pb, storage } = client({ extra: drafts });
  pb.signOut();
  assert.equal(storage.getItem('pb_auth'), null);
  for (const [k, v] of Object.entries(drafts)) assert.equal(storage.getItem(k), v, k + ' was lost at sign-out');
  assert.equal(pb.signedIn(), false);
  assert.equal(pb.state.reason, 'signed out');
});

test('flush: the page-teardown PATCH carries keepalive AND the token, through the same door as every other call', async () => {
  const { pb, fetch } = client();
  pb.flush('r9', { metadata: { state: 'active' } });
  await new Promise(r => setImmediate(r));
  assert.equal(fetch.calls.length, 1);
  const c = fetch.calls[0];
  assert.equal(c.method, 'PATCH'); assert.equal(c.path, REC + '/r9');
  assert.equal(c.keepalive, true); assert.equal(c.headers.Authorization, LIVE);
  assert.equal(c.headers['Content-Type'], 'application/json');
});

test('tokenExp reads base64url payloads (the - and _ alphabet, no padding) and refuses anything else', () => {
  const t = b64u({ alg: 'x' }) + '.' + b64u({ exp: 4102444800, n: '>>>???' }) + '.s';   // forces - and _ in the payload
  assert.match(t.split('.')[1], /[-_]/, 'the fixture does not exercise the url alphabet');
  assert.equal(P.tokenExp(t), 4102444800);
  assert.equal(P.tokenExp(null), null);
  assert.equal(P.tokenExp('a.b'), null);
});
