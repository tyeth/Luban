---
name: cnc-probing
description: "Measure work with the spindle touch probe and the whole-bed camera survey via the Luban MCP tools (probe_point, probe_vector, probe_sequence, probe_circle, probe_surface_path/grid flatness scans, survey_bed, run_tool_setter with accept_probe_contact) — including the motion laws written in the aftermath of a probe-destroying crash. Use whenever the user wants to probe stock, find surfaces/edges, check flatness or map a surface height, survey the bed, or calibrate the touch probe."
---

# CNC probing: the probe, the survey, and the motion laws

The spindle touch probe turns contact into coordinates; the bed survey turns
the camera into context. Between them sit the motion laws — written after a
real crash (2026-09-01) in which an XY traverse at a fabricated "clearance"
height drove the probe into the rotary stock and destroyed it.

## The motion laws (operator law — never overridden on model judgment)

1. **One motion per instruction, and no inferred approvals.** When the
   operator enumerates steps, execute exactly the step they name and stop.
   NEVER chain motion calls in a single command (`&&`, one script, one
   turn) — each motion needs a decision point in front of it. The crash
   happened because step 2 fired 117 ms after step 1 succeeded, with no
   chance to intervene. A motion is authorized ONLY by an explicit
   imperative in the operator's latest message ("home it", "go", "run the
   probe"). A motion mentioned in passing — "take a photo before homing",
   "then we'll traverse", an approved plan that lists it — is context, not
   a command: announce the next motion and WAIT for the word (violated
   2026-09-02: homed off the back of "before homing").
2. **X/Y traverses happen at top gantry height — ALL of them.** Any XY move
   over 1 mm is planned at the safe traverse height, with no exceptions: not
   between probe points, not "local hops" above a measured feature top, not
   at any other "measured safe" height (operator, 2026-09-02: "x/y motion
   over 1mm is never below gantry height"). Retreat Z FIRST, traverse, then
   descend at the destination. The only sub-gantry XY motion is fine
   positioning of <= 1 mm (touch-test nudges, probe march steps). Enforced:
   direct XY moves below `mcpSafeTraverseZ` (default 320) are refused
   without `operator_confirmed_clearance` — which only the operator's
   explicit words authorise, and which is for emergencies, not for planning
   around this law.
3. **Never fabricate clearance.** Only measured numbers or operator-stated
   numbers count for heights. Visual inference from survey frames is for
   FINDING things, not for clearing them — the crash analysis misread the
   same stock's orientation twice from photos. If a height is unknown, ask,
   or measure from a proven-safe height with `probe_point`.
4. **Landmarks are obstacles.** Give bed fixtures a `clearance_z` in
   `set_landmark`; XY paths crossing their box below it are refused.
5. **Contact sensors are crash sensors.** While MCP motion is in flight (every
   procedure move via `moveMachineSettled`, and `move_and_capture`), a trigger
   on a probe channel that no procedure declared as expected trips a CRASH
   alarm: job stopped, connection closed, motion latched until the operator
   clears it. The overtravel switch latches the same way, but ONLY while a
   procedure or MCP motion is in progress (operator rule, 2026-09-04) - the
   operator pressing it by hand with the machine idle just flashes the
   Workspace pill red and logs `overtravel_unarmed`; it is not an alarm. A
   latched alarm shows as an ALARM pill in Workspace -> Connection; the
   operator clears it there (Clear alarm button) or via
   `clear_overtravel_alarm` - never you on your own judgment. Do not
   disconnect the probe feed while anything might move.
6. **Chat is not a motion gate — the staged job is.** Deliberate traverses
   and descents go through `submit_gcode_job` / staged procedures, so the
   operator authorises the literal gcode with a one-time code from the
   confirm page. A "go" in chat is only permission to STAGE; interpretation
   of chat wording is exactly what fails (see law 1's violations). Direct
   move tools are for small vision nudges only. Home (re-prove position)
   before a traverse whenever position state has any doubt — including
   after any motion that wasn't part of the agreed sequence.
7. **Use tools for their purpose, through the MCP surface only.**
   `move_and_capture` is a vision reposition, not a goto — its required
   `reason` is shown to the operator, and rapid sequential direct moves are
   refused (pacing guard). A script looping motion calls is an unsupervised
   procedure without a confirm page: use `survey_bed`, `move_z` batches,
   probing procedures, or `submit_gcode_job` instead. Never touch the
   backend, configstore, or machine directly while the app runs — the
   guards live in the tools.

## Recording rules

- **Machine coordinates only** (operator, 2026-09-02): datums, landmarks and
  measurements are recorded in the machine frame. Work origins are volatile —
  a machine reboot mints a new one — so saved work coordinates are meaningless
  later. Re-verify `originOffset` after every (re)connect.
- **Heartbeat freshness is a precondition**: a stale report (>10 s; period is
  ~1 s) means the connection dropped without the server noticing (seen live —
  5.7 min of stale state served as truth). Motion and staging refuse on
  staleness; an M114 that returns no position text is a dead connection, not
  a success.

## Probe calibration (do once per probe fitting)

`run_tool_setter` with `accept_probe_contact: true` and a conservative
`bit_length_mm` (declare LOW: the floor sits only floor_margin below the
declared expectation, and coarse contact presses at most one coarse step —
fine for a sprung probe). On this rig the setter's switch is softer than the
probe's axial spring, so the setter fires first; either channel confirms.

- Setter surface = machine Z 100.5 (trigger 175.5 with the 75 mm reference).
- Probe effective length = measured trigger Z − 100.5 (measured 71.1 mm,
  2026-09-01, spread 0 across three passes).
- **Any probed surface height = probe contact toolhead Z − probe length.**

## Point probing

`probe_point` marches one axis (±X, ±Y, −Z) from the CURRENT position with a
required `max_travel_mm`; the envelope is anchored to the staging position
and re-verified before motion. Position first (top-height traverse, then
operator-confirmed descent), stage, operator approves, run. Results: median
of lift-and-retest passes, spread as the trust metric. Side probes touch one
tip-radius before the tip centre — correct for it.

Feed latency is TRANSPORT-dependent - read `transport` from
`get_probe_feed_status` first. MQTT (Adafruit IO, hardware-measured): trigger
message ~120-150 ms after physical contact; the default 200-300 ms contact
windows are right, and release messages lag ~1 s, so release checks are patient
by design - never shorten them on MQTT. GPIO (Blinka/U2IF, the Ubuntu box):
readings are polled every 10 ms locally, so `sensor_delay_ms` can drop to
~50 ms and releases are seen immediately; the defaults still work, they are
just slower than necessary. Before any sensor-gated run, sanity-check the
sensors: the Workspace -> Connection pills (Probe / Tool Setter / Setter
Overtravel) must all be green (yellow = no reading or feed down), and
`get_probe_feed_status` must show the channel untriggered with a fresh age. Two
non-error states you may meet: `unavailable: true` / `bridge: not detected` means
the USB sensor bridge is unplugged (the feed retries quietly - tell the operator);
a tool refusing with "the touch probe / tool setter is disabled (Settings -> MCP
Server)" means the operator switched that sensor off in the app - ask, never
bypass. Sensors the operator has disabled have no pill at all.

## Waiting on a job or procedure

Never read server logs to find out whether a job finished. `get_gcode_job_status` carries
the whole story: `job.state` (+ `terminal`), the procedure `result` once stored, and
`events` — state changes, the runner's phase announcements, gcode sent/replies while the
job was active, file-job progress every 5 %. Long-poll it: `wait_ms: 60000` returns as soon
as the state turns terminal or new events arrive past `since_event` (pass back
`next_event_index`), so one call replaces a polling loop. `start_gcode_job` on a procedure
waits up to `wait_ms` (default 25 s) and returns the result if it arrived, otherwise a
`running: true` status - the runner keeps going on the server; long-poll for the result,
never resubmit. If your MCP client times out anyway, the result is still on the record.

`survey_bed`'s `pitch_mm` is a MAXIMUM: each axis is divided evenly into steps no larger
than it (min 20), so rows and columns are uniform and both edges are covered — no more 80 mm
jumps followed by a 10 mm stub. Pick the pitch from what one frame covers.

## Circle probing

`probe_circle` measures a roughly-round vertical feature (post, boss, pin):
N radial marches from evenly spaced azimuths, one staged envelope, then a
least-squares circle fit. It REQUIRES the operator's min/max diameter
estimates (marches start beyond max/2 and abort at min/2 without contact)
and a MEASURED top height. Physics: every contact adds the tip's effective
radius, so the fit yields the COMBINED diameter — feature and tip are
inseparable unless one is known. Direction-dependent residuals expose an
out-of-round tip (the post-unbending health check). Repositioning between
points obeys law 2 in full: lift to the safe traverse height, hop, descend;
a probe touch during a hop or descent latches the CRASH alarm.

## Surface flatness and height maps

Two staged procedures measure a TOP surface with many −Z marches under ONE
operator approval; every commanded move is enumerated on the confirm page,
all numbers are machine coordinates, and every contact Z is TOOLHEAD Z (the
surface is that minus the probe length).

- `probe_surface_path` — N stations along a straight line (`start_x/start_y`
  plus `end_x/end_y` or `dx/dy` + `length_mm`; sampled by `stations` count or a
  MAXIMUM `spacing_mm`). Use it for "is this stock level along Y", "how much
  does the board rise toward the free end", a rotary-mounted flat. Result:
  per-station XYZ (or `no_contact`), Z min/max/range, best-fit line slope (mm
  per 100 mm and degrees, rise over the length), flatness = residual
  peak-to-valley, a text profile.
- `probe_surface_grid` — a serpentine grid over a region (`x_min..y_max` or
  `center_x/center_y` + `size_x_mm[/size_y_mm]`; sampled by a MAXIMUM `pitch_mm`
  or `x_count/y_count`, max 400 stations). Use it for a wasteboard, a pocketed
  box, a log — anything whose height varies in two directions. Result:
  `zMatrix` (rows = ys ascending, cols = xs ascending, null = no contact),
  best-fit plane (tilt X/Y) with per-point residuals and flatness, and a text
  `heightMap` printed with +Y at the top like the bed seen from above.

`start_z_machine` is REQUIRED for both: the toolhead machine Z at which the
first march starts with the tip just above the surface — measured (an earlier
`probe_point -Z`, a previous scan) or operator-stated, never inferred from a
photo (law 3). The runner reaches it law-2 style: raise to the traverse height,
hop at gantry height to station 1, then a guarded 1 mm descent where any
contact latches CRASH.

**The envelope (operator law, 2026-09-05)** — the ONLY exception to motion law
2, valid inside these two procedures only, between consecutive stations only.
The operator's words: "no more than 20mm z safe delta from the top (within a
horizontal change of 60mm)".

| Parameter | Default | Hard limit | Meaning |
|---|---|---|---|
| `z_safe_delta_mm` | 20 | **cap 20**, min 3 | After each station the probe retracts to LAST CONTACT + this and hops at that height. |
| `max_hop_mm` | 60 | **cap 60** | Largest allowed distance between consecutive stations. A spacing/pitch that breaks it is REFUSED at staging, naming the pair — pick a finer pitch; nothing is split for you. |
| `max_drop_mm` | 40 | cap 80 | How far below the previous real contact a station may search. Also bounded by `floor_z_machine` (default `start_z_machine − max_drop_mm`), the deepest Z the scan can ever command — shown on the confirm page. |

Reaching the floor without contact records the station `no_contact` and the
scan CONTINUES with the reference height unchanged (a pocket, a hole, an edge
overshoot); the first station finding nothing aborts. Hops run in ≤ 10 mm
sensor-checked segments expecting NO contact — a touch during a hop means the
surface rose more than `z_safe_delta_mm` and latches the CRASH alarm (law 5).
Completion and abort both raise to the traverse height. Never ask for the caps
to be widened and never approximate a scan with `probe_sequence` hops at a
"measured safe" height — that is exactly what law 2 forbids. On the GPIO
transport, `sensor_delay_ms: 50` and `coarse_step_mm: 2` on a known-flat surface
roughly halve the time per station.

## Bed survey

`survey_bed` at top gantry height: serpentine grid, one settled frame per
waypoint, saved to disk with a machine-position index. Cover the FULL
reachable envelope (`x_max` etc. beyond nominal size when reachable — the
camera on this rig looks ~90–150 mm in −X of the toolhead, so the far-X
column is the only view of the bed centre-right). Read the frames from disk;
landmarks near each position are the identities the operator already stated.
