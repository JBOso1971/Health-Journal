// tests/test_shell.mjs — the app shell wires the core in (CLAUDE.md §5: where a sentence names a FILE, something
// asserts the file EXISTS and is referenced — in index.html and in the service worker's shell list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');

test('hr-core.js exists and index.html loads it BEFORE the app script', () => {
  assert.ok(existsSync(join(ROOT, 'hr-core.js')));
  const tag = html.indexOf('<script src="hr-core.js"></script>');
  assert.ok(tag > 0, 'index.html does not load hr-core.js');
  const appScript = html.indexOf('<script>', tag);
  assert.ok(appScript > tag, 'the app <script> must follow the hr-core.js tag');
});

// W3b S3: the Lift core ships as a file of its own; index.html loads it and sw.js caches it at S4 (the load /
// SW assertions land with that wiring: S3 changes no index.html, W3b gate record C-4).
test('lift-core.js exists and is a pure core: no DOM, storage, network, clock, randomness, timer or delete of its own', () => {
  const p = join(ROOT, 'lift-core.js');
  assert.ok(existsSync(p), 'lift-core.js is missing');
  const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'])\/\/.*$/gm, '$1');   // comments may NAME these
  for (const [re, what] of [[/\bdocument\b/, 'document'], [/\bwindow\b/, 'window'], [/\blocalStorage\b/, 'localStorage'],
                            [/\bfetch\(/, 'fetch('], [/Date\.now\(/, 'Date.now('], [/new Date\(\s*\)/, 'new Date()'],
                            [/Math\.random\(/, 'Math.random('], [/\bcrypto\b/, 'crypto'], [/\bnavigator\b/, 'navigator'],
                            [/\bset(Timeout|Interval)\(/, 'a timer'], [/\.remove\(/, 'a DELETE (.remove()'], [/\bPB\./, 'the app\'s PB client']]) {
    assert.doesNotMatch(code, re, 'lift-core.js uses ' + what);
  }
  assert.match(code, /require\('\.\/hr-core\.js'\)/, 'lift-core.js must reuse hr-core.js, not re-implement it');
});

test('L17: the HR type Lift fixes is one the HR screen offers (the named type EXISTS in index.html)', () => {
  const L = createRequire(import.meta.url)('../lift-core.js');
  const types = html.match(/\[('Cardio'[^\]]*)\]\.map\(function\(t\)/);
  assert.ok(types, 'the HR type list was not found in index.html');
  assert.ok(types[1].split(',').map(s => s.trim().replace(/'/g, '')).includes(L.HR_EXERCISE_TYPE), L.HR_EXERCISE_TYPE + ' is not an HR type');
});

test('sw.js caches hr-core.js in the shell and the cache version is past v7', () => {
  assert.match(sw, /'\/Health-Journal\/hr-core\.js'/, 'sw.js SHELL does not list hr-core.js');
  const m = sw.match(/const CACHE = 'jb-health-v(\d+)'/);
  assert.ok(m, 'no CACHE constant');
  assert.ok(Number(m[1]) >= 8, 'cache version not bumped past v7 (JA2 ships as v8)');
});

test('the app script never issues a DELETE from an HR path (G-JA2-7): PB.remove is called only by undoEntry', () => {
  const calls = [...html.matchAll(/PB\.remove\(/g)].length;
  assert.equal(calls, 1, 'PB.remove call sites: ' + calls);
  const site = html.indexOf('PB.remove(');
  const fnStart = html.lastIndexOf('async function ', site);
  assert.match(html.slice(fnStart, fnStart + 40), /async function undoEntry\(/);
});

test('the app script calls the core at every site the brief names (the wiring exists, not just the vocabulary)', () => {
  for (const site of ['HRCore.createStoreSession(PB)', 'HRCore.startGuard(', 'HRCore.resumeDecision(', 'HRCore.checkpointPayload(',
                      'HRCore.discardLabel(', 'HRCore.isOpenEntry', 'HRCore.mergeSamples(', 'HRCore.summarize(', 'HRCore.DISCARD_KEEP_DAYS']) {
    assert.ok(html.includes(site), 'index.html does not call ' + site);
  }
  const init = html.slice(html.indexOf("window.addEventListener('DOMContentLoaded'"), html.indexOf('// ── ROUTER'));
  assert.match(init, /hrLaunchRecovery\(\);/, 'launch recovery is not called at DOMContentLoaded');
  assert.match(init, /hrStore = HRCore\.createStoreSession\(PB\);/);
});

test('G-JA2-6: START consults the guard and the refusal is shown AFTER the navigation home re-renders (not wiped by it)', () => {
  const start = html.indexOf('function hrStartExercise(');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assert.match(body, /HRCore\.startGuard\(hrGetCheckpoint\(\) \|\| hrGetSlot\(HR_OTHER_KEY\)/);
  const guardLine = body.slice(body.indexOf('if (guard)'), body.indexOf('\n', body.indexOf('if (guard)')));
  assert.ok(guardLine.indexOf("navigate('#home')") < guardLine.indexOf('showErr(guard.message)'), 'showErr must come after navigate, deferred');
  assert.match(guardLine, /setTimeout\(/, 'the refusal must be deferred past the home re-render');
  assert.match(guardLine, /return;/);
});

test('undo on a filed HR session discards, it never deletes (G-JA2-7)', () => {
  const start = html.indexOf('async function undoEntry(');
  const body = html.slice(start, html.indexOf('\n}\n', start));
  assert.match(body, /entry_type === 'heart_rate'/);
  assert.match(body, /state: 'discarded'/);
  assert.ok(body.indexOf("entry_type === 'heart_rate'") < body.indexOf('PB.remove('), 'the HR branch must come before the delete');
});

test('S3 wiring: foreground return reconnects, page hide flushes with keepalive, the loop is bounded by the core', () => {
  const vis = html.slice(html.indexOf("document.addEventListener('visibilitychange'"), html.indexOf('function hrFlushOnHide'));
  assert.match(vis, /hrScheduleReconnect\(0\)/, 'visibilitychange does not restart the reconnect loop');
  assert.match(vis, /hrStoreTickMaybe\(\)/);
  const flush = html.slice(html.indexOf('function hrFlushOnHide'), html.indexOf("document.addEventListener('freeze'"));
  // W2: the keepalive PATCH goes through the client (its keepalive + token are proven in test_pb_client.mjs);
  // the pre-W2 /keepalive: true/ literal here was satisfied by a COMMENT once the raw fetch moved out.
  assert.match(flush, /\n\s*PB\.flush\(hrStore\.state\.pbId, body\);/);
  assert.match(flush, /hrSaveCheckpoint\(\)/);
  assert.match(html, /window\.addEventListener\('pagehide', hrFlushOnHide\)/);
  const sched = html.slice(html.indexOf('function hrScheduleReconnect'), html.indexOf('function hrOnData'));
  assert.match(sched, /HRCore\.reconnectPolicy\(hrReconnectAttempts\)/, 'the loop does not consult the core policy');
  assert.match(sched, /if \(!plan\.retry\) return;/);
  assert.match(html, /navigator\.bluetooth\.getDevices === 'function'/, 'Q8: the getDevices path is absent');
  assert.doesNotMatch(html, /RECONNECT_MAX\s*=\s*\d+/, 'index.html defines its own reconnect ceiling');
});

test('S4 wiring: Log Review hides discarded behind a toggle, labels states, files and restores without a DELETE', () => {
  const rv = html.slice(html.indexOf("var result = await PB.list({ sort: '-started_at', perPage: 10"), html.indexOf('function toggleReviewDetail'));
  assert.ok(rv.length > 1000, 'the Log Review slice was not found');
  assert.match(rv, /rvShowDiscarded \|\| HRCore\.stateOf\(e\) !== 'discarded'/, 'discarded entries are not filtered');
  assert.match(rv, /'IN PROGRESS'/); assert.match(rv, /'UNFILED'/); assert.match(rv, /'DISCARDED'/);
  assert.match(rv, /hrFileFromReview\(/); assert.match(rv, /hrRestoreFromReview\(/);
  assert.match(html, /async function hrFileFromReview\(/); assert.match(html, /async function hrRestoreFromReview\(/);
  const restore = html.slice(html.indexOf('async function hrRestoreFromReview('), html.indexOf('async function hrRestoreFromReview(') + 600);
  assert.match(restore, /state: 'stopped'/); assert.doesNotMatch(restore, /PB\.remove/);
  assert.match(html, /let rvShowDiscarded = false;/);
});

test('Log Review: the discarded toggle renders ABOVE the list, never in the footer under the fixed bar (found live 2026-09-22)', () => {
  const view = html.slice(html.indexOf('async function renderLogReview()'), html.indexOf('function toggleReviewDetail'));
  const slot = view.indexOf('id="rv-discard-toggle"'), list = view.indexOf('id="rv-list"'), footer = view.indexOf('class="audit-footer"');
  assert.ok(slot > -1 && list > -1 && footer > -1, 'toggle slot, list and footer all present');
  assert.ok(slot < list, 'the toggle slot precedes the list');
  const footerLine = view.slice(footer, view.indexOf('\n', footer));
  assert.doesNotMatch(footerLine, /rvShowDiscarded/, 'the toggle is not in the footer');
  // the slot is filled with a working toggle that names how many are hidden
  assert.match(view, /getElementById\('rv-discard-toggle'\)\.innerHTML = [^\n]*onclick="rvShowDiscarded=!rvShowDiscarded;render\(\);return false"/);
  assert.match(view, /nDiscarded \+ ' hidden\)'/);
});

test('manifest.json parses and meets Chrome\'s install criteria (found TRUNCATED on 2026-09-21: the shortcut-not-app cause)', () => {
  const raw = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
  let m;
  assert.doesNotThrow(() => { m = JSON.parse(raw); }, 'manifest.json is not valid JSON');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/Health-Journal/');
  assert.equal(m.scope, '/Health-Journal/');
  assert.ok(m.name && m.short_name, 'name and short_name');
  const sizes = new Set(m.icons.filter(i => (i.purpose || 'any').split(' ').includes('any')).map(i => i.sizes));
  assert.ok(sizes.has('192x192') && sizes.has('512x512'), 'installability needs 192 and 512 icons with purpose any');
  for (const i of m.icons) assert.ok(existsSync(join(ROOT, i.src)), 'icon file missing: ' + i.src);
  assert.match(sw, /'\/Health-Journal\/manifest\.json'/, 'sw.js SHELL does not cache the manifest');
  assert.match(html, /<link rel="manifest" href="manifest.json">/);
});

test('the constants the app reads come from the core, not a second literal', () => {
  assert.doesNotMatch(html, /HR_STORE_TICK_SEC\s*=\s*\d+/, 'index.html defines its own tick constant');
  assert.doesNotMatch(html, /HR_STALE_SEC\s*=\s*\d+/, 'index.html defines its own stale constant');
});

// ── W2 S3: native auth (W2_Build_Brief_v1.md §2.3; the W2 gate record owns the corrections) ──────────────────
const appJs = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
const fnBody = name => { const i = html.indexOf(name); assert.ok(i > -1, 'missing: ' + name); return html.slice(i, html.indexOf('\n}\n', i)); };

test('W2: pb-client.js exists, loads after hr-core.js and before the app script, and the service worker caches it', () => {
  assert.ok(existsSync(join(ROOT, 'pb-client.js')));
  const core = html.indexOf('<script src="hr-core.js"></script>'), pbc = html.indexOf('<script src="pb-client.js"></script>');
  assert.ok(pbc > core && core > 0, 'pb-client.js must load after hr-core.js');
  assert.ok(html.indexOf('<script>', pbc) > pbc, 'the app <script> must follow pb-client.js');
  assert.match(sw, /'\/Health-Journal\/pb-client\.js'/, 'sw.js SHELL does not list pb-client.js');
});

test('W2: the app script issues no request of its own -- its one fetch( is the injection into PBClient.create', () => {
  const sites = [...appJs.matchAll(/fetch\(/g)].length;
  assert.equal(sites, 1, 'fetch( sites in the app script: ' + sites);
  const create = appJs.slice(appJs.indexOf('PBClient.create('), appJs.indexOf('});', appJs.indexOf('PBClient.create(')) + 3);
  assert.match(create, /fetch: function\(u, o\) \{ return fetch\(u, o\); \}/);
  assert.match(create, /onAuthLost: pbAuthLost/);
  assert.doesNotMatch(appJs, /PB_URL\s*\+\s*'\/api|\$\{PB_URL\}\/api/, 'a hand-built API URL survives outside the client');
  assert.doesNotMatch(appJs, /const PB = \{/, 'the pre-W2 unauthenticated wrapper is back');
});

test('C-8: every PB journal call site consumes its result (the inventory is derived from the tree, not listed)', () => {
  const sites = [...appJs.matchAll(/PB\.(list|get|insert|update|remove)\(/g)];
  assert.ok(sites.length >= 10, 'the derived inventory collapsed: ' + sites.length);
  const bare = sites.filter(m => {
    const lineStart = appJs.lastIndexOf('\n', m.index) + 1;
    return !/(=|return|\?)\s*(await\s+)?$/.test(appJs.slice(lineStart, m.index));
  }).map(m => appJs.slice(appJs.lastIndexOf('\n', m.index) + 1, appJs.indexOf('\n', m.index)).trim());
  assert.deepEqual(bare, [], 'result dropped at: ' + bare.join(' || '));
});

test('W2: the sign-in gate sits AFTER the capture lock and routes every signed-out view to the sign-in screen', () => {
  const r = fnBody('function render() {');
  const lock = r.indexOf('if (hrSessionActive)'), gate = r.indexOf('if (!PB.signedIn())'), home = r.indexOf("if (hash === '#home'");
  assert.ok(lock > -1 && gate > lock, 'the gate must come after the capture lock (a recording is never interrupted)');
  assert.ok(home > gate, 'the gate must come before the route dispatch');
  const g = r.slice(gate, r.indexOf("if (hash === '#signin') { location.hash = '#home'; return; }"));
  assert.match(g, /location\.hash = '#signin'/); assert.match(g, /renderSignIn\(\)/);
  const lost = fnBody('function pbAuthLost(');
  assert.match(lost, /if \(hrSessionActive\) return;/, 'auth loss must not interrupt a capture');
  const init = html.slice(html.indexOf("window.addEventListener('DOMContentLoaded'"), html.indexOf('// \u2500\u2500 ROUTER'));
  assert.match(init, /PB\.refresh\(\);/, 'the token is not refreshed at launch');
});

test('W2: the sign-in screen -- password field, no sign-up, the password cleared after the call and never stored', () => {
  const v = fnBody('function renderSignIn(');
  assert.match(v, /id="si-password" type="password" autocomplete="current-password"/);
  assert.match(v, /id="si-email" type="email" autocomplete="username"/);
  assert.doesNotMatch(v, /sign.?up|register|create account/i, 'there is no sign-up (users.createRule is locked)');
  const s = fnBody('async function submitSignIn(');
  assert.match(s, /PB\.signIn\(identity, pw\.value\)/);
  assert.ok(s.indexOf("pw.value = ''") > s.indexOf('PB.signIn('), 'the field is not cleared after the call');
  assert.doesNotMatch(s, /localStorage|sessionStorage/, 'submitSignIn touches storage (the client owns the token)');
});

test('Q8: the home footer carries a sign-out link, and sign-out clears the token only (drafts survive)', () => {
  const home = fnBody('function renderHome() {');
  assert.match(home, /id="sign-out"[^>]*onclick="signOutClick\(\);return false"/);
  const so = fnBody('function signOutClick(');
  assert.match(so, /PB\.signOut\(\);/);
  assert.doesNotMatch(so, /localStorage|clear\(\)/, 'sign-out must not touch the drafts');
  assert.match(home, /id="err-band"/, 'home has no error line: a refused END FAST would be silent');
});

test('C-8: a refused undo and a refused fast-end stay put and say so; the fast stays in jf', () => {
  const u = fnBody('async function undoEntry(');
  const e = u.indexOf('if (r.error)'), nav = u.indexOf("navigate('#home')");
  assert.ok(e > -1 && e < nav, 'undo navigates home before reading the refusal');
  assert.match(u.slice(e, u.indexOf('\n', e)), /showSafBackOnly\([^\n]*\); return; \}/);
  assert.match(fnBody('function showSafBackOnly('), /err-band/, 'the back-only bar cannot show the refusal');
  const f = fnBody('async function endFast(');
  const fe = f.indexOf('if (r.error)'), clr = f.indexOf('clearActiveFast()');
  assert.ok(fe > -1 && fe < clr, 'a refused END FAST clears jf anyway');
  assert.match(f.slice(fe, f.indexOf('\n', fe)), /showErr\(.*return; \}/);
});

test('W2: Log Review never shows a failed read as an empty journal', () => {
  const v = fnBody('async function renderLogReview(');
  const err = v.slice(v.indexOf('if (result.error || !result.data)'), v.indexOf('if (!result.data.length)'));
  assert.ok(err.length > 0, 'the error branch and the empty branch are not separate');
  assert.match(err, /could not load entries/); assert.doesNotMatch(err, /no entries found/);
});

test('navigate re-renders when the hash is unchanged (s20: END FAST on home left the banner up until a reload)', () => {
  // runs the REAL function from index.html against a fake location: an unchanged hash fires no hashchange, so
  // navigate must render itself; a changed hash must NOT render here (hashchange does -- two renders otherwise)
  const nav = src => new Function('location', 'render', src + '\n}\nreturn navigate;');   // fnBody stops before the closing brace
  const src = fnBody('function navigate(');
  for (const [from, to, renders] of [['#home', '#home', 1], ['#home', '#review', 0], ['#confirm', '#home', 0]]) {
    const loc = { hash: from }; let n = 0;
    nav(src)(loc, () => { n++; })(to);
    assert.equal(n, renders, `navigate('${to}') from ${from}: ${n} render(s), want ${renders}`);
    assert.equal(loc.hash, to);
  }
  // and END FAST, the site found on the phone, still reaches home through navigate after clearing the fast
  const f = fnBody('async function endFast(');
  assert.ok(f.indexOf('clearActiveFast()') < f.indexOf("navigate('#home')"), 'END FAST must clear jf, then navigate home');
});

// ── W3b S4: the Lift screens and their wiring (W3b_Build_Brief_v1.md §4 S4; corrections in the W3b gate record) ──
// Where a function can run on its own, it RUNS here: its REAL source from index.html, closed over stubs for the
// globals it reads (the navigate precedent above). Everything else is held by the text of the named site.
const L = createRequire(import.meta.url)('../lift-core.js');
const H = createRequire(import.meta.url)('../hr-core.js');
const fnSource = name => {   // the whole function: a one-liner is its own line (braces balanced), else fnBody + the closing brace
  const i = html.indexOf(name); assert.ok(i > -1, 'missing: ' + name);
  const line = html.slice(i, html.indexOf('\n', i));
  const depth = [...line].reduce((d, c) => d + (c === '{') - (c === '}'), 0);
  return depth === 0 && line.trim().endsWith('}') ? line : fnBody(name) + '\n}';
};
const make = (params, name) => new Function(...params, 'return (' + fnSource(name) + ');');
const liftTemplate = { id: 'T1', entry_type: 'lift_template', metadata: L.templateMeta('Legs', [{ name: 'Squat', side: 'both' }, { name: 'Split Squat', side: 'L' }, { name: 'Split Squat', side: 'R' }], false) };
const liftStarted = hrMode => L.startSession(liftTemplate, [], { sessionId: 'S1', nowMs: Date.UTC(2099, 0, 2, 12), utcOffsetS: -10800, hrMode, hrSessionId: hrMode === 'link' ? 'HR9' : null });

test('W3b S4 (C-4): lift-core.js loads after hr-core.js and before the app script; sw.js caches it; the cache is v13+', () => {
  const core = html.indexOf('<script src="hr-core.js"></script>'), lift = html.indexOf('<script src="lift-core.js"></script>');
  assert.ok(core > 0 && lift > core, 'lift-core.js must load after hr-core.js (it reuses HRCore)');
  assert.ok(html.indexOf('<script>', lift) > lift, 'the app <script> must follow lift-core.js');
  assert.match(sw, /'\/Health-Journal\/lift-core\.js'/, 'sw.js SHELL does not list lift-core.js');
  const m = sw.match(/const CACHE = 'jb-health-v(\d+)'/);
  assert.ok(m && Number(m[1]) >= 13, 'the cache is not bumped to v13 (W3b ships as v13)');
});

test('W3b S4: the Lift strip carries every hr-* element the HR ticker, hrOnData and the reconnect loop write to (derived from the tree)', () => {
  const ids = new Set();
  for (const w of ['function hrStartLockedTicker(', 'function hrOnData(', 'function hrScheduleReconnect(', 'function hrManualReconnect(']) {
    for (const m of fnBody(w).matchAll(/getElementById\('(hr-[a-z-]+)'\)/g)) ids.add(m[1]);
  }
  assert.ok(ids.has('hr-timer') && ids.size >= 5, 'the derived inventory collapsed: ' + [...ids]);
  // the REAL strip, rendered for a live strap session: every id the writers look up must be in it, or the strip goes silent
  const strip = make(['liftSession', 'hrSessionActive', 'hrLiftSessionId', 'hrLastBpm', 'hrStoreStatusText', 'fmtDur', 'escHtml', 'LiftCore', 'liftStore', 'hrStartTime'],
                     'function liftStripHTML(');
  const store = { statusText: () => 'STORE ✓ 1s ago', state: { missed: 0 } };
  const out = strip(liftStarted('strap'), true, 'S1', 88, () => 'STORE ✓ 2s ago', () => '00:00:01', s => String(s), L, store, 0)();
  const have = new Set([...out.matchAll(/id="([a-z-]+)"/g)].map(m => m[1]));
  const missing = [...ids].filter(id => !have.has(id));
  assert.deepEqual(missing, [], 'the live strip lacks ' + missing.join(', '));
  assert.ok(have.has('lift-store-status'), 'the Lift store status is not in the strip');
  // and a session whose strap is not live carries none of them (the HR ticker would drive a stopped session)
  const off = strip(liftStarted('none'), false, null, null, () => '', () => '00:00:01', s => String(s), L, store, 0)();
  assert.doesNotMatch(off, /id="hr-/, 'a strap-less strip carries an hr-* id');
  assert.match(off, /id="lift-timer"/);
  // the list, for the gate record (brief S4: "record the list")
  console.log('# strip inventory: ' + [...ids].sort().join(' '));
});

test('W3b S4 L19: while a Lift session runs, render() sends every route but the Lift screen (and the HR view with the strap) to the Lift screen', () => {
  const r = fnBody('function render() {');
  const lift = r.indexOf('if (liftRunning)'), hr = r.indexOf('if (hrSessionActive)'), gate = r.indexOf('if (!PB.signedIn())');
  assert.ok(lift > -1 && lift < hr && hr < gate, 'the Lift lock must precede the HR lock (A4) and the sign-in gate');
  const render = make(['location', 'liftRunning', 'LiftCore', 'liftStrapLinked', 'liftRenderLocked'], 'function render() {');
  const routes = ['', '#', '#home', '#review', '#confirm', '#signin', '#log/fast', '#log/note', '#log/heart_rate', '#log/resistance', '#lift/tpl/T1', '#lift/tpl/new'];
  for (const strap of [false, true]) {
    const allowed = strap ? ['#log/resistance', '#log/heart_rate'] : ['#log/resistance'];
    for (const route of routes) {
      const loc = { hash: route }; let drawn = null;
      render(loc, true, L, () => strap, h => { drawn = h; })();
      if (allowed.includes(route)) { assert.equal(drawn, route, `${route} (strap ${strap}) must render`); assert.equal(loc.hash, route); }
      else { assert.equal(drawn, null, `${route} (strap ${strap}) rendered under the lock`); assert.equal(loc.hash, '#log/resistance', `${route} (strap ${strap}) was not sent to the Lift screen`); }
    }
  }
});

test('W3b §3 Q2: UNDO on a filed Lift session discards it through the core, never a DELETE; the button says DISCARD', async () => {
  const calls = [];
  const PB = { update: async (id, body) => { calls.push(['update', id, body]); return { data: {}, error: null }; },
               remove: async id => { calls.push(['remove', id]); return { error: null }; } };
  let linked = 0, where = null;
  const undo = make(['db', 'confirmEntry', 'PB', 'LiftCore', 'liftUndoLinkedHr', 'showSafBackOnly', 'navigate', 'clearInterval'], 'async function undoEntry(');
  const entry = { id: 'R1', entry_type: 'resistance', metadata: L.fileShape(liftStarted('none').meta) };
  await undo(true, entry, PB, L, async () => { linked++; return null; }, () => {}, h => { where = h; }, () => {})('R1', 0);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0][0], 'update', 'a Lift UNDO must be a PATCH, never a DELETE');
  assert.equal(calls[0][2].metadata.state, 'discarded');
  assert.deepEqual(L.validateSession(calls[0][2].metadata), [], 'the discarded payload is not a valid session');
  assert.equal(linked, 1, 'the linked strap session is not offered its discard (§3 Q2)');
  assert.equal(where, '#home');
  // control: a plain entry still reaches the ONE delete site (the guard above keeps it at one)
  calls.length = 0;
  await undo(true, { id: 'N1', entry_type: 'note', metadata: {} }, PB, L, async () => null, () => {}, () => {}, () => {})('N1', 0);
  assert.deepEqual(calls.map(c => c[0]), ['remove']);
  assert.match(fnBody('function showSafUndo('), /entry_type === LiftCore\.ENTRY_TYPE\)\) \? 'UNDO &middot; DISCARD SESSION'/, 'the undo button says DELETE for a Lift session');
});

test('W3b S4 (ii): a strap session linked to the running Lift session has no stop and no LOG IT of its own', () => {
  const linked = make(['liftRunning', 'liftStrapLinked', 'hrLiftSessionId', 'liftSession', 'hrSessionActive', 'hrSessionData'], 'function liftLinkedHr(');
  const s = { session_id: 'S1' };
  assert.equal(linked(true, () => true, 'S1', s, true, null)(), true);
  assert.equal(linked(true, () => true, 'S1', s, false, { stopped: 1 })(), true, 'a stopped linked session is still the Lift session\'s');
  assert.equal(linked(false, () => true, 'S1', s, true, null)(), false, 'no Lift session runs');
  assert.equal(linked(true, () => false, 'S1', s, true, null)(), false, 'not a strap session');
  assert.equal(linked(true, () => true, 'OTHER', s, true, null)(), false, 'an HR session naming another Lift session');
  assert.equal(linked(true, () => true, null, s, true, null)(), false, 'an HR session naming no Lift session');
  const v = fnBody('function hrRenderLockedView(');
  assert.match(v, /var linked = liftLinkedHr\(\);/);
  const t = v.indexOf('(linked'), stop = v.indexOf('id="hr-stop-track"'), back = v.indexOf('id="hr-back-to-lift"');
  assert.ok(t > -1 && back > t && stop > back, 'the linked branch must replace the slide-to-stop');
  const rep = fnBody('function hrRenderReportView(');
  const b = rep.indexOf('if (liftLinkedHr()) {'), log = rep.indexOf("showSaf('LOG IT')");
  assert.ok(b > -1 && b < log, 'the report shows LOG IT before asking whether the session is linked');
  assert.match(rep.slice(b, log), /return;/, 'the linked branch falls through to LOG IT');
});

test('W3b L15 / Q3 (c): a strap session started from Lift carries lift_session_id from START (snapshot, checkpoint, both resumes)', () => {
  const snap = make(['hrSessionActive', 'hrSessionData', 'hrSessionId', 'hrDeviceLabel', 'hrExerciseType', 'hrSamples', 'hrRRBuffer', 'hrStartTime', 'hrEndTime', 'hrLiftSessionId'], 'function hrSnapshot(');
  const payload = liftId => H.checkpointPayload(Object.assign(snap(true, null, 'H1', () => 'phone', 'Weightlifting', [], [], 0, null, liftId)(), { state: 'active' }), '2099-01-02T00:00:00.000Z');
  assert.equal(payload('S1').lift_session_id, 'S1', 'the store payload does not name the Lift session');
  assert.ok(!('lift_session_id' in payload(null)), 'an HR session not started from Lift must carry no lift_session_id');
  assert.match(fnBody('function hrSaveCheckpoint('), /if \(hrLiftSessionId\) cp\.lift_session_id = hrLiftSessionId;/, 'the phone checkpoint drops it (pairDecision reads it at launch)');
  assert.match(fnBody('function hrSaveCheckpointFromStore('), /cp\.lift_session_id = m\.lift_session_id/, 'a store-side resume drops it');
  assert.match(fnBody('function hrResumeState('), /hrLiftSessionId = cp\.lift_session_id \|\| null;/);
  assert.match(fnBody('function hrBeginCapture('), /hrLiftSessionId = liftSessionId \|\| null;/);
  assert.match(fnBody('function hrResetState('), /hrLiftSessionId = null;/);
  assert.match(fnBody('function hrStartExercise('), /hrBeginCapture\(null\);/, 'the HR screen\'s own START names no Lift session');
  const start = fnBody('function liftStart(');
  assert.match(start, /hrExerciseType = LiftCore\.HR_EXERCISE_TYPE;\s*\n\s*hrBeginCapture\(sid\);/, 'the Lift START does not start the ONE capture path, typed by the core (L17)');
});

test('W3b L18: the Lift session\'s durability is wired (local copy on every change, store when due, page-hide flush, launch recovery, START guard)', () => {
  const init = html.slice(html.indexOf("window.addEventListener('DOMContentLoaded'"), html.indexOf('// ── ROUTER'));
  assert.match(init, /liftStore = LiftCore\.createLiftStoreSession\(PB, \{ now: function\(\) \{ return Date\.now\(\); \} \}\);/);
  assert.match(init, /liftLaunchRecovery\(\);/, 'launch recovery is not called at DOMContentLoaded');
  const commit = fnBody('function liftCommit(');
  assert.match(commit, /liftStore\.touch\(\);/); assert.match(commit, /liftSaveLocal\(\);/);
  for (const [fn, core] of [['function liftEdit(', 'LiftCore.editSet('], ['function liftCheck(', 'LiftCore.tapCheck('], ['function liftAddSet(', 'LiftCore.addSet('],
                            ['function liftRemoveSet(', 'LiftCore.removeSet('], ['function liftAddExercise(', 'LiftCore.addExercise('], ['function liftReviewInput(', 'LiftCore.setReview(']]) {
    const b = fnBody(fn);
    assert.ok(b.includes(core), fn + ' does not use ' + core);
    assert.match(b, /liftApply\(|liftCommit\(/, fn + ' changes the session without committing it');
  }
  assert.match(fnBody('function liftApply('), /liftCommit\(res\.meta\)/);
  assert.match(fnBody('function liftTick('), /liftStore\.due\(\)\) liftWrite\('active'\)/);
  const flush = fnBody('function liftFlushOnHide(');
  assert.match(flush, /PB\.flush\(liftStore\.state\.pbId, \{ metadata: LiftCore\.checkpointPayload\(liftSession\.meta, 'active'/);
  assert.match(html, /window\.addEventListener\('pagehide', liftFlushOnHide\)/); assert.match(html, /document\.addEventListener\('freeze', liftFlushOnHide\)/);
  const rec = fnBody('async function liftLaunchRecovery(');
  assert.match(rec, /ended_at = "" && metadata\.state = "active"/, 'launch recovery does not ask the store for an open session');
  assert.ok(rec.indexOf('PB.list(') < rec.indexOf('liftGetLocal()'), 'the store must be asked before the phone is read');
  assert.match(rec, /LiftCore\.resumeDecision\(/);
  const start = fnBody('function liftStart(');
  const g = start.indexOf('var guard = LiftCore.startGuard('), s = start.indexOf('LiftCore.startSession(');
  assert.ok(g > -1 && g < s, 'START must consult the guard (its result IS the guard) before starting a session');
  assert.match(start, /hrGetCheckpoint\(\) \|\| hrGetSlot\(HR_OTHER_KEY\)/, 'the guard does not see an unfiled HR session');
  const guardLine = start.slice(start.indexOf('if (guard)'), start.indexOf('\n', start.indexOf('if (guard)')));
  assert.ok(guardLine.indexOf("navigate('#home')") < guardLine.indexOf('showErr(guard.message)') && /setTimeout\(/.test(guardLine), 'the refusal is wiped by the home re-render (G-JA2-6)');
  assert.match(fnBody('function liftCanStart('), /LiftCore\.canStart\(/);
  const resume = fnBody('function liftResume(');
  assert.match(resume, /liftPairsHr\(\)/); assert.match(resume, /hrResumeState\(\) && hrSessionActive\) hrManualReconnect\(\)/, 'one RESUME does not resume and reconnect the strap session');
  assert.match(fnBody('function liftPairsHr('), /LiftCore\.pairDecision\(/);
  assert.match(fnBody('function hrResumeBannerHTML('), /if \(cp && !liftPairsHr\(\)\) html \+= hrBannerFor\(cp, 'primary'\);/, 'a paired HR session gets a second RESUME of its own');
  // the pairing itself, run: an INTERRUPTED Lift session carries its own strap session (one RESUME); a finished one does
  // not (its FILE files the Lift record only), nor does an HR session naming another Lift session
  const pairs = make(['liftGetLocal', 'hrGetCheckpoint', 'LiftCore', 'HRCore'], 'function liftPairsHr(');
  const lift = liftStarted('strap'), hr = { v: 2, started_at: lift.started_at, samples: [], session_id: 'H1', lift_session_id: 'S1' };
  assert.equal(pairs(() => lift, () => hr, L, H)(), true, 'an interrupted Lift session does not carry its strap session');
  assert.equal(pairs(() => Object.assign({}, lift, { ended_at: lift.started_at + 60000 }), () => hr, L, H)(), false, 'a finished Lift session hides its HR session\'s own banner');
  assert.equal(pairs(() => lift, () => Object.assign({}, hr, { lift_session_id: 'OTHER' }), L, H)(), false, 'an HR session naming another Lift session is paired');
  assert.equal(pairs(() => null, () => hr, L, H)(), false);
});

test('W3b L20: FINISH files both through LiftCore.fileBoth, Lift first; the HR session files with notes null and is never claimed', () => {
  const f = fnBody('async function liftFinish(');
  assert.match(f, /LiftCore\.fileBoth\(\s*\n\s*function\(\) \{ return liftWriteRetry\('filed', 3\); \},\s*\n\s*hrLinked \? function\(\) \{ return hrStoreWriteRetry\('filed', null, 3\); \} : null\)/);
  assert.match(f, /if \(hrLinked && hrSessionActive\) hrStopCapture\(\);/, 'FINISH must stop the capture without the HR report');
  assert.doesNotMatch(f, /hrEndExercise\(/);
  assert.match(f, /if \(outcome\.hr_filed === true\) \{ hrClearCheckpoint\(\); hrResetState\(\); \}/, 'an HR session is cleared only when it filed');
  assert.ok(f.indexOf('liftStartRetry()') > f.indexOf('if (outcome.lift_filed)'), 'a Lift session the store refused is not retried');
  assert.match(fnBody('function hrEndExercise('), /hrStopCapture\(\);\s*\n\s*hrRenderReportView\(\);/, 'the HR screen\'s own stop lost its report');
});

test('W3b: Log Review never lists a Lift template, and a discarded Lift session restores to filed through the core', () => {
  const v = fnBody('async function renderLogReview(');
  assert.match(v, /PB\.list\(\{ sort: '-started_at', perPage: 10, filter: 'entry_type != "' \+ LiftCore\.TEMPLATE_TYPE \+ '"' \}\)/);
  assert.match(v, /liftRestoreFromReview\(/);
  const r = fnBody('async function liftRestoreFromReview(');
  assert.match(r, /LiftCore\.checkpointPayload\(r\.data\.metadata, 'filed'/); assert.doesNotMatch(r, /PB\.remove/);
  assert.match(fnBody('function formatMetaReadable('), /case 'resistance':/);
});

test('W3b L14: no Lift path in the app script writes notes (the review is the one free text, in metadata)', () => {
  const names = [...appJs.matchAll(/function (lift\w+)\(/g)].map(m => m[1]);
  assert.ok(names.length >= 30, 'the derived Lift function inventory collapsed: ' + names.length);
  const writers = names.filter(n => /\bnotes\b/.test(fnBody('function ' + n + '(')));
  assert.deepEqual(writers, [], 'Lift functions naming notes: ' + writers.join(', '));
});

test('W3b D-60 (2): a strap connected on the Lift screen survives the Lift screens, and is released everywhere else', () => {
  const keeps = make(['LiftCore'], 'function liftKeepsStrap(')(L);
  for (const h of ['#log/resistance', '#lift/tpl/T1', '#lift/tpl/new']) assert.equal(keeps(h), true, h);
  for (const h of ['#home', '#log/heart_rate', '#review', '#confirm', '#log/fast', '#lift']) assert.equal(keeps(h), false, h);
  const r = fnBody('function render() {');
  const k = r.indexOf('if (!liftKeepsStrap(hash)) {');
  assert.ok(k > -1 && k < r.indexOf('hrDevice.gatt.disconnect()'), 'the teardown does not consult the Lift screens');
});

test('W3b: a running Lift session is never interrupted by a lost sign-in; the Lift entry is on Home and routed', () => {
  assert.match(fnBody('function pbAuthLost('), /if \(liftRunning\) return;/);
  assert.match(html, /resistance: \{ code:'LI', label:'Lift',/);
  assert.match(fnBody('function renderForm('), /case 'resistance': liftRenderPick\(meta\);/);
  assert.match(fnBody('function render() {'), /hash\.startsWith\('#lift\/tpl\/'\)[\s\S]*liftRenderTemplate\(/);
  assert.equal(L.LIFT_ROUTE, '#log/' + 'resistance', 'the core\'s Lift route is not the EMETA route');
});

test('s31: the confirm screen\'s UNDO countdown never writes the footer of a screen it no longer owns (it replaced a Lift session\'s FINISH)', () => {
  const run = keepScreen => {
    let tick = null, cleared = 0, backOnly = 0;
    const app = { innerHTML: '' }, txt = { textContent: '' };
    const doc = { getElementById: id => id === 'app' ? app : id === 'undo-txt' ? (keepScreen ? txt : null) : null };
    const rc = make(['confirmEntry', 'document', 'EMETA', 'fmtHeaderDate', 'setInterval', 'clearInterval', 'showSafUndo', 'showSafBackOnly', 'LiftCore', 'liftConfirmHTML', 'navigate'],
                    'function renderConfirm(');
    rc({ id: 'N1', entry_type: 'note', started_at: '2099-01-02 00:00:00.000Z', metadata: {} }, doc, { note: { code: 'NT', label: 'Note' } }, () => '',
       f => { tick = f; return 7; }, () => { cleared++; }, () => {}, () => { backOnly++; }, L, () => '', () => {})();
    assert.ok(tick, 'renderConfirm set no countdown');
    for (let i = 0; i < 40 && !cleared; i++) tick();   // a cleared interval fires no more
    return { cleared, backOnly };
  };
  const gone = run(false);
  assert.equal(gone.backOnly, 0, 'the countdown wrote the footer after its screen was gone');
  assert.ok(gone.cleared >= 1, 'the countdown kept running after its screen was gone');
  const stay = run(true);   // control: on its own screen the countdown still ends in the back-only bar
  assert.equal(stay.backOnly, 1);
});

test('W3b: the app script calls the Lift core at every site and defines no Lift rule of its own', () => {
  for (const site of ['LiftCore.createLiftStoreSession(PB', 'LiftCore.startGuard(', 'LiftCore.resumeDecision(', 'LiftCore.pairDecision(', 'LiftCore.lockRoute(',
                      'LiftCore.fileBoth(', 'LiftCore.startSession(', 'LiftCore.canStart(', 'LiftCore.linkHr(', 'LiftCore.historyFor(', 'LiftCore.pickable(',
                      'LiftCore.templateRecord(', 'LiftCore.templateMeta(', 'LiftCore.archiveTemplate(', 'LiftCore.linesFor(', 'LiftCore.moveLine(',
                      'LiftCore.checkpointPayload(', 'LiftCore.progress(', 'LiftCore.summary(', 'LiftCore.lineVolume(', 'LiftCore.isOpenLift', 'LiftCore.setKind(']) {
    assert.ok(appJs.includes(site), 'index.html does not call ' + site);
  }
  assert.doesNotMatch(appJs, /CHECKPOINT_SEC\s*=|ZERO_REPS_WITH_WEIGHT\s*=|'Weightlifting'\s*;/, 'index.html defines a Lift constant of its own');
  assert.doesNotMatch(appJs, /\.r \* [a-z.]*\.w|r \* w\b/, 'index.html computes a volume of its own (L1 is the core\'s)');
});
