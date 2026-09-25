// tests/test_hr_core.mjs — the pure core (hr-core.js), the REAL module (CLAUDE.md §5: no mocks at the seam).
// Fixtures use far-future sentinels; every clock is an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../hr-core.js');

const T0 = Date.parse('2099-03-01T10:00:00Z');                 // a far-future "now"
const iso = ms => new Date(ms).toISOString();
const pb = ms => iso(ms).replace('T', ' ');                     // PocketBase's space-separated form
const S = (t, bpm, est) => (est ? { t, bpm, est: true } : { t, bpm });

// ---------------------------------------------------------------- merge ----
test('mergeSamples: union by t, ascending, never drops a real sample', () => {
  const base = [S(0, 90), S(5, 92), S(10, 95)];
  const fresh = [S(10, 96), S(15, 100), S(20, 104)];
  const out = C.mergeSamples(base, fresh);
  assert.deepEqual(out.map(s => s.t), [0, 5, 10, 15, 20]);
  assert.equal(out.length, 5);
  assert.equal(out[out.length - 1].bpm, 104);                 // the LAST sample survives (the mutation target)
  assert.equal(out[2].bpm, 96);                                // two reals at one t: fresh wins
});

test('mergeSamples: a real sample beats an estimated one on either side', () => {
  assert.equal(C.mergeSamples([S(5, 100, true)], [S(5, 120)])[0].bpm, 120);
  assert.equal(C.mergeSamples([S(5, 120)], [S(5, 100, true)])[0].bpm, 120);
  assert.equal(C.mergeSamples([S(5, 120)], [S(5, 100, true)])[0].est, undefined);
});

test('mergeSamples: unsorted input comes out sorted; empty sides are fine', () => {
  assert.deepEqual(C.mergeSamples([S(20, 1), S(0, 2)], null).map(s => s.t), [0, 20]);
  assert.deepEqual(C.mergeSamples(undefined, undefined), []);
});

test('mergeSamples: a malformed sample is refused, not silently dropped', () => {
  assert.throws(() => C.mergeSamples([{ t: 'x', bpm: 1 }], []), /bad sample/);
  assert.throws(() => C.mergeSamples([], [{ t: 5 }]), /bad sample/);
});

test('mergeRR: the longer list wins and neither side is shortened', () => {
  assert.deepEqual(C.mergeRR([800, 810], [800, 810, 805]), [800, 810, 805]);
  assert.deepEqual(C.mergeRR([800, 810, 805], [1]), [800, 810, 805]);
  assert.deepEqual(C.mergeRR(null, undefined), []);
});

// ------------------------------------------------------------- tick due ----
test('tickDue: due at exactly the interval, not one ms before; first tick always due', () => {
  assert.equal(C.tickDue(null, T0), true);
  assert.equal(C.tickDue(T0, T0 + 60_000 - 1), false);
  assert.equal(C.tickDue(T0, T0 + 60_000), true);
  assert.equal(C.tickDue(T0, T0 + 5_000, 5), true);
  assert.equal(C.STORE_TICK_SEC, 60);                          // Q1 ruled 60 s (gate record §1)
});

// ------------------------------------------------------------- payload ----
const session = () => ({ state: 'active', session_id: 'sid-1', device: 'pixel', exercise_type: 'Weightlifting',
                         samples: [S(0, 90), S(5, 95)], rr: [800, 790], missed_ticks: 2 });

test('checkpointPayload: v2 shape, every summary key present and null while active', () => {
  const p = C.checkpointPayload(session(), iso(T0));
  assert.equal(p.v, 2);
  assert.equal(p.state, 'active');
  assert.equal(p.session_id, 'sid-1');
  assert.equal(p.checkpoint_at, iso(T0));
  assert.equal(p.missed_ticks, 2);
  assert.deepEqual(p.samples, [S(0, 90), S(5, 95)]);
  assert.deepEqual(p.rr, [800, 790]);
  for (const k of ['duration_sec', 'active_sec', 'gap_sec', 'est_sec', 'gaps', 'bpm_avg', 'bpm_max', 'bpm_min', 'rmssd_ms', 'zone_time_sec']) {
    assert.ok(k in p, k + ' missing'); assert.equal(p[k], null, k + ' should be null while active');
  }
});

test('checkpointPayload: refuses an unknown state and a missing now', () => {
  assert.throws(() => C.checkpointPayload({ ...session(), state: 'paused' }, iso(T0)), /unknown state/);
  assert.throws(() => C.checkpointPayload(session(), ''), /now is required/);
});

test('checkpointPayload: an est sample in an ACTIVE session is refused (J3); allowed once stopped', () => {
  const s = session(); s.samples.push(S(10, 97, true));
  assert.throws(() => C.checkpointPayload(s, iso(T0)), /est sample/);
  const stopped = { ...s, state: 'stopped', summary: { duration_sec: 15, bpm_avg: 94 } };
  const p = C.checkpointPayload(stopped, iso(T0));
  assert.equal(p.duration_sec, 15); assert.equal(p.bpm_avg, 94); assert.equal(p.gap_sec, null);
});

test('checkpointPayload: lift_session_id passes through when the session carries it, and is ABSENT otherwise (W3b Q3 (c))', () => {
  const plain = C.checkpointPayload(session(), iso(T0));
  assert.equal('lift_session_id' in plain, false, 'an HR session not started from Lift carries no lift_session_id key');
  assert.equal('lift_session_id' in C.checkpointPayload({ ...session(), lift_session_id: null }, iso(T0)), false);
  const linked = C.checkpointPayload({ ...session(), lift_session_id: 'lift-sid-9' }, iso(T0));
  assert.equal(linked.lift_session_id, 'lift-sid-9');
  assert.throws(() => C.checkpointPayload({ ...session(), lift_session_id: 42 }, iso(T0)), /lift_session_id/);
  assert.throws(() => C.checkpointPayload({ ...session(), lift_session_id: '' }, iso(T0)), /lift_session_id/);
});

test('checkpointPayload: the payload is a copy — mutating it does not touch the session', () => {
  const s = session(); const p = C.checkpointPayload(s, iso(T0));
  p.samples.push(S(99, 1)); p.rr.push(1);
  assert.equal(s.samples.length, 2); assert.equal(s.rr.length, 2);
});

// --------------------------------------------------------- open entries ----
test('isOpenEntry / stateOf: PocketBase empty date is "", pre-JA2 entries read as filed', () => {
  const open = { entry_type: 'heart_rate', ended_at: '', metadata: { state: 'active' } };
  assert.equal(C.isOpenEntry(open), true);
  assert.equal(C.isOpenEntry({ ...open, ended_at: pb(T0) }), false);
  assert.equal(C.isOpenEntry({ ...open, metadata: { state: 'stopped' } }), false);
  assert.equal(C.isOpenEntry({ ...open, entry_type: 'fast' }), false);
  assert.equal(C.stateOf({ metadata: { bpm_avg: 120 } }), 'filed');
  assert.equal(C.stateOf({ metadata: { state: 'discarded' } }), 'discarded');
});

// ------------------------------------------------------ resume decision ----
const storeRec = (ageS, sid = 'sid-1') => ({ id: 'rec1', entry_type: 'heart_rate', ended_at: '',
  started_at: pb(T0 - ageS * 1000 - 600_000), metadata: { state: 'active', session_id: sid, checkpoint_at: iso(T0 - ageS * 1000) } });
const localCp = (sid = 'sid-1', ended) => ({ v: 2, session_id: sid, started_at: T0 - 900_000, ended_at: ended || null, samples: [S(0, 90)] });

test('resumeDecision: store open + same local -> resume from both', () => {
  const d = C.resumeDecision({ store: storeRec(30), local: localCp(), nowMs: T0 });
  assert.equal(d.action, 'resume'); assert.equal(d.source, 'both'); assert.equal(d.record.id, 'rec1');
});

test('resumeDecision: store open + no local (other phone / cleared data) -> resume from store', () => {
  const d = C.resumeDecision({ store: storeRec(30), local: null, nowMs: T0 });
  assert.equal(d.action, 'resume'); assert.equal(d.source, 'store'); assert.equal(d.other_local, null);
});

test('resumeDecision: store open + a DIFFERENT local session -> resume store, the local is offered separately', () => {
  const d = C.resumeDecision({ store: storeRec(30), local: localCp('sid-2'), nowMs: T0 });
  assert.equal(d.action, 'resume'); assert.equal(d.source, 'store'); assert.equal(d.other_local.session_id, 'sid-2');
});

test('resumeDecision: the stale boundary is exactly 6 h from checkpoint_at (± 1 s)', () => {
  assert.equal(C.STALE_SEC, 21600);
  assert.equal(C.resumeDecision({ store: storeRec(21600 - 1), local: null, nowMs: T0 }).action, 'resume');
  assert.equal(C.resumeDecision({ store: storeRec(21600), local: null, nowMs: T0 }).action, 'resume');       // at the limit: not yet stale
  assert.equal(C.resumeDecision({ store: storeRec(21600 + 1), local: null, nowMs: T0 }).action, 'stale');
});

test('resumeDecision: stale falls back to started_at when checkpoint_at is absent; unparsable time throws', () => {
  const rec = storeRec(30); delete rec.metadata.checkpoint_at;           // started_at = age + 10 min
  assert.equal(C.resumeDecision({ store: rec, local: null, nowMs: T0 }).action, 'resume');
  rec.started_at = pb(T0 - 7 * 3600 * 1000);
  assert.equal(C.resumeDecision({ store: rec, local: null, nowMs: T0 }).action, 'stale');
  rec.started_at = 'not a date';
  assert.throws(() => C.resumeDecision({ store: rec, local: null, nowMs: T0 }), /parsable/);
});

// The ten-instant clock sweep (G-JA2-2, owed at s13, added s14). Far-future sentinels only. The four
// DST instants are the 2099 transitions DERIVED from Intl (America/New_York, Europe/London), not typed
// from memory; the others are year/leap/day edges. At each instant: the stale boundary ± 1 s in both
// timestamp spellings PocketBase and the app write, the started_at fallback, and a checkpoint that must
// win over a much older started_at. Run once more under a DST zone (gate record): the decision is on
// epoch ms and must not move with the process zone.
const SWEEP = [
  '2099-03-08T07:00:00.000Z',   // New York spring-forward
  '2099-11-01T06:00:00.000Z',   // New York fall-back
  '2099-03-29T01:00:00.000Z',   // London spring-forward
  '2099-10-25T01:00:00.000Z',   // London fall-back
  '2099-01-01T00:00:00.000Z',   // year start
  '2098-12-31T23:59:59.999Z',   // year end, last ms
  '2096-02-29T12:00:00.000Z',   // leap day
  '2100-03-01T00:00:00.000Z',   // the day after 2100-02-28 (2100 is not a leap year)
  '2099-06-15T03:00:00.000Z',   // local midnight in Brasilia (the machine zone at s14)
  '2099-06-15T12:34:56.789Z',   // a non-round millisecond
];
test('resumeDecision: ten-instant clock sweep — stale boundary ± 1 s, both spellings, fallback, checkpoint beats started_at', () => {
  const at = (nowMs, ageS, spell) => ({ id: 'rec1', entry_type: 'heart_rate', ended_at: '',
    started_at: pb(nowMs - 10 * 86400 * 1000),                                  // ten days old: stale by started_at alone
    metadata: { state: 'active', session_id: 'sid-1', checkpoint_at: spell(nowMs - ageS * 1000) } });
  let checked = 0;
  for (const when of SWEEP) {
    const nowMs = Date.parse(when);
    assert.equal(new Date(nowMs).toISOString(), when, `sentinel ${when} round-trips`);
    for (const spell of [iso, pb]) {
      const d = (ageS) => C.resumeDecision({ store: at(nowMs, ageS, spell), local: null, nowMs }).action;
      assert.equal(d(0), 'resume', `${when} fresh`);
      assert.equal(d(C.STALE_SEC - 1), 'resume', `${when} stale-1`);
      assert.equal(d(C.STALE_SEC), 'resume', `${when} at the limit`);
      assert.equal(d(C.STALE_SEC + 1), 'stale', `${when} stale+1`);
      checked += 4;
    }
    const noCp = at(nowMs, 0, iso); delete noCp.metadata.checkpoint_at;
    noCp.started_at = pb(nowMs - C.STALE_SEC * 1000);
    assert.equal(C.resumeDecision({ store: noCp, local: null, nowMs }).action, 'resume', `${when} fallback at the limit`);
    noCp.started_at = pb(nowMs - C.STALE_SEC * 1000 - 1000);
    assert.equal(C.resumeDecision({ store: noCp, local: null, nowMs }).action, 'stale', `${when} fallback stale+1`);
    checked += 2;
  }
  assert.equal(checked, SWEEP.length * 10);                                     // an empty sweep cannot pass
});

test('resumeDecision: store unreachable -> the local decision with offline:true, never "none" while a local exists', () => {
  const d = C.resumeDecision({ storeError: true, local: localCp(), nowMs: T0 });
  assert.equal(d.action, 'resume'); assert.equal(d.offline, true); assert.equal(d.source, 'local');
  const r = C.resumeDecision({ storeError: true, local: localCp('sid-1', T0 - 1000), nowMs: T0 });
  assert.equal(r.action, 'review');
  assert.deepEqual(C.resumeDecision({ storeError: true, local: null, nowMs: T0 }), { action: 'none', source: 'local', offline: true });
});

test('resumeDecision: nothing in the store + a local unfiled session -> local, flagged for re-creation', () => {
  const d = C.resumeDecision({ store: null, local: localCp(), nowMs: T0 });
  assert.equal(d.action, 'resume'); assert.equal(d.source, 'local'); assert.equal(d.recreate, true);
  const e = C.resumeDecision({ store: null, local: { ...localCp(), pb_id: 'rec9' }, nowMs: T0 });
  assert.equal(e.recreate, false);
  assert.deepEqual(C.resumeDecision({ store: null, local: null, nowMs: T0 }), { action: 'none', source: 'none' });
});

test('resumeDecision: nowMs is required (time is an input)', () => {
  assert.throws(() => C.resumeDecision({ store: null, local: null }), /nowMs/);
});

// ------------------------------------------------------------- the guard ----
test('startGuard: null with nothing unfiled; a refusal naming minutes and samples otherwise', () => {
  assert.equal(C.startGuard(null, null), null);
  const local = { exercise_type: 'Weightlifting', started_at: T0 - 43 * 60_000,
                  samples: Array.from({ length: 516 }, (_, i) => S(i * 5, 130)) };
  const g = C.startGuard(local, null, () => '16:25');
  assert.equal(g.count, 516);
  assert.equal(g.minutes, 43);                                 // 515*5 s = 2575 s -> 43 min
  assert.equal(g.message, 'Unfiled Weightlifting session from 16:25 (43 min, 516 samples). RESUME it, or FILE / DISCARD it first.');
});

test('startGuard: a store-side open session refuses too (no local copy on this phone)', () => {
  const rec = storeRec(30); rec.metadata.samples = [S(0, 90), S(5, 95)]; rec.metadata.exercise_type = 'HIIT';
  const g = C.startGuard(null, rec, () => '09:00');
  assert.match(g.message, /^Unfiled HIIT session from 09:00 \(0 min, 2 samples\)/);
});

test('discardLabel names what is discarded', () => {
  assert.equal(C.discardLabel([S(0, 1), S(5, 1)], 2580), 'DISCARD 43 min · 2 samples?');
});

test('reconnectPolicy: attempt 0 at once, then every 4 s, stops at RECONNECT_MAX (bounded, A1.3)', () => {
  assert.equal(C.RECONNECT_MAX, 8);
  assert.deepEqual(C.reconnectPolicy(0), { retry: true, delayMs: 0, attempt: 0 });
  assert.deepEqual(C.reconnectPolicy(1), { retry: true, delayMs: 4000, attempt: 1 });
  assert.equal(C.reconnectPolicy(7).retry, true);
  assert.deepEqual(C.reconnectPolicy(8), { retry: false, delayMs: null, attempt: 8 });
  assert.equal(C.reconnectPolicy(50).retry, false);
  assert.throws(() => C.reconnectPolicy(-1), /non-negative/);
  assert.throws(() => C.reconnectPolicy('3'), /non-negative/);
});

test('summarize counts real samples only and rounds minutes from the elapsed clock', () => {
  assert.deepEqual(C.summarize([S(0, 1), S(5, 1, true), S(10, 1)], 125), { count: 2, minutes: 2, last_t: 10 });
  assert.deepEqual(C.summarize([], undefined), { count: 0, minutes: 0, last_t: 0 });
});
