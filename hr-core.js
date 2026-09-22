/* hr-core.js — JA2 capture durability: the pure core of the HR session model.
 *
 * No DOM, no fetch, no Date: every function takes its inputs (including `now`)
 * as arguments, so the Node harness (tests/) runs the REAL module. Loaded by
 * index.html before the app script; exported for Node at the tail.
 *
 * Contract (JA2_Build_Brief_v1.md §2.1, rulings in the gate record §1):
 *   metadata v2 = { v:2, state, session_id, device, checkpoint_at, missed_ticks,
 *                   exercise_type, samples:[{t,bpm[,est]}], rr:[ms], ...summary }
 *   states: active -> stopped -> filed ; any -> discarded. Nothing deletes.
 */
var HRCore = (function () {
  'use strict';

  var STORE_TICK_SEC   = 60;        // Q1 (JB ruled 60 s)
  var STALE_SEC        = 6 * 3600;  // Q6: an open session older than this is offered as stopped, never resumed
  var DISCARD_KEEP_DAYS = 7;        // Q7: the local discard slot
  var META_V           = 2;
  var STATES           = ['active', 'stopped', 'filed', 'discarded'];
  var SUMMARY_KEYS     = ['duration_sec', 'active_sec', 'gap_sec', 'est_sec', 'gaps',
                          'bpm_avg', 'bpm_max', 'bpm_min', 'rmssd_ms', 'zone_time_sec'];

  function isSample(s) {
    return !!s && typeof s === 'object' && Number.isInteger(s.t) && s.t >= 0 &&
           typeof s.bpm === 'number' && isFinite(s.bpm);
  }

  // Union by t. A real sample beats an estimated one on either side; between two
  // real samples the FRESH side wins (on one phone the local copy is the newer).
  // Never drops a real sample; output ascending by t.
  function mergeSamples(base, fresh) {
    var byT = {};
    var put = function (s, side) {
      if (!isSample(s)) throw new Error('mergeSamples: bad sample ' + JSON.stringify(s));
      var cur = byT[s.t];
      if (!cur) { byT[s.t] = s; return; }
      var curReal = !cur.est, newReal = !s.est;
      if (newReal && !curReal) { byT[s.t] = s; return; }
      if (newReal === curReal && side === 'fresh') byT[s.t] = s;
    };
    (base || []).forEach(function (s) { put(s, 'base'); });
    (fresh || []).forEach(function (s) { put(s, 'fresh'); });
    return Object.keys(byT).map(Number).sort(function (a, b) { return a - b; }).map(function (t) { return byT[t]; });
  }

  // RR intervals carry no timestamp, so two lists cannot be interleaved: the
  // longer list wins (documented limitation, gate record). Never shorter than either.
  function mergeRR(a, b) {
    a = a || []; b = b || [];
    return (b.length > a.length ? b : a).slice();
  }

  function summarize(samples, nowElapsedSec) {
    var real = (samples || []).filter(function (s) { return !s.est; });
    var lastT = real.length ? real[real.length - 1].t : 0;
    var span = Number.isInteger(nowElapsedSec) ? nowElapsedSec : lastT;
    return { count: real.length, minutes: Math.round(span / 60), last_t: lastT };
  }

  function tickDue(lastOkMs, nowMs, intervalS) {
    var iv = Number.isInteger(intervalS) ? intervalS : STORE_TICK_SEC;
    if (lastOkMs === null || lastOkMs === undefined) return true;
    return nowMs - lastOkMs >= iv * 1000;
  }

  // The metadata object written to the store (whole-replace PATCH). Validates
  // the state and refuses an `est` sample before stop (J3: nothing synthetic
  // is ever persisted mid-session).
  function checkpointPayload(session, nowIso) {
    if (!session || typeof session !== 'object') throw new Error('checkpointPayload: no session');
    if (STATES.indexOf(session.state) < 0) throw new Error('checkpointPayload: unknown state ' + session.state);
    if (typeof nowIso !== 'string' || !nowIso) throw new Error('checkpointPayload: now is required');
    var samples = (session.samples || []).slice();
    if (session.state === 'active' && samples.some(function (s) { return s.est; })) {
      throw new Error('checkpointPayload: est sample in an active session');
    }
    var out = {
      v: META_V,
      state: session.state,
      session_id: session.session_id || null,
      device: session.device || null,
      checkpoint_at: nowIso,
      missed_ticks: Number.isInteger(session.missed_ticks) ? session.missed_ticks : 0,
      exercise_type: session.exercise_type || 'Cardio',
      samples: samples,
      rr: (session.rr || []).slice(),
    };
    SUMMARY_KEYS.forEach(function (k) {
      out[k] = (session.summary && session.summary[k] !== undefined) ? session.summary[k] : null;
    });
    return out;
  }

  // PocketBase serialises an empty date as "" — an open entry has no ended_at.
  function isOpenEntry(rec) {
    return !!rec && rec.entry_type === 'heart_rate' && !rec.ended_at &&
           !!rec.metadata && rec.metadata.state === 'active';
  }

  function stateOf(rec) {
    var m = rec && rec.metadata;
    return (m && typeof m.state === 'string') ? m.state : 'filed';   // pre-JA2 entries are filed
  }

  function parseMs(iso) {
    var ms = Date.parse(typeof iso === 'string' ? iso.replace(' ', 'T') : '');
    return isNaN(ms) ? null : ms;
  }

  // The launch decision (brief §2.1 table). `store` = the open record from the
  // store or null; `storeError` = the store was unreachable; `local` = the
  // localStorage checkpoint or null. Returns { action, source, ... } where
  // action is one of resume | review | stale | none.
  function resumeDecision(input) {
    var store = input.store || null, local = input.local || null;
    var nowMs = input.nowMs, staleS = Number.isInteger(input.staleS) ? input.staleS : STALE_SEC;
    if (!Number.isInteger(nowMs)) throw new Error('resumeDecision: nowMs is required');
    var localAction = local ? (local.ended_at ? 'review' : 'resume') : null;

    if (input.storeError) {
      return local ? { action: localAction, source: 'local', offline: true, local: local }
                   : { action: 'none', source: 'local', offline: true };
    }
    if (store) {
      var m = store.metadata || {};
      var lastMs = parseMs(m.checkpoint_at) || parseMs(store.started_at);
      if (lastMs === null) throw new Error('resumeDecision: open store entry without a parsable time');
      var sameLocal = !!(local && local.session_id && local.session_id === m.session_id);
      if (nowMs - lastMs > staleS * 1000) {
        return { action: 'stale', source: 'store', record: store, local: sameLocal ? local : null,
                 other_local: (local && !sameLocal) ? local : null };
      }
      if (sameLocal) return { action: 'resume', source: 'both', record: store, local: local };
      return { action: 'resume', source: 'store', record: store, other_local: local || null };
    }
    if (local) return { action: localAction, source: 'local', local: local, recreate: !local.pb_id };
    return { action: 'none', source: 'none' };
  }

  // The START guard: refuse while an unfiled session exists locally or in the
  // store. Returns null (start allowed) or { message, minutes, count }.
  function startGuard(local, storeOpen, fmtTime) {
    var src = local || storeOpen;
    if (!src) return null;
    var samples = local ? (local.samples || []) : ((storeOpen.metadata || {}).samples || []);
    var type = local ? (local.exercise_type || 'Cardio') : ((storeOpen.metadata || {}).exercise_type || 'Cardio');
    var startedAt = local ? local.started_at : storeOpen.started_at;
    var sum = summarize(samples);
    var when = typeof fmtTime === 'function' ? fmtTime(startedAt) : String(startedAt);
    return {
      minutes: sum.minutes, count: sum.count,
      message: 'Unfiled ' + type + ' session from ' + when + ' (' + sum.minutes + ' min, ' + sum.count +
               ' samples). RESUME it, or FILE / DISCARD it first.',
    };
  }

  function discardLabel(samples, elapsedSec) {
    var sum = summarize(samples, elapsedSec);
    return 'DISCARD ' + sum.minutes + ' min · ' + sum.count + ' samples?';
  }

  // BLE reconnect policy (brief §2.3, A1.3): bounded and visible. Attempt 0 fires at
  // once; later attempts every RECONNECT_DELAY_MS; after RECONNECT_MAX the loop stops
  // and the manual button carries the count. The timer (A3) never stops either way.
  var RECONNECT_MAX = 8, RECONNECT_DELAY_MS = 4000;
  function reconnectPolicy(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0) throw new Error('reconnectPolicy: attempt must be a non-negative integer');
    if (attempt >= RECONNECT_MAX) return { retry: false, delayMs: null, attempt: attempt };
    return { retry: true, delayMs: attempt === 0 ? 0 : RECONNECT_DELAY_MS, attempt: attempt };
  }

  // The store-side session engine (brief §2.1). `pb` is the PocketBase seam
  // ({insert, get, update} each answering {data, error}); `opts.now` the clock.
  // write() is one read-merge-write: insert while the store has no record, else
  // GET -> union the store's samples with the phone's (onMerge hands the merged
  // series back to the caller, which adopts it) -> PATCH the whole metadata.
  // A failure is COUNTED (state.missed) and reported, never thrown or swallowed.
  // Nothing here deletes.
  function createStoreSession(pb, opts) {
    var now = (opts && opts.now) || function () { return Date.now(); };
    var st = { pbId: null, lastOk: null, missed: 0, busy: false, writes: 0 };

    function fail() { st.missed++; return false; }

    async function write(state, snapshot, note, onMerge) {
      if (st.busy) return false;
      st.busy = true;
      try {
        var s = snapshot();
        s.state = state; s.missed_ticks = st.missed;
        var body = { metadata: checkpointPayload(s, new Date(now()).toISOString()) };
        if (state !== 'active') body.ended_at = new Date(s.ended_ms || now()).toISOString();
        if (note !== undefined) body.notes = note;
        if (!st.pbId) {
          var ins = await pb.insert(Object.assign(
            { entry_type: 'heart_rate', started_at: new Date(s.started_ms).toISOString(), ended_at: null, notes: null }, body));
          if (!ins || ins.error || !ins.data || !ins.data.id) return fail();
          st.pbId = ins.data.id;
        } else {
          var cur = await pb.get(st.pbId);
          if (!cur || cur.error || !cur.data) return fail();
          var m = cur.data.metadata || {};
          if (state === 'active') {
            var merged = mergeSamples(m.samples || [], s.samples), rr = mergeRR(m.rr || [], s.rr);
            body.metadata.samples = merged; body.metadata.rr = rr;
            if (onMerge) onMerge(merged, rr);
          }
          var upd = await pb.update(st.pbId, body);
          if (!upd || upd.error) return fail();
        }
        st.lastOk = now(); st.missed = 0; st.writes++;
        return true;
      } catch (e) { return fail(); }
      finally { st.busy = false; }
    }

    function due() { return tickDue(st.lastOk, now()); }
    function adopt(pbId, missed) { st.pbId = pbId || null; st.missed = missed || 0; st.lastOk = null; }
    function statusText() {
      if (st.missed > 0) return 'STORE OFFLINE · ' + st.missed + ' missed';
      if (st.lastOk === null) return 'STORE: SAVING…';
      return 'STORE ✓ ' + Math.round((now() - st.lastOk) / 1000) + 's ago';
    }
    return { state: st, write: write, due: due, adopt: adopt, statusText: statusText, fail: fail };
  }

  return {
    STORE_TICK_SEC: STORE_TICK_SEC, STALE_SEC: STALE_SEC, DISCARD_KEEP_DAYS: DISCARD_KEEP_DAYS,
    META_V: META_V, STATES: STATES.slice(),
    mergeSamples: mergeSamples, mergeRR: mergeRR, summarize: summarize, tickDue: tickDue,
    checkpointPayload: checkpointPayload, isOpenEntry: isOpenEntry, stateOf: stateOf,
    resumeDecision: resumeDecision, startGuard: startGuard, discardLabel: discardLabel,
    createStoreSession: createStoreSession,
    RECONNECT_MAX: RECONNECT_MAX, RECONNECT_DELAY_MS: RECONNECT_DELAY_MS, reconnectPolicy: reconnectPolicy,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HRCore;
