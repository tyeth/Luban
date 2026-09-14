---
name: cnc-motion-rules
description: "The standing motion and coordinate rules for the Snapmaker A350 CNC driven through the Luban MCP tools. Load this FIRST, before planning, staging, describing or reasoning about ANY machine motion or position: moves, jogs, traverses, homing, Z changes, probing, tool changes, staged gcode jobs, clearance heights, work origins, machine coordinates, G53/G54/G90/G91, the heartbeat position or its reliability. The other CNC skills (cnc-probing, cnc-visual-alignment, tool-change) assume these rules and point here. Written after a probe-destroying crash (2026-09-01) and a work-frame G0 Z0 job that reached the confirm page with no warning (2026-09-12)."
---

# CNC motion rules (operator law — the canonical copy)

Everything here is operator law, not model judgment. Two incidents wrote it:

- **2026-09-01** — an XY traverse at a fabricated "clearance" height drove the touch probe
  into the rotary stock and destroyed it. Laws 1–7 are the aftermath.
- **2026-09-12** — an agent staged `G90 / G0 Z0 / G0 X… Y…` as a transit job. `Z0` was in the
  WORK frame (whatever the controller had selected), the validator reported `Z 0 — 0, warnings:
  none`, and the operator could not tell from the confirm page which frame it meant. Nothing
  moved — the operator refused it — but every guard had passed. Section 2 is the aftermath.

If a tool refuses you, it is this document catching you. Fix the plan; never work around it.

## 0. Before ANY motion — the checklist

Run through this every time, in order, and say the answers out loud in your reply:

1. **State.** `get_connection_status` connected. `get_position`: `reliability` is `verified`,
   `heartbeat` or `cached-offset` — never `awaiting-resync` or `stale`; `warnings` empty;
   `isHomed` true; `machineStatus` idle. If in doubt, `query_firmware_position` (liveness) and
   `get_stored_state` (landmarks, limits, geometry). Not homed → law 1 applies to homing too,
   and homing also homes B: stock on the rotary rotates — warn the operator first.
2. **Frame.** Every number you are about to use is MACHINE frame, or you have converted it and
   written the conversion down. Every staged job declares its frame (§2). No bare `Z`.
3. **Height.** Any XY move over 1 mm happens at the traverse height — machine Z328 (home) —
   after a Z retreat. Sub-gantry XY is ≤ 1 mm fine positioning only.
4. **Obstacles.** `get_stored_state → landmarks`: does the path cross a box below its
   `clearanceZ`? The tailstock is inside the `rotary-axis` box and its height is UNMEASURED.
5. **Tool.** A tool or the probe is ALWAYS in the spindle. Where is its tip at the Z you plan?
6. **Authority.** An explicit imperative in the operator's LATEST message, then a staged job
   they click Approve on. Chat is not a gate; an approved plan is not a command.

## 1. The seven motion laws

1. **One motion per instruction, and no inferred approvals.** When the operator enumerates
   steps, execute exactly the step they name and stop. NEVER chain motion calls in a single
   command (`&&`, one script, one turn) — each motion needs a decision point in front of it.
   The 2026-09-01 crash happened because step 2 fired 117 ms after step 1 succeeded, with no
   chance to intervene. A motion is authorised ONLY by an explicit imperative in the operator's
   latest message ("home it", "go", "run the probe"). A motion mentioned in passing — "take a
   photo before homing", "then we'll traverse", an approved plan that lists it — is context,
   not a command: announce the next motion and WAIT for the word (violated 2026-09-02: homed
   off the back of "before homing").
2. **X/Y traverses happen at top gantry height — ALL of them.** Any XY move over 1 mm is
   planned at the traverse height (`mcpSafeTraverseZ`, default **machine Z328** = home Z),
   with no exceptions: not between probe points, not "local hops" above a measured feature
   top, not at any other "measured safe" height (operator, 2026-09-02: "x/y motion over 1mm is
   never below gantry height"). Retreat Z FIRST, traverse, then descend at the destination.
   The only sub-gantry XY motion is fine positioning of ≤ 1 mm (touch-test nudges, probe march
   steps) and the in-procedure envelopes in §4, which the operator approves on the confirm
   page as part of that one tool call — the NEXT motion starts from a full retreat again.
   Enforced: direct XY moves below `mcpSafeTraverseZ` are refused without
   `operator_confirmed_clearance`, which only the operator's explicit words authorise and which
   is for emergencies, never for planning around this law.
3. **Never fabricate clearance.** Only measured numbers or operator-stated numbers count for
   heights. Visual inference from camera frames is for FINDING things, not for clearing them —
   the crash analysis misread the same stock's orientation twice from photos. If a height is
   unknown, ask, or measure from a proven-safe height with `probe_point`.
4. **Landmarks are obstacles.** Give bed fixtures a `clearance_z` in `set_landmark`. Stored
   landmarks are CROSSING obstacles: an XY segment that enters or leaves their box below the
   clearance is refused — at staging for procedures, at call time for direct moves. A hop at
   Z328 passes because 328 is at or above every clearance, not because it is exempt; an
   in-procedure hop below 328 is checked like any low segment. A program's `keep_out` is a
   VOLUME: nothing enters, not even a descent column. Never delete or shrink a landmark to make
   a plan pass.
5. **Contact sensors are crash sensors.** While MCP motion is in flight, a trigger on a probe
   channel that no procedure declared as expected trips a CRASH alarm: job stopped, connection
   closed, motion latched until the operator clears it (Workspace → Connection → Clear alarm,
   or `clear_overtravel_alarm` on their words — never yours). The overtravel switch latches the
   same way, but ONLY while a procedure or MCP motion is in progress (operator rule,
   2026-09-04); pressed by hand with the machine idle it just flashes the pill. Do not
   disconnect the probe feed while anything might move.
6. **Chat is not a motion gate — the staged job is.** Deliberate traverses and descents go
   through `submit_gcode_job` / staged procedures, so the operator authorises the literal
   gcode by clicking Approve on the confirm page. After staging, call `start_gcode_job` with
   `wait_for_approval_ms` (e.g. 110000); `approved: false, timed_out: true` means call again,
   never restage. With hand-off disabled, they relay the one-time code as `confirm_token`. A
   "go" in chat is permission to STAGE. Home (re-prove position) before a traverse whenever
   position state has any doubt — including after any motion that wasn't part of the agreed
   sequence.
7. **Use tools for their purpose, through the MCP surface only.** `move_and_capture` is a
   vision reposition, not transport — its `reason` is shown to the operator, travel is capped
   (`mcpMaxJogDistance`, 100 mm, a safety cap on the non-interlocked path that the assistant
   never raises), and rapid sequential direct moves are refused. Transport is a staged job at
   the traverse height. Z goes through `move_z` (one confirm per step, `coordinate_system:
   "machine"`). A script looping motion calls is an unsupervised procedure without a confirm
   page. Never touch the backend, configstore, or machine directly while the app runs — the
   guards live in the tools.

## 2. Coordinate doctrine

**Two frames exist on the controller.** `G53` selects the MACHINE frame (home = X−19 Y342
Z328; the X switch sits 19 mm left of work-area zero); `G54`–`G59` select numbered WORK
workspaces whose origin the operator sets. The heartbeat reports position in the *currently
selected* workspace, and `machine = work − originOffset` is Luban's display convention —
NOT a fact you may apply to a single beat by hand (§3).

**Agents plan, stage, record and quote in MACHINE coordinates.** Say "machine" every time.
Landmarks, tool-setter config, probe results and the geometry store are all machine frame.

**The work origin belongs to the operator, Luban and the firmware — not to you.** It is set
on the touchscreen, by Luban, or by the tool-change wizard; Luban's own CNC exports run in it.
It persists across homing but **dies on a machine reboot**, and it moves whenever the
operator re-zeros or changes tools. So: read it fresh (`get_position.originOffset` +
`originOffsetSource`) whenever a work-frame number must be converted; never assume its
value; never write it — the ONE sanctioned write is `apply_tool_length_offset` (§4).

**`G90`/`G91` is distance mode, not a frame.** Absolute vs incremental is orthogonal to
machine vs work. A bare `G90 / G0 Z0` runs in whatever workspace the controller has selected
— it is not machine coordinates because you wrote `G90`, and it is not work coordinates
because you assumed `G54`. It is undeclared, and undeclared is refused.

**Every staged job declares its frame — the handshake.**
- Machine-frame job: `G53` must appear literally before the first motion line (the controller
  needs it; the MCP refuses a "machine" job without it). Emit the pattern the tools use:
  `G90` / `G53;` / moves / `G54;` — the trailing `G54;` reselects Luban's workspace so the
  operator's own jobs still run where they expect.
- Work-frame job (a Luban/slicer export, an operator's scripted file): the file contains
  `G54`, or you pass `frame: "work"` to `submit_gcode_job`. The MCP validates its extents
  against the live origin, shows the machine-resolved Z on the confirm page, and **never
  rewrites the file**.
- Neither → refused at staging with the rule quoted back. The confirm page shows
  `Frame: MACHINE (G53 at line N)` or `Frame: WORK (declared by …)` and the machine-resolved
  Z extents, so the operator validates numbers without trusting chat.
- Warned loudly, not refused: `G92` (rewrites the work origin), relative moves, Z outside
  0…328 in either frame, a work-frame absolute `Z0`.

**Gantry top is machine Z328.** It is `home` Z, `mcpSafeTraverseZ`, and where every
procedure ends. Work Z0 is wherever the operator put it — on this rig it has been the stock
top and it has been Z328; you do not know which until you read the offset.

**Any coordinate more than 50 mm outside machine bounds is a BUG, never a position.** Bounds:
X −19…339, Y 0…342, Z 0…328 (bracing kit fitted; travel exists past the nominal 320×340×330
bed on both ends of every axis). Such a reading is ignored and the next coherent sync
rectifies it (§3). Do not "recover" from it with a big move; do not subtract an offset to make
it fit; do not reinterpret which frame it was in.

**Numbers carry their qualifiers or they are not numbers.** Every height you quote or record
states: frame (machine), **toolhead Z vs physical surface** (surface = contact Z − probe
length), the tool fitted, the B angle for anything on the rotary, and the date. The probe's
effective length is `get_stored_state → geometry.probe.effectiveLength` (stored with
`set_probe_geometry` after `run_tool_setter accept_probe_contact`) — 71.1 (pre-crash), 71.2
and 71.3 are all in circulation in old text and none of them is truth. Stock-top and hole
figures on the rotary are B-dependent: square stock reads ~12 mm higher at B90 than at B0.

## 3. Position of record — what `get_position` means

The MCP keeps ONE judged machine position. Read it; never compute your own from a beat.

| `reliability` | Meaning | Motion and staging |
|---|---|---|
| `verified` | A controller echo or settled heartbeat matched a commanded target | allowed |
| `heartbeat` | Latest beat coherent, offset reported by the controller | allowed |
| `cached-offset` | Beat carried a missing/zero offset; the last complete offset was reused | allowed; re-read once before a position CHECK |
| `awaiting-resync` | The beat was REJECTED — machine value out of bounds, or a frame-flip signature — and the record is held at the last accepted position (with its age) until a coherent beat arrives | **refused** — wait for the next beat; if it persists, `query_firmware_position` for liveness and tell the operator |
| `stale` | Report older than 10 s (period is 2 s) — the connection has likely dropped without the server noticing | **refused** — reconnect and re-verify |

`frame` says which reading the judgement rests on (`machine-frame` / `work-frame` /
`undetermined`); `reasons` say why. The same judgement streams to the Workspace console as
`mcp:position` lines, so the operator and you see one position. The console's raw
`work(…) offset(…)` line is the controller's own words — it is not a position either.

Why this exists: the HTTP channel sends `G90` / `G53;` / `G1 …` / `G54;` as four requests, and
a status poll landing inside that window can carry either frame with the offset populated,
zeroed or missing. Hand-derived "machine" values of Z555 and Z656, and a verified Z320 read
as Z−8, all came from doing the subtraction on one such beat. The server now judges; you read.

## 4. Sanctioned exceptions (and their exact limits)

- **Surface-scan hop envelope** (`probe_surface_path` / `probe_surface_grid` only, between
  consecutive stations only; operator law 2026-09-05): the probe retracts to **LAST CONTACT +
  `z_safe_delta_mm`** (cap 20) and hops at most `max_hop_mm` (cap 60). Note the gap between
  the operator's words ("20 mm from the top") and the implementation (20 mm above the last
  contact): inside a pocket the hop height follows the floor down. `hop_mode` defaults to
  `guarded` — a hop runs at travel feed in ≤ 10 mm sensor-checked segments and treats contact
  as a COLLISION already in progress. For stepped, pocketed or uncertain surfaces pass
  `hop_mode: "stepped"` (touch-probing traverse that lifts on contact) or split the scan.
- **`apply_tool_length_offset`** — the one sanctioned work-origin write. It stages a single
  `G92` shifting work Z by (new − old) trigger height, exactly what the touchscreen's manual
  tool-change wizard does after its two operator confirmations. Requires a reliable position
  and a measurement pair from this connection (or explicit trigger Zs). Never `G92` by hand.
- **`operator_confirmed_clearance`** — skips the homed-first / traverse-floor guard on a
  direct move. Only on the operator's explicit words, for the specific corridor they named,
  in an emergency. Never a planning device.

## 5. Vocabulary (operator-defined)

- **Home / homing** = machine home, `G53;G28;G54` like Luban's button — ALWAYS. Also homes B.
- **Goto work origin** = XY to work (0, 0) at the current Z. Never called "home".
- **Traverse height** = `mcpSafeTraverseZ` = machine Z328.
- **Toolhead Z** = the Z the heartbeat reports for the head; **physical / surface height** =
  toolhead Z at contact minus the probe (or tool) length. Landmark text states which.
- **Camera pose for the board** = pre-home park (machine X0 Y0), not machine home.

## 6. Recording rules

- Record in machine coordinates, with the qualifiers in §2, via `set_landmark`,
  `set_probe_geometry`, `set_tool_setter_config`, `set_camera_calibration` — never by hand
  into the configstore, never as constants in a program, never as UI settings knobs.
- A camera calibration is valid at its machine Y AND Z AND depth plane only; tag `surface`.
- Never hand-seed tool-setter measurement history; `run_tool_setter` writes it.
- Historical position notes from a closed session are never live position: home first.
