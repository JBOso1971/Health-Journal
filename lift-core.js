/* lift-core.js — W3b: the pure core of the journal's Lift entry (resistance logging).
 *
 * No DOM, no fetch, no clock, no randomness: every function takes its inputs (the clock and the
 * session id included) as arguments, so the Node harness (tests/) runs the REAL module. Loaded by
 * index.html AFTER hr-core.js (it reuses HRCore's resume decision, start guard and tick rather than
 * a second implementation); exported for Node at the tail.
 *
 * Contract: W3b_Build_Brief_v1.md §2 (rules L1–L20); corrections, interpretations and rulings in
 * W3b_Gate_Record_v1.md (C-1 the offset test is R3 in full; I-1 a set-less session is 'skipped';
 * I-5 R 0 · W > 0 is refused; I-6… recorded at S3).
 *   lift_template metadata v1 = { v:1, name, archived, lines:[{name, side}] }
 *   resistance metadata v1    = { v:1, state, session_id, checkpoint_at, utc_offset_s, template:{id, name},
 *                                 hr_mode, hr_session_id, exercises:[{name, side, added, sets}], review }
 *     an ACTIVE set is {r, w, c[, from]}: r / w null = empty, c = confirmed, from = L8's older date;
 *     an ACTIVE exercise may carry `prior` (the date of the session its sets came from, L6);
 *     a FILED set is exactly {r, w} and a filed exercise {name, side, added, sets} (L3).
 *   states: active -> filed ; active | filed -> discarded ; discarded -> filed (restore). Nothing deletes (L18).
 * The local copy (`lift_session` in localStorage) and the engine's snapshot share one shape:
 *   { v:1, session_id, started_at: <ms>, ended_at?: <ms>, pb_id, missed, meta }
 * so HRCore.resumeDecision reads it as it reads the HR checkpoint.
 */
var LiftCore = (function () {
  'use strict';

  var HR = (typeof HRCore !== 'undefined') ? HRCore
         : (typeof require === 'function' ? require('./hr-core.js') : null);
  if (!HR) throw new Error('lift-core.js: hr-core.js must load first');

  var META_V = 1;
  var ENTRY_TYPE = 'resistance', TEMPLATE_TYPE = 'lift_template';
  var STATES = ['active', 'filed', 'discarded'];
  var SIDES = ['both', 'L', 'R'];
  var HR_MODES = ['strap', 'link', 'none'];
  var HR_EXERCISE_TYPE = 'Weightlifting';          // L17: the strap session's type, set by Lift, never asked
  var CHECKPOINT_SEC = 5;                          // L18: a store write per change, at most one per 5 s
  var OFFSET_STEP_S = 900, MAX_OFFSET_S = 14 * 3600;   // R3 (C-1): an integer multiple of 15 min within ±14 h
  var LIFT_ROUTE = '#log/resistance', HR_ROUTE = '#log/heart_rate';
  var ZERO_REPS_WITH_WEIGHT = '0 reps with a weight: enter the reps, or clear the weight';   // I-5 (JB, s29)

  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function isText(s) { return typeof s === 'string' && s.trim() !== ''; }
  function iso(ms) { return new Date(ms).toISOString(); }
  function parseMs(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    var ms = Date.parse(typeof v === 'string' ? v.replace(' ', 'T') : '');
    return isNaN(ms) ? null : ms;
  }
  function emptySet() { return { r: null, w: null, c: false }; }
  function isSkip(s) { return s.r === 0 && s.w === 0; }

  // ── R3 / L12: the local date ─────────────────────────────────────────────────────────────
  function isOffset(v) {
    return typeof v === 'number' && Number.isInteger(v) && v % OFFSET_STEP_S === 0 && Math.abs(v) <= MAX_OFFSET_S;
  }
  // The local date of an instant at the session's own offset; no valid offset gives NO date, never
  // the UTC date passed off as local (L12). The same arithmetic as the views' date(started_at, offset).
  function localDate(startedMs, offsetS) {
    if (typeof startedMs !== 'number' || !Number.isFinite(startedMs) || !isOffset(offsetS)) return null;
    return iso(startedMs + offsetS * 1000).slice(0, 10);
  }
  function sessionDate(rec) {
    return localDate(parseMs(rec && rec.started_at), rec && rec.metadata ? rec.metadata.utc_offset_s : undefined);
  }

  // ── Input: the screen's text -> a number, or a refusal in words (never a silent 0) ───────
  function parseReps(raw) {
    var s = (raw === null || raw === undefined) ? '' : String(raw).trim();
    if (s === '') return { value: null, error: null };
    if (!/^\d+$/.test(s)) return { value: null, error: 'Reps must be a whole number (' + s + ')' };
    return { value: parseInt(s, 10), error: null };
  }
  function parseLoad(raw) {
    var s = (raw === null || raw === undefined) ? '' : String(raw).trim().replace(',', '.');   // a pt-BR keypad types 22,5
    if (s === '') return { value: null, error: null };
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { value: null, error: 'Weight must be a number of kg (' + String(raw).trim() + ')' };
    return { value: parseFloat(s), error: null };
  }

  // ── L1 / L2 / L3: sets, volume, kinds ────────────────────────────────────────────────────
  // L2, exactly as the sets view's set_kind: R 0 · W 0 skipped, W 0 bodyweight (done), else loaded.
  // (A filed R 0 · W > 0 cannot arise, I-5; were one ever stored it would read 'loaded' at volume 0.)
  function setKind(r, w) {
    if (r === 0 && w === 0) return 'skipped';
    if (w === 0) return 'bodyweight';
    return 'loaded';
  }
  // L1: W is the set's TOTAL load; volume = R × W, no multiplier.
  function setVolume(s) { return s.r * s.w; }
  // L3: an unconfirmed set files as R 0 · W 0 and `c` never reaches the filed record.
  function filedSet(s) {
    if (!s || typeof s !== 'object') throw new Error('filedSet: not a set');
    if (s.c === false) return { r: 0, w: 0 };
    if (!Number.isInteger(s.r) || typeof s.w !== 'number' || !Number.isFinite(s.w)) {
      throw new Error('filedSet: a confirmed set without numbers ' + JSON.stringify(s));
    }
    return { r: s.r, w: s.w };
  }
  function allSets(meta) {
    var out = [];
    ((meta && meta.exercises) || []).forEach(function (e) { (e.sets || []).forEach(function (s) { out.push(s); }); });
    return out;
  }
  function volume(sets) { return (sets || []).map(filedSet).reduce(function (a, s) { return a + setVolume(s); }, 0); }
  function lineVolume(ex) { return volume(ex && ex.sets); }

  // L11: the session status, derived from the sets AS THEY FILE (an active session reads as it would
  // file, L3). Every set skipped = skipped, some = partial, none = completed. I-1: no sets at all =
  // 'skipped' (nothing was done), as the view says.
  function status(meta) {
    var sets = allSets(meta).map(filedSet);
    var skipped = sets.filter(isSkip).length;
    if (skipped === sets.length) return 'skipped';
    return skipped === 0 ? 'completed' : 'partial';
  }
  // What the sessions view serves for the same record (status, n_sets, n_skipped, volume_kg).
  function summary(meta) {
    var sets = allSets(meta).map(filedSet);
    return { status: status(meta), n_sets: sets.length, n_skipped: sets.filter(isSkip).length, volume_kg: volume(sets) };
  }
  // The session screen's footer: confirmed / total and the confirmed volume.
  function progress(meta) {
    var sets = allSets(meta);
    return { confirmed: sets.filter(function (s) { return s.c === true; }).length, total: sets.length, volume_kg: volume(sets) };
  }

  // ── Shapes and their validators (a list of problems; empty = valid) ─────────────────────
  function validateLines(lines, where) {
    var p = [];
    if (!Array.isArray(lines) || !lines.length) return [where + ': at least one exercise line'];
    lines.forEach(function (l, i) {
      if (!l || !isText(l.name)) p.push(where + '[' + i + ']: an exercise needs a name');
      if (!l || SIDES.indexOf(l.side) < 0) p.push(where + '[' + i + ']: side must be both, L or R');
    });
    return p;
  }
  function validateTemplate(meta) {
    if (!meta || typeof meta !== 'object') return ['template: no metadata'];
    var p = [];
    if (meta.v !== META_V) p.push('template: v must be ' + META_V);
    if (!isText(meta.name)) p.push('template: a name is required');
    if (typeof meta.archived !== 'boolean') p.push('template: archived must be true or false');
    return p.concat(validateLines(meta.lines, 'template.lines'));
  }
  function validateSet(s, kind, where) {
    var p = [];
    if (!s || typeof s !== 'object') return [where + ': not a set'];
    var keys = Object.keys(s);
    var numR = function (v) { return Number.isInteger(v) && v >= 0; };
    var numW = function (v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; };
    if (kind === 'filed') {
      if (keys.length !== 2 || !('r' in s) || !('w' in s)) p.push(where + ': a filed set is exactly {r, w}');
      if (!numR(s.r) || !numW(s.w)) p.push(where + ': a filed set carries a whole R and a W in kg');
      else if (s.r === 0 && s.w > 0) p.push(where + ': ' + ZERO_REPS_WITH_WEIGHT);
      return p;
    }
    if (keys.some(function (k) { return ['r', 'w', 'c', 'from'].indexOf(k) < 0; })) p.push(where + ': unknown key in an active set');
    if (!(s.r === null || numR(s.r))) p.push(where + ': R must be empty or a whole number');
    if (!(s.w === null || numW(s.w))) p.push(where + ': W must be empty or a number of kg');
    if (typeof s.c !== 'boolean') p.push(where + ': c must be true or false');
    if (s.c === true) {
      if (!numR(s.r) || !numW(s.w)) p.push(where + ': a confirmed set carries both numbers');
      else if (s.r === 0 && s.w > 0) p.push(where + ': ' + ZERO_REPS_WITH_WEIGHT);
    }
    if ('from' in s && !(s.from === null || typeof s.from === 'string')) p.push(where + ': from must be a date or null');
    return p;
  }
  function validateSession(meta) {
    if (!meta || typeof meta !== 'object') return ['session: no metadata'];
    var p = [];
    if (meta.v !== META_V) p.push('session: v must be ' + META_V);
    if (STATES.indexOf(meta.state) < 0) p.push('session: unknown state ' + meta.state);
    if (!isText(meta.session_id)) p.push('session: session_id is required');
    if (typeof meta.checkpoint_at !== 'string' || !meta.checkpoint_at) p.push('session: checkpoint_at is required');
    if (!Number.isInteger(meta.utc_offset_s)) p.push('session: utc_offset_s must be a whole number of seconds');
    if (!meta.template || !isText(meta.template.id) || !isText(meta.template.name)) p.push('session: the template copy {id, name} is required');
    if (HR_MODES.indexOf(meta.hr_mode) < 0) p.push('session: hr_mode must be strap, link or none');
    if (!(meta.hr_session_id === null || isText(meta.hr_session_id))) p.push('session: hr_session_id must be an id or null');
    if (meta.hr_mode === 'link' && !isText(meta.hr_session_id)) p.push('session: a linked session names its HR session');
    if (meta.hr_mode === 'none' && meta.hr_session_id !== null) p.push('session: no HR mode, no HR id');
    if (typeof meta.review !== 'string') p.push('session: review must be text');
    if (!Array.isArray(meta.exercises)) return p.concat(['session: exercises must be a list']);
    meta.exercises.forEach(function (e, i) {
      var w = 'exercises[' + i + ']';
      if (!e || !isText(e.name)) p.push(w + ': a name is required');
      if (!e || SIDES.indexOf(e.side) < 0) p.push(w + ': side must be both, L or R');
      if (!e || typeof e.added !== 'boolean') p.push(w + ': added must be true or false');
      if (!e || !Array.isArray(e.sets)) { p.push(w + ': sets must be a list'); return; }
      e.sets.forEach(function (s, k) {
        var kind = meta.state === 'active' ? 'active' : meta.state === 'filed' ? 'filed'
                 : (s && 'c' in s ? 'active' : 'filed');                 // a discarded session keeps either shape
        p = p.concat(validateSet(s, kind, w + '.sets[' + k + ']'));
      });
    });
    return p;
  }
  function assertValid(problems, where) { if (problems.length) throw new Error(where + ': ' + problems.join('; ')); }

  // ── Templates (Q1 (a): archived, never deleted) ──────────────────────────────────────────
  // L9: a unilateral lift is two lines, L then R, each with its own sets and its side stored.
  function linesFor(name, lateral) {
    if (!isText(name)) throw new Error('linesFor: an exercise needs a name');
    var n = name.trim();
    if (lateral === 'both') return [{ name: n, side: 'both' }];
    if (lateral === 'uni') return [{ name: n, side: 'L' }, { name: n, side: 'R' }];
    throw new Error('linesFor: lateral must be both or uni');
  }
  function templateMeta(name, lines, archived) {
    var m = { v: META_V, name: isText(name) ? name.trim() : '', archived: !!archived,
              lines: (lines || []).map(function (l) { return { name: l.name, side: l.side }; }) };
    assertValid(validateTemplate(m), 'templateMeta');
    return m;
  }
  // The record a new template is inserted as: started_at is the creation instant (the field is required).
  function templateRecord(name, lines, nowMs) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new Error('templateRecord: nowMs is required');
    return { entry_type: TEMPLATE_TYPE, started_at: iso(nowMs), ended_at: null, notes: null, metadata: templateMeta(name, lines, false) };
  }
  function archiveTemplate(meta) { var m = copy(meta); m.archived = true; assertValid(validateTemplate(m), 'archiveTemplate'); return m; }
  function moveLine(lines, i, d) {
    var L = copy(lines), j = i + d;
    if (i < 0 || i >= L.length || j < 0 || j >= L.length) return L;
    var t = L[i]; L[i] = L[j]; L[j] = t; return L;
  }
  // The picker: templates not archived, by name.
  function pickable(records) {
    return (records || []).filter(function (r) {
      return r && r.entry_type === TEMPLATE_TYPE && r.metadata && r.metadata.archived !== true;
    }).sort(function (a, b) { return String(a.metadata.name).toLowerCase() < String(b.metadata.name).toLowerCase() ? -1 : 1; });
  }

  // ── L5–L8: pre-fill ──────────────────────────────────────────────────────────────────────
  // L5 (and L13's filter): FILED sessions of the SAME template, by template.id, newest first.
  function historyFor(records, templateId) {
    return (records || []).filter(function (r) {
      var m = r && r.metadata;
      return r.entry_type === ENTRY_TYPE && m && m.state === 'filed' && m.template && m.template.id === templateId &&
             Array.isArray(m.exercises) && parseMs(r.started_at) !== null;
    }).map(function (r) {
      return { id: r.id, started_ms: parseMs(r.started_at), date: sessionDate(r), exercises: r.metadata.exercises };
    }).sort(function (a, b) { return b.started_ms - a.started_ms; });
  }
  function lineOf(h, line) {
    for (var i = 0; i < h.exercises.length; i++) {
      var e = h.exercises[i];
      if (e && e.name === line.name && e.side === line.side && Array.isArray(e.sets)) return e;
    }
    return null;
  }
  // L6: the number of sets = the most recent session holding the line (a skip is a saved row, so it
  //     never shrinks it). L7: each set's R × W = the most recent session in which THAT set was done
  //     (anything but R 0 · W 0); never done -> an empty set. L8: a set taken from an older session than
  //     the one holding the line carries that session's date (`from`). No history -> null (L10).
  function prefill(history, line) {
    var holding = -1;
    for (var i = 0; i < (history || []).length; i++) { if (lineOf(history[i], line)) { holding = i; break; } }
    if (holding < 0) return null;
    var n = lineOf(history[holding], line).sets.length;
    if (n < 1) return null;
    var sets = [];
    for (var k = 0; k < n; k++) {
      var set = emptySet();
      for (var j = 0; j < history.length; j++) {
        var l = lineOf(history[j], line), s = l && l.sets[k];
        if (s && Number.isInteger(s.r) && typeof s.w === 'number' && !isSkip(s)) {
          set = { r: s.r, w: s.w, c: false };
          if (j !== holding) set.from = history[j].date;
          break;
        }
      }
      sets.push(set);
    }
    return { prior: history[holding].date, sets: sets };
  }

  // ── L4 / L10 / L17: starting a session ───────────────────────────────────────────────────
  // L17: START is refused until what it needs is there, with the reason in words.
  function canStart(opts) {
    var t = opts && opts.template, m = t && t.metadata;
    if (!m || !Array.isArray(m.lines) || !m.lines.length) return { ok: false, reason: 'Pick a workout with at least one exercise' };
    if (m.archived === true) return { ok: false, reason: 'That template is archived' };
    if (HR_MODES.indexOf(opts.hrMode) < 0) return { ok: false, reason: 'Choose how heart rate is recorded' };
    if (opts.hrMode === 'strap' && opts.strapConnected !== true) return { ok: false, reason: 'Connect the strap first' };
    if (opts.hrMode === 'link' && !isText(opts.hrSessionId)) return { ok: false, reason: "Pick today's heart-rate session to link" };
    return { ok: true, reason: null };
  }
  // L4: the session COPIES its template (name + lines) at START; nothing later rewrites it. The sets
  // come from pre-fill (L5–L8), or one empty set per line (L10: a template's first session).
  // opts = { sessionId, nowMs, utcOffsetS, hrMode, hrSessionId }. Returns the local copy (see header).
  function startSession(template, history, opts) {
    opts = opts || {};
    var m = template && template.metadata;
    if (!template || !isText(template.id) || template.entry_type !== TEMPLATE_TYPE) throw new Error('startSession: not a template record');
    assertValid(validateTemplate(m), 'startSession');
    if (m.archived) throw new Error('startSession: the template is archived');
    if (!isText(opts.sessionId)) throw new Error('startSession: sessionId is required');
    if (typeof opts.nowMs !== 'number' || !Number.isFinite(opts.nowMs)) throw new Error('startSession: nowMs is required (time is an input)');
    if (!Number.isInteger(opts.utcOffsetS)) throw new Error('startSession: utcOffsetS must be a whole number of seconds');
    if (HR_MODES.indexOf(opts.hrMode) < 0) throw new Error('startSession: hrMode must be strap, link or none');
    var hist = historyFor(history, template.id);
    var meta = {
      v: META_V, state: 'active', session_id: opts.sessionId, checkpoint_at: iso(opts.nowMs),
      utc_offset_s: opts.utcOffsetS,
      template: { id: template.id, name: m.name },
      hr_mode: opts.hrMode, hr_session_id: opts.hrMode === 'link' ? (opts.hrSessionId || null) : null,
      exercises: m.lines.map(function (l) {
        var p = prefill(hist, l);
        return { name: l.name, side: l.side, added: false, prior: p ? p.prior : null, sets: p ? p.sets : [emptySet()] };
      }),
      review: '',
    };
    assertValid(validateSession(meta), 'startSession');
    return { v: META_V, session_id: opts.sessionId, started_at: opts.nowMs, pb_id: null, missed: 0, meta: meta };
  }

  // ── L10 / I-5: editing a running session. Each returns { meta, refused, focus } and never
  //    mutates its input; `refused` is the reason in words, `focus` the field the screen should focus.
  function activeCopy(meta) {
    if (!meta || meta.state !== 'active') throw new Error('a session can be edited only while active');
    return copy(meta);
  }
  function setAt(m, ei, si) {
    var e = m.exercises[ei], s = e && e.sets[si];
    if (!s) throw new Error('no set ' + ei + '.' + si);
    return s;
  }
  // ✓: confirms what is on screen. On an empty set it puts the cursor in R and confirms nothing
  // (L10); a confirmed set is un-confirmed (the mock's toggle). A missing W with reps is bodyweight;
  // R 0 with a weight is refused and stays unconfirmed (I-5).
  function tapCheck(meta, ei, si, rawR, rawW) {
    var m = activeCopy(meta), s = setAt(m, ei, si);
    if (s.c) { s.c = false; return { meta: m, refused: null, focus: null }; }
    var r = parseReps(rawR), w = parseLoad(rawW);
    if (r.error || w.error) return { meta: copy(meta), refused: r.error || w.error, focus: r.error ? 'r' : 'w' };
    if (r.value === null && w.value === null) { s.r = null; s.w = null; return { meta: m, refused: null, focus: 'r' }; }
    var R = r.value === null ? 0 : r.value, W = w.value === null ? 0 : w.value;
    if (s.r !== r.value || s.w !== w.value) delete s.from;
    if (R === 0 && W > 0) { s.r = r.value; s.w = w.value; return { meta: m, refused: ZERO_REPS_WITH_WEIGHT, focus: 'r' }; }
    s.r = R; s.w = W; s.c = true;
    return { meta: m, refused: null, focus: null };
  }
  // A number changed: L10, that set is confirmed, once it carries both numbers (I-8: a cleared field
  // un-confirms it, so nothing files that was not confirmed as it stands). R 0 with a weight: refused (I-5).
  function editSet(meta, ei, si, field, raw) {
    if (field !== 'r' && field !== 'w') throw new Error('editSet: field must be r or w');
    var p = field === 'r' ? parseReps(raw) : parseLoad(raw);
    if (p.error) return { meta: copy(meta), refused: p.error, focus: field };
    var m = activeCopy(meta), s = setAt(m, ei, si);
    if (s[field] !== p.value) delete s.from;              // no longer the older session's numbers (L8)
    s[field] = p.value;
    if (s.r === null || s.w === null) { s.c = false; return { meta: m, refused: null, focus: null }; }
    if (s.r === 0 && s.w > 0) { s.c = false; return { meta: m, refused: ZERO_REPS_WITH_WEIGHT, focus: 'r' }; }
    s.c = true;
    return { meta: m, refused: null, focus: null };
  }
  // + SET: a copy of the line's last set as an unconfirmed suggestion.
  function addSet(meta, ei) {
    var m = activeCopy(meta), e = m.exercises[ei];
    if (!e) throw new Error('addSet: no exercise ' + ei);
    var last = e.sets[e.sets.length - 1], n = { r: last ? last.r : null, w: last ? last.w : null, c: false };
    if (last && 'from' in last) n.from = last.from;
    e.sets.push(n);
    return { meta: m, refused: null, focus: null };
  }
  // − SET: never below one (an unwanted set is left unconfirmed and files as a skip).
  function removeSet(meta, ei) {
    var m = activeCopy(meta), e = m.exercises[ei];
    if (!e) throw new Error('removeSet: no exercise ' + ei);
    if (e.sets.length <= 1) return { meta: copy(meta), refused: 'A line keeps at least one set: leave it unconfirmed to save it as a skip', focus: null };
    e.sets.pop();
    return { meta: m, refused: null, focus: null };
  }
  // An exercise added on the day (L10: added, one empty set; the template is never changed; L9 for uni).
  function addExercise(meta, name, lateral) {
    if (!isText(name)) return { meta: copy(meta), refused: 'Name the exercise first', focus: 'name' };
    var m = activeCopy(meta);
    linesFor(name, lateral).forEach(function (l) {
      m.exercises.push({ name: l.name, side: l.side, added: true, prior: null, sets: [emptySet()] });
    });
    return { meta: m, refused: null, focus: null };
  }
  // L14: the one free text served to Kito lives here; `notes` is never written by a Lift path.
  function setReview(meta, text) {
    if (typeof text !== 'string') throw new Error('setReview: text must be a string');
    var m = activeCopy(meta); m.review = text;
    return { meta: m, refused: null, focus: null };
  }
  // L15 (strap): the HR store record's id, stored as soon as that record exists; never re-pointed
  // once stored (a disagreeing id is reported, and the stored one stands: I-3's order).
  function linkHr(meta, hrPbId) {
    if (meta.hr_mode !== 'strap' || !isText(hrPbId) || meta.hr_session_id === hrPbId) return { meta: meta, changed: false, conflict: false };
    if (meta.hr_session_id) return { meta: meta, changed: false, conflict: true };
    var m = copy(meta); m.hr_session_id = hrPbId;
    return { meta: m, changed: true, conflict: false };
  }

  // L3: the metadata as it files: every set {r, w} (unconfirmed -> R 0 · W 0), no `c`, no `from`,
  // no `prior`; state 'filed'.
  function fileShape(meta) {
    if (!meta || STATES.indexOf(meta.state) < 0) throw new Error('fileShape: not a session');
    var out = copy(meta);
    out.state = 'filed';
    out.exercises = (meta.exercises || []).map(function (e) {
      return { name: e.name, side: e.side, added: !!e.added, sets: (e.sets || []).map(filedSet) };
    });
    assertValid(validateSession(out), 'fileShape');
    return out;
  }

  // ── L18: the store session (modelled on HRCore.createStoreSession) ───────────────────────
  // The metadata written to the store (whole-replace PATCH). A 'filed' payload is ALWAYS the file
  // shape (L3 cannot be bypassed by a caller); every payload is validated.
  function checkpointPayload(meta, state, nowIso) {
    if (STATES.indexOf(state) < 0) throw new Error('checkpointPayload: unknown state ' + state);
    if (typeof nowIso !== 'string' || !nowIso) throw new Error('checkpointPayload: now is required');
    var out = state === 'filed' ? fileShape(meta) : copy(meta);
    out.state = state; out.checkpoint_at = nowIso;
    assertValid(validateSession(out), 'checkpointPayload');
    return out;
  }
  // `pb` is the PocketBase seam ({insert, update} each answering {data, error}); `opts.now` the clock
  // (required). The record is inserted at the first write (START, `active`) and PATCHed whole after;
  // `notes` is null at the insert and never in a PATCH (L14). A failure is COUNTED (state.missed) and
  // reported, never thrown or swallowed. touch() marks a change; due() = a change not yet written and
  // at least CHECKPOINT_SEC since the last attempt. Nothing here deletes.
  function createLiftStoreSession(pb, opts) {
    var now = opts && opts.now;
    if (typeof now !== 'function') throw new Error('createLiftStoreSession: opts.now is required (time is an input)');
    var st = { pbId: null, lastOk: null, lastTry: null, missed: 0, busy: false, writes: 0, rev: 0, written: 0 };

    function fail() { st.missed++; return false; }
    function touch() { st.rev++; }
    function dirty() { return st.rev !== st.written; }

    async function write(state, snapshot) {
      if (st.busy) return false;
      st.busy = true;
      var rev = st.rev;
      st.lastTry = now();
      try {
        var s = snapshot();
        var body = { metadata: checkpointPayload(s.meta, state, iso(now())) };
        if (state !== 'active') body.ended_at = iso(typeof s.ended_at === 'number' ? s.ended_at : now());
        if (!st.pbId) {
          var ins = await pb.insert(Object.assign(
            { entry_type: ENTRY_TYPE, started_at: iso(s.started_at), ended_at: null, notes: null }, body));
          if (!ins || ins.error || !ins.data || !ins.data.id) return fail();
          st.pbId = ins.data.id;
        } else {
          var upd = await pb.update(st.pbId, body);
          if (!upd || upd.error) return fail();
        }
        st.lastOk = now(); st.missed = 0; st.writes++; st.written = rev;
        return true;
      } catch (e) { return fail(); }
      finally { st.busy = false; }
    }

    function due() { return dirty() && HR.tickDue(st.lastTry, now(), CHECKPOINT_SEC); }
    function adopt(pbId, missed) { st.pbId = pbId || null; st.missed = missed || 0; st.lastOk = null; st.lastTry = null; }
    function statusText() {
      if (st.missed > 0) return 'STORE OFFLINE · ' + st.missed + ' missed';
      if (st.lastOk === null) return 'STORE: SAVING…';
      return 'STORE ✓ ' + Math.round((now() - st.lastOk) / 1000) + 's ago';
    }
    return { state: st, write: write, touch: touch, dirty: dirty, due: due, adopt: adopt, statusText: statusText, fail: fail };
  }

  // ── Launch: resume (the store first, then the phone), for a Lift session and a Lift + HR pair ──
  function isOpenLift(rec) {
    return !!rec && rec.entry_type === ENTRY_TYPE && !rec.ended_at && !!rec.metadata && rec.metadata.state === 'active';
  }
  // HRCore's decision, unchanged (store before phone; stale after HRCore.STALE_SEC from checkpoint_at);
  // the local copy's shape is the HR checkpoint's (session_id, ended_at, pb_id). A store record that
  // is not an open Lift session is refused, never read as one.
  function resumeDecision(input) {
    if (input && input.store && !isOpenLift(input.store)) throw new Error('resumeDecision: the store record is not an open Lift session');
    return HR.resumeDecision(input);
  }
  function liftSidOf(d) {
    return (d && d.record && d.record.metadata && d.record.metadata.session_id) || (d && d.local && d.local.session_id) || null;
  }
  function hrClaims(d, sid) {
    var rm = d.record && d.record.metadata, lc = d.local;
    return !!sid && ((!!rm && rm.lift_session_id === sid) || (!!lc && lc.lift_session_id === sid));
  }
  // One decision for Home: the Lift session's, with its OWN HR session (the one whose lift_session_id
  // names it) carried beside it, so one RESUME tap resumes both and is the Bluetooth gesture. An HR
  // session that does not name this Lift session is left to its own JA2 path (`other_hr`).
  function pairDecision(lift, hr) {
    if (!lift || !hr) throw new Error('pairDecision: both decisions are required');
    var linked = lift.action !== 'none' && hr.action !== 'none' && hrClaims(hr, liftSidOf(lift));
    return { action: lift.action, lift: lift, hr: linked ? hr : null,
             other_hr: (!linked && hr.action !== 'none') ? hr : null,
             reconnect: linked && lift.action === 'resume' && hr.action === 'resume' };
  }
  // The START guard: refuse while an unfiled Lift session (phone or store) or an unfiled HR session
  // exists (the HR half is HRCore's own guard). Returns null or { source, message }.
  function startGuard(lift, hr, fmtTime) {
    lift = lift || {}; hr = hr || {};
    var src = lift.local || lift.storeOpen;
    if (src) {
      var meta = lift.local ? lift.local.meta : lift.storeOpen.metadata;
      var startedAt = lift.local ? lift.local.started_at : lift.storeOpen.started_at;
      var p = { confirmed: 0, total: 0 };
      try { p = progress(meta); } catch (e) { /* a malformed copy still refuses START; the counts read 0 */ }
      var name = (meta && meta.template && meta.template.name) || 'Lift';
      var when = typeof fmtTime === 'function' ? fmtTime(startedAt) : String(startedAt);
      return { source: 'lift', message: 'Unfiled Lift session (' + name + ') from ' + when + ': ' + p.confirmed + ' of ' + p.total +
               ' sets confirmed. RESUME it, or FILE / DISCARD it first.' };
    }
    var g = HR.startGuard(hr.local || null, hr.storeOpen || null, fmtTime);
    return g ? { source: 'hr', message: g.message, minutes: g.minutes, count: g.count } : null;
  }

  // ── L19: the route lock ──────────────────────────────────────────────────────────────────
  // While a Lift session runs, every route returns to the Lift screen; with the strap linked the HR
  // view is admitted too (the HR lock, A4, relaxed for the Lift screen only). Returns the hash to go
  // to, or null when `hash` may render. `lock` = { lift: an active Lift session, strap: strap-linked }.
  function lockRoute(hash, lock) {
    if (!lock || !lock.lift) return null;
    var allowed = lock.strap ? [LIFT_ROUTE, HR_ROUTE] : [LIFT_ROUTE];
    return allowed.indexOf(hash) >= 0 ? null : LIFT_ROUTE;
  }

  // ── L20: FINISH files both, independently, the Lift session first ────────────────────────
  // liftOk: the Lift record filed (true / false); hrOk: the linked HR session filed (true / false), or
  // null when there is none. The words name both outcomes; nothing claims a filing that did not happen.
  function fileOutcome(liftOk, hrOk) {
    if (typeof liftOk !== 'boolean') throw new Error('fileOutcome: liftOk must be true or false');
    if (hrOk !== null && typeof hrOk !== 'boolean') throw new Error('fileOutcome: hrOk must be true, false or null');
    var parts = [liftOk ? 'Lift filed' : 'Lift NOT filed: kept, retrying'];
    if (hrOk === true) parts.push('HR filed');
    else if (hrOk === false) parts.push('HR not filed, kept: file or discard it from Home');
    return { lift_filed: liftOk, hr_filed: hrOk, retry_lift: !liftOk, hr_kept: hrOk === false, text: parts.join(' · ') };
  }
  // fileLift / fileHr: async functions answering true when their record filed (the app's retrying
  // writes). The Lift session is filed first and never waits on, or is held by, the HR session; the
  // HR session is attempted whatever the Lift write did. A throw is a failure, never an escape.
  async function fileBoth(fileLift, fileHr) {
    var liftOk = false, hrOk = null;
    try { liftOk = (await fileLift()) === true; } catch (e) { liftOk = false; }
    if (typeof fileHr === 'function') {
      try { hrOk = (await fileHr()) === true; } catch (e) { hrOk = false; }
    }
    return fileOutcome(liftOk, hrOk);
  }

  return {
    META_V: META_V, ENTRY_TYPE: ENTRY_TYPE, TEMPLATE_TYPE: TEMPLATE_TYPE, STATES: STATES.slice(), SIDES: SIDES.slice(),
    HR_MODES: HR_MODES.slice(), HR_EXERCISE_TYPE: HR_EXERCISE_TYPE, CHECKPOINT_SEC: CHECKPOINT_SEC,
    MAX_OFFSET_S: MAX_OFFSET_S, LIFT_ROUTE: LIFT_ROUTE, HR_ROUTE: HR_ROUTE, ZERO_REPS_WITH_WEIGHT: ZERO_REPS_WITH_WEIGHT,
    isOffset: isOffset, localDate: localDate, sessionDate: sessionDate, parseReps: parseReps, parseLoad: parseLoad,
    setKind: setKind, setVolume: setVolume, filedSet: filedSet, volume: volume, lineVolume: lineVolume,
    status: status, summary: summary, progress: progress,
    validateTemplate: validateTemplate, validateSession: validateSession,
    linesFor: linesFor, templateMeta: templateMeta, templateRecord: templateRecord, archiveTemplate: archiveTemplate,
    moveLine: moveLine, pickable: pickable,
    historyFor: historyFor, prefill: prefill, canStart: canStart, startSession: startSession,
    tapCheck: tapCheck, editSet: editSet, addSet: addSet, removeSet: removeSet, addExercise: addExercise,
    setReview: setReview, linkHr: linkHr, fileShape: fileShape,
    checkpointPayload: checkpointPayload, createLiftStoreSession: createLiftStoreSession,
    isOpenLift: isOpenLift, resumeDecision: resumeDecision, pairDecision: pairDecision, startGuard: startGuard,
    lockRoute: lockRoute, fileOutcome: fileOutcome, fileBoth: fileBoth,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiftCore;
