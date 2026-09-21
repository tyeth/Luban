---
name: cnc-probing
description: "Measure work with the spindle touch probe via the Luban MCP tools — probe_point, probe_vector, probe_sequence, probe_circle, probe_surface_path/grid flatness scans, probe_stock_outline, probe_program (many ops, one approval), run_tool_setter with accept_probe_contact — under the motion laws of the cnc-motion-rules skill (load that first). Use whenever the user wants to probe stock, find surfaces/edges or an unknown height, check flatness or map a surface, locate a crown or a block, or calibrate the touch probe. CAM probing programs (run_probing_gcode) live in references/cam-probing.md."
---

# CNC probing: the touch probe

> **Load `cnc-motion-rules` first; do not plan motion without it.** The eight laws, the coordinate
> doctrine, `get_position.reliability`, the canonical calls and the two-op find-then-scan program
> live there (§8). This file holds only what is specific to probing. The bed camera survey lives
> in `cnc-visual-alignment`.

## Jig facts for this rig (read `get_stored_state`; these are for orientation only)

| Item | Value | Note |
|---|---|---|
| Traverse height | machine Z328 | every hop; every procedure ends here |
| Probe effective length | `geometry.probe.effectiveLength` | never a remembered figure; measure if unset |
| Tool setter | surface machine Z100.5; trigger 175.5 with the 75 mm reference | `run_tool_setter` |
| Rotary axis | `geometry.rotary` (axisX ≈ 170, axisZ physical ≈ 112) | B-dependent stock heights |
| Chuck jaws | reach ~Y269 | a `keep_out` volume for programs |
| Tailstock | inside the `rotary-axis` box, Y < ~110; height UNMEASURED | measure it (see below), then `set_landmark` |

## The fastest lawful shape for almost every request

**Find the top, then scan it — one `probe_program`, one approval** (the JSON is in
`cnc-motion-rules` §8). The first op is a `sequence`: `hop` to the station at the traverse
height, then a `probe` with `dz: -1` and a generous `max_travel_mm` (up to 150; the floor must
keep the tip off the bed and above the axis if a cylinder is expected). The second op references
`<id>.<probe>.z` for `start_z_machine` (plus 2–3 mm) and `expected_z_machine`. Separate
`probe_point` → `probe_surface_path` approvals cost the operator a round-trip and buy nothing.

Which second op:

| The operator wants… | Op | Notes |
|---|---|---|
| one height | just the `sequence` | report toolhead Z and physical = Z − probe length |
| a profile along a line, a crown, "is it level along Y" | `surface_path` | crown X = symmetry centre, see "Reading a profile" |
| "is it flat", a height map, a pocketed box | `surface_grid` | plane residual peak-to-valley + tilt |
| where a block is and how big | `stock_outline` | needs an estimated centre and size |
| a VERTICAL post/boss/hole diameter and centre | `probe_circle` | vertical-axis features only — a cylinder lying along Y is a `surface_path` across it |
| edges of stock of estimated size | `sequence` side marches | start outside the largest size; long travel is cheap |

**Unknown Z, no stored axis, no operator number** (the common "scan that thing" case): the only
lawful route is the sensor-gated −Z march from the traverse height inside the program above.
It costs about `max_travel / coarse_step` sensor windows (~0.3 s each): ask for an approximate
height in your one question batch and shorten it — a long limit costs time, not safety.

**Measuring inside an unmeasured region** (the tailstock): a `keep_out` bans SCAN geometry from
entering a volume; it does not ban deliberately measuring the thing. The sanctioned first
measurement is exactly the sequence above at the operator-named X/Y; record the result with
`set_landmark` + `clearance_z`, and say the keep-out is retired for that Y band only.

## Point, vector and circle probing

`probe_point` marches one axis (±X, ±Y, −Z) from the CURRENT position with a required
`max_travel_mm`; `probe_vector` marches an arbitrary direction. Side probes touch one tip radius
before the tip centre — correct for it. Results: median of lift-and-retest passes, spread as the
trust metric. `probe_circle` (N radial marches + Kasa fit) REQUIRES the operator's min/max
diameter bounds and a MEASURED top height; OUTSIDE fits = feature + tip diameter, INSIDE (hole)
fits = feature − tip diameter.

Feed latency is TRANSPORT-dependent — read `transport` from `get_probe_feed_status`. GPIO
(Blinka/U2IF, the Ubuntu box): 10 ms polling, `sensor_delay_ms: 50` is ample. MQTT: ~120–150 ms
trigger latency, keep the 200–300 ms defaults and the patient release checks. Before any run
the Workspace → Connection pills (Probe / Tool Setter / Setter Overtravel) must be green;
`unavailable: true` = the USB bridge is unplugged (tell the operator); "disabled (Settings → MCP
Server)" = the operator switched that sensor off — ask, never bypass.

## Surface flatness and height maps

Both procedures measure a TOP surface with many −Z marches under ONE approval; every number is
machine coordinates and every contact Z is TOOLHEAD Z.

- `probe_surface_path` — N stations along a line: `start_x/start_y` + `end_x/end_y` (or
  `dx/dy` + `length_mm`); `stations` (2–400; above 60 the confirm page warns about duration and
  event budget) or `spacing_mm` (a MAXIMUM; stations = `floor(length / spacing) + 1`, both
  ends included — 164→176 at 0.2 is 61 stations, 164.1→175.9 is 60). Result: per-station XYZ or
  `no_contact`, Z min/max/range, best-fit line slope, flatness = residual peak-to-valley.
- `probe_surface_grid` — serpentine grid (`x_min..y_max` or `center_x/center_y` + `size_x_mm/size_y_mm`;
  `pitch_mm` maximum or `x_count/y_count`, max 400 stations). Result: `zMatrix`, best-fit plane
  (tilt X/Y), per-point residuals, flatness, a text `heightMap` with +Y up.

`start_z_machine` is REQUIRED: the toolhead Z where the first march starts — measured (the
find-op reference, a `probe_point -Z`, an earlier scan) or operator-stated; never a guess and
never a rough estimate when a march can measure it. `expected_z_machine` gives station 1 its
slow zone. The runner reaches station 1 law-2 style (raise, hop at 328, segmented guarded
descent), then works the envelope.

**Envelope (operator law, 2026-09-05)** — the one exception to law 2, between consecutive
stations only. Lowering a value is always allowed; raising past a cap is refused.

| Parameter | Default | Cap | Meaning |
|---|---|---|---|
| `z_safe_delta_mm` | 20 (conservative; use 5 on a surface known to vary < 5 mm between stations) | 20, min 3 | retract above the LAST CONTACT for the hop |
| `max_hop_mm` | 60 | 60 | largest station-to-station distance; check `span / (stations − 1) ≤ 60` before staging |
| `max_drop_mm` | 40 | 80 | how far below the previous contact a station may search; also bounded by `floor_z_machine` |
| `hop_mode` | `guarded` | — | see `cnc-motion-rules` §4: spacing × slope ≪ delta → guarded; steps/pockets/unknown → `stepped` (+ `hop_lift_mm`, default 2) |
| `coarse_step_mm` | 1 | 1 | also the worst-case press; station 1 is capped at 1 mm unless `expected_z_machine` is given |

Contact during a `guarded` hop is a collision already in progress (detected at the end of a ≤ 10
mm segment); a `no_contact` station records and the scan continues; the first station finding
nothing aborts. Completion and abort both raise to 328. `stop_gcode_job` stops at the next step
boundary and keeps every completed station under `result` with `ending` saying why.

**Event budget — compute it the moment you know the station count.** The job keeps
`mcpJobEventLimit` events (default 2000, `get_mcp_diagnostics → buffers`); beyond it the log
keeps the first 20 and the newest tail, while `result` is never trimmed. Cost ≈ 100 + stations ×
(110 at `z_safe_delta_mm` 20, 60 at 5); a blind −Z find adds ~3 events per mm of travel. When
the estimate exceeds the limit, ask the operator to raise it (Settings → MCP Server → Diagnostic
buffers, or `LUBAN_MCP_JOB_EVENT_LIMIT`) in the same question batch as everything else; if they
decline, stage anyway and read `result`.

**Reading a profile.** `summary.highestAt.x` is resolution-limited to half a station and
ill-conditioned on a gentle crown. For "where is the axis", prefer the symmetry centre (the
midpoint of the two flank stations at each Z level, or of matching plateaus) — a symmetric tip
preserves the crown's X and offsets only the height by the tip radius, so crown-X answers survive
an unknown tip radius while height answers do not. Quote ± the station pitch / 2 at least.
For "is it flat", report the plane residual peak-to-valley and the tilt, every Z as toolhead Z
with physical = Z − probe length, and the B angle.

**Speed.** Read `result.timing` (or `get_job_timing`). The coarse walk down from the hop height
dominates; on stock known to vary < 5 mm use `z_safe_delta_mm: 5`, `confirm_passes: 2`,
`sensor_delay_ms: 30–50` on GPIO. Never raise the coarse feed yourself.

## Whole-stock programs (`probe_program`)

Ops: `rotate_b` (absolute B; refused unless the head is at/above the traverse height;
`swept_radius_mm` adds the tip-outside-the-cylinder check), `surface_path`, `surface_grid`,
`sequence`, `stock_outline`, `capture {settle_ms?, label?}` (NO motion: one frame from wherever
the previous op left the head, stamped with position and B, saved on the job record — read it
back with `get_frame {frame_id}` or `get_frame {file}`), `home {}` (machine home, the LAST op
only; it also homes B — the page says so), and `group {for_b: [0, 90, 180, 270], ops}` which
runs its inner ops once per angle (`${b}` in strings; a `capture` may sit inside, a `home` may
not). Every probing op ends raised at 328; a program that ends with `home` ends AT HOME.
**Look at both sides of a rotary part under one click**: `sequence {hop x,y}` → `capture` →
`rotate_b 180` → `capture` → `home`. References (grammar in
`cnc-motion-rules` §8) may sit in any numeric argument; bounds are mandatory (law 3); order ops
so every reference points backwards; `on_fail: "skip"` lets a non-critical op fail without
ending the program (a requested stop always ends it). Staging REFUSES a program whose event
estimate exceeds the limit and tells you the number to ask for.

`sequence` steps: `{"kind": "hop", "x", "y"}` (at the hop height), `{"kind": "descend", "z"}`
(guarded segments then 1 mm sensor-checked steps), `{"kind": "probe", "name", "dx"|"dy"|"dz",
"max_travel_mm", "on_miss"?}`. Results read as `<opId>.<name>.x|y|z` (contactMachine).

Geometry is NEVER a prerequisite: a program that references only its own earlier ops needs
nothing stored. Only `axis.*` references need the rotary axis and probe length — measure and
store them yourself (`set_probe_geometry`) or write the program without them. Rotary stock is
B-dependent (square stock ~12 mm higher at B90); every result carries its B.

- **Derive, don't guess**: `{"mid": ["s0.west.x", "s0.east.x"]}` is the stock centre;
  `{"diff": ["s0.east.x", "s0.west.x"], "scale": 0.5, "plus": "axis.z_contact"}` the B90 face
  height. Name probes `top`, `west*`, `east*`, `end*` and `result.derived` (thickness per face
  pair, centring, width, centre X, yaw, end slope) is computed — planning inference, never a
  clearance.
- **Keep-out for this clamping**: `keep_out: [{"name", "machine": {"x0", "y0", "x1", "y1"},
  "clearance_z"}]` — a VOLUME nothing enters. Stored landmarks are CROSSING obstacles (a hop or
  march wholly inside one is allowed). Never shrink a landmark to make a plan pass.
- **Cylinders across the axis**: `surface_path` with `expected_profile: {"circle": {"center_x",
  "center_z_contact", "radius"}}` (stations > 0.7 R off the axis are refused); along the axis a
  plain path suffices.
- **Side marches on stock of estimated size**: start outside the largest size, `max_travel_mm`
  covers the whole uncertainty, first probe at mid-length; a miss records `no_contact` and the
  sequence continues (`on_miss` default); a later reference to it refuses that op.

**Block on the bed or in the chuck: `probe_stock_outline`.** Estimated centre + size, operator
`start_z_machine` / `floor_z_machine`; finds the top at `top_points` (highest wins, holes
ignored), marches the sides from `overextend_mm` outside at `top − side_depth_mm`, returns
`centerMachine`, `sizeMm` (centre-to-centre), `sizePhysicalMm` (minus tip), `yawDeg`. Do NOT
shorten `side_max_travel_mm` (default 25) to save time — a first outline missed a face 13.6 mm
away with an 11 mm march. Also an op kind in `probe_program`.

Hardware test order for a new program: B0 half without rotations, then one rotation, then the
whole program — and compare `derived` with the operator's calipers.

## Probe calibration (once per probe fitting)

`run_tool_setter` with `accept_probe_contact: true` and a conservative `bit_length_mm`
(`bit_length_mm` is the fitted tool's PROTRUSION in mm — a length, never a diameter; declare
LOW). Setter surface = machine Z100.5, so effective length = measured trigger Z − 100.5; store
it with `set_probe_geometry`. **Any probed surface height = contact toolhead Z − probe length.**
The run ends with the head raised straight up to the traverse height (machine Z328, reported as
`result.finalZ`), never at its start height — the next hop starts from there.

## Waiting on a job or procedure

Never read server logs. `get_gcode_job_status {job_id, wait_ms: 110000, since_event}` carries
the whole story — state, `ending` (why it ended), the stored `result`, and events (runner
phases, gcode traffic, `position-recheck`, `heartbeat_frame_flip`, `slow_step`). Pass back
`next_event_index` as `since_event` or the poll returns on the first existing event. A
`position-recheck` note or a `get_position` of `awaiting-resync` during a march is the server
protecting you, not a fault. If a scan aborts saying the toolhead is BELOW the descent target,
verify with `query_firmware_position` before re-staging.

**Stopping.** `stop_gcode_job {job_id}` on a running procedure stops at the next step boundary
(≤ 1 mm or one sensor window), raises to 328, and ends the job `stopped` with everything measured
so far in `result` and `ending.kind: stopped-by-agent`. It is not an emergency stop — the crash
guard and the machine's own stop are.
