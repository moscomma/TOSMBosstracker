# Bug Log

> One entry per fixed bug. Newest first.

---

## 2026-05-27 · Sound double-trigger

### P4 alert re-fires after snapshot regression
`checkPhaseAlert` used `prevPhases[id]` as a plain rolling value. If a new
snapshot arrived with a phase value below 4.0 (e.g. bot/user logged "P3.9"
while the estimate was already P4.1), the estimate temporarily dipped below 4.0
and then re-crossed it on the next tick → SOUND_P4 fired a second time, ~1–2 s
after the first.

**Fix:** Added `_p4Alerted = {}` gate. P4 fires at most once per P1 cycle;
the gate is cleared in `checkTransition` when state transitions to `'p1'`
(start of a new cycle). (`website/index.html` lines ~395, ~437, ~498–502)

### Spawn re-alert fires even when AudioContext was never suspended
The `visibilitychange` handler re-fired SOUND_SPAWN for spawns that occurred
while the tab was hidden. Browsers do not suspend the AudioContext immediately on
tab-hide — a brief tab-switch left it running, so the tick-based beep was
audible AND the re-alert fired on return.

**Fix:** Capture `ctx.state === 'suspended'` *before* calling `ctx.resume()`.
Re-alert only when `wasSuspended` is true. (`website/index.html` lines ~529–542)
