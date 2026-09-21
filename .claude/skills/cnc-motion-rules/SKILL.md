---
name: cnc-motion-rules
description: "The standing motion and coordinate rules for the Snapmaker A350 CNC driven through the Luban MCP tools, plus the canonical tool calls. Load this FIRST, before planning, staging, describing or reasoning about ANY machine motion or position: moves, jogs, traverses, homing, Z changes, probing, tool changes, running or staging an existing gcode/CAM/Luban program, clearance heights, work origins, machine coordinates, G53/G54/G90/G91, the heartbeat position or its reliability. It is also the answer to 'get_position says something odd'. The other CNC skills (cnc-probing, cnc-visual-alignment, tool-change) assume these rules and point here; for a plain transit or a plain 'run this file' this is the only skill you need."
---

# CNC motion rules (operator law — the canonical copy)

Everything here is operator law, not model judgment. Two incidents wrote it (appendix A); if a
tool refuses you, it is this document catching you — fix the plan, never work around it.
**The operator's time is the scarce resource**: every rule below is applied so that a lawful
plan reaches the confirm page in the fewest operator interactions, not the most.

## 0. Before ANY motion — the checklist

Run through it every time, and state the answers in your reply in one short block (a line per
item, quoting the tool result — not an essay):

1. **State.** `get_connection_status` connected; `get_position`: `reliability` is `verified`,
   `heartbeat` or `cached-offset` (never `awaiting-resync` or `stale`), `warnings` empty,
   `isHomed` true, `machineStatus` idle. `get_stored_state` for landmarks, limits, geometry.
   Not homed → homing is itself a motion (law 1), and it also homes B: stock on the rotary
   rotates — say so before calling it. `home` runs on the call, with no confirm page (law 6):
   the operator's word in chat is its whole authority, so get that word first.
2. **Frame.** Every number you plan with is MACHINE frame, or the job declares the WORK frame
   and the MCP resolves it (§2). Never convert a file's coordinates by hand. No bare `Z`.
3. **Height.** Any XY move over 1 mm runs at or above the MOTION FLOOR — machine **Z320**
   (`mcpMotionFloorZ`; a head reading 319.96 is at it). That is not the same number as the PARK
   height, machine Z328 = home, which is where procedures hop between stations, retreat to on an
   abort, and end. If the head is below the floor, the retreat is its own `move_z` step and needs
   its own word from the operator: ask "may I raise Z first?" — a transit request is not
   authority to move Z.
4. **Obstacles.** The same `get_stored_state` call: does the path — the whole SEGMENT from
   where the toolhead is to where it is going, not the destination point — cross a landmark box
   below the toolhead Z it demands? Read `requiredToolheadZ` on the landmark rather than working
   it out: for a box stated with `obstacle_top_z` it is the top plus the fitted tool plus a 5 mm
   margin, and for a legacy `clearance_z` it is that number as it stands. The test is
   at-or-above, so equal passes. A box the operator states in chat is a planning obstacle
   immediately; write it with `set_landmark` only when they ask; if chat and the store disagree,
   stop and ask which is current.
5. **Tool.** A tool or the probe is ALWAYS in the spindle. Where is its tip at the Z you plan?
6. **Authority.** An explicit imperative in the operator's LATEST message is necessary — not
   sufficient. It authorises STAGING; the click on the confirm page authorises the motion. An
   imperative on a rejected or stale position ("home it to fix the reading") is still refused
   by the tools, and you say why (§3). **Staging is half a call, and the LINK comes first.**
   The moment a staging tool returns, reply with one sentence and the `confirm_url` as the
   last line, and END THE TURN — the operator cannot click a link they have not seen. Only
   then wait: `start_gcode_job {job_id, wait_for_approval_ms}` as a BACKGROUND poll, or
   `confirm_token` with the code they paste. A wait that times out means nothing happened yet
   — call again; it is never a reason to withdraw the job or to conclude anything (2026-09-21:
   a move_z was staged, the agent blocked 50 s on a click the operator had no link for,
   withdrew it and invented a conclusion). Every staging result carries this contract as
   `handoff`.
7. **Ask once.** Before staging anything, list every unknown the whole procedure needs — the Y
   of a feature, a diameter bound, a clear Z, what an ambiguous word means, which tool-change
   flow — and ask them in ONE message. A question per turn is the most expensive mistake an
   agent makes on this machine. If the prompt already answers everything, ask nothing. A
   question you ask is a question you WAIT for: the first tool call that uses an answer comes
   after the answer, never before it.

**Fast path.** For a transit that starts at or above Z328 and writes no Z, `get_position` +
`get_stored_state` discharge items 1–5 in one breath: quote the two results and stage
`traverse_xy` (§8). One approval, no questions.

## 1. The eight motion laws

1. **One motion per instruction, and no inferred approvals.** When the operator enumerates
   steps, execute exactly the step they name and stop. NEVER chain motion calls in a single
   command (`&&`, one script, one turn) — each motion needs a decision point in front of it
   (appendix A, incident 1). A motion mentioned in passing — "take a photo before homing",
   "then we'll traverse", a plan they approved — is context, not a command: announce it and
   WAIT for the word. **Resolution with law 6**: a request that names a procedure ("scan the
   tailstock", "probe along X from 164 to 176") authorises STAGING that procedure; the confirm
   page is its decision point. A staged program or procedure is ONE decision point for every
   move inside its approved envelope — that is the efficient lawful form, not a violation.
2. **X/Y traverses happen at or above the motion floor — ALL of them.** Any XY move over 1 mm
   is planned at or above `mcpMotionFloorZ`, default **machine Z320** (a head reading 319.96 is
   at it). No "local hops" above a measured top, no other "measured safe" height (operator,
   2026-09-02: "x/y motion over 1mm is never below gantry height"; revised 2026-09-19 from a
   single height to a floor). Retreat Z FIRST, traverse, then descend at the destination. The
   only sub-floor XY motion is fine positioning of ≤ 1 mm and the in-procedure envelopes in §4,
   which the operator approves on the confirm page as part of that one tool call — the NEXT
   motion starts from a full retreat again. Enforced: `traverse_xy` and direct XY moves below
   the floor are refused; `operator_confirmed_clearance` exists for emergencies on the
   operator's explicit words, never for planning.

   **The floor is not the park height.** `mcpSafeTraverseZ` (machine Z328 = home) is where
   procedures hop between stations, retreat to on an abort, and finish; that is unchanged, and
   `planRaiseToTop` still targets it. The floor could only drop below it once clearances stopped
   carrying tool length (law 4): a hop at the floor is checked against every stored landmark
   exactly like any low segment, and there is still **no exemption for being high**. What it
   costs is 8 mm less blind protection for anything on the bed with no landmark — which is why
   an unmapped object taller than the floor minus the tool is the operator's problem to state,
   not the guard's to catch.
3. **Never fabricate clearance.** Only measured numbers or operator-stated numbers count for
   heights. A photo FINDS things, it clears nothing (incident 1). An unknown height is measured
   from a proven-safe height by a sensor-gated −Z march (§8 example), never assumed — and never
   fed as `start_z_machine` from an operator's rough guess when a march can measure it first.
4. **Landmarks are obstacles, and a clearance is the OBSTACLE's height.** Stored landmarks are
   CROSSING obstacles: an XY segment that enters or leaves their box below the toolhead Z it
   demands is refused — at staging for procedures, at call time for direct moves. State a new
   one with `obstacle_top_z`: the top of the obstacle ITSELF, nothing about the tool. The server
   adds how far the fitted tool hangs below the toolhead (the longest of the last tool-setter
   measurement, `probe_effective_length` and `longest_bit_length_mm` — a measurement only ever
   lengthens the requirement) plus a 5 mm margin. With the touch probe fitted, a 250 mm-high
   obstacle still demands 328; with a 2 mm engraving bit it demands 257, and that is where the
   machine gets its working room back. If NOTHING is known about the tool, a physically stated
   obstacle is impassable rather than passable — state a tool length. Legacy `clearance_z`
   records are toolhead heights with a tool already baked in and are enforced exactly as before;
   `get_stored_state.landmarkClearances` lists which ones still want re-stating. A hop passes
   because it is at or above the requirement (equal passes), never because it is exempt; an
   in-procedure hop below it is checked like any low segment; marches are exempt because they
   stop on contact. A program's `keep_out` is a
   VOLUME: nothing enters, not even a descent column. Never delete or shrink a landmark to make
   a plan pass. Measuring INSIDE an unmeasured region is allowed and is how a keep-out is
   retired: one sensor-gated march, then `set_landmark` with the measured clearance.
5. **Contact sensors are crash sensors.** While MCP motion is in flight, a trigger on a probe
   channel that no procedure declared as expected trips a CRASH alarm: job stopped, connection
   closed, motion latched until the operator clears it (Workspace → Connection → Clear alarm, or
   `clear_overtravel_alarm` on their words — never yours). The overtravel switch latches the same
   way, but ONLY while a procedure or MCP motion is in progress; pressed by hand with the
   machine idle it just flashes the pill. Do not disconnect the probe feed while anything might
   move.
6. **Chat is not a motion gate — the staged job is.** Every transport, Z and measuring tool
   stages a job and needs the operator's click: `traverse_xy`, `move_z`, `goto_work_origin`,
   `goto_tool_change_position`, `submit_gcode_job`, and every `probe_*` / `run_tool_setter` /
   `probe_program`. **Two tools move on the call itself, with no confirm page** (operator
   ruling, 2026-09-21): `home` — homing is safe: Z rises first, then every axis to its switch,
   B included; it still needs the operator's explicit word (law 1) and a reliable position
   (§3), and you say the stock will turn before calling it — and `move_and_capture`, the
   ≤ 100 mm vision nudge, which is Z-gated inside the tool (law 7). Everything else that moves
   the head reaches the operator as a page. **Order:
   stage → deliver the confirm URL as the LAST LINE of your message, alone, plain, one
   sentence above it saying what they are approving, no tool call after it in the same turn
   (the desktop client has hidden it otherwise) → END THE TURN → then wait**, either with
   `start_gcode_job {job_id, wait_for_approval_ms: 110000}` in the background (a keep-alive,
   not a review budget — it does not scale with job size; `approved: false, timed_out: true`
   means call again, never restage, never withdraw) or with the one-time code the operator
   pastes as `confirm_token`. When the operator says "don't bother
   me with confirmations": one click per whole procedure IS the minimum — offer the one-approval
   program form, do not skip the page, do not lecture.
7. **Use tools for their purpose, through the MCP surface only.** `move_and_capture` is a
   vision reposition (≤ 100 mm, a safety cap the assistant never raises, pacing-guarded), not
   transport, and it is **Z-gated first**: before any XY is commanded the tool proves from the
   position of record that the head is at the park height (machine Z328), raises it straight
   up there first if it is not, and refuses the call outright when Z cannot be established —
   you do not pre-check this, and you never pass `operator_confirmed_clearance` to skip it
   (§4). Transport is `traverse_xy`. Z is `move_z` with `coordinate_system: "machine"`.
   Programs someone generated (Luban, CAM) are exactly what `submit_gcode_job` is for — law 7
   forbids file jobs as TRANSPORT, not file jobs. A script looping motion calls is an
   unsupervised procedure without a confirm page. Never touch the backend, configstore, or
   machine directly while the app runs.
8. **An abort retreats STRAIGHT UP to the traverse height — never to a "start height", never
   down.** This is what the server does on every procedure abort (`abortRaiseToTop`): no motion
   if the overtravel trip is closing the connection; HOLD if the probe still reads contact (the
   operator frees it); nothing sent if the head is already at the top; otherwise one Z-only
   move to `mcpSafeTraverseZ`. It is also what YOU do when recovering by hand: after any abort,
   refusal or doubt, the first motion is `move_z` to the traverse height, then re-prove position
   (`get_position`), then plan again. Never "return to where the procedure started" — before
   the travel, the start height is BELOW the head (appendix A, 2026-09-16). A COMPLETED
   `run_tool_setter` ends the same way (issue #91): raised straight up to the traverse height,
   `result.finalZ` says where the head is — except `stay_at_trigger`, which holds the tip in
   contact for the touchscreen wizard and retreats nowhere.

## 2. Coordinate doctrine

**Two frames exist on the controller.** `G53` selects the MACHINE frame (home = X−19 Y342
Z328); `G54`–`G59` select numbered WORK workspaces whose origin the operator sets. The
heartbeat reports the *currently selected* workspace. `G90`/`G91` is **distance mode**, not a
frame: a bare `G90 / G0 Z0` runs in whatever workspace is selected. It is undeclared, and
undeclared is refused.

**Agents plan, stage, record and quote in MACHINE coordinates.** Say "machine" every time.
Landmarks, tool-setter config, probe results and the geometry store are all machine frame.

**Every staged job declares its frame — the handshake.**
- **Work-frame job — a Luban/slicer export or the operator's scripted file (the common case).**
  Luban exports contain neither `G53` nor `G54`: pass `frame: "work"` to `submit_gcode_job` and
  hand the bytes through **unchanged**. You never add `G53` or `G54` to a file you did not
  write; you never convert its Z by hand. The MCP resolves the extents through the live origin
  and the confirm page shows `Frame: WORK (declared by argument)` plus the **machine-resolved Z
  extents** — read both to the operator. `frame: "work"` resolves against the offset on the
  heartbeat, i.e. the workspace currently selected on the controller.
- **Machine-frame job.** `G53` must appear literally on its own line before the first move
  (the controller needs it; `frame: "machine"` without it is refused). The tools emit `G90` /
  `G53;` / moves / `G54;` — the trailing `G54;` reselects Luban's workspace.
- Neither → refused at staging with the rule quoted back.
- Warned, not refused: `G92`, relative moves, Z outside 0…328 in either frame, a work-frame
  absolute `Z0`, inline `G53 G0 …` (the firmware ignores a one-shot G53).

**The work origin belongs to the operator, Luban and the firmware — not to you.** It persists
across homing, **dies on a machine reboot**, and moves when the operator re-zeros or changes
tools. Read it fresh from `get_position.originOffset`; never assume it; the ONE sanctioned write
is `apply_tool_length_offset` (§4).

**Gantry top is machine Z328.** Work Z0 is wherever the operator put it — on this rig it has
been the stock top and it has been Z328.

**Any coordinate more than 50 mm outside machine bounds is a BUG, never a position.** Bounds:
X −19…339, Y 0…342, Z 0…328. The server ignores such a beat (§3); you never "recover" from it
with a move, subtract an offset to make it fit, or reinterpret its frame. Plan stations near an
edge (Y340 is 2 mm from the limit) with the margin said aloud.

**Numbers carry their qualifiers or they are not numbers.** Every height states: frame
(machine), **toolhead Z vs physical surface** (surface = contact Z − probe or tool length), the
tool fitted, the B angle for anything on the rotary, and the date. **Probe length**: an operator
naming a length in chat tells you WHICH probe is fitted, not its calibration — read
`get_stored_state → geometry.probe.effectiveLength`. It is normally set — plan on the stored
value and do not budget an approval for measuring it. Only after you have READ an empty store do
you add one measurement (`run_tool_setter accept_probe_contact`, then `set_probe_geometry`,
§8) and announce it; if store and operator disagree by more than 0.3 mm, ask before converting
anything. The same subtraction gives a cutting tool's surface height: contact Z − fitted tool
length, in machine Z. Figures remembered from text (71.1, 71.2, 71.3) are historical.

## 3. Position of record — what `get_position` means

The MCP keeps ONE judged machine position. Read it; never compute your own from a beat.

| `reliability` | Meaning | Motion and staging |
|---|---|---|
| `verified` | A controller echo or settled heartbeat matched a commanded target | allowed |
| `heartbeat` | Latest beat coherent, offset reported by the controller | allowed |
| `cached-offset` | Beat carried a missing/zero offset; the last complete offset was reused | allowed; re-read once before a position CHECK |
| `awaiting-resync` | The beat was REJECTED (out of bounds, frame-flip signature, or no offset yet) and the record is held at the last accepted position with its age | **refused** by every motion tool |
| `heartbeat` + `frame: machine-frame` | Three consecutive beats read as a legal MACHINE position while the work reading was impossible: the controller is stuck in the machine workspace. The raw fields ARE the position | allowed — but the work coordinates and the offset are not to be trusted until `restore_work_frame` |
| `stale` | No report for > 10 s (period 2 s) — the connection has likely dropped unnoticed | **refused** — reconnect and re-verify |

**Nothing you do performs the resync, with one exception.** The server clears
`awaiting-resync` when a coherent beat arrives (normally the next one, 2 s). Homing does not
clear it, reconnecting does not clear it, re-reading only lets you see that it cleared. Re-read
`get_position` once after ~3 s.

The exception is the one that cost a whole session on 2026-09-19: if the controller was left in
the MACHINE workspace — a job declared `G53` and never selected a work workspace again — then
every beat carries machine coordinates with the work-origin offset still populated, `raw −
offset` is impossible, and no amount of waiting fixes it. The server recognises that after
three such beats and says so in `reasons`, reporting `frame: machine-frame` and using the raw
fields as the machine position. **The remedy is `restore_work_frame`**: `G90` and `G54`, no
axis word, permitted precisely because the position is incoherent. A re-home is NOT the remedy,
though it happens to work — it emits a `G54` on the way.

**Frame hygiene stops it happening.** Every machine-frame job hands the frame back: `G53` on its
own line before the moves, `G54` on its own line after the last one. `traverse_xy` and `move_z`
already emit exactly that, which is the real reason to use them instead of writing the file
yourself; a hand-authored transit that is pure transport is refused and told so.

Still rejected after ~3 re-reads (~10 s) and not a frame problem: stop polling, call
`query_firmware_position` (proves the controller is alive — it reports WORK coordinates, not an
independent machine frame) and `get_mcp_diagnostics → machinePosition` (rejected-beat counters
by reason), and tell the operator — that is a connection or controller fault, not a wait. `frame: undetermined` means
the judgement rests on no clean reading: treat it as `awaiting-resync`. During a direct move,
beats sampled inside the `G53…G54` window are rejected by design and the record holds the
start position — expect it, do not act on it.

## 4. Sanctioned exceptions (and their exact limits)

- **Surface-scan hop envelope** (`probe_surface_path` / `probe_surface_grid` only, between
  consecutive stations): retract to **LAST CONTACT + `z_safe_delta_mm`** (cap 20, min 3) and hop
  at most `max_hop_mm` (cap 60). Lowering either is always allowed; raising is refused. `hop_mode`
  `guarded` (default) hops at travel feed in ≤ 10 mm sensor-checked segments and treats contact
  as a COLLISION; `stepped` is a touch-probing traverse that lifts on contact. Choose by the
  height change between consecutive stations, not by the surface's name: spacing × steepest
  credible slope ≪ `z_safe_delta_mm` → `guarded`; a station may sit more than `z_safe_delta_mm`
  above or below its neighbour (steps, pockets, edges, unknown stock) → `stepped`.
- **Stepped links in `run_probing_gcode`** (`link_mode` `"stepped"` / `"wall"`, between
  consecutive stations only): a touch-probing traverse at the programmed height. Toward a TOP
  station a contact lifts `hop_lift_mm` (+Z) and retries; toward a SIDE-MARCH station (a pocket
  wall) a contact is a wall — back off 1 mm, retreat `hop_lift_mm` along the path just travelled
  (the only proven-clear direction, never +Z), record it as a `link_contact`, mark the station
  `blocked`, continue. A contact during the guarded descent at such a link's destination is a
  `blocked` station, not a crash: the head lifts straight back up the column it came down. A
  `blocked` station is a normal report outcome; `top_z_machine` (measured, never a guess) caps
  the +Z lifts at the top; an abort still obeys law 8.
- **`apply_tool_length_offset`** — the one sanctioned work-origin write: a single `G92` shifting
  work Z by (new − old) trigger height, what the touchscreen wizard does after its two operator
  confirmations. Requires a reliable position and a measurement pair from this connection.
- **`operator_confirmed_clearance`** — on `move_and_capture` only: skips the homed-first guard
  and the raise-to-park-height gate, so the XY runs at the CURRENT Z in the corridor the operator
  named. Only on the operator's explicit words, in an emergency; an unknown Z is refused even
  then. `goto_work_origin` has no such switch — its confirm page is the operator's word.

## 5. Vocabulary (operator-defined)

- **Home / homing** = machine home, `G53;G28;G54` like Luban's button — ALWAYS. Also homes B.
  It clears the NOT-HOMED state; it is not a remedy for `awaiting-resync` or `stale`.
- **Goto work origin** = XY to work (0, 0) at the current Z, STAGED like `traverse_xy`: the
  confirm page shows the destination in MACHINE coordinates (a work origin is operator-set and
  dies on a reboot, so "work zero" can be anywhere on the bed — read the operator the machine
  numbers), and it is refused while the origin offset is not the heartbeat's own or the position
  is not trusted (§3). Never called "home".
- **Motion floor** = `mcpMotionFloorZ` = machine Z320: the lowest Z any XY move may happen at.
- **Park height** (a.k.a. traverse height) = `mcpSafeTraverseZ` = machine Z328: where procedures
  hop, retreat on abort, and end. `get_stored_state.limits` reports both.
- **Toolhead Z** = the Z the heartbeat reports for the head; **physical / surface height** =
  toolhead Z at contact minus the probe (or tool) length.
- **`bit_length_mm`** (tool setter) = the fitted tool's PROTRUSION from the collet in mm — a
  length, never a diameter.
- **Camera pose for the board** = pre-home park (machine X0 Y0), not machine home.

## 6. Recording rules

Record in machine coordinates with the §2 qualifiers via `set_landmark`, `set_probe_geometry`,
`set_tool_setter_config`, `set_camera_calibration` — never by hand into the configstore, never
as constants in a program. A camera calibration is valid at its machine Y AND Z AND depth plane
only. Never hand-seed tool-setter measurement history. Historical position notes from a closed
session are never live position: home first.

## 7. Running a program someone else generated (Luban, Fusion, hand-written)

This is what the machine is for, and it is one approval:

1. Preflight, asked as ONE batch only where the prompt leaves it open: same tool as when the
   work origin was set (a swap moves work Z — see `tool-change`)? clamps clear of the XY
   extents? deepest Z vs stock thickness? door shut, extraction on?
2. `validate_gcode {gcode}` — read the warnings. `M3 Sxxxx … M5` in a cutting file is normal:
   the file owns its spindle (the `M3` refusal belongs to `run_probing_gcode` only). A
   spindle-on Z below 0, an unmatched `M3`, or an out-of-travel Z is a warning to put in front
   of the operator, not a reason to edit the file.
3. `submit_gcode_job {gcode, name, frame: "work"}` for a Luban/slicer export (§2); the file is
   passed through unchanged.
4. Read the operator the confirm page's **Frame** row and **machine-resolved Z extents**.
5. Deliver the confirm URL and end the turn; then `start_gcode_job {job_id,
   wait_for_approval_ms: 110000}` in the background (or `confirm_token`); the door interlock applies to file
   jobs — the machine pauses if the door opens and resumes from the machine; the job's
   `ending` records it.
6. Long-poll `get_gcode_job_status {job_id, wait_ms, since_event}`; `ending.kind` says why it
   ended (`completed`, `stopped-by-agent`, `machine-stopped`, `crash-alarm`, …).
7. `stop_gcode_job` on a file job is a firmware stop: motion and spindle stop, nothing retracts,
   the cut is not resumable — re-run from the top with the operator. The machine's own stop and
   the crash guard are the E-stop.

## 8. Canonical calls (real argument names — copy these, do not guess)

Every staging call below is followed by its start call — they are one instruction, in two
turns: the staging result's `confirm_url` goes to the operator FIRST (last line, end the turn),
the start call waits in the background afterwards or takes their pasted code.

```jsonc
// Transport at the traverse height (default frame machine; series form: "targets": [{"x","y"}, ...])
traverse_xy {"x": 290, "y": 105, "coordinate_system": "machine", "reason": "..."}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
// Work origin: XY to work (0, 0) at the current Z, STAGED - the page shows the MACHINE destination
goto_work_origin {"reason": "..."}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
// Machine home runs ON THE CALL - no confirm page, no start_gcode_job (operator ruling 2026-09-21: safe).
// Needs the operator's explicit word (law 1) and a reliable position; homes B too - say the stock will turn.
home {}
// Z, one operator-confirmed step per target
move_z {"z": 328, "coordinate_system": "machine", "reason": "..."}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
// A Luban export (the file text, unchanged)
submit_gcode_job {"gcode": "<file text>", "name": "pocket.nc", "frame": "work"}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
// Poll any running job to its end; ending.kind says why it ended
get_gcode_job_status {"job_id": "<id>", "wait_ms": 110000, "since_event": <next_event_index>}
// Tool setter: bit_length_mm is the fitted tool's protrusion (a length, never a diameter)
run_tool_setter {"bit_length_mm": 40, "reason": "..."}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
// Measure the touch probe itself (only after reading an EMPTY store), then record it
run_tool_setter {"bit_length_mm": 70, "accept_probe_contact": true, "reason": "..."}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
set_probe_geometry {"probe_effective_length": 71.28, "reason": "run_tool_setter job <id>, 2026-09-14"}
// Tool change, flow A, step 4 of 4: shift work Z by new − old (defaults to the last two measurements)
apply_tool_length_offset {"reason": "..."}            // or {"old_trigger_z": 100.5, "new_trigger_z": 98.2, "reason": "..."}
start_gcode_job {"job_id": "<id>", "wait_for_approval_ms": 110000}
```

`probe_program` (below) is also staged and started the same way — one `start_gcode_job` after
it, one click for every op inside.

**Find the top, then scan it — the two-op program (one approval).** Use it whenever a height is
unknown: the first op measures, the second references the measurement.

```jsonc
probe_program {
  "name": "headstock X profile at Y340",
  "reason": "...",
  "ops": [
    {"id": "find", "kind": "sequence", "steps": [
      {"kind": "hop", "x": 170, "y": 340},                       // at the traverse height
      {"kind": "probe", "name": "top", "dz": -1, "max_travel_mm": 150, "on_miss": "abort"}
    ]},
    {"id": "scan", "kind": "surface_path",
     "start_x": 164.1, "start_y": 340, "end_x": 175.9, "end_y": 340, "stations": 60,
     "start_z_machine":    {"from": "find.top.z", "plus": 3, "between": [178, 328]},
     "expected_z_machine": {"from": "find.top.z", "between": [178, 328]},
     "hop_mode": "guarded", "z_safe_delta_mm": 5, "sensor_delay_ms": 50}
  ]
}
```

For flatness swap the second op for a grid: `{"id": "map", "kind": "surface_grid", "x_min": 140,
"x_max": 200, "y_min": 135, "y_max": 260, "pitch_mm": 10, "start_z_machine": {"from":
"find.top.z", "plus": 3, "between": [178, 328]}, "expected_z_machine": {"from": "find.top.z",
"between": [178, 328]}, "hop_mode": "stepped", "z_safe_delta_mm": 5}` (stepped: an unknown top may vary by more than the hop) — and keep it out of the
chuck jaws' reach (Y ≳ 269 on this rig; box it with `keep_out` or narrow the grid).

Reference grammar: `{"from": "<opId>.<probeName>.<x|y|z>" | "<opId>.summary.<field>" |
"axis.<x|z_contact|z_physical|tip_radius|probe_length>", "plus"?: n|path, "minus"?: n|path,
"between": [lo, hi]}`; two-operand forms `{"mid": [a, b]}`, `{"diff": [a, b], "scale"?}`,
`{"min"|"max": [...]}`. `between` is mandatory (law 3). A reference to a probe that missed
refuses its op at run time — give the finding march enough `max_travel_mm`. A blind −Z march
costs about `max_travel / coarse_step` sensor windows (~1 mm/step, ~0.3 s each): ask for an
approximate height and shorten it — a long limit costs time, not safety.

## Appendix A — why these laws exist

- **2026-09-01.** An XY traverse at a fabricated "clearance" height drove the touch probe into
  the rotary stock and destroyed it; step 2 fired 117 ms after step 1 with no chance to
  intervene, and the height had been read off a photo that misread the stock twice. Laws 1–5.
- **2026-09-02.** A home was performed off the back of "take a photo before homing". Law 1.
- **2026-09-12.** An agent staged `G90 / G0 Z0 / G0 X… Y…` as a transit job; `Z0` was in the
  WORK frame, the validator reported `Z 0 — 0, warnings: none`, and the operator could not tell
  from the confirm page which frame it meant. Nothing moved — the operator refused it — but every
  guard had passed. §2, the frame handshake, `traverse_xy`.
- **2026-09-14.** The heartbeat's `machine = work − offset` on a beat sampled inside a `G53`
  window produced Z 555 / Z 656 "positions" that passed every guard, and once read a verified
  Z320 as Z−8. §3, the position of record.
- **2026-09-16.** `run_tool_setter` (deployed build pre-dating the 327.999 tolerance fix) refused
  its XY travel at home and its abort path "retreated to the start height": `G1 Z205.500` from
  Z328 at the home XY (174.5, 340), inside the rotary landmark — a 122 mm plunge with no XY move
  ever sent. Law 8, `abortRaiseToTop`.
