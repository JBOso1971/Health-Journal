// tests/test_lift_core.mjs — W3b S3: the Lift core (lift-core.js), the REAL module, with the REAL hr-core.js
// beside it (CLAUDE.md §5: no mocks at the seam; the PocketBase seam is a schema-shaped fake). One or more
// named tests per rule of W3b_Build_Brief_v1.md §2.2 (L1–L20), each killed by a prove_journal.mjs mutation.
// Fixtures are far-future sentinels; every clock and every id is an argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../lift-core.js');
const H = require('../hr-core.js');

const T0 = Date.parse('2099-03-01T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const pbDate = ms => iso(ms).replace('T', ' ');                  // PocketBase's space-separated form
const OFF = -10800;                                              // the phone's offset (UTC-3)
const set = (r, w) => ({ r, w });
const LINES = [{ name: 'Back Squat', side: 'both' }, { name: 'Bulgarian Split Squat', side: 'L' },
               { name: 'Bulgarian Split Squat', side: 'R' }, { name: 'Romanian Deadlift', side: 'both' },
               { name: 'Leg Extension', side: 'both' }];
const tpl = (over = {}) => ({ id: 'tplLegsHeavy01', entry_type: 'lift_template', started_at: '2099-01-01 00:00:00.000Z',
  metadata: { v: 1, name: 'Legs Heavy', archived: false, lines: structuredClone(LINES), ...over } });

// A filed session record as the store holds it (the mock's history for Legs Heavy, moved to 2099).
function filedRec(id, startedIso, exercises, over = {}) {
  return { id, entry_type: 'resistance', started_at: startedIso.replace('T', ' '), ended_at: startedIso.replace('T', ' '), notes: '',
    metadata: { v: 1, state: 'filed', session_id: 'sid-' + id, checkpoint_at: startedIso, utc_offset_s: OFF,
      template: { id: 'tplLegsHeavy01', name: 'Legs Heavy' }, hr_mode: 'none', hr_session_id: null,
      exercises: exercises.map(([name, side, sets]) => ({ name, side, added: false, sets: sets.map(([r, w]) => set(r, w)) })),
      review: '', ...over } };
}
const REC_22 = filedRec('rec22', '2099-02-24T12:00:00.000Z', [       // the newest: a short day
  ['Back Squat', 'both', [[10, 60], [8, 100], [6, 110], [6, 110]]],
  ['Bulgarian Split Squat', 'L', [[10, 36], [10, 36], [10, 36]]],
  ['Bulgarian Split Squat', 'R', [[10, 36], [10, 36], [8, 36]]],
  ['Romanian Deadlift', 'both', [[10, 80], [10, 80], [0, 0]]],
  ['Leg Extension', 'both', [[0, 0], [0, 0], [0, 0]]]]);
const REC_19 = filedRec('rec19', '2099-02-21T12:00:00.000Z', [
  ['Back Squat', 'both', [[10, 60], [8, 95], [6, 105], [6, 105]]],
  ['Bulgarian Split Squat', 'L', [[10, 32], [10, 32], [10, 32]]],
  ['Bulgarian Split Squat', 'R', [[10, 32], [10, 32], [10, 32]]],
  ['Romanian Deadlift', 'both', [[10, 75], [10, 75], [8, 75]]],
  ['Leg Extension', 'both', [[12, 40], [12, 40], [10, 40]]]]);
// Noise the pre-fill must not read (L5): newer, but not filed / another template / not a session.
const NOISE = [
  filedRec('recDisc', '2099-02-27T12:00:00.000Z', [['Back Squat', 'both', [[1, 1]]]], { state: 'discarded' }),
  { ...filedRec('recAct', '2099-02-28T12:00:00.000Z', [['Back Squat', 'both', [[2, 2]]]]), ended_at: '' },
  filedRec('recOther', '2099-02-26T12:00:00.000Z', [['Back Squat', 'both', [[3, 3]]]], { template: { id: 'tplOther', name: 'Legs Heavy' } }),
  { id: 'tplX', entry_type: 'lift_template', started_at: '2099-02-28 12:00:00.000Z', metadata: { v: 1, name: 'X', archived: false, lines: LINES } },
  { id: 'hr1', entry_type: 'heart_rate', started_at: '2099-02-28 12:00:00.000Z', metadata: { state: 'filed' } },
];
NOISE[1].metadata.state = 'active';
const HISTORY = [REC_19, NOISE[0], REC_22, NOISE[1], NOISE[2], NOISE[3], NOISE[4]];   // deliberately unsorted

const startOpts = (over = {}) => ({ sessionId: 'lift-sid-1', nowMs: T0, utcOffsetS: OFF, hrMode: 'none', ...over });
const start = (history = HISTORY, over = {}) => L.startSession(tpl(), history, startOpts(over));
const view = m => m.exercises.map(e => e.sets.map(s => [s.r, s.w, s.c, 'from' in s ? s.from : '-']));

// ── L1 / L2 ────────────────────────────────────────────────────────────────────────────────
test('L1: volume = R x W of the TOTAL load, no multiplier (a dumbbell pair is entered summed)', () => {
  assert.equal(L.setVolume(set(10, 52)), 520);                  // 2 x 26 kg entered as 52
  assert.equal(L.volume([set(10, 36), set(10, 36)]), 720);      // a unilateral L + R pair: each line its own
  assert.equal(L.volume([set(8, 0), set(0, 0), set(6, 110)]), 660);   // a bodyweight set and a skip add 0
  assert.equal(L.volume([{ r: 10, w: 60, c: false }, { r: 5, w: 20, c: true }]), 100);   // unconfirmed = 0 (L3)
  assert.equal(L.volume([]), 0);
});

test('L2: set kinds exactly as the sets view: 0/0 skipped, W 0 bodyweight (done), else loaded', () => {
  assert.equal(L.setKind(0, 0), 'skipped');
  assert.equal(L.setKind(8, 0), 'bodyweight');
  assert.equal(L.setKind(10, 60), 'loaded');
  assert.equal(L.setKind(1, 0.5), 'loaded');
});

test('L2: a bodyweight set counts as DONE in the status (a session of pull-ups is completed, not skipped)', () => {
  const m = { exercises: [{ sets: [set(8, 0), set(7, 0), set(6, 0)] }] };
  assert.equal(L.status(m), 'completed');
  assert.deepEqual(L.summary(m), { status: 'completed', n_sets: 3, n_skipped: 0, volume_kg: 0 });
});

// ── L3 ─────────────────────────────────────────────────────────────────────────────────────
test('L3: an unconfirmed set files as R 0 / W 0 and no c, from or prior reaches the filed record', () => {
  let s = start();
  let m = L.tapCheck(s.meta, 0, 0, '10', '60').meta;             // confirm Back Squat set 1 as suggested
  m = L.editSet(m, 3, 0, 'w', '85').meta;                        // RDL set 1: a number changed = confirmed
  const f = L.fileShape(m);
  assert.equal(f.state, 'filed');
  assert.deepEqual(f.exercises[0].sets, [set(10, 60), set(0, 0), set(0, 0), set(0, 0)]);   // suggestions left unconfirmed -> skips
  assert.deepEqual(f.exercises[3].sets[0], set(10, 85));
  const text = JSON.stringify(f);
  assert.doesNotMatch(text, /"c":/); assert.doesNotMatch(text, /"from":/); assert.doesNotMatch(text, /"prior":/);
  for (const e of f.exercises) assert.deepEqual(Object.keys(e).sort(), ['added', 'name', 'sets', 'side']);
  assert.equal(s.meta.state, 'active', 'fileShape never mutates the running session');
});

// ── L4 ─────────────────────────────────────────────────────────────────────────────────────
test('L4: a session COPIES its template (name + lines) at START; editing, renaming or archiving the template never rewrites it', () => {
  const t = tpl();
  const s = L.startSession(t, [], startOpts());
  assert.deepEqual(s.meta.template, { id: 'tplLegsHeavy01', name: 'Legs Heavy' });
  assert.deepEqual(s.meta.exercises.map(e => [e.name, e.side]), LINES.map(l => [l.name, l.side]));
  const before = JSON.stringify(s.meta);
  t.metadata.name = 'Legs Renamed'; t.metadata.lines[0].name = 'Front Squat'; t.metadata.lines.pop();
  Object.assign(t.metadata, L.archiveTemplate(t.metadata));
  assert.equal(JSON.stringify(s.meta), before);
  assert.throws(() => L.startSession(tpl({ archived: true }), [], startOpts()), /archived/);
  assert.throws(() => L.startSession({ ...tpl(), entry_type: 'resistance' }, [], startOpts()), /not a template/);
});

// ── L5 ─────────────────────────────────────────────────────────────────────────────────────
test('L5: pre-fill reads FILED sessions of the SAME template id, newest first; discarded, active, other templates and other types never', () => {
  const h = L.historyFor(HISTORY, 'tplLegsHeavy01');
  assert.deepEqual(h.map(x => x.id), ['rec22', 'rec19']);
  assert.deepEqual(h.map(x => x.date), ['2099-02-24', '2099-02-21']);
  assert.deepEqual(L.historyFor(HISTORY, 'tplOther').map(x => x.id), ['recOther']);   // by id, never by name
  assert.deepEqual(L.historyFor([], 'tplLegsHeavy01'), []);
});

test('L5: no signal = no history = no pre-fill, and logging still works (one empty set per line)', () => {
  const s = start([]);
  assert.deepEqual(view(s.meta), LINES.map(() => [[null, null, false, '-']]));
  assert.ok(s.meta.exercises.every(e => e.prior === null));
  const m = L.tapCheck(s.meta, 0, 0, '5', '40').meta;
  assert.deepEqual(m.exercises[0].sets[0], { r: 5, w: 40, c: true });
});

// ── L6 / L7 / L8 (D-60's per-set fallback; the mock's Legs Heavy case) ───────────────────────
test('L6-L8: the Legs Heavy pre-fill: counts from 24 Feb, each set from the last session it was done, older sets dated', () => {
  const s = start();
  assert.deepEqual(view(s.meta), [
    [[10, 60, false, '-'], [8, 100, false, '-'], [6, 110, false, '-'], [6, 110, false, '-']],
    [[10, 36, false, '-'], [10, 36, false, '-'], [10, 36, false, '-']],
    [[10, 36, false, '-'], [10, 36, false, '-'], [8, 36, false, '-']],
    [[10, 80, false, '-'], [10, 80, false, '-'], [8, 75, false, '2099-02-21']],        // RDL set 3 skipped on the 24th
    [[12, 40, false, '2099-02-21'], [12, 40, false, '2099-02-21'], [10, 40, false, '2099-02-21']],   // all skipped on the 24th
  ]);
  assert.ok(s.meta.exercises.every(e => e.prior === '2099-02-24'));
  assert.equal(s.meta.exercises.reduce((n, e) => n + e.sets.length, 0), 16);             // the mock's 16 sets
});

test('L6: the set COUNT is the most recent session holding the line: a skip never shrinks it, an older longer session never grows it', () => {
  const newest = filedRec('n', '2099-02-24T12:00:00.000Z', [['Back Squat', 'both', [[10, 60], [0, 0]]]]);
  const older = filedRec('o', '2099-02-21T12:00:00.000Z', [['Back Squat', 'both', [[10, 50], [9, 50], [8, 50], [7, 50]]]]);
  const p = L.prefill(L.historyFor([older, newest], 'tplLegsHeavy01'), { name: 'Back Squat', side: 'both' });
  assert.equal(p.sets.length, 2);
  assert.deepEqual(p.sets[1], { r: 9, w: 50, c: false, from: '2099-02-21' });
  const allSkipped = filedRec('s', '2099-02-24T12:00:00.000Z', [['Back Squat', 'both', [[0, 0], [0, 0], [0, 0]]]]);
  assert.equal(L.prefill(L.historyFor([allSkipped], 'tplLegsHeavy01'), { name: 'Back Squat', side: 'both' }).sets.length, 3);
});

test('L7: a set never done in any session starts EMPTY (never a 0 x 0 suggestion); a bodyweight set is a done set', () => {
  const h = L.historyFor([filedRec('a', '2099-02-24T12:00:00.000Z', [['Pull-up', 'both', [[8, 0], [0, 0]]]])], 'tplLegsHeavy01');
  const p = L.prefill(h, { name: 'Pull-up', side: 'both' });
  assert.deepEqual(p.sets, [{ r: 8, w: 0, c: false }, { r: null, w: null, c: false }]);
  assert.equal(L.prefill(h, { name: 'Pull-up', side: 'L' }), null, 'the side is part of the line');
});

test('L8: `from` only on a set taken from an older session than the one holding the line; a session with no valid offset dates it null, never UTC', () => {
  const newest = filedRec('n', '2099-02-24T12:00:00.000Z', [['Back Squat', 'both', [[0, 0]]]]);
  const older = filedRec('o', '2099-02-21T01:00:00.000Z', [['Back Squat', 'both', [[10, 50]]]], { utc_offset_s: 600 });
  const p = L.prefill(L.historyFor([older, newest], 'tplLegsHeavy01'), { name: 'Back Squat', side: 'both' });
  assert.deepEqual(p.sets[0], { r: 10, w: 50, c: false, from: null });
  assert.equal(p.prior, '2099-02-24');
});

// ── L9 ─────────────────────────────────────────────────────────────────────────────────────
test('L9: a unilateral lift is two lines, L then R, each with its own sets and its side stored', () => {
  assert.deepEqual(L.linesFor(' Single Leg RDL ', 'uni'), [{ name: 'Single Leg RDL', side: 'L' }, { name: 'Single Leg RDL', side: 'R' }]);
  assert.deepEqual(L.linesFor('Calf Press', 'both'), [{ name: 'Calf Press', side: 'both' }]);
  assert.throws(() => L.linesFor('', 'both'), /name/); assert.throws(() => L.linesFor('X', 'left'), /lateral/);
  const m = L.addExercise(start([]).meta, 'Single Leg RDL', 'uni').meta;
  const [l, r] = m.exercises.slice(-2);
  assert.deepEqual([l.side, r.side], ['L', 'R']);
  assert.notEqual(l.sets, r.sets);
  const m2 = L.tapCheck(m, m.exercises.length - 2, 0, '10', '20').meta;
  assert.equal(m2.exercises.at(-1).sets[0].c, false, 'confirming L never confirms R');
});

// ── L10 ────────────────────────────────────────────────────────────────────────────────────
test('L10: tick on an EMPTY set puts the cursor in R and confirms nothing', () => {
  const s = start([]);
  const r = L.tapCheck(s.meta, 0, 0, '', '');
  assert.equal(r.focus, 'r'); assert.equal(r.refused, null);
  assert.deepEqual(r.meta.exercises[0].sets[0], { r: null, w: null, c: false });
});

test('L10: tick confirms what is on screen; reps with no weight is bodyweight; a second tick un-confirms', () => {
  const s = start();
  let r = L.tapCheck(s.meta, 0, 1, '8', '100');
  assert.deepEqual(r.meta.exercises[0].sets[1], { r: 8, w: 100, c: true });
  r = L.tapCheck(r.meta, 0, 1, '8', '100');
  assert.equal(r.meta.exercises[0].sets[1].c, false);
  const bw = L.tapCheck(start([]).meta, 0, 0, '12', '');
  assert.deepEqual(bw.meta.exercises[0].sets[0], { r: 12, w: 0, c: true });
  const skip = L.tapCheck(start([]).meta, 0, 0, '', '0');
  assert.deepEqual(skip.meta.exercises[0].sets[0], { r: 0, w: 0, c: true }, 'an explicit 0 / 0 is a confirmed skip');
});

test('L10: changing a number confirms that set (once it carries both numbers)', () => {
  const s = start();
  const r = L.editSet(s.meta, 0, 2, 'w', '112.5');
  assert.deepEqual(r.meta.exercises[0].sets[2], { r: 6, w: 112.5, c: true });
  const e = L.editSet(start([]).meta, 0, 0, 'r', '10');
  assert.deepEqual(e.meta.exercises[0].sets[0], { r: 10, w: null, c: false }, 'one number on an empty set is not yet a set');
  assert.deepEqual(L.editSet(e.meta, 0, 0, 'w', '40').meta.exercises[0].sets[0], { r: 10, w: 40, c: true });
});

test('L10 / I-8: clearing a number un-confirms the set, so nothing files that was not confirmed as it stands', () => {
  const s = start();
  const m = L.tapCheck(s.meta, 0, 0, '10', '60').meta;
  const r = L.editSet(m, 0, 0, 'w', '');
  assert.deepEqual(r.meta.exercises[0].sets[0], { r: 10, w: null, c: false });
  assert.deepEqual(L.fileShape(r.meta).exercises[0].sets[0], set(0, 0));
});

test('L10: an exercise added on the day is `added`, starts with one empty set, and never changes the template', () => {
  const t = tpl(); const before = JSON.stringify(t);
  const s = L.startSession(t, [], startOpts());
  const r = L.addExercise(s.meta, 'Calf Press', 'both');
  assert.deepEqual(r.meta.exercises.at(-1), { name: 'Calf Press', side: 'both', added: true, prior: null, sets: [{ r: null, w: null, c: false }] });
  assert.ok(s.meta.exercises.every(e => e.added === false));
  assert.equal(JSON.stringify(t), before);
  assert.equal(L.addExercise(s.meta, '  ', 'both').refused, 'Name the exercise first');
});

test('L10: + SET copies the last set as an unconfirmed suggestion; - SET never goes below one', () => {
  const s = start();
  const a = L.addSet(s.meta, 3).meta;
  assert.deepEqual(a.exercises[3].sets.at(-1), { r: 8, w: 75, c: false, from: '2099-02-21' });
  const one = start([]).meta;
  const r = L.removeSet(one, 0);
  assert.match(r.refused, /at least one set/); assert.equal(r.meta.exercises[0].sets.length, 1);
  assert.equal(L.removeSet(a, 3).meta.exercises[3].sets.length, 3);
});

test('input: reps a whole number, weight a number of kg (a pt-BR comma accepted); anything else refused in words, never a silent 0', () => {
  assert.deepEqual(L.parseReps(' 12 '), { value: 12, error: null });
  assert.deepEqual(L.parseReps(''), { value: null, error: null });
  for (const bad of ['10.5', '-3', 'ten', '1e2']) assert.match(L.parseReps(bad).error, /whole number/, bad);
  assert.equal(L.parseLoad('22,5').value, 22.5);
  assert.equal(L.parseLoad('22.5').value, 22.5);
  assert.equal(L.parseLoad('0').value, 0);
  for (const bad of ['-5', 'abc', '2,5,0', '1e3']) assert.match(L.parseLoad(bad).error, /number of kg/, bad);
  const r = L.editSet(start().meta, 0, 0, 'r', 'x');
  assert.match(r.refused, /whole number/); assert.equal(r.focus, 'r');
  assert.deepEqual(r.meta.exercises[0].sets[0], { r: 10, w: 60, c: false }, 'a refused edit changes nothing');
});

// ── I-5 (JB, s29): R 0 with a weight is a typo -> refused on BOTH paths ────────────────────
test('I-5 tick path: R 0 (or empty) with a weight is refused in words and stays unconfirmed', () => {
  for (const reps of ['', '0']) {
    const r = L.tapCheck(start([]).meta, 0, 0, reps, '60');
    assert.equal(r.refused, L.ZERO_REPS_WITH_WEIGHT, 'reps ' + JSON.stringify(reps));
    assert.equal(r.meta.exercises[0].sets[0].c, false);
    assert.equal(r.focus, 'r');
    assert.equal(L.fileShape(r.meta).exercises[0].sets[0].w, 0, 'if never corrected it files as a skip (L3)');
  }
  assert.equal(L.ZERO_REPS_WITH_WEIGHT, '0 reps with a weight: enter the reps, or clear the weight');
});

test('I-5 edit path: an edit that leaves R 0 with a weight is refused and UN-confirms a confirmed set', () => {
  const m = L.tapCheck(start().meta, 0, 0, '10', '60').meta;
  const r = L.editSet(m, 0, 0, 'r', '0');
  assert.equal(r.refused, L.ZERO_REPS_WITH_WEIGHT);
  assert.deepEqual(r.meta.exercises[0].sets[0], { r: 0, w: 60, c: false });
  assert.deepEqual(L.summary(L.fileShape(r.meta)).n_skipped, 16);
  const ok = L.editSet(r.meta, 0, 0, 'w', '0');
  assert.deepEqual(ok.meta.exercises[0].sets[0], { r: 0, w: 0, c: true }, 'clearing the weight makes it a confirmed skip');
});

test('I-5: the validators refuse a confirmed or filed R 0 / W > 0 (a stored one cannot arise from the core)', () => {
  const m = start([]).meta; m.exercises[0].sets[0] = { r: 0, w: 60, c: true };
  assert.ok(L.validateSession(m).some(p => p.includes('0 reps with a weight')));
  const f = L.fileShape(start([]).meta); f.exercises[0].sets[0] = set(0, 60);
  assert.ok(L.validateSession(f).some(p => p.includes('0 reps with a weight')));
});

// ── L11 ────────────────────────────────────────────────────────────────────────────────────
test('L11: status derived: every set skipped = skipped, some = partial, none = completed; I-1 no sets = skipped', () => {
  const ex = (...sets) => ({ exercises: [{ sets }] });
  assert.equal(L.status(ex(set(0, 0), set(0, 0))), 'skipped');
  assert.equal(L.status(ex(set(10, 60), set(0, 0))), 'partial');
  assert.equal(L.status(ex(set(10, 60), set(8, 0))), 'completed');
  assert.equal(L.status({ exercises: [] }), 'skipped');           // I-1, as the view
  assert.equal(L.status({ exercises: [{ sets: [] }] }), 'skipped');
  assert.equal(L.status(start().meta), 'skipped', 'an active session reads as it would file: nothing confirmed yet');
});

// ── L12 (R3 in full, C-1) ────────────────────────────────────────────────────────────────────
test('L12: session_date is the local date of started_at at the session offset, both sides of midnight', () => {
  assert.equal(L.localDate(Date.parse('2099-02-03T01:30:00Z'), -10800), '2099-02-02');
  assert.equal(L.localDate(Date.parse('2099-02-03T23:30:00Z'), 3600), '2099-02-04');
  assert.equal(L.localDate(Date.parse('2099-02-03T02:59:59.999Z'), -10800), '2099-02-02');
  assert.equal(L.localDate(Date.parse('2099-02-03T03:00:00Z'), -10800), '2099-02-03');
  assert.equal(L.localDate(Date.parse('2099-02-03T12:00:00Z'), 20700), '2099-02-03');   // +05:45 is a multiple of 900
  assert.equal(L.sessionDate(REC_22), '2099-02-24');
});

test('L12 / C-1: no valid offset gives NO date (never the UTC date): a float, a 600, beyond +/-14 h, the -1 sentinel, missing', () => {
  const t = Date.parse('2099-02-03T12:00:00Z');
  assert.equal(L.localDate(t, 50400), '2099-02-04'); assert.equal(L.localDate(t, -50400), '2099-02-02');
  for (const bad of [10800.5, 600, 54000, 50400 + 900, -50400 - 900, -1, undefined, null, '-10800', NaN]) {
    assert.equal(L.localDate(t, bad), null, 'offset ' + String(bad));
    assert.equal(L.isOffset(bad), false, 'isOffset ' + String(bad));
  }
  assert.equal(L.localDate(NaN, 0), null);
  assert.equal(L.MAX_OFFSET_S, 50400);
});

// A differential sweep: the same local date from ICU (Intl with a fixed Etc/GMT zone, a different code path)
// at the ten far-future instants of the JA2 sweep. Etc/GMT's sign is inverted (Etc/GMT+3 = UTC-3).
const SWEEP = ['2099-03-08T07:00:00.000Z', '2099-11-01T06:00:00.000Z', '2099-03-29T01:00:00.000Z', '2099-10-25T01:00:00.000Z',
  '2099-01-01T00:00:00.000Z', '2098-12-31T23:59:59.999Z', '2096-02-29T12:00:00.000Z', '2100-03-01T00:00:00.000Z',
  '2099-06-15T03:00:00.000Z', '2099-06-15T12:34:56.789Z'];
test('L12: ten-instant sweep, five offsets, against Intl (ICU) as the independent reference', () => {
  let checked = 0;
  for (const when of SWEEP) {
    const ms = Date.parse(when);
    for (const h of [-3, 1, -5, 14, -12]) {
      const zone = 'Etc/GMT' + (h > 0 ? '-' + h : '+' + (-h));
      const ref = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
      assert.equal(L.localDate(ms, h * 3600), ref, `${when} at ${h} h`);
      checked++;
    }
  }
  assert.equal(checked, 50);
});

// ── L14 / L18: the store session ─────────────────────────────────────────────────────────────
function fakePB() {
  const recs = new Map(); let n = 0; const calls = []; const fail = { insert: 0, update: 0, get: 0 };
  return { recs, calls, fail,
    async insert(body) { calls.push(['insert', structuredClone(body)]); if (fail.insert-- > 0) return { data: null, error: { message: 'offline' } };
      const id = 'rec' + (++n); recs.set(id, { id, ...structuredClone(body) }); return { data: structuredClone(recs.get(id)), error: null }; },
    async get(id) { calls.push(['get', id]); if (fail.get-- > 0) return { data: null, error: { message: 'offline' } };
      const r = recs.get(id); return r ? { data: structuredClone(r), error: null } : { data: null, error: { status: 404 } }; },
    async update(id, body) { calls.push(['update', id, structuredClone(body)]); if (fail.update-- > 0) return { data: null, error: { message: 'offline' } };
      const r = recs.get(id); if (!r) return { data: null, error: { status: 404 } }; Object.assign(r, structuredClone(body)); return { data: structuredClone(r), error: null }; },
    async remove() { calls.push(['DELETE']); throw new Error('DELETE must never be issued on a Lift path'); },
  };
}

test('L18: in the store from START (insert active), PATCHed whole as sets change, finished filed through the file shape; nothing DELETEs', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const eng = L.createLiftStoreSession(pb, { now: () => now.t });
  let s = start();
  assert.equal(await eng.write('active', () => s), true);
  const ins = pb.calls[0][1];
  assert.equal(ins.entry_type, 'resistance'); assert.equal(ins.started_at, iso(T0)); assert.equal(ins.ended_at, null);
  assert.equal(ins.metadata.state, 'active'); assert.equal(ins.metadata.checkpoint_at, iso(T0));
  const id = eng.state.pbId; assert.ok(id);
  now.t += 7000; s = { ...s, meta: L.tapCheck(s.meta, 0, 0, '10', '60').meta };
  assert.equal(await eng.write('active', () => s), true);
  assert.equal(pb.calls[1][0], 'update'); assert.equal(pb.calls[1][1], id);
  assert.deepEqual(pb.recs.get(id).metadata.exercises[0].sets[0], { r: 10, w: 60, c: true });
  now.t += 60_000; s = { ...s, ended_at: now.t };
  assert.equal(await eng.write('filed', () => s), true);
  const rec = pb.recs.get(id);
  assert.equal(rec.metadata.state, 'filed'); assert.equal(rec.ended_at, iso(now.t));
  assert.doesNotMatch(JSON.stringify(rec.metadata), /"c":/);
  assert.deepEqual(rec.metadata.exercises[1].sets[0], set(0, 0));
  assert.equal(pb.recs.size, 1, 'one record for the whole session');
  assert.equal(pb.calls.some(c => c[0] === 'DELETE'), false);
  assert.equal(s.meta.state, 'active', 'the engine never mutates the snapshot');
});

test('L18: a failed write is COUNTED and said, never thrown or swallowed; the next success clears it', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const eng = L.createLiftStoreSession(pb, { now: () => now.t });
  const s = start();
  assert.equal(eng.statusText(), 'STORE: SAVING…');
  pb.fail.insert = 1;
  assert.equal(await eng.write('active', () => s), false);
  assert.equal(eng.state.missed, 1); assert.equal(eng.state.pbId, null);
  assert.equal(eng.statusText(), 'STORE OFFLINE · 1 missed');
  pb.fail.update = 0;
  assert.equal(await eng.write('active', () => ({ ...s, meta: { ...s.meta, session_id: '' } })), false, 'an invalid payload is a counted failure');
  assert.equal(eng.state.missed, 2);
  assert.equal(await eng.write('active', () => s), true);
  assert.equal(eng.state.missed, 0); now.t += 3000;
  assert.equal(eng.statusText(), 'STORE ✓ 3s ago');
});

test('L18: touch marks a change; due = unwritten change and >= 5 s since the last attempt; a change during a write stays due', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const eng = L.createLiftStoreSession(pb, { now: () => now.t });
  const s = start();
  assert.equal(eng.due(), false, 'nothing changed, nothing due');
  eng.touch(); assert.equal(eng.due(), true, 'the first change is due at once');
  assert.equal(await eng.write('active', () => s), true);
  assert.equal(eng.due(), false);
  eng.touch(); now.t += 4999; assert.equal(eng.due(), false, 'debounced: not 1 ms before 5 s');
  now.t += 1; assert.equal(eng.due(), true, 'due at exactly 5 s');
  pb.fail.update = 1;
  assert.equal(await eng.write('active', () => s), false);
  assert.equal(eng.due(), false, 'a failed attempt waits 5 s before the retry'); now.t += 5000;
  assert.equal(eng.due(), true, 'and is retried');
  const p = eng.write('active', () => { eng.touch(); return s; });   // a change lands while the write is in flight
  assert.equal(await p, true);
  assert.equal(eng.dirty(), true, 'the change made during the write is still owed');
  assert.equal(L.CHECKPOINT_SEC, 5);
});

test('L18: busy: a second write while one is in flight is refused; adopt continues the SAME record', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const a = L.createLiftStoreSession(pb, { now: () => now.t });
  const s = start();
  const p1 = a.write('active', () => s);
  assert.equal(await a.write('active', () => s), false);
  assert.equal(await p1, true);
  assert.equal(pb.calls.filter(c => c[0] === 'insert').length, 1);
  const b = L.createLiftStoreSession(pb, { now: () => now.t });
  b.adopt(a.state.pbId, 0);
  assert.equal(await b.write('active', () => s), true);
  assert.equal(pb.recs.size, 1, 'no rival record');
  assert.throws(() => L.createLiftStoreSession(pb, {}), /now is required/);
});

test('L14: notes is null at the insert and absent from every PATCH; the review lives in metadata.review', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const eng = L.createLiftStoreSession(pb, { now: () => now.t });
  let s = start();
  s = { ...s, meta: L.setReview(s.meta, 'Squats moved well; RDL grip failed on set 3').meta };
  await eng.write('active', () => s); await eng.write('active', () => s);
  s = { ...s, ended_at: T0 + 1000 }; await eng.write('filed', () => s);
  assert.equal(pb.calls[0][1].notes, null);
  for (const c of pb.calls.filter(c => c[0] === 'update')) assert.equal('notes' in c[2], false, 'a PATCH carries notes');
  const rec = [...pb.recs.values()][0];
  assert.equal(rec.notes, null);
  assert.equal(rec.metadata.review, 'Squats moved well; RDL grip failed on set 3');
});

test('checkpointPayload: refuses an unknown state and a missing now; a filed payload is ALWAYS the file shape', () => {
  const s = start();
  assert.throws(() => L.checkpointPayload(s.meta, 'paused', iso(T0)), /unknown state/);
  assert.throws(() => L.checkpointPayload(s.meta, 'active', ''), /now is required/);
  const f = L.checkpointPayload(s.meta, 'filed', iso(T0));
  assert.deepEqual(f.exercises[0].sets[0], set(0, 0));
  assert.equal(f.checkpoint_at, iso(T0));
  const d = L.checkpointPayload(s.meta, 'discarded', iso(T0));
  assert.equal(d.state, 'discarded'); assert.equal(d.exercises[0].sets[0].c, false, 'a discarded session keeps what it held');
});

// ── L15 ────────────────────────────────────────────────────────────────────────────────────
test('L15 (strap): the HR record id is stored once it exists and never re-pointed; link and none are untouched', () => {
  const s = start([], { hrMode: 'strap' });
  assert.equal(s.meta.hr_session_id, null);
  const a = L.linkHr(s.meta, 'hrrec1');
  assert.equal(a.changed, true); assert.equal(a.meta.hr_session_id, 'hrrec1');
  assert.equal(s.meta.hr_session_id, null, 'linkHr never mutates its input');
  assert.deepEqual(L.linkHr(a.meta, 'hrrec1'), { meta: a.meta, changed: false, conflict: false });
  const c = L.linkHr(a.meta, 'hrrec2');
  assert.equal(c.conflict, true); assert.equal(c.meta.hr_session_id, 'hrrec1', 'the stored id stands (I-3)');
  const link = start([], { hrMode: 'link', hrSessionId: 'hrPicked' });
  assert.equal(link.meta.hr_session_id, 'hrPicked');
  assert.equal(L.linkHr(link.meta, 'hrOther').meta.hr_session_id, 'hrPicked');
  assert.equal(L.linkHr(start([]).meta, 'hrrec1').meta.hr_session_id, null);
  assert.throws(() => start([], { hrMode: 'link' }), /names its HR session/);
});

test('L15: the HR session names its Lift session through the REAL HR engine, so the offline-throughout link resolves from the HR side', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const lift = start([], { hrMode: 'strap' });
  const hr = H.createStoreSession(pb, { now: () => now.t });
  const snap = () => ({ session_id: 'hr-sid-1', device: 'strap', exercise_type: L.HR_EXERCISE_TYPE, samples: [{ t: 0, bpm: 90 }], rr: [],
                        summary: null, started_ms: T0, ended_ms: null, lift_session_id: lift.session_id });
  assert.equal(await hr.write('active', snap), true);
  const rec = pb.recs.get(hr.state.pbId);
  assert.equal(rec.metadata.lift_session_id, 'lift-sid-1');
  assert.equal(rec.metadata.exercise_type, 'Weightlifting');
  assert.equal(L.linkHr(lift.meta, hr.state.pbId).meta.hr_session_id, hr.state.pbId, 'and the Lift side stores the id once it exists');
});

// ── L17 ────────────────────────────────────────────────────────────────────────────────────
test('L17: with the strap chosen START is refused until it is connected; the HR type is Weightlifting, not asked', () => {
  const t = tpl();
  assert.deepEqual(L.canStart({ template: t, hrMode: 'strap', strapConnected: false }), { ok: false, reason: 'Connect the strap first' });
  assert.deepEqual(L.canStart({ template: t, hrMode: 'strap', strapConnected: true }), { ok: true, reason: null });
  assert.equal(L.canStart({ template: t, hrMode: 'link' }).ok, false);
  assert.equal(L.canStart({ template: t, hrMode: 'link', hrSessionId: 'hr1' }).ok, true);
  assert.equal(L.canStart({ template: t, hrMode: 'none' }).ok, true);
  assert.equal(L.canStart({ template: tpl({ lines: [] }), hrMode: 'none' }).ok, false);
  assert.equal(L.canStart({ template: tpl({ archived: true }), hrMode: 'none' }).ok, false);
  assert.equal(L.canStart({ template: null, hrMode: 'none' }).ok, false);
  assert.equal(L.HR_EXERCISE_TYPE, 'Weightlifting');
  assert.ok(H.checkpointPayload({ state: 'active', exercise_type: L.HR_EXERCISE_TYPE, samples: [], rr: [] }, iso(T0)));
});

// ── L19 ────────────────────────────────────────────────────────────────────────────────────
test('L19: while a Lift session runs every route returns to the Lift screen; with the strap the HR view is admitted too, and only it', () => {
  const strap = { lift: true, strap: true }, plain = { lift: true, strap: false };
  assert.equal(L.lockRoute('#log/resistance', strap), null);
  assert.equal(L.lockRoute('#log/heart_rate', strap), null);
  for (const h of ['#home', '#review', '#log/fast', '#confirm', '#signin', '#lift/tpl/x', '']) {
    assert.equal(L.lockRoute(h, strap), '#log/resistance', h);
    assert.equal(L.lockRoute(h, plain), '#log/resistance', h);
  }
  assert.equal(L.lockRoute('#log/heart_rate', plain), '#log/resistance', 'no strap, no HR view');
  assert.equal(L.lockRoute('#home', { lift: false, strap: false }), null, 'no Lift session, no Lift lock');
  assert.equal(L.lockRoute('#home', null), null);
});

// ── L20 ────────────────────────────────────────────────────────────────────────────────────
test('L20: the four FINISH outcomes in words; nothing claims a filing that did not happen', () => {
  assert.equal(L.fileOutcome(true, true).text, 'Lift filed · HR filed');
  assert.equal(L.fileOutcome(true, null).text, 'Lift filed');
  assert.equal(L.fileOutcome(true, false).text, 'Lift filed · HR not filed, kept: file or discard it from Home');
  assert.equal(L.fileOutcome(false, true).text, 'Lift NOT filed: kept, retrying · HR filed');
  assert.equal(L.fileOutcome(false, false).text, 'Lift NOT filed: kept, retrying · HR not filed, kept: file or discard it from Home');
  assert.deepEqual(L.fileOutcome(true, false), { lift_filed: true, hr_filed: false, retry_lift: false, hr_kept: true,
    text: 'Lift filed · HR not filed, kept: file or discard it from Home' });
  assert.throws(() => L.fileOutcome('yes', null)); assert.throws(() => L.fileOutcome(true, 'no'));
});

test('L20: an HR store that REFUSES never blocks the Lift filing; the HR session is kept unfiled with its data', async () => {
  const pb = fakePB(); const now = { t: T0 };
  const lift = L.createLiftStoreSession(pb, { now: () => now.t });
  const hr = H.createStoreSession(pb, { now: () => now.t });
  let s = start([], { hrMode: 'strap' });
  const samples = [{ t: 0, bpm: 90 }, { t: 5, bpm: 120 }];
  const hrSnap = () => ({ session_id: 'hr-sid-1', device: 'strap', exercise_type: 'Weightlifting', samples, rr: [], summary: null,
                          started_ms: T0, ended_ms: null, lift_session_id: s.session_id });
  assert.equal(await hr.write('active', hrSnap), true);
  s = { ...s, meta: L.linkHr(L.tapCheck(s.meta, 0, 0, '10', '60').meta, hr.state.pbId).meta };
  assert.equal(await lift.write('active', () => s), true);
  const order = [];
  pb.fail.get = 99;                                               // the HR store now refuses every read-merge-write
  now.t += 60_000; s = { ...s, ended_at: now.t };
  const out = await L.fileBoth(async () => { order.push('lift'); return lift.write('filed', () => s); },
                               async () => { order.push('hr'); return hr.write('filed', hrSnap); });
  assert.deepEqual(order, ['lift', 'hr'], 'the Lift session is filed first');
  assert.equal(out.lift_filed, true); assert.equal(out.hr_filed, false); assert.equal(out.hr_kept, true);
  assert.equal(out.text, 'Lift filed · HR not filed, kept: file or discard it from Home');
  const liftRec = pb.recs.get(lift.state.pbId), hrRec = pb.recs.get(hr.state.pbId);
  assert.equal(liftRec.metadata.state, 'filed'); assert.equal(liftRec.metadata.hr_session_id, hr.state.pbId);
  assert.equal(hrRec.metadata.state, 'active', 'the HR record is not filed');
  assert.deepEqual(hrRec.metadata.samples, samples, 'and it keeps its data');
  assert.equal(hr.state.missed > 0, true);
});

test('L20: a Lift write that fails (or throws) is said and the HR session is still attempted', async () => {
  const order = [];
  const a = await L.fileBoth(async () => { order.push('lift'); return false; }, async () => { order.push('hr'); return true; });
  assert.deepEqual(order, ['lift', 'hr']);
  assert.deepEqual([a.lift_filed, a.retry_lift, a.hr_filed], [false, true, true]);
  const b = await L.fileBoth(async () => { throw new Error('boom'); }, null);
  assert.equal(b.text, 'Lift NOT filed: kept, retrying');
  const c = await L.fileBoth(async () => true, async () => { throw new Error('boom'); });
  assert.equal(c.text, 'Lift filed · HR not filed, kept: file or discard it from Home');
});

// ── Launch: resume and the START guard ───────────────────────────────────────────────────────
const openLift = (ageS, sid = 'lift-sid-1') => ({ id: 'lrec1', entry_type: 'resistance', ended_at: '', started_at: pbDate(T0 - ageS * 1000 - 600_000),
  metadata: { ...start().meta, session_id: sid, checkpoint_at: iso(T0 - ageS * 1000) } });

test('resume: the store first, then the phone; HRCore\'s decision and stale limit, an HR record refused as a Lift one', () => {
  const local = { ...start(), pb_id: 'lrec1' };
  const d = L.resumeDecision({ store: openLift(30), local, nowMs: T0 });
  assert.equal(d.action, 'resume'); assert.equal(d.source, 'both');
  assert.equal(L.resumeDecision({ store: openLift(H.STALE_SEC + 1), local: null, nowMs: T0 }).action, 'stale');
  assert.equal(L.resumeDecision({ storeError: true, local, nowMs: T0 }).offline, true);
  assert.equal(L.resumeDecision({ store: null, local: { ...local, pb_id: null }, nowMs: T0 }).recreate, true);
  assert.equal(L.resumeDecision({ store: null, local: { ...local, ended_at: T0 - 5 }, nowMs: T0 }).action, 'review', 'finished, not filed: retry the filing');
  assert.throws(() => L.resumeDecision({ store: { ...openLift(30), entry_type: 'heart_rate' }, local: null, nowMs: T0 }), /not an open Lift/);
  assert.equal(L.isOpenLift(openLift(30)), true);
  assert.equal(L.isOpenLift({ ...openLift(30), ended_at: pbDate(T0) }), false);
});

test('resume: one RESUME for the Lift session and ITS HR session (the one naming it); an unrelated HR session keeps its own path', () => {
  const lift = L.resumeDecision({ store: openLift(30), local: null, nowMs: T0 });
  const hrRec = (lsid) => ({ id: 'hrrec', entry_type: 'heart_rate', ended_at: '', started_at: pbDate(T0 - 600_000),
    metadata: { state: 'active', session_id: 'hr-sid', checkpoint_at: iso(T0 - 30_000), ...(lsid ? { lift_session_id: lsid } : {}) } });
  const mine = H.resumeDecision({ store: hrRec('lift-sid-1'), local: null, nowMs: T0 });
  const p = L.pairDecision(lift, mine);
  assert.equal(p.action, 'resume'); assert.equal(p.hr, mine); assert.equal(p.other_hr, null); assert.equal(p.reconnect, true);
  const other = H.resumeDecision({ store: hrRec(null), local: null, nowMs: T0 });
  const q = L.pairDecision(lift, other);
  assert.equal(q.hr, null); assert.equal(q.other_hr, other); assert.equal(q.reconnect, false);
  const byLocal = H.resumeDecision({ store: null, local: { session_id: 'hr-sid', started_at: T0, samples: [], lift_session_id: 'lift-sid-1' }, nowMs: T0 });
  assert.equal(L.pairDecision(lift, byLocal).hr, byLocal, 'the HR checkpoint on the phone names it too');
  const none = H.resumeDecision({ store: null, local: null, nowMs: T0 });
  assert.deepEqual(L.pairDecision(lift, none), { action: 'resume', lift, hr: null, other_hr: null, reconnect: false });
});

test('startGuard: START refuses over an unfiled Lift session (phone or store), then over an unfiled HR session', () => {
  assert.equal(L.startGuard({}, {}), null);
  const local = { ...start(), meta: L.tapCheck(start().meta, 0, 0, '10', '60').meta };
  const g = L.startGuard({ local }, {}, () => '16:25');
  assert.deepEqual(g, { source: 'lift', message: 'Unfiled Lift session (Legs Heavy) from 16:25: 1 of 16 sets confirmed. RESUME it, or FILE / DISCARD it first.' });
  assert.equal(L.startGuard({ storeOpen: openLift(30) }, {}, () => '09:00').source, 'lift');
  const hrLocal = { exercise_type: 'Cardio', started_at: T0, samples: [{ t: 0, bpm: 90 }] };
  const h = L.startGuard({}, { local: hrLocal }, () => '08:00');
  assert.equal(h.source, 'hr'); assert.match(h.message, /^Unfiled Cardio session from 08:00/);
});

// ── Templates and shapes ───────────────────────────────────────────────────────────────────
test('templates (Q1 (a)): a record with a name and lines; archived leaves the picker, never deleted; the validator names what is wrong', () => {
  const rec = L.templateRecord(' Upper ', L.linesFor('Row', 'uni'), T0);
  assert.deepEqual(rec, { entry_type: 'lift_template', started_at: iso(T0), ended_at: null, notes: null,
    metadata: { v: 1, name: 'Upper', archived: false, lines: [{ name: 'Row', side: 'L' }, { name: 'Row', side: 'R' }] } });
  assert.throws(() => L.templateRecord('', LINES, T0), /name is required/);
  assert.throws(() => L.templateRecord('X', [], T0), /at least one exercise/);
  const recs = [tpl(), { ...tpl(), id: 'b', metadata: { ...tpl().metadata, name: 'arms' } },
                { ...tpl(), id: 'c', metadata: L.archiveTemplate(tpl().metadata) }, REC_22];
  assert.deepEqual(L.pickable(recs).map(r => r.id), ['b', 'tplLegsHeavy01']);
  assert.deepEqual(L.moveLine(LINES, 1, 1).map(l => l.side), ['both', 'R', 'L', 'both', 'both']);
  assert.deepEqual(L.moveLine(LINES, 0, -1), LINES);
});

test('startSession: the shape of record (brief §2.1) and every input it needs; the result validates', () => {
  const s = start([], { hrMode: 'strap' });
  assert.deepEqual(Object.keys(s).sort(), ['meta', 'missed', 'pb_id', 'session_id', 'started_at', 'v']);
  assert.deepEqual(Object.keys(s.meta).sort(), ['checkpoint_at', 'exercises', 'hr_mode', 'hr_session_id', 'review', 'session_id',
    'state', 'template', 'utc_offset_s', 'v']);
  assert.equal(s.meta.utc_offset_s, OFF); assert.equal(s.meta.review, ''); assert.equal(s.meta.hr_mode, 'strap');
  assert.deepEqual(L.validateSession(s.meta), []);
  for (const bad of [{ sessionId: '' }, { nowMs: undefined }, { utcOffsetS: 1.5 }, { hrMode: 'maybe' }]) {
    assert.throws(() => start([], bad), undefined, JSON.stringify(bad));
  }
});
