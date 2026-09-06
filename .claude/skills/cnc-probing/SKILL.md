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
   operator authorises the literal gcode by clicking approve on the confirm
   page. After staging, call `start_gcode_job` with `wait_for_approval_ms`
   (e.g. 110000): it starts the moment they click, with nothing to copy, and
   returns `approved: false, timed_out: true` if they have not clicked yet -
   call again, never restage. If the operator has hand-off disabled, they
   relay the one-time code as `confirm_token` instead. A "go" in chat is only permission to STAGE; interpretation
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
`next_event_index` is a sequence number, not an array index: the log keeps 2000 events and
paging stays valid when it trims.

**Stopping a procedure.** `stop_gcode_job {job_id}` on a running procedure (probe_*,
probe_program, tool setter, survey) is a cooperative stop: the runner finishes the step in
flight (<= 1 mm or one sensor window), raises to the traverse height and ends the job in
state `stopped` with everything measured so far in `result` (stations, contacts,
completed ops, `derived`). The call waits up to `wait_ms` (default 20 s) and answers
`{ok: true, stopped | stopping}`; if `stopping`, long-poll the status. It is NOT an
emergency stop - the crash guard and the operator's machine stop are that. Stopping a
program stops the whole program regardless of `on_fail`. A procedure that has not
started yet is withdrawn by the same call.

When a procedure is slow or aborts, the evidence is already in its events - do not grep
server logs. `gcode` events carry `execMs` (send to controller reply) and `idleMs` (previous
reply to this send; engine + sensor window only, so > 750 ms inside a job also raises a
`slow_step` event). `event_loop_stall`, `heartbeat_gap`, `heartbeat_frame_flip`,
`sense_overrun` and `position-estimated` events name the server-side cause when there is
one; `get_mcp_diagnostics` has the totals. The machine heartbeat is a 2 s poll: a
`position-recheck` note saying the record or a machine-frame (G53 window) report was used
is normal, not a fault - the runner verified every move against the controller's echo.
Likewise a `get_position` warning that a zero work-origin offset was set aside (a
G53-window beat reports offsets as 0,0,0 with machine coordinates in `pos`) is the server
protecting you: machine coordinates stay right, `originOffsetSource` reads `cached`. Only a
zero offset that persists for 3 beats is believed. If a scan aborts saying the toolhead is
BELOW the descent target, do not re-stage from a lower `start_z_machine` - verify the
position with `query_firmware_position` first; the check exists because one bad beat once
read Z320 as Z-8.

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
hop at gantry height to station 1, then descend in ≤ 5 mm segments to 20 mm
above `start_z_machine` under the asynchronous crash guard (a probe touch latches
CRASH and the next segment is refused), then a guarded 1 mm descent with a serial
sensor check after each step. Every procedure descent is segmented like this
(operator law: a single long move toward the work cannot be stopped once sent),
and the segments do not wait on the heartbeat - expect `position-estimated` notes.

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
"measured safe" height — that is exactly what law 2 forbids.

**Coarse press.** `coarse_step_mm` is also the worst-case press into the probe:
the controller finishes a step before the runner sees the sensor. From station 2
the runner uses the previous contact as the expected height and switches to fine
steps `slow_zone_mm` (default 1) above it — press one fine step. Station 1 has no
neighbour, so its coarse step is capped at 1 mm unless you pass
`expected_z_machine` (a MEASURED neighbouring contact — a `probe_point -Z`, a
`probe_sequence` centre, an earlier scan; never a guess, law 3). Each station
result says `approach: slow-zone | coarse-contact` and `worstPressMm`. `coarse_step_mm`
is capped at 1 mm in surface scans (operator law: never 2; 0.5–1). On the GPIO
transport `sensor_delay_ms: 50` is ample.

## Whole-stock programs (one approval)

`probe_program` strings operations into ONE approved job: `rotate_b` (absolute B;
the runner refuses it unless the toolhead is at/above the traverse height),
`surface_path`, `surface_grid` and `sequence` with their usual arguments. Where a
later op needs a number only an earlier op can measure, pass a REFERENCE with
operator-approved bounds - `expected_z_machine: {"from": "c90.top.z", "between":
[200, 240]}` (sequence op `c90`, probe named `top`), `start_z_machine: {"from":
"c90.top.z", "plus": 7, "between": [205, 250]}`, a sequence `descend` `z: {"from":
"ns90.summary.zMean", "minus": 7, "between": [...]}`. Bounds are required (law 3):
the confirm page shows them, and the runner refuses the op outside them, stops the
program raised and keeps earlier results under `result.ops`. Order ops so every
reference points backwards; `on_fail: "skip"` lets an overtravel-type op fail
without ending the program. A four-face survey is `rotate_b 90 → centre sequence →
N-S path → W-E path → sides sequence → rotate_b 180 → …`; budget the event log
(≈ 100 + stations × 120 per scan op) before staging and use
`wait_for_approval_ms` to start. Staging REFUSES a program whose estimate exceeds the
job event limit and tells you the number to ask the operator for.

**New stock, nothing known but the jig.** Geometry is NEVER a prerequisite: a program
that references only its own earlier ops (any B0-only, stationary or off-rotary survey)
needs nothing stored, so stage it. Only a reference to `axis.*` needs the rotary axis
and probe length; check `get_stored_state → geometry`, and if they are unset, MEASURE
them and store them yourself with `set_probe_geometry` (axis Z = mean of an
opposite-face pair minus the probe length, axis X = mid of a side pair, probe length
from `run_tool_setter accept_probe_contact`) - or write the program without `axis.*`.
Never ask the operator to type numbers into a settings pane, and never type them into
your program as constants. Stock size is a property of the stock, not the jig: pass the
largest reach of THIS stock as `swept_radius_mm` on `rotate_b` if you want the
tip-outside-the-cylinder check. Then:

- **Find the top** without knowing the height: a `sequence` whose `descend` is
  `{"from": "axis.z_contact", "plus": <largest possible radius + 5>, "between": [...]}`
  and whose probe is `dz: -1, max_travel_mm: <that radius + 10>` (segmented descent, 1 mm
  coarse in the last band). Without `axis`, descend to an operator-stated Z instead.
- **Derive, don't guess**: `{"mid": ["s0.west.x", "s0.east.x"], "between": [...]}` is the
  stock centre; `{"diff": ["s0.east.x", "s0.west.x"], "scale": 0.5, "plus":
  "axis.z_contact", "between": [...]}` is the B90 face height (axis + half-width);
  `{"min"|"max": [...]}` over several paths. References may sit anywhere in an op's
  arguments (`steps[].z`, `start_x`, `expected_profile.circle.center_x`). Name your
  probes `top`, `west*`, `east*`, `end*` and the result's `derived` section (thickness
  per face pair, centring, width with tip, centre X, yaw, end slope) is computed for
  you - it is planning inference, never a clearance.
- **Keep-out for this clamping**: pass `keep_out: [{"name": "chuck jaws", "machine":
  {"x0", "y0", "x1", "y1"}, "clearance_z"}]` (toolhead Z) - a VOLUME nothing enters, not
  even a descent column. Stored landmarks are CROSSING obstacles: they forbid traversing
  into or out of their box low, and a hop, column or march wholly inside one (probing
  the stock inside the rotary-axis landmark) is allowed - the operator approves it on
  the page. So never ask to delete or shrink the rotary landmark to make a scan pass; if
  a check names it, the plan really does enter or leave the rotary region low. Both are
  checked at staging AND when references resolve; a hit names the step. Jaws reach
  ~Y269 on this jig (measured 2026-09-02); the tailstock bracket stands above the stock
  below ~Y110 - use those as `keep_out` volumes, with the operator's confirmation.
- **Cylinders**: `surface_path` with `expected_profile: {"circle": {"center_x": {"from":
  "axis.x", ...}, "center_z_contact": {"from": "axis.z_contact", ...}, "radius": <operator
  bound>}}` - each station's slow zone and drop band follow the circle; stations more than
  0.7 R off the axis are refused. Locate the crown with `summary.highestAt.x`.
- **Repeat per rotation**: `{"id": "faces", "kind": "group", "for_b": [0, 90, 180, 270],
  "ops": [...]}` runs the inner ops once per angle after a `rotate_b`; write `${b}` in
  ids/names/paths (or leave ids plain and they get `_b<angle>`).

- **Side marches on stock of estimated size**: start each march OUTSIDE the largest
  size the stock could be, set `max_travel_mm` to cover the whole uncertainty (the
  travel is approved, so a long limit costs time, not safety), and put the first side
  probe at mid-length, never near a corner. A march that reaches its limit records
  `status: "no_contact"` and the sequence CONTINUES (`on_miss` default) - a miss is the
  measurement "nothing within N mm". Only pass `on_miss: "abort"` when a later step is
  unsafe without that contact. A reference to a missed probe refuses its op instead.

**Block on the bed or in the chuck: `probe_stock_outline` (centre from an estimate).**
Give it the estimated centre and size, the operator's `start_z_machine` /
`floor_z_machine`, and it finds the top at `top_points` (default 3; the highest wins, a
sample > `hole_tolerance_mm` lower is a hole and ignored - so a first probe in a drilled
hole cannot define the surface), then marches the sides from `overextend_mm` outside the
estimate at `top - side_depth_mm`, `points_per_side` per side, skipping along each face at
`side_standoff_mm` off the last contact (a projection bumps the probe outward, never
aborts), and returns `centerMachine`, `centerWork`, `sizeMm` (centre-to-centre),
`sizePhysicalMm` (MINUS the tip diameter - external faces lie one tip radius inside their
contacts; the centre needs no correction), `yawDeg`. Use it instead of hand-built
sequences whenever the job is "where is this block and how big is it". Defaults are
deliberately generous: `points_per_side` 3 (midpoint first), `side_max_travel_mm` 25,
`overextend_mm` 5, `side_depth_mm` 2. Do NOT shorten the travel to save time: the first
outline on the box marched 11 mm and missed a face 13.6 mm away because the centre estimate
was 3.85 mm off - travel must cover overextend + width uncertainty + centre uncertainty +
margin, and a march that finds nothing is only lost time. For top scans over stock that may
be narrow or offset from the estimate, keep `spacing_mm` at 5 or less. Also an op kind
`stock_outline` in `probe_program`. For surface scans over uneven or holed stock use
`hop_mode: "stepped"` with `hop_lift_mm` (contact lifts and continues) instead of a big
`z_safe_delta_mm`.

**Landmarks vs the traverse height.** The rotary landmark says clearance 328; the traverse
height is 320. Hops at the traverse height are lawful and exempt from crossing landmarks;
so are marches (they stop on contact). A refusal naming a landmark therefore means a LOW
hop or a descent column enters or leaves its box - fix the plan, do not touch the landmark.

Hardware test order for a new program: B0 half without rotations first, then one
rotation, then the whole program - and compare `derived` with the operator's calipers.

**Speed.** Read `result.timing` (or `get_job_timing`) after a scan instead of mining
events: per command kind it gives count, feeds, distance, controller time vs motion
time vs overhead, idle and sensor windows, plus per-station wall time. The coarse walk
down from the hop height is the biggest cost (~19 of 30 commands per station at
`z_safe_delta_mm` 20), so on stock known to vary < 5 mm between stations use
`z_safe_delta_mm: 5`, `confirm_passes: 2` and `sensor_delay_ms: 30` on GPIO (an
11-station path ~400 s → ~170 s). Never raise the coarse feed yourself: impact speed is
the operator's call.

**Event-log budget — check it BEFORE staging a large scan.** The job keeps at most
`mcpJobEventLimit` events (default 2000; `get_mcp_diagnostics` → `buffers` and the
Settings pane show the live value). Beyond that the log keeps its first 20 events
and the newest tail — `eventsTotal` > `eventCount` on the job tells you it trimmed.
The procedure `result` (stations, fit, height map) is stored separately and is
never trimmed; only the step-by-step evidence is. Measured cost (8-station path,
`z_safe_delta_mm` 20, coarse 1, fine 0.1, 3 confirm passes: 763 events):

| Item | Events |
|---|---|
| Fixed: approval, raise, traverse, 20-step guarded descent, final raise | ≈ 100 |
| Per station (coarse ladder over the 20 mm retract ≈ 19 steps, ≈ 10 fine, 3 confirm cycles, hop segments, readings, diagnostics) | ≈ 90–120 |
| Same with `z_safe_delta_mm` 5 on a known-flat surface (4 coarse steps) | ≈ 60 |

So `events ≈ 100 + stations × 110` (use 120 to be safe): the default 2000 covers
about 15 stations; a 5 × 5 grid needs ~3000, a 10 × 10 grid ~12 000, the 400-station
maximum ~48 000. There is deliberately no MCP tool to change the limit: when the
estimate exceeds the live value, ASK the operator to raise it (Settings → MCP Server →
Diagnostic buffers, or `LUBAN_MCP_JOB_EVENT_LIMIT`, range 400–100 000, applied
immediately) BEFORE you stage, and say the number you need. If they decline, stage
anyway and read the result from `result`, not the events.

## Bed survey

`survey_bed` at top gantry height: serpentine grid, one settled frame per
waypoint, saved to disk with a machine-position index. Cover the FULL
reachable envelope (`x_max` etc. beyond nominal size when reachable — the
camera on this rig looks ~90–150 mm in −X of the toolhead, so the far-X
column is the only view of the bed centre-right). Read the frames from disk;
landmarks near each position are the identities the operator already stated.
