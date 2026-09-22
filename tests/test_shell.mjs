// tests/test_shell.mjs — the app shell wires the core in (CLAUDE.md §5: where a sentence names a FILE, something
// asserts the file EXISTS and is referenced — in index.html and in the service worker's shell list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.match(flush, /keepalive: true/);
  assert.match(flush, /hrSaveCheckpoint\(\)/);
  assert.match(html, /window\.addEventListener\('pagehide', hrFlushOnHide\)/);
  const sched = html.slice(html.indexOf('function hrScheduleReconnect'), html.indexOf('function hrOnData'));
  assert.match(sched, /HRCore\.reconnectPolicy\(hrReconnectAttempts\)/, 'the loop does not consult the core policy');
  assert.match(sched, /if \(!plan\.retry\) return;/);
  assert.match(html, /navigator\.bluetooth\.getDevices === 'function'/, 'Q8: the getDevices path is absent');
  assert.doesNotMatch(html, /RECONNECT_MAX\s*=\s*\d+/, 'index.html defines its own reconnect ceiling');
});

test('S4 wiring: Log Review hides discarded behind a toggle, labels states, files and restores without a DELETE', () => {
  const rv = html.slice(html.indexOf("var result = await PB.list({ sort: '-started_at', perPage: 10 });"), html.indexOf('function toggleReviewDetail'));
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
