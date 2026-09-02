# Luban MCP server

An MCP (Model Context Protocol) server inside the Luban backend, exposing the connected
Snapmaker machine to local AI agents over guarded, operator-gated tools. Built and
hardware-verified against a Snapmaker 2.0 A350 (CNC, 200 W toolhead, rotary module,
bracing kit) during 2026-08; this file is the durable record of the design, the machine
facts learned on hardware, and the development workflow — written so a fresh session can
continue the work without re-deriving any of it.

## Enabling and configuration

Off by default. The server configstore is `~/.snapmaker-luban.json` (shared with the
official Luban); the Settings → MCP Server pane edits the main keys, `GET/POST /api/mcp`
serves them, and `LUBAN_MCP_PORT` (env) overrides everything for one run.

| Key | Meaning |
|---|---|
| `mcpEnabled`, `mcpPort` | Start the server on 127.0.0.1:port (default 40889). Legacy: `mcpPort` alone enables when `mcpEnabled` was never written. |
| `mcpCameraUrl` | HTTP(S) snapshot URL; takes precedence over ffmpeg. |
| `mcpFfmpegPath`, `mcpCameraDevice`, `mcpCameraLastGood` | ffmpeg DirectShow capture. Device choice is sticky (last-good preferred); a vanished device is an error, never a silent substitution. |
| `mcpMaxJogDistance` | Per-call XY travel cap for direct moves, default 100 mm. `goto_work_origin` is exempt (fixed operator-set destination). |
| `mcpToolRegion` | Fractional box where the endmill images (fixed camera-to-spindle geometry); returned with every frame; settable via the `set_tool_region` tool. |
| `mcpInstalledModules` | e.g. `["snapmaker-2.0-bracing-kit-module"]` — feeds effective work ranges in `get_machine_profile`. |
| `mcpMqtt*` | Probe sensor feed (MQTT): `Host`, `Port` (default 8883 = TLS, 1883 = plain), `User`, `Pass`, `ClientId` (default = username + MAC bytes), `FeedToolsetter`, `FeedOvertravel`, `FeedProbe` (Adafruit IO feed key, or a full topic when it contains `/`), `Inverted` (comma-separated channels whose sensor idles HIGH and reads low on contact — the operator's CNC touch probe is normally open, so `"probe"`). Env `LUBAN_MCP_MQTT_HOST/PORT/USER/PASS/CLIENT_ID/FEED_TOOLSETTER/FEED_OVERTRAVEL/FEED_PROBE/INVERTED` override field-by-field. |

A project-scope `.mcp.json` at the repo root points Claude Code sessions at
`http://127.0.0.1:40889/mcp` automatically.

## Architecture

Own `http.Server` bound strictly to loopback — NOT a route on Luban's Express app (whose
`/api` carries the renderer session JWT and whose IP whitelist is LAN-wide). The MCP
transport is hand-rolled stateless Streamable HTTP (JSON-RPC over `POST /mcp`): Electron 15
embeds Node 16 and the official SDK needs ≥ 18. Zero added dependencies anywhere —
`jpeg-js` (tracking) was already in the tree; the lockfile has never changed.

```
mcp/
  index.ts       start/stop, config resolution, routing (/mcp, /confirm), mcpBroadcast
  McpServer.ts   JSON-RPC transport, per-call logging + mcp:activity broadcast
  registry.ts    tool registration/dispatch; McpToolError = tool-level failure
  jobs.ts        JobManager + human confirm pages (/confirm/<id>); job kinds file|direct
  validator.ts   static gcode inspection (extents, spindle, distance-mode hazards)
  camera.ts      capture providers, frame cache (last 12, frameId), sticky device
  tracking.ts    zero-mean NCC template matching between cached frames
  calibration.ts Y/Z-keyed pixel->mm calibration store (userDataDir, persists)
  mqtt.ts        minimal MQTT 3.1.1 client over net/tls (hand-rolled, no deps)
  probeFeed.ts   external probe sensor feed: config resolution (env->config),
                 last-reading cache per channel, overtravel tripwire latch
  toolSetter.ts  tool height measurement: config, envelope planner, staged runner
  tools/         status, machine, gcode, camera, calibration, probe, toolsetter
```

External probe sensors (tool height setter, overtravel switch, CNC touch probe) report
over a message feed, not the controller. The transport is abstracted behind
`ProbeFeedService`; the first implementation is MQTT (built for Adafruit IO:
`{user}/feeds/{key}` topics, TLS on 8883, and a `<topic>/get` publish primes the last
value on connect). The feed auto-connects at service start when fully configured, and
verified against public brokers over both plain TCP and TLS.

**Overtravel tripwire**: any triggered reading on the overtravel channel immediately
stops the running job, force-closes the machine connection, latches an alarm that blocks
every motion tool (`assertNoOvertravel` in `assertSafeToMove`, `home`, `move_z`,
`start_gcode_job`), and reports to the operator. The latch clears only via
`clear_overtravel_alarm` on the operator's explicit word (refused while the feed still
reads triggered) or an application restart. `disconnect_probe_feed` disarms the tripwire
— never disconnect while a probing procedure could run.

UI integration: verbose console toggle (Workspace) mirrors heartbeat position changes,
every MCP-sent gcode line and controller reply (`[mcp:home] > G28` / `< X:-19.00 ...`),
and tool activity — all timestamped. Events: `mcp:activity`, `mcp:gcode` (whitelisted in
`socket-communication.ts`).

## Motion laws (operator law after the 2026-09-01 probe crash)

An XY traverse at a fabricated "clearance" height (Z200, derived from assumptions about
the rotary stock's geometry — wrong twice over) destroyed the fitted touch probe. The
step had also been chained onto an approved Z move in one command, executing 117 ms after
it with no decision point, when the operator had authorised "step 1" only. Laws:

1. **One motion per instruction, no inferred approvals** — never chain motion tool calls
   in a single command or turn; each motion gets its own decision point. Enumerated steps
   run one at a time. Only an explicit imperative in the operator's latest message
   authorizes a motion; a motion mentioned in passing ("before homing", "then we'll…",
   a previously approved plan) is context, not a command — announce and wait.
2. **X/Y traverses at top gantry height** — direct XY moves below `mcpSafeTraverseZ`
   (default 320) are refused without `operator_confirmed_clearance`. Retreat, traverse,
   descend — in that order.
3. **No fabricated clearances** — only measured or operator-stated heights count. Visual
   inference finds things; it never clears them.
4. **Landmarks are obstacles** — `clearance_z` on a landmark refuses XY paths crossing its
   box below that height.
5. **Contact sensors are crash sensors** — a probe/toolsetter trigger during motion that no
   procedure declared as expected trips a CRASH alarm (stop + force-close + latch), the
   same machinery as overtravel; `clear_overtravel_alarm` clears either kind on the
   operator's explicit word. Feed readings and all gcode traffic are logged server-side.
6. The approved-code page re-shows the exact gcode next to the one-time code.
   **Chat is not a motion gate — the staged job is** (operator, 2026-09-02): deliberate
   traverses/descents go through staged jobs so authorization is the one-time code against
   the literal gcode, not a model's reading of chat wording. A "go" in chat only permits
   staging. Re-prove position (home) before a traverse when state is in any doubt,
   including after any motion that wasn't part of the agreed sequence.
7. **Use tools for their purpose** — `move_and_capture` is a vision reposition, not a
   transport primitive (its `reason` is required and shown to the operator); sequences of
   motion belong in the staged, operator-approved mechanisms (`survey_bed`, `move_z`
   batches, procedures, `submit_gcode_job`). Enforced: rapid sequential direct moves are
   warned then refused (pacing guard) — scripting a motion loop around the direct tools is
   an unsupervised procedure without a confirm page, which is what the crash was.
8. **The MCP surface is the only interface** — no agent may touch the machine, its
   configstore, or the backend APIs directly while the app runs; every guard lives in the
   tools, so bypassing them bypasses all of it.

## Safety model (operator-defined, non-negotiable)

- **Compound motion and all cutting goes out as gcode FILES** through the same
  `prepare_print`/`start_print` path as Luban's Start button, so the controller job state
  machine and the enclosure **door interlock** apply (fork issue #23). The direct
  (`execute_code`) path is reserved for single guarded actions.
- **Human confirm page** (`/confirm/<id>`, loopback + Origin-checked): shows validation,
  extents, warnings, and for direct moves a banner stating the interlock does NOT apply.
  Approval mints a one-time code (15 min TTL) that is never returned over MCP — a model
  cannot self-authorise motion. Batch direct jobs: one approval covers an exact target
  list; each `start_gcode_job` call executes one step.
- **Z policy**: no Z through XY tools, ever. `move_z` = per-move operator confirmation
  showing current Z, target, delta, feed. Every request needs a `reason`.
- **Guards on every direct move**: machine idle, toolhead off (headStatus/headPower),
  homed-first (override `operator_confirmed_clearance` only on the operator's explicit
  word), travel cap, build-envelope check with overtravel allowance (machine −25..+40 —
  X home rests at −19).
- **Verified-settle contract**: motion tools block until the returned position verifiably
  matches the move (Z parsed from the executed gcode, ±0.15 mm; XY at target; home must
  leave its pre-G28 position at least once). `wait_until_moved: false` opts out and always
  returns `position_verified: false` with a poll instruction. `capture: false` = verified
  move without a frame.
- The endmill is ALWAYS in the collet; the rotary is fitted and may hold stock. Report
  dimensions with uncertainty. See `.claude/skills/cnc-visual-alignment/` for the full
  vision methodology.

## Machine facts (hardware-verified 2026-08-30)

- Controller has **G53 (machine workspace) and G54+ (numbered workspaces)**; the heartbeat
  `pos` is in the *currently selected* workspace. Convention everywhere:
  `machine = work − originOffset`.
- **Machine home = (−19, 342, 328)**; **firmware X limit = 339** (sweep-verified 2026-09-01:
  tracks requests exactly through 330, clamps a 340 request at 339 — the tool-change park X);
  homing = `G53;G28;G54` exactly like Luban's button
  (a bare G28 leaves reporting in an unselected workspace → impossible derived coords like
  Y 464/Z 656). Homing takes ~15–20 s and **also homes B — stock on the rotary rotates**.
- **Work origins are operator-set per workspace and persist across homing.**
- **The machine interpreter returns to Z top at the job's finish position when a file job
  COMPLETES** (operator-clarified 2026-09-02; supersedes the earlier "parks at the work
  origin" reading — Z top and this setup's work-origin Z are both 328, which hid the
  difference). XY holds; Z does not — that is why `move_z` exists on the direct path.
  The job-concept split that matters: machine-interpreter (file) jobs get the door-detector
  emergency stop; MCP direct single-command ops do NOT.
- Heartbeat period ~1 s; a settled-looking heartbeat can predate the motion (hence the
  verified-settle contract). `query_firmware_position` (M114) is the authoritative check.
- Camera is **toolhead-mounted** (rides X/Z; the platform moves under it in Y): pixel→mm
  calibration is keyed by machine Y AND Z. The board-viewing anchor pose is the pre-home
  park (machine X0/Y0), not machine home. The **gold cylinder at machine Y≈176–340 is the
  TOOL HEIGHT CHECKER** (operator-confirmed; was misidentified twice).
- **Tool setter: centre at machine (X79, Y293), top-left of bed. MEASURED trigger Z 175.500
  with the 75 mm reference endmill (three confirm passes agreed, spread 0)** — so the setter
  SURFACE is machine Z 100.5, and expected trigger Z for a bit of length L is
  `175.5 + (L − 75)`. Config + measurement history live in `mcpToolSetter`.
- **Touch probe (measured 2026-09-01): effective length 71.1 mm** (trigger on the setter at
  machine Z 171.6 ⇒ any surface = probe contact toolhead Z − 71.1). The probe's AXIAL
  spring is stiffer than the setter's switch, so on the setter the SETTER fires first —
  measuring the probe there is safe with `accept_probe_contact: true` (either channel
  confirms). Probe feed latency, hardware-measured: **~120–150 ms** sensor→feed on a local
  bump test (trigger message 452 ms after move issue incl. ~330 ms motion) — the 200 ms
  contact windows are correctly sized.
- **Camera offset**: the toolhead camera looks roughly **90–150 mm in −X** of the toolhead
  (setup-specific — verify per rig): features at machine X appear in frames taken from
  toolhead X+90..150. The far-X column of a bed survey is therefore the only view of the
  bed centre-right.
- **Bed map (operator-stated + survey 25c4f87a, 2026-09-01)**: rotary module along the bed
  centre at **machine X≈170**, axis along Y, chuck at the back (~Y250–320), yellow tailstock
  at the front; tool setter top-left. Both stored as landmarks (`rotary-axis`,
  `tool-setter`).
- **Silent non-motion signature**: the controller can reply `ok` to a direct move and not
  move at all (settle times out with position unchanged; observed once 2026-09-01, suspected
  enclosure door open — unconfirmed). The verified-settle contract catches it; do not trust
  an `ok` alone.
- Fleet: machine named "Snapmaker" @ 192.168.1.173 = the A350 CNC; "F350" @ .130 = the
  3D printer. Same Luban profile identifier — distinguish by NAME/address, never profile.

## Tool surface (33)

`get_connection_status` · `get_machine_profile` (kinematics, module offsets) ·
`get_position` (both frames, warnings on incoherent reporting) ·
`query_firmware_position` (raw M114) · `validate_gcode` · `submit_gcode_job` →
`start_gcode_job` → `get_gcode_job_status` / `stop_gcode_job` · `move_z` (single or
`z_targets` batch) · `home` · `goto_work_origin` · `move_and_capture` · `list_cameras` ·
`capture_frame` (position-stamped, `frameId`, `expectedToolRegion`) · `set_tool_region` ·
`track_feature` (NCC between cached frames — use instead of eyeballing pixels) ·
`set_/get_/delete_camera_calibration` (Y/Z-keyed; optional `surface` depth-plane tag;
optional `jacobian` REJECTS sign-flipped matrices, M·J ≈ −I) · `visual_servo` (one clamped
step per call; trips when the error fails to shrink OR when the measured response diverges
from the calibration prediction — the depth-plane parallax signature) ·
`set_landmark` / `delete_landmark` (named scene features by machine extent; nearby ones are
surfaced on every capture) · `get_stored_state` (one-call orientation: calibrations,
landmarks, tool region, limits, camera config, connection, probe feed — call this first in
a fresh session) · `get_probe_feed_status` · `connect_probe_feed` / `disconnect_probe_feed`
(MQTT sensor feed; connecting arms the overtravel tripwire) · `clear_overtravel_alarm`
(operator's explicit word only) · `set_/get_tool_setter_config` (setter centre, trigger Z
with a reference bit, bit lengths — operator-stated) · `run_tool_setter` (tool height
measurement: ONE operator approval covers a server-driven envelope-bounded routine — XY to
centre, Z to `triggerZ + (longest−ref) + 50`, 1 mm sensor-gated descent, release, 0.1 mm
approach, 0.3 mm backoff, ≥2 s/0.1 mm confirm pass, retreat; hard floor at expected
trigger − margin; requires the probe feed connected and the toolsetter sensor readable
and untriggered; `store_as_reference` locks the measured Z in as the new reference;
`stay_at_trigger` / `start_from_current` support the touchscreen swap wizard) ·
`goto_tool_change_position` (two approved steps: Z up, then X/Y to the operator-set park) ·
`apply_tool_length_offset` (confirmed G92 shifting work-origin Z by the measured
new−old tool length difference — flow A only).

## Tool change workflows

**A — MCP-managed offset**: measure old tool (`run_tool_setter`) →
`goto_tool_change_position` (operator-set park: machine Z at homing height, X at the far
end, Y free — stored via `set_tool_setter_config` `tool_change_x/y/z`) → operator swaps by
hand → measure new tool → `apply_tool_length_offset` stages a single
`G92 Z(current work Z − (new−old))` for confirmation: nothing moves, the work frame shifts
so work Z 0 stays on the same physical plane. Measurement history (last/previous) persists
in the config; deltas over 50 mm are refused.

**B — touchscreen manual-swap wizard**: the firmware matches tip positions itself, so MCP
applies NO offset. `run_tool_setter` with `stay_at_trigger: true` measures and HOLDS the
tip in contact for the operator to confirm on the touchscreen; after the swap the wizard
returns the tool over the setter, and the second run adds `start_from_current: true`
(skips travel, verified over the centre within 1.5 mm). Never combine flow B with
`apply_tool_length_offset` — it would double-apply.

Full agent guidance in `.claude/skills/tool-change/SKILL.md`.

## Development workflow (learned the hard way)

- **Build**: Node 16 (`/c/dev/software/snapmaker/.tools/node-v16.20.2-win-x64`), python
  3.11 for node-gyp, `npm run build` (~4 min). gulp **exits 0 on failure**: require
  `Finished 'production'` and zero `errored` lines, and verify key strings in
  `dist/Luban/src/server/index.js`. NEVER build while any electron.exe from this worktree
  runs (EBUSY leaves dist half-deleted); count processes read-only first and ask the
  operator to close their copy. The build dirties `src/package.json` and
  `MaterialTestGcodeParams.jsx` — revert before staging.
- **Stack**: stacked single-commit PRs `mcp/N-*`, each targeting the previous branch
  (#15 → #49 as of writing; origin = Snapmaker/Luban is NEVER pushed). Mid-stack changes:
  amend + rebase the chain. commitlint enforces `Type: Sentence-case subject` (20–100
  chars).
- **Credentials**: active gh account is `tyeth-ai-assisted` (no push). Per-command
  override only: `GH_TOKEN=$(gh auth token -u tyeth)` for gh calls;
  `git -c "credential.helper=!f() { echo username=tyeth; echo password=$GH_TOKEN; }; f" push ...`.
  Never `gh auth switch`, never store the token.
- eslint judged against baseline (pre-existing errors in ConnectionManager/SstpHttpChannel
  stay); `npx tsc -p tsconfig-server.json --noEmit` filtered to `services/mcp` must be
  clean.

## Open threads

- **#50–#53 implemented** in `mcp/22-stored-state`: landmark registry (`set_landmark`,
  surfaced as `nearbyLandmarks` on captures within 120 mm), calibration `surface` tag +
  automatic Jacobian-prediction divergence warning in `visual_servo`, `expected_shift`
  tie-breaking in `track_feature` (reports `chosen_by`/`raw_best`), and `get_stored_state`.
  Seed the landmark registry with the tool height checker (machine Y≈176–340).
- **#38 startup socket.io gap** — properly belongs in the startup stack; hotfixed here.
- **#24 measurement systems, #25 collision watcher** — designed but not started.
- **CNC touch probe (next)**: a normally-open touch probe in the spindle, reporting on the
  probe feed channel (config already carries `mcpMqttFeedProbe`), combined with the camera
  to measure work from the top and sides in any position including on the rotary axis.
  Long term: a manual probe/inspection file driving a probing session, and a report
  exportable to CAD/CAM (Fusion + free tools). The tool setter's staged
  approach/release/confirm runner in `toolSetter.ts` is the motion template.
- **Future probe transports (operator-stated 2026-08-31)**: MQTT may be replaced or joined
  by hardwired USB-GPIO, or an HTTP service (e.g. a Pi running Python with a USB camera
  plus GPIOs for the contact sensors). The transport contract is the `ProbeFeedService`
  surface (`connect/disconnect/getReading/waitForReading/assertNoOvertravel/status`) —
  consumers never see MQTT; a new backend implements that surface and feeds the same
  reading cache and overtravel latch. Sensor latency is transport-dependent: local GPIO
  would let `sensor_delay_ms` and the release timeouts collapse to near zero. The Pi's
  camera half already fits `mcpCameraUrl` (any HTTP snapshot endpoint), so one box could
  serve both.
