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
2. **X/Y traverses happen at top gantry height.** Retreat Z (operator-
   confirmed `move_z`) to the safe traverse height FIRST, traverse, then
   descend at the destination. Enforced: direct XY moves below
   `mcpSafeTraverseZ` (default 320) are refused without
   `operator_confirmed_clearance` — which only the operator's explicit words
   authorise.
3. **Never fabricate clearance.** Only measured numbers or operator-stated
   numbers count for heights. Visual inference from survey frames is for
   FINDING things, not for clearing them — the crash analysis misread the
   same stock's orientation twice from photos. If a height is unknown, ask,
   or measure from a proven-safe height with `probe_point`.
4. **Landmarks are obstacles.** Give bed fixtures a `clearance_z` in
   `set_landmark`; XY paths crossing their box below it are refused.
5. **Contact sensors are crash sensors.** During any motion, a trigger on a
   probe channel that no procedure declared as expected trips a CRASH alarm:
   job stopped, connection closed, motion latched until the operator clears
   it. Do not disconnect the probe feed while anything might move.
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

Feed latency (hardware-measured, Adafruit IO): trigger message ~120–150 ms
after physical contact; 200 ms contact windows are right. Release messages
lag ~1 s — release checks are patient by design; never shorten them.

## Bed survey

`survey_bed` at top gantry height: serpentine grid, one settled frame per
waypoint, saved to disk with a machine-position index. Cover the FULL
reachable envelope (`x_max` etc. beyond nominal size when reachable — the
camera on this rig looks ~90–150 mm in −X of the toolhead, so the far-X
column is the only view of the bed centre-right). Read the frames from disk;
landmarks near each position are the identities the operator already stated.
