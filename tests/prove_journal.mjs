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
  { id: 'M20-review-toggle-in-footer', what: 'the discarded toggle back in the footer (the state found live on 2026-09-22: under the fixed bar, a tap lands on the bar)',
    file: 'index.html',
    anchor: "    '<div class=\"audit-footer\">&middot; tap any row to expand details</div>';\n",
    replacement: "    '<div class=\"audit-footer\">&middot; tap any row to expand details &middot; <a href=\"#\" onclick=\"rvShowDiscarded=!rvShowDiscarded;render();return false\">show discarded sessions</a></div>';\n",
    must_fail: ['test_shell.mjs:Log Review: the discarded toggle renders ABOVE the list, never in the footer under the fixed bar (found live 2026-09-22)'] },
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
  { id: 'M21-stale-from-started-at', what: 'staleness measured from started_at although a checkpoint exists -> any session longer than 6 h, or resumed late, reads stale and is never resumed',
    file: 'hr-core.js',
    anchor: "      var lastMs = parseMs(m.checkpoint_at) || parseMs(store.started_at);\n",
    replacement: "      var lastMs = parseMs(store.started_at) || parseMs(m.checkpoint_at);\n",
    must_fail: ['test_hr_core.mjs:resumeDecision: ten-instant clock sweep — stale boundary ± 1 s, both spellings, fallback, checkpoint beats started_at'] },
  // ── W2 S3: native auth (pb-client.js + the index.html wiring) ──
  { id: "W2-C1-header-dropped", what: "the token is never attached -> every call goes out as a guest (reads 200/0 rows once the rules close)",
    file: "pb-client.js",
    anchor: "      if (a) h.Authorization = a.token;\n",
    replacement: "      if (a && false) h.Authorization = a.token;\n",
    must_fail: ["test_pb_client.mjs:every journal verb carries Authorization = the held token", "test_pb_client.mjs:flush: the page-teardown PATCH carries keepalive AND the token, through the same door as every other call"] },
  { id: "W2-C2-no-token-still-sent", what: "a signed-out client still calls the server -> an empty-looking journal after the flip (G-W2-4)",
    file: "pb-client.js",
    anchor: "      if (!usableAuth()) { onAuthLost(",
    replacement: "      if (false) { onAuthLost(",
    must_fail: ["test_pb_client.mjs:no token -> no request: every verb is refused locally with status 401 and the app is told (never an empty-looking journal)"] },
  { id: "W2-C3-expiry-ignored", what: "an expired token is still used -> guest reads that look like an empty journal",
    file: "pb-client.js",
    anchor: "      if (exp === null || exp * 1000 <= now()) {",
    replacement: "      if (exp === null) {",
    must_fail: ["test_pb_client.mjs:an expired token (exp <= now, to the second) is treated as none and cleared; one second earlier it is live"] },
  { id: "W2-C4-expiry-off-by-one", what: "a token at exactly exp reads live (<= became <)",
    file: "pb-client.js",
    anchor: "exp * 1000 <= now()",
    replacement: "exp * 1000 < now()",
    must_fail: ["test_pb_client.mjs:an expired token (exp <= now, to the second) is treated as none and cleared; one second earlier it is live"] },
  { id: "W2-C5-401-keeps-session", what: "a server 401/403 is returned but the dead token is kept -> the app never reaches sign-in",
    file: "pb-client.js",
    anchor: "        if (REFUSED.indexOf(r.status) >= 0) lose('refused');\n",
    replacement: "        if (false) lose('refused');\n",
    must_fail: ["test_pb_client.mjs:a server 401 or 403 on a journal verb ends the session (token cleared, app told); 400 and 404 do not"] },
  { id: "W2-C6-404-signs-out", what: "a rule non-match (404) is read as a lost session -> a bad id signs the user out",
    file: "pb-client.js",
    anchor: "  var REFUSED = [401, 403];",
    replacement: "  var REFUSED = [401, 403, 404];",
    must_fail: ["test_pb_client.mjs:a server 401 or 403 on a journal verb ends the session (token cleared, app told); 400 and 404 do not"] },
  { id: "W2-C7-remove-swallows", what: "a refused DELETE reports success (C-8, the pre-W2 undo)",
    file: "pb-client.js",
    anchor: "undefined, function () { return null; }); return { error: r.error }; },",
    replacement: "undefined, function () { return null; }); return { error: null }; },",
    must_fail: ["test_pb_client.mjs:C-8: remove() returns the refusal, never a silent success"] },
  { id: "W2-C8-empty-body-is-data", what: "a 200 with no readable body becomes an empty list",
    file: "pb-client.js",
    anchor: "      catch (e) { return { data: null, error: { status: r.status, message: 'unreadable response (' + r.status + ')' } }; }\n",
    replacement: "      catch (e) { return { data: [], error: null }; }\n",
    must_fail: ["test_pb_client.mjs:offline and unreadable responses come back as errors, never a throw and never data"] },
  { id: "W2-C9-password-stored", what: "sign-in writes the password into localStorage beside the token",
    file: "pb-client.js",
    anchor: "        writeAuth({ token: r.json.token, id: r.json.record.id, email: r.json.record.email || null });\n        st.reason = null;\n",
    replacement: "        writeAuth({ token: r.json.token, id: r.json.record.id, email: r.json.record.email || null, pw: password });\n        st.reason = null;\n",
    must_fail: ["test_pb_client.mjs:signIn: POSTs identity + password to users/auth-with-password, stores {token,id,email}; the password is stored NOWHERE"] },
  { id: "W2-C10-refresh-signs-out-offline", what: "an offline/5xx refresh clears the token -> a phone in a basement is signed out",
    file: "pb-client.js",
    anchor: "        return { error: { status: r.status, message: 'refresh unavailable (kept signed in)' } };",
    replacement: "        lose('refused'); return { error: { status: r.status, message: 'refresh unavailable (kept signed in)' } };",
    must_fail: ["test_pb_client.mjs:refresh: a refusal (401/403/404) clears the token; offline or a 5xx KEEPS it (a phone in a basement is not signed out)"] },
  { id: "W2-C11-signout-wipes-drafts", what: "sign-out removes the active fast and the capture checkpoint with the token",
    file: "pb-client.js",
    anchor: "      signOut: function () { clearAuth(); st.reason = 'signed out'; },",
    replacement: "      signOut: function () { ['jf', 'hr_session'].forEach(function (k) { storage.removeItem(k); }); clearAuth(); st.reason = 'signed out'; },",
    must_fail: ["test_pb_client.mjs:signOut clears pb_auth and ONLY pb_auth: the active fast, the capture checkpoint and the slots survive"] },
  { id: "W2-C12-flush-no-keepalive", what: "the teardown PATCH loses keepalive -> it dies with the page",
    file: "pb-client.js",
    anchor: "      if (extra && extra.keepalive) init.keepalive = true;",
    replacement: "      if (false) init.keepalive = true;",
    must_fail: ["test_pb_client.mjs:flush: the page-teardown PATCH carries keepalive AND the token, through the same door as every other call"] },
  { id: "W2-C13-exp-not-base64url", what: "the JWT payload is decoded as plain base64 -> a token whose payload carries - or _ reads as unreadable",
    file: "pb-client.js",
    anchor: "parts[1].replace(/-/g, '+').replace(/_/g, '/')",
    replacement: "parts[1]",
    must_fail: ["test_pb_client.mjs:tokenExp reads base64url payloads (the - and _ alphabet, no padding) and refuses anything else"] },
  { id: "W2-C14-untested-verb", what: "a new network verb is added to the client with no test naming it",
    file: "pb-client.js",
    anchor: "      // Page teardown: a keepalive PATCH",
    replacement: "      raw: function (p) { return send('GET', p); },\n      // Page teardown: a keepalive PATCH",
    must_fail: ["test_pb_client.mjs:the verb inventory is derived from the client object itself, both directions (a new verb cannot ship untested)"] },
  { id: "W2-H1-undo-drops-result", what: "undoEntry drops the DELETE result again (C-8 as found)",
    file: "index.html",
    anchor: "    } else r = await PB.remove(id);",
    replacement: "    } else await PB.remove(id);",
    must_fail: ["test_shell.mjs:C-8: every PB journal call site consumes its result (the inventory is derived from the tree, not listed)"] },
  { id: "W2-H2-endfast-clears-on-refusal", what: "a refused END FAST still clears jf -> the fast is lost locally while the store says it is running",
    file: "index.html",
    anchor: "retry'); autoHideErr(6000); return; }\n  }\n  clearActiveFast();",
    replacement: "retry'); autoHideErr(6000); }\n  }\n  clearActiveFast();",
    must_fail: ["test_shell.mjs:C-8: a refused undo and a refused fast-end stay put and say so; the fast stays in jf"] },
  { id: "W2-H3-flush-bypasses-client", what: "the page-hide flush goes back to a raw fetch -> no token, refused once the rules close",
    file: "index.html",
    anchor: "    PB.flush(hrStore.state.pbId, body);   // keepalive: true, with the token (pb-client.js)\n",
    replacement: "    fetch(PB_URL + '/api/collections/journal_entries/records/' + hrStore.state.pbId, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });   // keepalive: true\n",
    must_fail: ["test_shell.mjs:W2: the app script issues no request of its own -- its one fetch( is the injection into PBClient.create", "test_shell.mjs:S3 wiring: foreground return reconnects, page hide flushes with keepalive, the loop is bounded by the core"] },
  { id: "W2-H4-authloss-interrupts-capture", what: "a lost session routes to sign-in in the middle of a recording",
    file: "index.html",
    anchor: "  if (hrSessionActive) return;\n  if (location.hash !== '#signin')",
    replacement: "  if (location.hash !== '#signin')",
    must_fail: ["test_shell.mjs:W2: the sign-in gate sits AFTER the capture lock and routes every signed-out view to the sign-in screen"] },
  { id: "W2-H5-no-launch-refresh", what: "the token is never refreshed at launch -> it dies 14 days after sign-in regardless of use",
    file: "index.html",
    anchor: "  PB.refresh();         // W2:",
    replacement: "  void 0;         // W2:",
    must_fail: ["test_shell.mjs:W2: the sign-in gate sits AFTER the capture lock and routes every signed-out view to the sign-in screen"] },
  { id: "W2-H6-review-error-as-empty", what: "Log Review shows a refused read as \"no entries found\" (an absence reads like a pass)",
    file: "index.html",
    anchor: "'<div class=\"empty-state\">could not load entries &middot; '",
    replacement: "'<div class=\"empty-state\">no entries found &middot; '",
    must_fail: ["test_shell.mjs:W2: Log Review never shows a failed read as an empty journal"] },
  { id: "W2-H7-signin-stores-password", what: "the sign-in form copies the password into localStorage",
    file: "index.html",
    anchor: "  pw.value = '';                // the password lives only in the request\n",
    replacement: "  localStorage.setItem('pb_pw', pw.value); pw.value = '';\n",
    must_fail: ["test_shell.mjs:W2: the sign-in screen -- password field, no sign-up, the password cleared after the call and never stored"] },
  { id: "W2-H8-signout-clears-storage", what: "the sign-out link clears all of localStorage (fast, checkpoint, slots)",
    file: "index.html",
    anchor: "  PB.signOut();\n  navigate('#signin');",
    replacement: "  PB.signOut(); localStorage.clear();\n  navigate('#signin');",
    must_fail: ["test_shell.mjs:Q8: the home footer carries a sign-out link, and sign-out clears the token only (drafts survive)"] },
  { id: "W2-H9-sw-drops-client", what: "the service worker stops caching pb-client.js -> the shell cannot boot offline",
    file: "sw.js",
    anchor: "'/Health-Journal/pb-client.js', ",
    replacement: "",
    must_fail: ["test_shell.mjs:W2: pb-client.js exists, loads after hr-core.js and before the app script, and the service worker caches it"] },
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
