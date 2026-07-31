# Phase & Boss System — Reference

> **Read this first** whenever a task touches "phase", boss timing, spawn
> prediction, or the Insights panel. All logic described here lives in
> `website/index.html` (a single-file app). Line numbers are approximate —
> search by function name if they drift.

---

## 1. Game mechanics

> ⚠ **Verify with project owner** — this section is inferred from the code,
> not confirmed game documentation. Correct anything wrong.

- A field/map has a **phase** that runs from **1.0 → 5.0**.
- Phase progression is **player-driven**: phases advance as players clear
  monsters on the map. More players on the map ⇒ faster progression. A quiet,
  low-population map progresses slowly and erratically.
- At **Phase 5.0 the boss spawns** ("respawn"). Once killed, a fixed respawn
  countdown runs; when it ends the map is back at **Phase 1.0** and the cycle
  repeats.
- Players report the current phase by eye (e.g. "phase 3.5") — each report
  becomes a **snapshot**.

**Cycle:** `boss killed` → respawn countdown (`durationMs`) → `Phase 1.0` →
players clear monsters, phase climbs 1→5 → `Phase 5.0` = boss spawns → killed → repeat.

---

## 2. Boss lifecycle & states

`getState(e, now)` (~line 579) returns one of:

| State   | Meaning            | Trigger |
|---------|--------------------|---------|
| `wait`  | Respawn countdown running | `killTime`+`durationMs` set, time remaining |
| `soon`  | (defined but **unused** — `getState` never returns it) | — |
| `p1`    | Boss active, in phases 1–4 | a snapshot exists, or countdown expired |
| `late`  | Active, countdown long overdue | `rem < -20 min` and not yet phase 5 |
| `miss`  | Marked missing     | `e.missing` flag |
| `spawn` | Boss respawned (Phase 5) | latest reported snapshot ≥ 5 |

**Entry object** (camelCase, `rowToEntry`): `id, level, channel, killTime,
durationMs, snapshots[], note, createdAt, missing`.

**Snapshot object:** `{ phase: <1.0–5.0>, time: <epoch ms> }`. A snapshot at
`phase 5.0` means "spawned".

**Snapshot input parsing** (`Returns { kind … }` ~line 1494):
- `on` / `spawn` / `respawn` → snapshot `phase 5.0`
- one-decimal `X.Y` with `X ∈ 1–5` → snapshot at that phase
- bare numbers / `m:ss` → a kill time / countdown, not a phase

---

## 3. Estimation model (parametric)

Core formula:

```
speed(segment) = baseSpeed(level) × PHASE_ACCEL^(segment-1)
```

- **`PHASE_ACCEL = 1.95`** — fixed game mechanic. Each phase runs ~1.95× faster
  than the previous; Phase 4 is ~7× Phase 1. Observed per-segment speeds:

  | Segment | Observed speed | ≈ duration |
  |---------|---------------|-----------|
  | P1→P2 | 0.78× ref | ~38 min |
  | P2→P3 | 1.46× ref | ~21 min |
  | P3→P4 | 2.78× ref | ~11 min |
  | P4→P5 | 5.80× ref | ~5 min  |

- **`baseSpeed`** — the *variable*: a level's learned P1-equivalent speed,
  scaling with population. `baseSpeedFor(level, atTime)` (~833): normalises
  every sample to a P1 base (`sampleBaseSpeed`, ~755 — divides out the segment
  acceleration using `eff_seg`/`effectiveSeg` when known, else integer `seg`,
  else a legacy P1.5 guess), runs a day-type/hour-bucket
  cascade, and takes a **weighted geometric mean** (`weightedGeoMean`, ~815 —
  speed data is log-normal, so an arithmetic mean would overestimate).
  Memoised in `_baseSpeedCache`, cleared by `rebuildKnowledge`.

- `getPhaseSpeed(level, seg, atTime)` (~874) = `segmentSpeed(baseSpeedFor(...), seg)`.

- `walkPhases(startPh, startT, untilT, level)` (~891) integrates forward segment
  by segment. Used by `estimatePhase` (~907, current phase) and `getSpawnAt`
  (~921, predicted spawn time).

- `getSpawnStddev` (~956) gives the `±` uncertainty, using a coefficient of
  variation from `levelCV` (~938).

`REF_SPEED = 3 / (90 min)` is just the unit reference for the `×ref` ratios.

---

## 4. Population detection

"Low population" is **relative and shifts over time** — today's endgame
(EP14–15, LV105–123) becomes a quiet zone when new episodes release. So it is
detected **dynamically**, never by hardcoded level number.

- `levelActivity(level, now)` (~762): counts samples received within
  `ACTIVE_WINDOW_MS` (7 days). `≥ ACTIVE_MIN_SAMPLES` (5) ⇒ `active`, else `quiet`.
- Cold-start fallbacks: `BASE_ACTIVE` (0.80×ref) for active levels,
  `BASE_QUIET` (0.45×ref) for quiet ones.
- Quiet levels get a wider uncertainty CV (`levelCV` returns 0.85) and a
  `⚠ quiet zone` label from `confidence(level)` (~878) — they never claim
  `✦ adaptive` accuracy.

---

## 5. Data

**Supabase table `phase_samples`** (shared learning across browsers, ~447 rows):

| Column | Meaning |
|--------|---------|
| `level` | map level (string) |
| `spd`   | phases per ms between two snapshots |
| `ts`    | epoch ms of the later snapshot |
| `seg`   | integer phase segment 1–4; `0` = the pair spanned segments. Still the clean single-segment flag used by the weekly per-segment / `PHASE_ACCEL` analysis. |
| `eff_seg` | **(added 2026-05-26)** fractional, time-weighted effective segment of the pair (`effectiveSeg`). For cross-segment pairs this replaces the biased `seg=0`→P1.5 decode so base speed comes out unbiased. NULL on legacy rows ⇒ falls back to `seg`; the ~474 historical `seg=0` rows still decode at P1.5 and **cannot be retroactively de-biased** (original snapshot endpoints weren't stored). The fix accumulates on new inserts. Migration: `db/2026-05-26-add-eff_seg.sql`. |
| `w`     | base weight (always 2 from inserts) |
| `hb`    | hour-bucket at insert (⚠ stale scheme — code re-derives from `ts`) |
| `source_id`, `created_at` | provenance |

- `loadSamples` (~1862) pulls all rows on load; realtime channel merges new
  inserts from other browsers.
- `persistLatestSample` (~1875) writes the newest snapshot pair (skips pairs
  `< 2 min` apart or non-advancing).
- `rebuildKnowledge` (~773) pools live entry snapshots + persisted samples into
  the in-memory `knowledge` map: `{ 'lv123': [{spd, ts, seg, w, hb}, …] }`.
- `decayWeight` (~807) ages samples 5%/day, floor 0.2.

**Supabase table `spawn_cycles`** (added 2026-05-26 — ground truth for spawn-time
backtesting; migration `db/2026-05-26-add-spawn_cycles.sql`):

| Column | Meaning |
|--------|---------|
| `level`, `channel` | the cycle's map level / channel |
| `cycle_start_ts` | epoch ms of the cycle's first snapshot; the dedupe key (`unique (level, channel, cycle_start_ts)`) so duplicate spawn reports collapse but each new cycle is its own row |
| `spawn_ts` | epoch ms of the **player-observed** phase-5 report (actual spawn) |
| `trajectory` | jsonb `[{phase, time}, …]` — the cycle's phase climb incl. the spawn point |
| `n_snaps`, `source_id`, `created_at` | provenance |

- `recordSpawnCycle` (in `commitSnapshot`, fires when a player reports phase ≥ 5)
  captures a cycle only if it had a genuine pre-spawn climb and wasn't already
  marked spawned by a reported Phase 5 snapshot — so the spawn time is real, not the
  model's own estimate (which would make backtesting circular).
- `analyze.py` (`backtest_spawn_cycles`) replays the model from each cycle's early
  snapshots and compares predicted vs actual spawn → **real end-to-end accuracy**,
  the only check that goes beyond the base-speed self-consistency of the LOO CV.
  Empty until the table exists and cycles accrue.

---

## 6. Code map (`website/index.html`)

| Area | Function | ~Line |
|------|----------|------|
| Model constants | `REF_SPEED` / `PHASE_ACCEL` / `BASE_ACTIVE` / `BASE_QUIET` | 742 |
| Sample → base | `segmentSpeed` / `sampleBaseSpeed` | 749 / 755 |
| Population | `levelActivity` | 762 |
| Knowledge build | `rebuildKnowledge` | 773 |
| Decay / estimator | `decayWeight` / `weightedGeoMean` | 807 / 815 |
| Per-level speed | `baseSpeedFor` / `getPhaseSpeed` | 833 / 874 |
| Confidence | `confidence` | 878 |
| Forward walk | `walkPhases` | 891 |
| Estimates | `estimatePhase` / `getSpawnAt` / `getSpawnStddev` | 907 / 921 / 956 |
| Uncertainty | `levelCV` | 938 |
| State machine | `getState` | 579 |
| Alert sound | `checkPhaseAlert` | 497 |
| Insights UI | `renderInsights` | 1234 |

---

## 7. Provisional / open items

- **Recalibrate `BASE_QUIET` & `ACTIVE_MIN_SAMPLES`** — the `phase_samples`
  table was <14 days old when the parametric model shipped (2026-05-18), so no
  zone had genuinely gone quiet. Re-derive these once it holds zones aged
  several weeks.
- **Dead `soon` state / `SOUND_SOON`** — `getState` never returns `soon`;
  the sound constant is unreachable.
- **P1/P4 alert sounds not heard** — `checkPhaseAlert` / `checkTransition` run
  only for cards currently in the DOM, so a boss filtered out of view misses
  its P1/P4 alert. Known, not yet fixed.
- **Unbounded `loadSamples`** — pulls every row ever; add a recency cutoff as
  the table grows.

---

## 8. Glossary

- **Phase** — a map's 1.0→5.0 progress meter; 5.0 = boss spawned.
- **Segment** — an integer phase band (P1 = 1.0–1.99, …, P4 = 4.0–4.99).
- **Base speed** — a level's P1-equivalent progression speed, the
  population-dependent term in the model.
- **×ref ratio** — a speed expressed relative to `REF_SPEED` (3 phases / 90 min).
- **`spd`** — raw phases-per-millisecond between two snapshots.
- **`w`** — a sample's weight in the average (before decay).
- **Decay weight** — recency multiplier, 5%/day down to a 0.2 floor.
- **Hour-bucket** — Bangkok-time band: `sleep / dawn / morning / noon /
  evening / night`.
- **Day-type** — `wkd` (Mon–Fri) or `wke` (Sat–Sun), Bangkok time.
- **Active / quiet** — a level's detected population regime.
