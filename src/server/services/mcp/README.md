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
  tools/         status, machine, gcode, camera, calibration registrations
```

UI integration: verbose console toggle (Workspace) mirrors heartbeat position changes,
every MCP-sent gcode line and controller reply (`[mcp:home] > G28` / `< X:-19.00 ...`),
and tool activity — all timestamped. Events: `mcp:activity`, `mcp:gcode` (whitelisted in
`socket-communication.ts`).

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
- **Machine home = (−19, 342, 328)**; homing = `G53;G28;G54` exactly like Luban's button
  (a bare G28 leaves reporting in an unselected workspace → impossible derived coords like
  Y 464/Z 656). Homing takes ~15–20 s and **also homes B — stock on the rotary rotates**.
- **Work origins are operator-set per workspace and persist across homing.**
- **The firmware parks at the work origin when a file job COMPLETES** — file jobs cannot
  hold a position; that is why `move_z` exists on the direct path.
- Heartbeat period ~1 s; a settled-looking heartbeat can predate the motion (hence the
  verified-settle contract). `query_firmware_position` (M114) is the authoritative check.
- Camera is **toolhead-mounted** (rides X/Z; the platform moves under it in Y): pixel→mm
  calibration is keyed by machine Y AND Z. The board-viewing anchor pose is the pre-home
  park (machine X0/Y0), not machine home. The **gold cylinder at machine Y≈176–340 is the
  TOOL HEIGHT CHECKER** (operator-confirmed; was misidentified twice).
- Fleet: machine named "Snapmaker" @ 192.168.1.173 = the A350 CNC; "F350" @ .130 = the
  3D printer. Same Luban profile identifier — distinguish by NAME/address, never profile.

## Tool surface (24)

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
landmarks, tool region, limits, camera config, connection — call this first in a fresh
session).

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
