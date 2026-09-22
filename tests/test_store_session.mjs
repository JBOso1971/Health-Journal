// tests/test_store_session.mjs — the store-side session engine replayed against a FAKE PocketBase at the
// PB seam (brief §2.6 S2, gate G-JA2-3): one offline start, one dropped tick, one second-window merge, one
// stale read, stop and file. The REAL engine (hr-core.js createStoreSession); the clock is an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../hr-core.js');

const T0 = Date.parse('2099-03-01T10:00:00Z');
const S = (t, bpm, est) => (est ? { t, bpm, est: true } : { t, bpm });

// A schema-shaped fake: one collection, records by id, PocketBase's {data,error} answers, programmable failures.
function fakePB() {
  const recs = new Map(); let n = 0;
  const calls = [];
  const fail = { insert: 0, get: 0, update: 0 };          // fail the next N calls of a verb
  const pb = {
    calls, recs, fail,
    async insert(body) { calls.push(['insert']); if (fail.insert-- > 0) return { data: null, error: { message: 'offline' } }; const id = 'rec' + (++n); recs.set(id, { id, ...structuredClone(body) }); return { data: recs.get(id), error: null }; },
    async get(id) { calls.push(['get', id]); if (fail.get-- > 0) return { data: null, error: { message: 'offline' } }; const r = recs.get(id); return r ? { data: structuredClone(r), error: null } : { data: null, error: { status: 404 } }; },
    async update(id, body) { calls.push(['update', id]); if (fail.update-- > 0) return { data: null, error: { message: 'offline' } }; const r = recs.get(id); if (!r) return { data: null, error: { status: 404 } }; Object.assign(r, structuredClone(body)); return { data: structuredClone(r), error: null }; },
    async remove() { calls.push(['DELETE']); throw new Error('DELETE must never be issued by the session engine'); },
  };
  return pb;
}

function phone(pb, nowRef) {
  // the app's live arrays + snapshot, exactly as index.html's hrSnapshot builds it
  const live = { samples: [], rr: [], summary: null, started_ms: T0, ended_ms: null, active: true };
  const eng = C.createStoreSession(pb, { now: () => nowRef.t });
  const snapshot = () => ({ session_id: 'sid-1', device: 'pixel', exercise_type: 'Weightlifting',
    samples: live.active ? live.samples : live.summary.samples, rr: live.rr, summary: live.active ? null : live.summary,
    started_ms: live.started_ms, ended_ms: live.ended_ms });
  const adopt = (s, rr) => { live.samples = s; live.rr = rr; };
  return { live, eng, write: (state, note) => eng.write(state, snapshot, note, state === 'active' ? adopt : null) };
}

test('G-JA2-3 replay: offline start, dropped tick, second window, stale read, stop, file -> the store holds the union', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const ph = phone(pb, now);
  const captured = [];                                   // everything the strap produced, on either window
  const cap = (t, bpm) => { captured.push(S(t, bpm)); return S(t, bpm); };

  // START with the store unreachable (Q10): the session starts anyway, the insert is counted as missed
  pb.fail.insert = 1;
  assert.equal(await ph.write('active'), false);
  assert.equal(ph.eng.state.missed, 1); assert.equal(ph.eng.state.pbId, null);
  assert.equal(ph.eng.due(), true, 'a failed first write leaves the tick due');

  // tick 1 (60 s later): insert succeeds
  now.t += 60_000; ph.live.samples.push(cap(0, 90), cap(5, 95), cap(10, 100));
  assert.equal(await ph.write('active'), true);
  assert.equal(ph.eng.state.missed, 0); assert.ok(ph.eng.state.pbId);
  assert.equal(ph.eng.due(), false, 'not due right after a success');
  now.t += 59_999; assert.equal(ph.eng.due(), false);
  now.t += 1;      assert.equal(ph.eng.due(), true, 'due at exactly 60 s');

  // tick 2: a dropped tick (PATCH fails) -> counted, lastOk unchanged, nothing lost locally
  const lastOk = ph.eng.state.lastOk;
  ph.live.samples.push(cap(15, 104), cap(20, 108)); pb.fail.update = 1;
  assert.equal(await ph.write('active'), false);
  assert.equal(ph.eng.state.missed, 1); assert.equal(ph.eng.state.lastOk, lastOk);
  assert.equal(ph.live.samples.length, 5);

  // a SECOND WINDOW resumed the same record meanwhile and wrote samples of its own (t 25, 30)
  const rec = pb.recs.get(ph.eng.state.pbId);
  rec.metadata.samples = C.mergeSamples(rec.metadata.samples, [cap(25, 112), cap(30, 115)]);
  rec.metadata.rr = [800, 810, 805, 799];

  // tick 3: read-merge-write adopts the other window's samples and writes the union
  now.t += 60_000; ph.live.samples.push(cap(35, 118)); ph.live.rr = [800, 810];
  assert.equal(await ph.write('active'), true);
  assert.deepEqual(ph.live.samples.map(s => s.t), [0, 5, 10, 15, 20, 25, 30, 35], 'the phone adopted the union');
  assert.deepEqual(ph.live.rr, [800, 810, 805, 799], 'the longer RR list won');
  assert.equal(ph.eng.state.missed, 0);
  // the STORE holds the union right after this tick, not only at the end (a later write must not be what saves it)
  assert.deepEqual(pb.recs.get(ph.eng.state.pbId).metadata.samples.map(s => s.t), [0, 5, 10, 15, 20, 25, 30, 35], 'the store has the union after the tick');
  assert.deepEqual(pb.recs.get(ph.eng.state.pbId).metadata.rr, [800, 810, 805, 799]);

  // a stale read: GET fails once -> counted, no PATCH attempted with a blind body
  now.t += 60_000; ph.live.samples.push(cap(40, 120)); pb.fail.get = 1;
  const before = pb.calls.length;
  assert.equal(await ph.write('active'), false);
  assert.equal(pb.calls.slice(before).filter(c => c[0] === 'update').length, 0, 'no PATCH after a failed read');

  // STOP: the summary is computed by the app (here: the resolved timeline with one est point) and written
  now.t += 5_000; ph.live.samples.push(cap(45, 121));
  ph.live.active = false; ph.live.ended_ms = now.t;
  ph.live.summary = { duration_sec: 50, active_sec: 50, gap_sec: 0, est_sec: 5, gaps: [], bpm_avg: 108, bpm_max: 121, bpm_min: 90, rmssd_ms: 30,
                      zone_time_sec: { sub1: 10, z1: 40 }, samples: C.mergeSamples(ph.live.samples, [S(42, 120, true)]) };
  assert.equal(await ph.write('stopped'), true);
  let stored = pb.recs.get(ph.eng.state.pbId);
  assert.equal(stored.metadata.state, 'stopped'); assert.ok(stored.ended_at);
  assert.equal(stored.metadata.duration_sec, 50); assert.equal(stored.metadata.bpm_max, 121);

  // FILE with a note
  assert.equal(await ph.write('filed', 'good session'), true);
  stored = pb.recs.get(ph.eng.state.pbId);
  assert.equal(stored.metadata.state, 'filed'); assert.equal(stored.notes, 'good session');

  // THE gate: every real sample ever captured, on either window, is in the store, by t
  const storedReal = stored.metadata.samples.filter(s => !s.est).map(s => s.t).sort((a, b) => a - b);
  const capturedT = [...new Set(captured.map(s => s.t))].sort((a, b) => a - b);
  assert.deepEqual(storedReal, capturedT);
  assert.equal(stored.metadata.samples.some(s => s.est && s.t === 42), true, 'the est point survives after stop (allowed once stopped)');
  assert.equal(pb.calls.some(c => c[0] === 'DELETE'), false, 'G-JA2-7: no DELETE');
  assert.equal(stored.metadata.v, 2); assert.equal(stored.metadata.session_id, 'sid-1');
});

test('an est sample is never written while active (J3 through the engine)', async () => {
  const pb = fakePB(); const now = { t: T0 }; const ph = phone(pb, now);
  ph.live.samples.push(S(0, 90), S(5, 95, true));
  assert.equal(await ph.write('active'), false);           // checkpointPayload throws -> counted as a failure, nothing written
  assert.equal(ph.eng.state.missed, 1); assert.equal(pb.recs.size, 0);
});

test('busy: a second write while one is in flight is refused, not queued into a race', async () => {
  const pb = fakePB(); const now = { t: T0 }; const ph = phone(pb, now);
  ph.live.samples.push(S(0, 90));
  const p1 = ph.write('active'); const r2 = await ph.write('active');
  assert.equal(r2, false); assert.equal(await p1, true);
  assert.equal(pb.calls.filter(c => c[0] === 'insert').length, 1);
});

test('adopt: a resumed session continues the SAME record and merges what the store already holds', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const a = phone(pb, now); a.live.samples.push(S(0, 90), S(5, 92));
  assert.equal(await a.write('active'), true);
  const id = a.eng.state.pbId;
  // ...the app dies; a fresh launch resumes with pb_id from the checkpoint and only a partial local copy
  const b = phone(pb, now); b.eng.adopt(id, 0); b.live.samples.push(S(0, 90), S(10, 96));
  now.t += 60_000;
  assert.equal(await b.write('active'), true);
  assert.equal(b.eng.state.pbId, id);
  assert.deepEqual(b.live.samples.map(s => s.t), [0, 5, 10]);
  assert.equal(pb.recs.size, 1, 'no rival record was created');
});

test('statusText tells the truth: saving, ok with age, offline with the missed count', async () => {
  const pb = fakePB(); const now = { t: T0 }; const ph = phone(pb, now);
  assert.equal(ph.eng.statusText(), 'STORE: SAVING…');
  ph.live.samples.push(S(0, 90)); await ph.write('active'); now.t += 12_000;
  assert.equal(ph.eng.statusText(), 'STORE ✓ 12s ago');
  pb.fail.update = 2; now.t += 60_000; await ph.write('active'); now.t += 60_000; await ph.write('active');
  assert.equal(ph.eng.statusText(), 'STORE OFFLINE · 2 missed');
});
