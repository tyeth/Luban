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
| `mcpAllowLan` | Default off = loopback only. On: bind every interface but accept only clients (and browser origins) on this machine's own IPv4 subnets; confirm-page links use the LAN address. **No authentication exists** — anyone on that subnet can command the machine; the pane warns in red. Env `LUBAN_MCP_ALLOW_LAN` overrides. Applies at the next start. |
| `mcpToolSetterEnabled`, `mcpProbeToolEnabled` | Default on. Off = that sensor's channel is never bound on any transport (overtravel follows the tool setter): no pill, no readings, and procedures needing it refuse with a clear message. Use when the sensor or the USB bridge is not fitted. Env `LUBAN_MCP_TOOLSETTER_ENABLED` / `LUBAN_MCP_PROBE_ENABLED` override. |
| `mcpCameraUrl` | HTTP(S) snapshot URL; takes precedence over ffmpeg. |
| `mcpFfmpegPath`, `mcpCameraDevice`, `mcpCameraLastGood` | ffmpeg capture — DirectShow on Windows (device = friendly name), v4l2 on Linux (device = a `list_cameras` entry, preferably the stable `/dev/v4l/by-id/… (Name)` form; a bare `/dev/videoN` works but renumbers on replug). Device choice is sticky (last-good preferred); a vanished device is an error, never a silent substitution. |
| `mcpMaxJogDistance` | Per-call XY travel cap for direct moves, default 100 mm. `goto_work_origin` is exempt (fixed operator-set destination). |
| `mcpToolRegion` | Fractional box where the endmill images (fixed camera-to-spindle geometry); returned with every frame; settable via the `set_tool_region` tool. |
| *(machine, toolheads, modules)* | **Not MCP keys.** `get_machine_profile` / `get_stored_state` read the machine, toolheads and installed add-on modules (bracing kit, quick-swap) from Luban's own **Machine Settings** (`userData/machine.json`, `state.machine`) on every call — change them in the app (it returns to its home page) and the MCP follows. `mcpInstalledModules` is gone (2026-09-05). |
| `mcpMqtt*` | Probe sensor feed (MQTT): `Host`, `Port` (default 8883 = TLS, 1883 = plain), `User`, `Pass`, `ClientId` (default = username + MAC bytes), `FeedToolsetter`, `FeedOvertravel`, `FeedProbe` (Adafruit IO feed key, or a full topic when it contains `/`), `Inverted` (comma-separated channels whose sensor idles HIGH and reads low on contact — the operator's CNC touch probe is normally open, so `"probe"`). Env `LUBAN_MCP_MQTT_HOST/PORT/USER/PASS/CLIENT_ID/FEED_TOOLSETTER/FEED_OVERTRAVEL/FEED_PROBE/INVERTED` override field-by-field. |
| `mcpProbeTransport` | Which probe feed backend: `mqtt` or `gpio`. Unset = auto: `mqtt`, unless only the GPIO side is configured. Env `LUBAN_MCP_PROBE_TRANSPORT` overrides. |
| `mcpGpio*` | Probe sensor feed (direct GPIO via Adafruit Blinka, default over U2IF — a Pi Pico as USB GPIO bridge): `PinToolsetter`, `PinOvertravel`, `PinProbe` (Blinka pin name with optional pull suffix, e.g. `GP6:up`, `GP7:down`, `GP8` = floating), `Inverted` (same semantics as the MQTT field — a pull-up NO switch idles `1`, so its channel goes here), `Python` (interpreter with `adafruit-blinka` installed, e.g. the venv's; default `python3`/`python`), `PollMs` (default 10, clamp 2–1000), `BlinkaEnv` (NAME=VALUE pairs handed to the monitor so Blinka picks the board — default `BLINKA_U2IF=1`; `BLINKA_MCP2221=1`, `BLINKA_FT232H=1`, `BLINKA_FORCEBOARD=…`, or `native` for on-board GPIO). Env `LUBAN_MCP_GPIO_PIN_TOOLSETTER/PIN_OVERTRAVEL/PIN_PROBE/INVERTED/PYTHON/POLL_MS/BLINKA_ENV` override field-by-field. All of it is editable on Settings → MCP Server, which also flags active env overrides. |

A project-scope `.mcp.json` at the repo root points Claude Code sessions at
`http://127.0.0.1:40889/mcp` automatically.

## Installing

- **Release/CI builds**: the fork publishes no releases — installers come from CI
  artifacts. `Build on PR` (`build-on-pull-request.yml`) auto-runs only on pushes to
  `main`/`release/*`; for a feature branch dispatch it manually (Actions → Build on PR →
  Run workflow → pick branch + platforms, or `gh workflow run build-on-pull-request.yml
  --ref <branch> -f platforms=all`) and download the platform installer from the run's
  artifacts.
- **Ubuntu 23.10+ / AppArmor**: these releases restrict unprivileged user namespaces
  (`kernel.apparmor_restrict_unprivileged_userns=1`), which kills Chromium's sandbox — the
  app dies on launch with `Trace/breakpoint trap (core dumped)` (seen on Ubuntu 24.04,
  2026-09-04). The `.deb`/`.rpm` post-install (`build/linux-after-install.sh`) writes
  `/etc/apparmor.d/snapmaker-luban` granting `userns` (same shape Ubuntu ships for
  Discord/code) and reloads it; post-remove deletes it. For a package built before that,
  install the profile by hand once:
  `sudo tee /etc/apparmor.d/snapmaker-luban > /dev/null <<'EOF'` … (contents in the
  script) … `EOF && sudo apparmor_parser -r /etc/apparmor.d/snapmaker-luban`. Last-resort
  workaround: launch with `snapmaker-luban --no-sandbox` (also proves the diagnosis).
- **Local dev**: Node 16 + python 3.11 for node-gyp (details under Development workflow),
  `npm install`, then `npm run dev` (watch mode) or `npm run build` + `npm run
  start-electron` (production build; see the build caveats below).
- **Python venv — GPIO probe transport only**: `python3 -m venv .venv &&
  .venv/bin/pip install -r src/server/services/mcp/requirements.txt` (Windows:
  `.venv\Scripts\pip`), then point `LUBAN_MCP_GPIO_PYTHON` / `mcpGpioPython` at that
  interpreter. Nothing else needs Python at runtime. On Linux, if the monitor dies with
  an HID open/permission error, grant the user access to the Pico's hidraw device (udev
  rule) and re-plug.
- **ffmpeg — camera capture (Windows + Linux)**: install any ffmpeg build (`apt install
  ffmpeg` on Ubuntu) and set `mcpFfmpegPath` if not on PATH. Windows captures via
  DirectShow (device = friendly name); Linux via v4l2 — devices are enumerated from
  `/sys/class/video4linux` (capture nodes only, listed as
  `/dev/v4l/by-id/usb-…-video-index0 (Name)` — stable across replugs, unlike
  `/dev/videoN`, which renumbers when cameras come and go), and the user must be able to
  read `/dev/video*` (usually the `video` group). Pin `mcpCameraDevice` to the by-id
  entry from `list_cameras`, never to a bare `/dev/videoN`. macOS has no
  ffmpeg input wired up. `mcpCameraUrl` (HTTP snapshot, e.g. Android IP Webcam) remains
  platform-independent and takes precedence everywhere.

## Architecture

Own `http.Server` bound to loopback by default (`mcpAllowLan` widens it to this machine's own IPv4
subnets, with the same-subnet check on every request) — NOT a route on Luban's Express app (whose
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
  probeTransport.ts  probe channel names + the ProbeTransport contract
  probeFeed.ts   external probe sensor feed: config resolution (env->config),
                 last-reading cache per channel, overtravel tripwire latch,
                 transport selection + the MQTT backend
  gpioFeed.ts    GPIO backend: Blinka/U2IF python monitor subprocess (embedded
                 source, JSON lines: ready|reading|hb|fatal), stall watchdog
  toolSetter.ts  tool height measurement: config, envelope planner, staged runner
  tools/         status, machine, gcode, camera, calibration, probe, toolsetter
```

External probe sensors (tool height setter, overtravel switch, CNC touch probe) report
over a sensor feed, not the controller. The transport is abstracted behind
`ProbeFeedService` (contract in `probeTransport.ts`; readings, polarity, the alarm latch
and reconnect backoff all live in the service — backends only deliver raw values). Two
backends exist, selected by `mcpProbeTransport` / `LUBAN_MCP_PROBE_TRANSPORT`:

- **MQTT** (built for Adafruit IO: `{user}/feeds/{key}` topics, TLS on 8883, and a
  `<topic>/get` publish primes the last value on connect); verified against public
  brokers over both plain TCP and TLS. Change-reporting: silence means unchanged.
- **GPIO** (2026-09-03): sensors wired to pins read through Adafruit Blinka, by default
  via U2IF (a Pi Pico as a USB GPIO bridge, `BLINKA_U2IF=1`). Blinka is Python, so the
  transport spawns a monitor subprocess (`python -c`, source embedded in `gpioFeed.ts`)
  that polls the pins (default 10 ms) and streams JSON lines: `reading` on change plus a
  1 s heartbeat with all values. The heartbeat doubles as a liveness watchdog (silent
  ≥5 s ⇒ kill + reconnect) and refreshes reading ages without log/broadcast spam; trip
  decisions stay on change events, matching MQTT semantics. Pin config carries the pull
  (`GP6:up`); polarity stays in the shared `inverted` mechanism. Latency is poll + USB
  round-trip (single-digit ms vs MQTT's measured ~120–150 ms). Verified against a real
  PICO_U2IF (board detect, pulls, heartbeats) and a stubbed Blinka (change detection,
  fatal paths incl. unknown-pin reporting the board's available pins).

The feed auto-connects at service start when fully configured. **Tolerance**: if the sensor
bridge is unplugged (Blinka: "BLINKA_U2IF … no compatible device found") the GPIO transport
reports `bridge: not detected`, the service retries with backoff but logs each distinct error
once (attempt logs thin out after the third), `get_probe_feed_status` shows
`unavailable: true`, pills stay yellow, and every sensor-gated procedure refuses via
`assertChannelReady`. Operators who know a sensor is absent switch it off instead
(`mcpToolSetterEnabled` / `mcpProbeToolEnabled`): a disabled channel is unbound everywhere.

**Overtravel tripwire**: while a sensor-gated procedure is running (the tool setter /
probing runners declare expected contacts for their whole run) or MCP direct motion is in
flight (`procedureArmed()`), a triggered reading on the overtravel channel immediately
stops the running job, force-closes the machine connection, latches an alarm that blocks
every motion tool (`assertNoOvertravel` in `assertSafeToMove`, `home`, `move_z`,
`start_gcode_job`), and reports to the operator. The latch clears only via
`clear_overtravel_alarm` on the operator's explicit word (refused while the feed still
reads triggered) or an application restart. Outside that window — machine idle, operator
pressing the switch by hand — it is logged and broadcast (`overtravel_unarmed`) but does
NOT latch (operator decision 2026-09-04: "we only care about the overtravel alarm latching
during a tool height test, not for general use"). `disconnect_probe_feed` disarms the
tripwire — never disconnect while a probing procedure could run.

**Sensor pills** (Workspace → Connection, beside the module badges): Probe / Tool Setter /
Setter Overtravel, each yellow (unknown: feed not connected, no reading yet), green (idle)
or red (in contact) — a visual bump-test aid. A red pill with an **ALARM** marker is the
safety LATCH, not the sensor: it survives reconnects and clears only on the operator's
word — the pill's **Clear alarm** button (confirm dialog → `POST /api/mcp/clear-alarm`,
the operator's own click) or the `clear_overtravel_alarm` tool — or a restart; both paths
refuse while the sensor still reads triggered. Hand bump tests with the machine idle no
longer latch (see the tripwire arming rule above) — the pill just goes red while pressed.
Seeded from `GET /api/mcp` (`probeFeed`), driven live by `mcp:activity` (`probe_feed`
readings / connected / disconnected / alarms), reconciled by a 10 s poll.

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
2. **X/Y traverses at top gantry height — ALL of them** (operator, 2026-09-02: "x/y motion
   over 1mm is never below gantry height"). Any XY move over 1 mm is planned at the safe
   traverse height — no local hops above a measured feature, no other "measured safe"
   heights. Retreat, traverse, descend — in that order. Sub-gantry XY is only fine
   positioning <= 1 mm (touch nudges, probe march steps). Enforced: direct XY below
   `mcpSafeTraverseZ` (default 320) refused without `operator_confirmed_clearance`, which
   is for emergencies on the operator's explicit words, not a planning device.
3. **No fabricated clearances** — only measured or operator-stated heights count. Visual
   inference finds things; it never clears them.
4. **Landmarks are obstacles** — `clearance_z` on a landmark refuses XY paths crossing its
   box below that height.
5. **Contact sensors are crash sensors** — a probe/toolsetter trigger during motion that no
   procedure declared as expected trips a CRASH alarm (stop + force-close + latch), the
   same machinery as overtravel; `clear_overtravel_alarm` (or the Workspace pill's Clear
   alarm button) clears either kind on the operator's explicit word. Motion is "in
   flight" inside `moveMachineSettled` (every procedure move, since 2026-09-04) and
   `move_and_capture`. Feed readings and all gcode traffic are logged server-side.
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
- **Bed = 320 × 340 × 330 mm (X/Y/Z), with extra travel on BOTH ends of every axis**
  (operator, 2026-09-02) — matching the observed extremes below.
- **Machine home = (−19, 342, 328)**; **firmware X limit = 339** (sweep-verified 2026-09-01:
  tracks requests exactly through 330, clamps a 340 request at 339 — the tool-change park X);
  homing = `G53;G28;G54` exactly like Luban's button
  (a bare G28 leaves reporting in an unselected workspace → impossible derived coords like
  Y 464/Z 656). Homing takes ~15–20 s and **also homes B — stock on the rotary rotates**.
- **Work origins are operator-set per workspace and persist across homing — but NOT across
  machine reboots** (operator, 2026-09-02): a rebooted machine gets a new work origin, so
  never assume it carries over between sessions; re-verify `originOffset` after every
  (re)connect before trusting work coordinates.
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
- Fleet, continued: a Snapmaker **Ray** exists but rarely comes online. Machine tokens are
  also backed up in other configs in the Luban user data folder.
- **Rotary stock (measured 2026-09-02, 71.2 mm probe, machine coords)**: square wooden stock
  in the chuck, flat side up at B0. Top 207.7 at (170, 195) — physical 136.5 — rising ~+0.9
  toward the free end (207.3–207.5 at Y250; 208.0–208.2 at Y140; 207.1/206.7 at Y270, 1 mm
  from the chuck jaws — **jaws reach ~Y269**). Sides E≈205.4 / W≈133.5 (width ≈69.5,
  centre X≈169.5); end face contact Y128.9 (exposed span ~Y130–300). The W side at Y140 was
  flaky (twice lost the confirm re-contact — local chamfer/fibre?). Stock-top figures are
  B-dependent (square stock rotates with B).
- **Chuck fixed hole (probe_circle INSIDE mode, 8 points, rms 0.021, max residual 0.041)**:
  centre (168.974, 290.969), hole − tip 3.734. Cross-feature constraint: air-blast post
  diameter + hole diameter = **10.41 mm exactly** (tip-independent); the operator estimates
  (post ~6, tip ~2.5, hole 5–9) were mutually inconsistent by ~1.8 — one caliper measurement
  pins all three.
- **Standing operator rules not enforced in code** (state them, don't infer around them):
  the endmill is **always left in the spindle** — never assume an empty collet, even for
  "safe" test moves; **home first is the default** before direct motion after (re)connecting
  (G28 raises Z first and clears stale position state) unless the operator explicitly
  confirms current Z and a clear path; **"Home" ALWAYS means machine home** (G28), moving to
  work X0 Y0 is the distinct "Goto Work Origin"; quote every position with its coordinate
  system; and **browser-approval delegation never carries forward** — if the operator lets
  the agent click Approve for one bounded series of moves, that authority ends with that
  series ("no approvals carry forwards in CNC work").

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
(sensor feed over MQTT or Blinka GPIO; connecting arms the overtravel tripwire) ·
`clear_overtravel_alarm`
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
  (#15 → #73 as of 2026-09-04: tip `mcp/39-linux-mac-packaging`, next `mcp/40`; #70 stale-
  heartbeat, #71 probe_sequence, #72 GPIO probe feed, #73 Linux/mac packaging; origin =
  Snapmaker/Luban is NEVER pushed). Mid-stack changes:
  amend + rebase the chain. commitlint enforces `Type: Sentence-case subject` (20–100
  chars).
- **Credentials**: active gh account is `tyeth-ai-assisted` (no push). Per-command
  override only: `GH_TOKEN=$(gh auth token -u tyeth)` for gh calls;
  `git -c "credential.helper=!f() { echo username=tyeth; echo password=$GH_TOKEN; }; f" push ...`.
  Never `gh auth switch`, never store the token.
- eslint judged against baseline (pre-existing errors in ConnectionManager/SstpHttpChannel
  stay); `npx tsc -p tsconfig-server.json --noEmit` filtered to `services/mcp` must be
  clean.
- **Claude Code caches MCP tool schemas at session start**: after a server rebuild that adds
  or changes tool arguments, the client strips the new args (`additionalProperties: false`)
  until Claude Code restarts — or use a raw JSON-RPC helper
  (`C:/dev/software/snapmaker/.tools/mcp-call.js`, or a urllib one-liner against
  `http://127.0.0.1:40889/mcp` on the box) in the meantime.
- **Where operator state lives** (per machine running Luban — it does NOT sync between
  rigs): configstore `~/.snapmaker-luban.json` (`mcp*` keys incl. `mcpToolSetter`,
  `mcpToolRegion`, `mcpSafeTraverseZ`, `mcpMaxJogDistance`); userData
  (`%APPDATA%/snapmaker-luban` or `~/.config/snapmaker-luban`): `machine.json` (the app's
  Machine Settings), `mcp-landmarks.json`, `mcp-camera-calibration.json`, `mcp-surveys/`.
  While Luban runs, change state only through the MCP tools (`set_tool_setter_config`,
  `set_landmark`, `set_tool_region`, `set_camera_calibration`) or the app UI — the
  configstore file is rewritten on save. Migrating a second rig = replaying those tool calls
  and copying `mcp-surveys/`.
- **Startup facts**: cold services-ready was ~13 s → ~6 s post-reboot after the server bundle
  (#57), ~0.7 s warm; the remaining cold cost is the keep-external packages. A Chromium HSTS
  file can replace the userData directory ~11 s after launch (boot/quit guards rename it
  aside, #63). Dev runs report app version 15.5.7 to the updater (Electron's own version —
  benign).
- **Assistant-tooling gotchas**: on Windows Git Bash, python passed through a Bash heredoc
  gets its backslashes halved (a written `\r` arrives as a real CR) — build escapes with
  `chr(92)` or use the editor tools, and always re-read the patched line. skill-creator's
  scripts (validator/packager) read files in the locale codepage — run them with
  `PYTHONUTF8=1`; the canonical skill-creator source is `anthropics/skills` (takes external
  PRs), while `anthropics/claude-plugins-official` is a mirror that auto-closes external PRs;
  the UTF-8 fix already has open PRs upstream (#1591 et al.) — don't add another.

## Deployment notes: the Ubuntu MCP box (2026-09-04)

The second rig (x86_64 Ubuntu 24.04, Celeron N4020, hostname `pi-iOTA-Flo-360`, user `pi`,
LAN 192.168.1.153 — not a Raspberry Pi) runs the `.deb` with the GPIO probe transport and the
toolhead camera. Everything a fresh install needs:

- **Sensor bridge**: an Adafruit **KB2040** running U2IF (`239a:0105`, Blinka board id
  `KB2040_U2IF`, pin names `D*`/`A*`). Wiring (operator, bump-tested 2026-09-04): probe
  **A0** (idles driven HIGH → `inverted`), tool setter contact **D2** (idles LOW), setter
  overtravel **D3** (idles LOW); all three lines are actively driven, so pulls are a
  don't-care in operation — configured fail-safe (`A0:down`, `D2:up`, `D3:up`: a broken wire
  reads *triggered*). Pushing the setter plunger ~1 s past contact trips overtravel.
- **udev**: pip `hidapi` uses the **libusb** backend, so the rule must open the USB device,
  not just hidraw — `/etc/udev/rules.d/99-u2if.rules`:
  `SUBSYSTEM=="hidraw", ATTRS{idVendor}=="239a", ATTRS{idProduct}=="0105", MODE="0660", GROUP="plugdev", TAG+="uaccess"`
  and the same line with `SUBSYSTEM=="usb"`; then `udevadm control --reload-rules &&
  udevadm trigger`. Symptom without it: `OSError: open failed` from `hid.device.open`.
- **Verify wiring** with `.venv/bin/python src/server/services/mcp/gpio_bumptest.py --seconds 90`
  (reads the configstore, prints raw → idle/TRIGGERED, flags a resting-state-triggered
  channel = wrong polarity).
- **Cameras**: two are attached. The **toolhead camera is the Sonix "USB 2.0 Camera"**
  (pinned by `/dev/v4l/by-id/usb-Sonix_…-video-index0`); at the homed position it looks
  straight at the enclosure's aluminium extrusion, which reads as a near-field silver strut
  on a dark textured background — that IS the toolhead view, not a stray camera. The
  icspring camera (wide, warm view of the MDF wasteboard) is the other one. `/dev/videoN`
  numbers reshuffle on replug; always pin the by-id entry.
- **Launching**: Ubuntu 24.04 needs the AppArmor `userns` profile the `.deb` postinst
  installs (see Installing); until then `snapmaker-luban --no-sandbox`. To launch into the
  operator's GNOME/RDP session from ssh, borrow `DISPLAY`/`XAUTHORITY`/`WAYLAND_DISPLAY`
  from a session process's `/proc/<pid>/environ`.
- **State**: a fresh box has NO operator state — replay it through the MCP tools (see
  "Where operator state lives" above); this bit us on 2026-09-04 when an agent correctly
  refused to run the tool setter because the reference was empty.

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
- **Probe transports**: the USB-GPIO transport landed 2026-09-03 (Blinka/U2IF backend in
  `gpioFeed.ts`, behind the `ProbeTransport` contract — consumers still only see the
  `ProbeFeedService` surface). Remaining ideas from the 2026-08-31 operator note: an HTTP
  service (e.g. a Pi running Python with a USB camera plus GPIOs — its camera half
  already fits `mcpCameraUrl`), and UART sensors through the same U2IF Pico. With local
  GPIO the `sensor_delay_ms` contact windows and release timeouts can collapse to near
  zero — the defaults are still MQTT-sized, so tighten them per-call when running on
  gpio.

- **Procedure results only travel on the `start_gcode_job` response** — a client timeout
  loses them (recovered once from the motion log; `probe_sequence` aborts also drop
  completed results into the error text). Store the runner outcome on the job record.
- **`traverse_xy` staged batch tool** (law-2-compliant XY transport twin of `move_z`): hops
  currently need `submit_gcode_job` file jobs or `probe_sequence` hop steps.
- **Console bug**: MCP gcode broadcasts leak into the Workspace console INPUT element with
  raw ANSI codes.
- **#60 install size**: bundle/asar the main process, squeeze the remaining server externals.
- **`sensor_delay_ms` defaults are MQTT-sized** (200–300 ms); on the GPIO transport they can
  drop to ~50 ms — per call for now, a transport-aware default later.
