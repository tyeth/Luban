---
name: cnc-probing
description: "Measure work with the spindle touch probe and the whole-bed camera survey via the Luban MCP tools (probe_point, survey_bed, run_tool_setter with accept_probe_contact) — including the motion laws written in the aftermath of a probe-destroying crash. Use whenever the user wants to probe stock, find surfaces/edges, survey the bed, or calibrate the touch probe."
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

## Bed survey

`survey_bed` at top gantry height: serpentine grid, one settled frame per
waypoint, saved to disk with a machine-position index. Cover the FULL
reachable envelope (`x_max` etc. beyond nominal size when reachable — the
camera on this rig looks ~90–150 mm in −X of the toolhead, so the far-X
column is the only view of the bed centre-right). Read the frames from disk;
landmarks near each position are the identities the operator already stated.
