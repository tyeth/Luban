# Luban MCP tool surface (54 tools)

Terse per-tool reference. Machines: A350 = CNC, F350 = printer. Motion tools stage a job and
need one operator click on the confirm page; nothing moves on an agent's word alone. Results
quote coordinates with their frame (machine vs work). Call `get_stored_state` first in a fresh
session.

## Orientation and status (read-only)

- `get_stored_state` — everything known in one call: calibrations, landmarks, tool region, limits, camera (incl. `camera.stream.stream_url`, the operator's live view), connection, probe feed. Start here.
- `get_connection_status` — is Luban connected to a machine, over what channel.
- `get_machine_profile` — kinematics, work envelope, toolhead module offsets.
- `get_position` — the machine POSITION OF RECORD: judged machine coordinates with `reliability` (verified | heartbeat | cached-offset | awaiting-resync | stale), the frame it rests on and `reasons`, plus the raw work report and originOffset. Motion refuses unless verified/heartbeat/cached-offset; never derive machine = work − offset yourself.
- `query_firmware_position` — raw `M114`; use when `get_position` looks suspect.
- `get_mcp_diagnostics` — event-loop stalls and timing evidence for slow or aborted procedures; `machinePosition` counts rejected heartbeats by reason (out-of-bounds, frame-flip, no-offset-yet), resyncs and disconnects.
- `get_job_timing` — where a job's time went, from its event log; works for running, done and failed jobs.

## G-code jobs

- `validate_gcode` — static inspection: extents, spindle state, distance-mode hazards, and the FRAME the job declares (G53 own-line = machine, G54..G59 = work; inline `G53 G0` flagged - the firmware ignores it; G92 flagged). Free, run before submitting.
- `submit_gcode_job {gcode, name, frame?: "machine"|"work", head_type?}` — stage a file job (the gcode TEXT, not a path); returns the confirm-page URL — deliver it to the operator as the last line of your message, alone. REFUSED unless the job declares its frame: `G53` on its own line before the first move (machine), or `G54..G59` in the file / `frame: "work"` for a Luban/slicer export (work; the file is never modified). `frame: "machine"` without a literal G53 is refused. The confirm page shows Frame and machine-resolved Z extents.
- `start_gcode_job {job_id, wait_for_approval_ms?, wait_ms?, confirm_token?}` — call right after staging with `wait_for_approval_ms` (e.g. 110000): the operator's click on the confirm page starts the job; `approved: false, timed_out: true` means call again, never restage. Procedures return the result if it lands within `wait_ms` (default 25 s), else `running` — long-poll `get_gcode_job_status`.
- `get_gcode_job_status {job_id, wait_ms?, since_event?}` — event log plus stored result and `ending` (why it ended: completed | stopped-by-agent | stopped-by-operator | withdrawn | rejected-by-operator | crash-alarm | overtravel-alarm | unexpected-contact | controller-rejected | timeout | operation-failure | machine-stopped | completion-unverified, with reason and measured count); a stopped or failed procedure keeps every completed station under `result`. Long-poll with `wait_ms` / `since_event` instead of spinning.
- `stop_gcode_job` — procedures stop cooperatively at the next step and raise; file jobs get a firmware stop. Partial result kept.

## Direct motion (each is one approved job)

- `home` — machine home (`G53;G28;G54`; also homes B). Default first step after (re)connecting; raises Z first and clears the NOT-HOMED state. It is not a remedy for a `get_position` reliability of `awaiting-resync` or `stale` — a rejected or aged beat is a reporting fault, not a position fault, and motion is refused until the record recovers on its own (next coherent beat, ~2 s).
- `goto_work_origin` — move to work X0 Y0. Distinct from `home`.
- `move_z {z | z_targets[], coordinate_system: "machine"|"work", feed_rate?, reason}` — single Z target or a batch; one approval covers the list, one `start_gcode_job` per step. Only on the operator's explicit request.
- `traverse_xy {x?, y? | targets: [{x?, y?}], coordinate_system?: "machine" (default) | "work", feed_rate?, reason}` — law-2 TRANSPORT: an absolute XY target or an ordered `targets` series at the height the head is already at (>= the motion floor), one approval, one `start_gcode_job` per leg, like `move_z`. Refused unless the head is already at/above `mcpMotionFloorZ` (default 320; no override); every leg checked against landmarks and the travel; Z never written; default frame machine (`G53` per step). Use this, never a hand-written file job, to move the head.
- `move_and_capture` — one guarded XY move followed by a position-stamped frame; the unit of visual alignment.
- `goto_tool_change_position` — two approved steps: Z up, then XY to the operator-set park spot.

- `restore_work_frame {reason?}` — `G90` + `G54` on their own lines, NO MOTION. The cure for a controller left in the machine workspace by a job that declared `G53` and never handed the frame back: every beat then carries machine coordinates with the work-origin offset still populated, `raw − offset` is impossible, and the position of record refuses everything - including this, which is why it is explicitly allowed while `awaiting-resync` or `stale`. Reports the position before and after. A re-home is not the remedy.

## Camera and vision

- `list_cameras` — enumerate capture devices (DirectShow names on Windows, `/dev/v4l/by-id` on Linux), plus `selection` (which camera captures actually use: `url`, `device`, `last_good`, `effective`, `pinned`) and `stream` — `enabled`, `stream_url` (`/camera` page for the OPERATOR's browser; not for the agent to fetch), `running`, `clients`, `fps`.
- `preview_cameras {device?}` — one frame from EACH attached camera (or just the named one), labelled with its device string and `frame_id`. With two cameras attached both return good-looking frames and nothing downstream can tell which is which — the measurements are simply wrong — so look before you pin. A camera that will not open is reported beside the others, never substituted. Read-only; the selection is untouched.
- `select_camera {device | clear, confirm_frame_id?, operator_confirmed?, reason?}` — pin which camera every capture uses (`mcpCameraDevice`, or `mcpCameraUrl` for an http(s) snapshot URL — picking one clears the other, since the URL wins wherever both are set). `device` matches a `list_cameras` entry, its `/dev` path (symlink or the node it resolves to), or its friendly name; ambiguous matches and bare indices are refused, never guessed. `confirm_frame_id` must be a frame that came from THAT camera (from `preview_cameras`) — waived only when one camera is attached or the selection is unchanged; `operator_confirmed` is the OPERATOR's word, not the model's. Returns a fresh frame from the camera it just selected, restarts the live stream loop onto it, and — when the camera actually changed — marks the solved camera model unverified, because that geometry belonged to the old camera. `clear: true` unpins.
- `capture_frame` — position-stamped frame with a `frameId`, the expected tool region, nearby landmarks, `source` (`stream` = served by the live MJPEG loop someone is watching, `one-shot` = this call opened the device) and `stream_url`. Cached (last 12). Works the same whether or not the stream is running.
- `get_frame {frame_id | file}` — a frame captured earlier: one of the last 12 cached, or a `probe_program` `capture` op's saved file (read only from the program-frame directory). Read-only, no capture, no motion.
- `set_tool_region` — tell the server where the tool appears in frame so captures can flag it.
- `track_feature` — normalised cross-correlation of a template between two cached frames. Use instead of eyeballing pixels.
- `set_camera_calibration` — Y/Z-keyed pixel-to-mm calibration, optional `surface` depth tag and `jacobian`. Sign-flipped matrices are rejected.
- `get_camera_calibration` / `delete_camera_calibration` — read or remove a stored calibration.
- `visual_servo` — one clamped step toward a seen target per call. Trips when the error stops shrinking or the response diverges from the calibration prediction (parallax signature).
- `survey_bed` — approved serpentine XY camera grid at gantry height; whole-bed mosaic for finding stock and fixtures. New: `overlap_fraction` + `plane_z` derive the pitch from the camera model's real field of view ("seamless" is a relationship between pitch and field of view, and a picked pitch is not one); `z_levels` runs the grid at several heights under ONE approval, each entered with XY stationary; with a verified model each pass is composed into `mosaic_z<Z>.jpg` indexed in machine coordinates, and the seams double as a drift check that marks the model unverified when overlapping frames disagree.
- *(not a tool)* Live view for humans: `GET /camera` on the MCP port (`stream_url` above) — MJPEG at `/camera/stream.mjpeg`, one JPEG at `/camera/snapshot.jpg`, `/camera/status.json`. Same LAN gate as `/mcp`; off (Settings → MCP Server → Camera) = 404.

### The camera model (the camera is SESSION STATE, not a rig constant)

It can sit differently after every power cycle, be knocked, be re-aimed, or be a different camera. Nothing converts a pixel into a machine coordinate, or a machine coordinate into a pose, until a model is solved AND verified on this connection. Plain captures never need one.

- `get_camera_model {history?}` — the model, its state (verified | unverified | superseded), why it is not usable, and which tool fixes it. Read-only.
- `verify_camera_model {target, pixel_u, pixel_v, tolerance_px?}` — predict where a target of known machine coordinates should appear at the CURRENT toolhead position, compare with where it does, record the residual in px and mm. **The first camera call of any session.** Beyond tolerance the model stays unverified and says the camera has probably moved. No motion - position with `traverse_xy` first.
- `camera_bootstrap {stage, reason, ...}` — solve the geometry FROM NOTHING, two staged procedures, one approval each. `stage: "search"`: a grid at the park height bracketing the tool setter, whose machine XY is known exactly - which frames contain it gives the camera offset INCLUDING ITS SIGN with no prior assumption, and it is the only step meaningful without a calibration. `stage: "poses"`: the poses that implies, each sweeping Z from the park height to the motion floor with XY stationary. A pose the TOOLHEAD cannot reach is dropped with a reason, never quietly adjusted.
- `set_camera_model {offset, rotation, intrinsics, valid_band_z, central_region, residuals, ...}` — store a solve from `scripts/camera_bootstrap.py`. Always stored UNVERIFIED; the previous model is kept superseded, never overwritten.
- `plan_view_pose {target, toolhead_z?}` — where must the TOOLHEAD go to see this machine point? Returns the pose, the standoff and the field of view, from the model. Use it instead of computing a pose; never carry one between sessions.

## Landmarks and scene

- `set_landmark` — name a scene feature by machine extent, optionally with `clearance_z`. Landmarks are obstacles: planners refuse XY paths that cross them below clearance.
- `delete_landmark` — remove one.

## Probe feed (external sensors: tool setter, overtravel switch, touch probe)

- `get_probe_feed_status` — transport, per-channel last readings, tripwire state.
- `connect_probe_feed` — bring up the MQTT or Blinka GPIO feed; connecting arms the overtravel tripwire.
- `disconnect_probe_feed` — drop the feed.
- `clear_overtravel_alarm` — reset a latched overtravel trip. Operator's explicit word only.

## Tool setter and tool change

- `set_tool_setter_config` — setter centre, trigger Z with a reference bit, known bit lengths. Operator-stated values only.
- `get_tool_setter_config` — read it back.
- `run_tool_setter` — tool height measurement as one approved, envelope-bounded routine: sensor-gated 1 mm descent, release, 0.1 mm approach, confirm pass, then a Z-only raise straight up to the traverse height (machine Z328 — never the start height; `result.finalZ`). Hard floor below expected trigger. `store_as_reference` locks the new reference; `stay_at_trigger` / `start_from_current` support the swap wizard.
- `apply_tool_length_offset` — confirmed `G92` shifting work Z by the new-minus-old tool length. Keeps the work origin true across a swap without re-touching stock.

## Touch-probe procedures (staged, one approval per circuit, results in machine coordinates)

- `probe_point` — one axis from the current position. The atom.
- `probe_vector` — probe along any downward or lateral unit vector.
- `probe_sequence` — enumerated hop / descend / probe circuit with law-2 hops at safe traverse height; keep-out boxes honoured at plan time.
- `probe_circle` — N radial marches plus least-squares circle fit, outside a boss or inside a hole. Reports rms and residuals.
- `probe_surface_path` — N minus-Z stations along a line: per-station contact, best-fit slope, flatness.
- `probe_surface_grid` — serpentine minus-Z grid: Z matrix, best-fit plane and residuals, ASCII height map. Both scans hop at last contact plus `z_safe_delta_mm`.
- `probe_stock_outline` — from an estimate of a block, find its top, true outline and centre in one approved procedure.
- `probe_program` — composite program: an ordered list of operations, derived references, jig geometry, keep-out and groups under one approval. The new-stock survey lives here. Op kinds: `rotate_b`, `surface_path`, `surface_grid`, `sequence`, `stock_outline`, `capture {x?, y?}` (a position- and B-stamped frame saved on the job record; with x/y it first hops there at the traverse height, travel- and obstacle-checked like a sequence hop, else no motion) and `home` (machine home, last op only, homes B too) — so "capture at (x, y), rotate_b 180, capture, home" is one click.
- `set_probe_geometry` — jig and tool constants a rotary `probe_program` can reference as the `axis` namespace. Measured or operator-stated, with a reason.

## CAM probing programs

- FreeCAD side: `docs/post/freecad_probe_emitter.py` writes a `run_probing_gcode` program with `(PROBE ...)` nominals, normals and tolerances read straight off the selected faces (the Path Probe operation carries none of that, so it is bypassed, along with the post processor). `frame="machine"` + a measured `App.Placement` for a re-clamped part.

- `run_probing_gcode` — stage a CAM-generated probing program (Fusion 360, FreeCAD, any Grbl/Marlin post, or hand-written). `G38` cycles are translated into staged probes, never sent raw. Returns an inspection report.
- `get_inspection_report` — re-render a finished or aborted probing run's report in another format, such as Fusion's.

## Standing rules the tools assume

- The endmill is always in the spindle; never plan as if the collet is empty.
- Any XY move over 1 mm is planned at the safe traverse height - machine Z328 (home). Landmarks are honoured literally: a hop at 328 clears them on its own merits, a lower hop is checked like any low segment.
- No Z motion without a direct request. "Home" always means machine home.
- Approval covers one bounded series of moves and never carries forward. A staged procedure or program is ONE approval for every move inside its envelope — the efficient lawful form.
- Every motion tool stages a job: call `start_gcode_job` with `wait_for_approval_ms` after staging; the operator's click starts it. Hand the confirm URL over as the last line of the message, alone.
- Agents plan, stage, record and quote in MACHINE coordinates. Every staged job declares its frame or is refused; `G90`/`G91` is distance mode, not a frame; never a bare frameless `Z`.
- The work origin is the operator's (touchscreen, Luban, tool-change wizard). Read it fresh from `get_position`; never assume it; never write it except through `apply_tool_length_offset`.
- `get_position.machine` is the judged position of record with a `reliability`; a reading more than 50 mm outside the travel is a bug, never a position, and is ignored until the next coherent beat. Do not derive a machine position from one heartbeat by hand.
- Canonical agent guidance: `.claude/skills/cnc-motion-rules/SKILL.md`.
