# Luban MCP tool surface (47 tools)

Terse per-tool reference. Machines: A350 = CNC, F350 = printer. Motion tools stage a job and
need one operator click on the confirm page; nothing moves on an agent's word alone. Results
quote coordinates with their frame (machine vs work). Call `get_stored_state` first in a fresh
session.

## Orientation and status (read-only)

- `get_stored_state` — everything known in one call: calibrations, landmarks, tool region, limits, camera, connection, probe feed. Start here.
- `get_connection_status` — is Luban connected to a machine, over what channel.
- `get_machine_profile` — kinematics, work envelope, toolhead module offsets.
- `get_position` — machine and work coordinates together, warns when firmware reporting is incoherent.
- `query_firmware_position` — raw `M114`; use when `get_position` looks suspect.
- `get_mcp_diagnostics` — event-loop stalls and timing evidence for slow or aborted procedures.
- `get_job_timing` — where a job's time went, from its event log; works for running, done and failed jobs.

## G-code jobs

- `validate_gcode` — static inspection: extents vs envelope, spindle state, distance-mode hazards. Free, run before submitting.
- `submit_gcode_job` — stage a file or direct-command job; returns the confirm-page URL for the operator.
- `start_gcode_job` — run an approved job; returns the result if it lands within `wait_ms` (default 25 s), else `running`.
- `get_gcode_job_status` — event log plus stored result; long-poll with `wait_ms` / `since_event` instead of spinning.
- `stop_gcode_job` — procedures stop cooperatively at the next step and raise; file jobs get a firmware stop. Partial result kept.

## Direct motion (each is one approved job)

- `home` — machine home (`G28`). Default first step after (re)connecting; raises Z first and clears stale position state.
- `goto_work_origin` — move to work X0 Y0. Distinct from `home`.
- `move_z` — single Z target or a `z_targets` batch. Only on the operator's explicit request.
- `move_and_capture` — one guarded XY move followed by a position-stamped frame; the unit of visual alignment.
- `goto_tool_change_position` — two approved steps: Z up, then XY to the operator-set park spot.

## Camera and vision

- `list_cameras` — enumerate capture devices (DirectShow names on Windows, `/dev/v4l/by-id` on Linux).
- `capture_frame` — position-stamped frame with a `frameId`, the expected tool region, and nearby landmarks. Cached (last 12).
- `set_tool_region` — tell the server where the tool appears in frame so captures can flag it.
- `track_feature` — normalised cross-correlation of a template between two cached frames. Use instead of eyeballing pixels.
- `set_camera_calibration` — Y/Z-keyed pixel-to-mm calibration, optional `surface` depth tag and `jacobian`. Sign-flipped matrices are rejected.
- `get_camera_calibration` / `delete_camera_calibration` — read or remove a stored calibration.
- `visual_servo` — one clamped step toward a seen target per call. Trips when the error stops shrinking or the response diverges from the calibration prediction (parallax signature).
- `survey_bed` — approved serpentine XY camera grid at gantry height; whole-bed mosaic for finding stock and fixtures.

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
- `run_tool_setter` — tool height measurement as one approved, envelope-bounded routine: sensor-gated 1 mm descent, release, 0.1 mm approach, confirm pass, retreat. Hard floor below expected trigger. `store_as_reference` locks the new reference; `stay_at_trigger` / `start_from_current` support the swap wizard.
- `apply_tool_length_offset` — confirmed `G92` shifting work Z by the new-minus-old tool length. Keeps the work origin true across a swap without re-touching stock.

## Touch-probe procedures (staged, one approval per circuit, results in machine coordinates)

- `probe_point` — one axis from the current position. The atom.
- `probe_vector` — probe along any downward or lateral unit vector.
- `probe_sequence` — enumerated hop / descend / probe circuit with law-2 hops at safe traverse height; keep-out boxes honoured at plan time.
- `probe_circle` — N radial marches plus least-squares circle fit, outside a boss or inside a hole. Reports rms and residuals.
- `probe_surface_path` — N minus-Z stations along a line: per-station contact, best-fit slope, flatness.
- `probe_surface_grid` — serpentine minus-Z grid: Z matrix, best-fit plane and residuals, ASCII height map. Both scans hop at last contact plus `z_safe_delta_mm`.
- `probe_stock_outline` — from an estimate of a block, find its top, true outline and centre in one approved procedure.
- `probe_program` — composite program: an ordered list of operations, derived references, jig geometry, keep-out and groups under one approval. The new-stock survey lives here.
- `set_probe_geometry` — jig and tool constants a rotary `probe_program` can reference as the `axis` namespace. Measured or operator-stated, with a reason.

## CAM probing programs

- `run_probing_gcode` — stage a CAM-generated probing program (Fusion 360, FreeCAD, any Grbl/Marlin post, or hand-written). `G38` cycles are translated into staged probes, never sent raw. Returns an inspection report.
- `get_inspection_report` — re-render a finished or aborted probing run's report in another format, such as Fusion's.

## Standing rules the tools assume

- The endmill is always in the spindle; never plan as if the collet is empty.
- Any XY move over 1 mm is planned at safe traverse height.
- No Z motion without a direct request. "Home" always means machine home.
- Approval covers one bounded series of moves and never carries forward.
