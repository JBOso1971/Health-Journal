#!/usr/bin/env node
// tests/prove_journal.mjs — THE prover for the journal's client estate (CLAUDE.md §5; modelled on
// Platform/tests/prove_aiamata.py). One registry of mutations; each is applied to the tree, the NAMED
// tests must FAIL, the file is restored byte-for-byte. Guard rails:
//   - anchor matches exactly once; replacement differs from anchor
//   - pristine tree green first (run_all), unless --skip-pristine
//   - the named test FAILS by name in TAP output, and the suite actually RAN tests (ran 0 = problem)
//   - every discovered suite is named by some mutation; every named suite exists
//   - restoration verified by bytes
// Prints a PROBLEMS block; the gate reads that, never the count. Re-run after ANY edit, comment-only included.
//   node tests/prove_journal.mjs              everything
//   node tests/prove_journal.mjs --only M3    one mutation (substring on id)
//   node tests/prove_journal.mjs --check      registry checks only
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { discover, runFile, ROOT } from './run_all.mjs';

const REGISTRY = [
  { id: 'M1-merge-drops-last', what: 'the merged series loses its last sample -> a resume silently truncates',
    file: 'hr-core.js',
    anchor: "    return Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return byT[t]; });\n",
    replacement: "    return Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return byT[t]; }).slice(0, -1);\n",
    must_fail: ['test_hr_core.mjs:mergeSamples: union by t, ascending, never drops a real sample'] },
  { id: 'M2-est-beats-real', what: 'an estimated sample overwrites a real one -> fabricated data persists (J3)',
    file: 'hr-core.js',
    anchor: "      if (newReal && !curReal) { byT[s.t] = s; return; }\n",
    replacement: "      if (!newReal && curReal) { byT[s.t] = s; return; }\n",
    must_fail: ['test_hr_core.mjs:mergeSamples: a real sample beats an estimated one on either side'] },
  { id: 'M3-tick-off-by-one', what: 'the tick fires one interval late (> instead of >=)',
    file: 'hr-core.js',
    anchor: "    return nowMs - lastOkMs >= iv * 1000;\n",
    replacement: "    return nowMs - lastOkMs > iv * 1000;\n",
    must_fail: ['test_hr_core.mjs:tickDue: due at exactly the interval, not one ms before; first tick always due'] },
  { id: 'M4-stale-boundary', what: 'a session at exactly 6 h reads stale (>= instead of >)',
    file: 'hr-core.js',
    anchor: "      if (nowMs - lastMs > staleS * 1000) {\n",
    replacement: "      if (nowMs - lastMs >= staleS * 1000) {\n",
    must_fail: ['test_hr_core.mjs:resumeDecision: the stale boundary is exactly 6 h from checkpoint_at (± 1 s)'] },
  { id: 'M5-guard-silent', what: 'START allowed over an unfiled local session (the 21 Sep loss)',
    file: 'hr-core.js',
    anchor: "    var src = local || storeOpen;\n    if (!src) return null;\n",
    replacement: "    var src = storeOpen;\n    if (!src) return null;\n",
    must_fail: ['test_hr_core.mjs:startGuard: null with nothing unfiled; a refusal naming minutes and samples otherwise'] },
  { id: 'M6-offline-none', what: 'store unreachable -> "none" even with a local session (an absence reads like a pass)',
    file: 'hr-core.js',
    anchor: "      return local ? { action: localAction, source: 'local', offline: true, local: local }\n",
    replacement: "      return false ? { action: localAction, source: 'local', offline: true, local: local }\n",
    must_fail: ['test_hr_core.mjs:resumeDecision: store unreachable -> the local decision with offline:true, never "none" while a local exists'] },
  { id: 'M7-est-persisted-active', what: 'an est sample is written to the store mid-session',
    file: 'hr-core.js',
    anchor: "    if (session.state === 'active' && samples.some(function (s) { return s.est; })) {\n",
    replacement: "    if (session.state === 'never' && samples.some(function (s) { return s.est; })) {\n",
    must_fail: ['test_hr_core.mjs:checkpointPayload: an est sample in an ACTIVE session is refused (J3); allowed once stopped'] },
  { id: 'M8-state-unchecked', what: 'an unknown state is accepted into the store',
    file: 'hr-core.js',
    anchor: "    if (STATES.indexOf(session.state) < 0) throw new Error('checkpointPayload: unknown state ' + session.state);\n",
    replacement: "    if (STATES.indexOf(session.state) < -1) throw new Error('checkpointPayload: unknown state ' + session.state);\n",
    must_fail: ['test_hr_core.mjs:checkpointPayload: refuses an unknown state and a missing now'] },
  { id: 'M11-engine-merge-not-written', what: 'the engine merges but PATCHes the phone-only series -> the other window\'s samples are lost in the store',
    file: 'hr-core.js',
    anchor: "            body.metadata.samples = merged; body.metadata.rr = rr;\n",
    replacement: "            body.metadata.rr = rr;\n",
    must_fail: ['test_store_session.mjs:G-JA2-3 replay: offline start, dropped tick, second window, stale read, stop, file -> the store holds the union'] },
  { id: 'M12-engine-failed-insert-uncounted', what: 'a failed insert is not counted -> the badge says saving forever (an absence reads like a pass)',
    file: 'hr-core.js',
    anchor: "          if (!ins || ins.error || !ins.data || !ins.data.id) return fail();\n",
    replacement: "          if (!ins || ins.error || !ins.data || !ins.data.id) return false;\n",
    must_fail: ['test_store_session.mjs:G-JA2-3 replay: offline start, dropped tick, second window, stale read, stop, file -> the store holds the union'] },
  { id: 'M13-engine-busy-race', what: 'two writes in flight -> a duplicate record',
    file: 'hr-core.js',
    anchor: "      if (st.busy) return false;\n      st.busy = true;\n",
    replacement: "      st.busy = true;\n",
    must_fail: ['test_store_session.mjs:busy: a second write while one is in flight is refused, not queued into a race'] },
  { id: 'M14-engine-adopt-loses-record', what: 'a resumed session forgets its record id -> a rival record on the first tick',
    file: 'hr-core.js',
    anchor: "    function adopt(pbId, missed) { st.pbId = pbId || null; st.missed = missed || 0; st.lastOk = null; }\n",
    replacement: "    function adopt(pbId, missed) { st.pbId = null; st.missed = missed || 0; st.lastOk = null; }\n",
    must_fail: ['test_store_session.mjs:adopt: a resumed session continues the SAME record and merges what the store already holds'] },
  { id: 'M15-engine-status-hides-missed', what: 'the status line never shows the missed count',
    file: 'hr-core.js',
    anchor: "      if (st.missed > 0) return 'STORE OFFLINE \· ' + st.missed + ' missed';\n",
    replacement: "      if (st.missed > 99) return 'STORE OFFLINE \· ' + st.missed + ' missed';\n",
    must_fail: ['test_store_session.mjs:statusText tells the truth: saving, ok with age, offline with the missed count'] },
  { id: 'M16-reconnect-unbounded', what: 'the reconnect loop never stops (the pre-JA2 behaviour: invisible, endless)',
    file: 'hr-core.js',
    anchor: "    if (attempt >= RECONNECT_MAX) return { retry: false, delayMs: null, attempt: attempt };\n",
    replacement: "    if (attempt >= RECONNECT_MAX * 1000) return { retry: false, delayMs: null, attempt: attempt };\n",
    must_fail: ['test_hr_core.mjs:reconnectPolicy: attempt 0 at once, then every 4 s, stops at RECONNECT_MAX (bounded, A1.3)'] },
  { id: 'M17-visibility-no-reconnect', what: 'returning to the foreground only re-acquires the wake lock (the pre-JA2 handler)',
    file: 'index.html',
    anchor: "  if (!hrChar && hrDevice) { hrReconnectAttempts = 0; hrScheduleReconnect(0); }\n",
    replacement: "  if (!hrChar && hrDevice) { hrReconnectAttempts = 0; }\n",
    must_fail: ['test_shell.mjs:S3 wiring: foreground return reconnects, page hide flushes with keepalive, the loop is bounded by the core'] },
  { id: 'M18-review-shows-discarded', what: 'Log Review lists discarded sessions as if filed (the toggle is decorative)',
    file: 'index.html',
    anchor: "  var data = result.data.filter(function(e) { return rvShowDiscarded || HRCore.stateOf(e) !== 'discarded'; });\n",
    replacement: "  var data = result.data.filter(function(e) { return true || HRCore.stateOf(e) !== 'discarded'; });\n",
    must_fail: ['test_shell.mjs:S4 wiring: Log Review hides discarded behind a toggle, labels states, files and restores without a DELETE'] },
  { id: 'M19-manifest-truncated', what: 'manifest.json truncated mid-string (the state found live on 2026-09-21) -> Chrome installs a shortcut, not the app',
    file: 'manifest.json',
    anchor: '      "purpose": "maskable"\n    }\n  ]\n}\n',
    replacement: '      "purpose": "',
    must_fail: ["test_shell.mjs:manifest.json parses and meets Chrome's install criteria (found TRUNCATED on 2026-09-21: the shortcut-not-app cause)"] },
  { id: 'M9-sw-shell-drops-core', what: 'the service worker stops caching hr-core.js -> the app shell breaks offline',
    file: 'sw.js',
    anchor: "'/Health-Journal/hr-core.js'",
    replacement: "'/Health-Journal/hr-core.js.missing'",
    must_fail: ['test_shell.mjs:sw.js caches hr-core.js in the shell and the cache version is past v7'] },
  { id: 'M10-html-drops-core', what: 'index.html no longer loads hr-core.js',
    file: 'index.html',
    anchor: '<script src="hr-core.js"></script>',
    replacement: '<script src="hr-core.js.missing"></script>',
    must_fail: ['test_shell.mjs:hr-core.js exists and index.html loads it BEFORE the app script'] },
];

function checkRegistry(reg, discovered) {
  const problems = [];
  const discNames = new Set(discovered.map(f => basename(f)));
  const ids = new Set();
  const named = new Set();
  for (const m of reg) {
    if (ids.has(m.id)) problems.push(`${m.id}: duplicate id`);
    ids.add(m.id);
    const p = join(ROOT, m.file);
    if (!existsSync(p)) { problems.push(`${m.id}: file ${m.file} missing`); continue; }
    const src = readFileSync(p, 'utf8');
    const n = src.split(m.anchor).length - 1;
    if (n !== 1) problems.push(`${m.id}: anchor matches ${n} time(s) in ${m.file}, expected exactly 1`);
    if (m.replacement === m.anchor) problems.push(`${m.id}: replacement equals anchor`);
    if (!m.must_fail.length) problems.push(`${m.id}: names no test`);
    for (const t of m.must_fail) {
      const [file] = t.split(':');
      named.add(file);
      if (!discNames.has(file)) problems.push(`${m.id}: names ${file}, not discovered`);
    }
  }
  for (const f of discNames) if (!named.has(f)) problems.push(`suite ${f} is named by no mutation`);
  return problems;
}

function proveOne(m) {
  const problems = [];
  const p = join(ROOT, m.file);
  const pristine = readFileSync(p);
  const src = pristine.toString('utf8');
  writeFileSync(p, src.replace(m.anchor, m.replacement));
  try {
    const byFile = new Map();
    for (const t of m.must_fail) { const [file, ...rest] = t.split(':'); (byFile.get(file) || byFile.set(file, []).get(file)).push(rest.join(':')); }
    for (const [file, names] of byFile) {
      const r = runFile(join(ROOT, 'tests', file));
      if (r.ran === 0) problems.push(`${m.id}: ${file} ran ZERO tests under the mutation`);
      for (const name of names) {
        if (!r.failed.includes(name)) problems.push(`${m.id}: '${name}' did NOT fail (${file}); failed=[${r.failed.join(' | ')}]`);
      }
    }
  } finally {
    writeFileSync(p, pristine);
    if (!readFileSync(p).equals(pristine)) problems.push(`${m.id}: ${m.file} NOT restored byte-for-byte`);
  }
  return problems;
}

function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const discovered = discover();
  let problems = checkRegistry(REGISTRY, discovered);
  console.log(`prove_journal: ${REGISTRY.length} mutation(s) registered, ${discovered.length} suite(s) discovered`);
  if (argv.includes('--check')) return report(problems);
  if (!argv.includes('--skip-pristine')) {
    for (const f of discovered) { const r = runFile(f); if (r.code !== 0 || r.ran === 0) problems.push(`pristine tree NOT green: ${basename(f)} (ran=${r.ran}, failed=[${r.failed.join(' | ')}])`); }
    if (problems.length) return report(problems);
  }
  let caught = 0;
  for (const m of REGISTRY.filter(m => !only || m.id.includes(only))) {
    const pr = proveOne(m);
    console.log(`${pr.length ? 'MISSED' : 'CAUGHT'}  ${m.id}  -- ${m.what}`);
    problems.push(...pr); if (!pr.length) caught++;
  }
  console.log(`prove_journal: ${caught} CAUGHT`);
  return report(problems);
}

function report(problems) {
  console.log(`PROBLEMS: ${problems.length}`);
  for (const p of problems) console.log('  - ' + p);
  return problems.length ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
