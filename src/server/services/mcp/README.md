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
  probing.ts     shared sensor-gated motion engine (moveMachineSettled, senseAfter, guards)
  probeTool.ts / probeVector.ts / probeSequence.ts / probeCircle.ts   staged probe procedures
  surfaceScan.ts pure station planning + flatness statistics (no imports; unit-tested alone)
  probeSurface.ts probe_surface_path / probe_surface_grid plan builders + runner
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
6. The approved-code page re-shows the exact gcode next to the approval.
   **Chat is not a motion gate — the staged job is** (operator, 2026-09-02): deliberate
   traverses/descents go through staged jobs so authorization is the operator's click on the
   confirm page against the literal gcode, not a model's reading of chat wording. Since
   2026-09-05 (operator request) that click can be **handed straight to a waiting agent**:
   `start_gcode_job` called with `wait_for_approval_ms` stays open until the click and starts
   the job with no code to relay (times out `approved: false` after ≤ 120 s; call again). The
   one-time code path remains, and Settings → MCP Server → Job approval can require it. A "go" in chat only permits
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

### Surface scans — the one bounded exception to law 2 (operator-authorised 2026-09-05)

`probe_surface_path` and `probe_surface_grid` measure a TOP surface with many −Z marches
in one approved circuit. The operator's words: *"with the grid we need the point to point
variation to not risk the probe toolhead so no more than 20mm z safe delta from the top
(within a horizontal change of 60mm)"*. Hence, **inside these two procedures only, between
consecutive stations only**, the probe retracts to `last contact + z_safe_delta_mm` and hops
horizontally at that height instead of at the gantry. Nothing else inherits this. Bounds
(`surfaceScan.ts`, refused at staging — never clamped or split silently):

- `z_safe_delta_mm` default 20, **hard cap 20** (min 3) — the hop height above the last real
  contact (`resolveEnvelope`).
- `max_hop_mm` default 60, **hard cap 60** — every consecutive station pair must be within
  it (`assertHopsWithin`); a spacing/pitch that violates it is refused naming the pair.
- `max_drop_mm` default 40, cap 80 — a station's march may search at most this far below the
  previous real contact, and never below `floor_z_machine` (default `start_z_machine −
  max_drop_mm`, the deepest Z the scan can ever command — on the confirm page). Reaching the
  floor without contact records the station `no_contact` and continues; the reference height
  stays the last real contact. The FIRST station finding nothing aborts (no measured
  reference to base the envelope on).
- `start_z_machine` is REQUIRED — measured or operator-stated, never guessed. The approach to
  station 1 is a full law-2 move: raise to the traverse height, hop, guarded 1 mm descent
  (`probe_sequence` pattern; contact = CRASH). Completion and abort both raise to the
  traverse height.
- Runtime (`probeSurface.ts`): hops go through `moveMachineSettled` with
  `clearExpectedContact()` in ≤ 10 mm sensor-checked segments, so a probe touch during a hop
  latches CRASH (law 5); only marches run with `setExpectedContact(['probe'])`. The staged
  position and every march start are re-checked (one re-read after ~1.2 s).

**Descents are segmented (operator law, 2026-09-05).** A single long `G1` toward the work
cannot be stopped once sent — a collision would be driven to the end of the move. Every
procedure descent (surface scans and probe_sequence to the guard top, probe_circle to its
probe height, the tool setter's travel to its start height) is therefore issued in
`descendInSegments`: segments of **≤ 5 mm**, and **none of them waits on the heartbeat**
(lenient settle: the controller's ok is the gate; a misframed or missing echo records the
commanded Z as `estimated`). Contact detection during a descent is **asynchronous**: the
probe feed's crash guard latches CRASH the instant an unexpected channel fires while motion
is in flight (job stop + connection close), and every segment re-checks the latch before it
is sent, so a hit ends the descent within one segment with no serial sensor wait between
segments. A manoeuvre that needs a synchronous verdict passes `serialCheck` (a `senseAfter`
window after each segment). The tool setter's travel clears its expected-contact set for
the descent, so a setter hit above the start height is a collision, not a measurement. The
1 mm guarded final approach and the coarse/fine ladders (which do sense serially, because
contact there is the measurement) are unchanged. Upward moves stay single.

**Coarse press and the slow zone (operator, 2026-09-05, job d8f6ec1b5c11).** A coarse step is
executed whole by the controller before the runner sees the probe, so wherever the surface
is found by a coarse step the probe is pressed past contact by up to a FULL coarse step
(0.4 mm at station 1 with 2 mm steps; worst case the whole step). `coarse_step_mm` is
therefore also the worst-case press. From station 2 the runner knows the expected contact
(the previous station's Z), so — like `run_tool_setter`'s `slow_zone_mm` — coarse steps now
stop `slow_zone_mm` (default 1, min 0.3) above it and fine steps take over, down to
`slow_zone + 2 × coarse` below it (coarse resumes lower, so a pocket edge costs seconds).
Press in the zone = one fine step. Station 1 has no neighbour: coarse is capped at 1 mm
unless `expected_z_machine` (a MEASURED neighbouring contact, law 3) is given. The confirm
page prints the zone; each station result carries `approach` (`slow-zone` |
`coarse-contact`) and `worstPressMm`. Bonus: no coarse contact means no release-and-return
ladder, ~5–8 s saved per station. **`coarse_step_mm` is capped at 1 mm everywhere in
surface scans** (operator, job cdbc29371b97: "we never wanted 2mm"; range 0.5–1, default 1).
Verified on the rerun (cdbc29371b97, 8/8, same numbers as d8f6): every station
`slow-zone`, `worstPressMm 0.1`, 408 s vs 492 s.

**Where the time goes (measured 2026-09-05, on-box analysis of the four-face survey).** Every
command batch costs ~270 ms over its motion time on the WiFi channel (four HTTP lines per
batch); motion time is distance / feed, so short steps are dominated by that overhead.

| Step | Feed | Motion | Measured per command |
|---|---|---|---|
| Coarse 1 mm | F100 | 600 ms | ~874 ms |
| Fine 0.1 mm | F60 | 100 ms | ~365 ms |
| Backoff 0.3 mm | F60 | 300 ms | ~574 ms |
| Retract 20 mm | F600 | 2000 ms | ~2280 ms |
| Descent segment 5 mm | F600 | 500 ms | ~834 ms |
| Raise 120 mm | F600 | 12 s | ~12.4 s |

An 11-station path at 402 s split as: 179 s coarse steps, 51 s fine, 35 s confirm, 26 s
retracts, 20 s hops, 18 s station-1 guard band, 17 s backoffs, 14 s initial descent, 16 s
traverse + final raise, 25 s of sensor windows; ~31.5 s per station of which 19 of the 30
commands are the coarse walk back down from the 20 mm hop height. Levers, no code needed:
`z_safe_delta_mm` 20 → 5 (~145 s per scan; the hop guard still catches a surface rising > 5 mm),
`confirm_passes` 2 (~19 s), `sensor_delay_ms` 30 (~8 s); coarse feed F100 → F300 (~80 s) is an
operator call on impact speed. Code levers: `get_job_timing` / `result.timing` now compute this
breakdown from any job's events (per kind: count, feeds, distance, controller vs motion vs
overhead, idle, sensor windows; per station; waits). One-line `G53 G1 …` (three lines per
batch, no workspace switch, ~100 s per scan) is NOT used: it is unverified on this firmware and
an unsupported inline G53 would execute in WORK coordinates. Station 1 of a surface scan now searches down to an explicit `floor_z_machine` (job
d7ac9247838e aborted because only start − max_drop was honoured).

**`probe_program` — one approval for a whole survey (2026-09-06).** An ordered list of
operations, staged once and approved on ONE confirm page that enumerates every op's envelope
and the B rotation schedule, run by one runner that hands the machine from op to op (each ends
raised at the traverse height): `rotate_b` (absolute B on the direct path, refused unless the
toolhead is at/above the safe traverse height, verified by the M114 in the same batch or the
heartbeat's `b`), `surface_path`, `surface_grid` and `sequence` with their standalone
arguments. Numbers an op cannot know at staging are **references** to earlier results —
`{from: "c90.top.z", plus: 7, between: [200, 240]}` (a sequence probe by name, `.z` shorthand
for `contactMachine.z`) or `{from: "ns90.summary.zMean", minus: 7, between: [...]}` — with
operator-approved **bounds required** (law 3): the page shows the bounds and a preview plan at
the mid-point, and the runner refuses the op if the resolved value falls outside them,
stopping the program raised and keeping every earlier result under `result.ops`. `on_fail:
"skip"` records a failure and continues (rotations always stop). Each op result is the
standalone tool's result object. The four-face survey that took 18 approvals is one program:
`rotate_b 90 → sequence (centre) → surface_path N–S (expected from the centre) → surface_path
W–E → sequence (sides) → rotate_b 180 → …`.

**New stock from the jig alone (mcp/48, 2026-09-06).** What the manual four-face survey did by
hand is now in the program tooling (work plan and hardware test order in
[docs/NEW_STOCK_SURVEY_TODO.md](docs/NEW_STOCK_SURVEY_TODO.md)):

- **Two-operand references** (`programRefs.ts`): `{mid: [a, b]}` = (a+b)/2 (stock centre from
  two side contacts), `{diff: [a, b], scale: 0.5}` = (a−b)·scale (width, half-width),
  `{min|max: [...]}`; `plus`/`minus` may be a number or a path, so "axis + half-width" is one
  reference: `{diff: ["s0.east.x", "s0.west.x"], scale: 0.5, plus: "axis.z_contact", between:
  [210, 235]}`. `.x/.y/.z` on a sequence probe read `contactMachine`. References may sit at
  any depth of an op's arguments (`steps[1].z`, `expected_profile.circle.center_x`). Bounds
  stay required; the page prints the formula (`describeRef`) and the runner the values.
- **Rotary axis and probe geometry through the MCP surface** (`rotaryGeometry.ts`, tool
  `set_probe_geometry` — operator-stated or MEASURED values with a reason, like `set_landmark`;
  env overrides `LUBAN_MCP_ROTARY_AXIS_X/_Z`, `LUBAN_MCP_PROBE_LENGTH`,
  `LUBAN_MCP_PROBE_TIP_DIAMETER`; read back in `get_stored_state → geometry`): axis X and
  PHYSICAL axis Z, probe effective length and tip diameter. Programs read them as the seeded
  namespace **`axis`** (`axis.x`, `axis.z_physical`, `axis.z_contact` = axis Z + probe length,
  `axis.tip_radius`, `axis.probe_length`). **Never a prerequisite**: only a reference to
  `axis.*` needs them (then a missing value is a staging error naming the tool); B0-only,
  stationary and off-rotary work needs nothing. **Stock size is not stored anywhere** — it is a
  property of the stock, not the jig — so a rotation takes an optional per-program
  `swept_radius_mm` for the tip-outside-the-cylinder check. (A first cut put these in the app's
  settings pane with a "max stock radius"; the operator rejected it on 2026-09-06 and it is
  gone.) Measured values this jig: axis X ≈ 169.7, physical Z ≈ 112.4, probe 71.3, tip ≈ 2.5 —
  re-measure after any probe re-fit or rotary move.
- **Keep-out at plan time** (`envelopeChecks.ts`, law 4 in the planners): every `probe_sequence`
  hop / descend column / march and every surface-scan station-1 descent, hop (at its lowest
  possible height, floor + z_safe_delta) and station column is checked against the obstacle
  landmarks (`clearanceZ` set) and the program's transient **`keep_out`** boxes (`[{name,
  machine: {x0, y0, x1, y1}, clearance_z}]`, this clamping's chuck jaws / tailstock, shown on
  the page, never persisted). Two obstacle semantics: stored landmarks are **crossing**
  obstacles — their clearance forbids entering or leaving the box on a low path, exactly what the
  direct XY guard enforces, while a hop, column or march wholly inside the box is the approved
  procedure (the `rotary-axis` landmark covers the whole stock; probing it is the job — the first
  cut treated it as a volume and refused every descent, caught by the on-box agent 2026-09-06);
  program `keep_out` boxes are **volumes** nothing enters, not even a column. A hit refuses
  staging naming the step, the obstacle and the Z; the check re-runs when references resolve at
  run time. `rotate_b` with `swept_radius_mm` additionally refuses if the tip is inside that
  cylinder (`insideSweptCylinder`).
- **Discovery**: `summary.highestAt` / `lowestAt` (machine XY) locate a cylinder's crown or a
  face's high edge by reference; `surface_path expected_profile: {circle: {center_x,
  center_z_contact, radius, tip_radius?}}` models a cylinder along machine Y — each station's
  slow zone and max_drop band follow `z(d) = c + √((R+rt)² − d²) − rt`, stations beyond 0.7 R
  off the axis are refused (the tip would glance). Unknown height needs no new op: a sequence
  whose `descend` is `axis.z_contact + (largest possible radius + 5)` and whose probe travels
  that radius + 10 (segmented descent, 1 mm coarse in the last band).
- **`group`**: `{id, kind: "group", for_b: [0, 90, 180, 270], ops: [...]}` expands at staging
  into a `rotate_b` per angle followed by the inner ops with the token `${b}` replaced in every
  string; inner ids without the token get `_b<angle>` and references between them are rewritten
  (`programGroups.ts`). Cap 80 ops after expansion.
- **Derived section** on the program result (`stockGeometry.ts`, `result.derived`, labelled
  inference not clearance): face heights above the axis per B, opposite-face thickness and
  centring offset, centre-to-centre width and PHYSICAL width (minus the tip diameter: external
  faces lie one tip radius inside their contacts) and stock centre X per Y, yaw per 100 mm, end
  face slope, top-face slopes — the 2026-09-05 report's arithmetic, unit-tested against it.
  Relies on probe names `top`, `west*`, `east*`, `end*`; every op result carries its `b`.
- **Event budget**: the plan estimates its events (100 + 120/station + 60/probe + 20/rotation);
  staging is refused when the estimate exceeds the job event limit, naming the number to set.

Still open from the brief: multi-segment paths in one op, live progress on the confirm page.

**`probe_stock_outline` — top, outline and centre from an estimate (2026-09-06).** The
operator's ask after watching the agent re-probe the centre for every side: one approved
procedure that (1) finds the TOP at a few points around the estimated centre (`top_points`,
default 3 along the longer axis) — the highest contact wins and a sample lower by more than
`hole_tolerance_mm` (default 2) is a hole and ignored, so a first probe landing in a drilled hole
does not define the surface; (2) probes the SIDES with horizontal marches from `overextend_mm`
(default 5) outside the estimate at `top − side_depth_mm` (default 2), `points_per_side` (default
3, midpoint first) over the middle half of each side (corners are where estimates fail), each up
to `side_max_travel_mm` (default 25), a miss recorded as `no_contact`; (3) FITS per-side mean and
slope into centre (machine and work frame), size centre-to-centre and PHYSICAL (MINUS the tip
diameter: on opposite external faces each stylus centre stops one tip radius outside its face —
the on-box agent caught the earlier "+ tip" sign error; the centre is unaffected) and yaw
(`outlineFit.ts`, pure, unit-tested against the agent's block: centre 168.85 / 241.383, physical
44.27 × 69.0). **Why 25 mm:** the agent's first outline marched 11 mm from X132 and found nothing
on the west; the face was at X145.5 — the estimate's centre was 3.85 mm off and its width a few
mm out. A short march silently turns ordinary estimate error into a missed face; a generous one
is still sensor-gated and only costs time. Derive travel as overextend + width uncertainty +
centre uncertainty + margin, never less than 20–25 mm. Also a
`probe_program` op kind `stock_outline`. The motion machinery is shared in `march.ts`:
`marchToContact` (the coarse → release → fine → confirm march every runner used to copy) and
**`steppedTraverse`** — travel close to a surface as a TOUCH-PROBING move: 1 mm steps at F300
with the probe expected; a contact backs off one step, retreats `hop_lift_mm` (default 2) along
the retreat direction and continues, so the path follows the surface in steps (a gentle slope,
one lift at the wall of a hole, one bump for a projection on a side). Over a top the retreat is
+Z, capped at the traverse height where a plain move finishes (law 2); along a side it is AWAY
from the face, capped at the approved start line where a further contact is a fault. Between
side points the probe backs off the last contact by `side_standoff_mm` (default 3) and skips
along the face at that standoff; the next march starts from the arrival point (a dynamic start
off the previous contact, never a fresh approach from the outside line). Surface scans take the
same idea as `hop_mode: "stepped"` (`hop_lift_mm`) in place of the fixed `z_safe_delta_mm` hop
whose only answer to a contact was to abort; `guarded` stays the default.

**CAM-generated probing programs — `run_probing_gcode` (mcp/49, 2026-09-07).** Fusion 360,
FreeCAD, any Grbl/Marlin post or a hand-written file supplies the probing toolpath as gcode; the
server PARSES and TRANSLATES it (`probeGcode.ts` pure parser/simulator, `probeCam.ts`
planner/runner) — never sends it raw, because the firmware has no G38 cycle and a raw program
obeys none of the motion laws. `G38.2`/`G38.3` become the shared sensor-gated march toward the
programmed target (the travel limit; retreat to the cycle start; G38.2 without contact aborts
per Grbl unless `on_miss: "continue"`); `G38.4`/`G38.5` become a probe-away (coarse steps until
the probe releases, then on to the target); `G0`/`G1` links follow law 2 (`link_mode: "raise"`:
traverse at the safe height and guarded segmented descent to the programmed Z; `"stepped"`: a
touch-probing traverse at the programmed height that lifts on contact); `G4` dwells; `G90/G91`,
`G53`, `G20/G21` honoured; programmed feeds ignored. Refused at staging with the line number:
`M3/M4` (spindle with the probe fitted), `M0/M1`, `M6`, `G28`, `G92`/`G55-59`, arcs, macro
variables. Coordinates are the CAM's WCS (work frame) unless `frame: "machine"` or `G53`. Probe
metadata in a comment before a cycle — `(PROBE id=3 name=top nominal=10,20,0 normal=0,0,1
tol=0.1,-0.1)` — supplies nominals, normals and tolerances. The confirm page enumerates every
translated step beside its original line; the keep-out check runs like any procedure. The
**inspection report** (`inspectionReport.ts`, pure) is stored as JSON on the job and rendered by
`report_format` / `get_inspection_report`: `fusion` = Fusion 360 inspection results in the exact
shape Autodesk's own "result generator probing.cps" writes (verified 2026-09-07, see
[docs/FUSION_POST_REVIEW.md](docs/FUSION_POST_REVIEW.md)): `START` / `RESULTSFILE` / `DOCUMENTID` /
`MODELVERSION` / `TIMESTAMP`, per toolpath `TOOLPATHID` / `TOOLPATH` / `G331` (CAD transform) /
`G330` (work plane; the 3+2 station's B goes in its `B` word), per point `G800` (nominal XYZ 4 dp,
normal IJK 6 dp, `O` = inspect surface offset, `U`/`L` tolerances with `L` signed) and `G801`
(measured TIP-CENTRE XYZ, `R` = stylus radius — Fusion subtracts it itself), then `END`; a miss =
nominal only. A `(RESULTS documentid= modelversion= toolpathid= toolpath=)` comment in the program
fills the envelope. Also `csv`, `grbl` (`[PRB:x,y,z:1]`). Per probe the tip-centre contact in both
frames, the B station, travel, distance short of the target, confirm spread, and the deviation of
the SURFACE (tip centre minus one tip radius along the normal — the review caught the raw tip centre
being compared, a bias of one stylus radius) with a tolerance verdict; without a stored tip
diameter the deviation is null rather than wrong. Files land under the app data dir
`mcp-inspection/<job>.<ext>`. Aborts keep the partial report.

**Test material for the translator (2026-09-07 survey, `docs/CAM_TEST_CATALOGUE.md`).** A second
Opus agent catalogued 827 files from 22 sources: hobby-ecosystem probing routines (almost all are
parameterised macros with `#`, `[expr]`, `%VAR` or O-words - exactly one upstream program, Adam
Lange's MIT `probe_surface.ngc`, parses unmodified and is now a regression fixture), Autodesk post
outputs, genuine and broken Fusion results files, PC-DMIS/QIF/DMIS/Renishaw/Heidenhain report
samples, and the standard artefacts (ring gauge, gauge block, 1-2-3 block, ISO 10360-5 sphere)
with pass bands. Six derived fixtures live in `docs/examples/cam-tests/` (each names its source and
transformation) and the ten-item verification set - six software assertions, four on the machine
with an artefact - is the plan for the first hardware runs. The survey also surfaced two parser
gaps, both fixed: nested parentheses inside a comment (`(MSG, do (this))`) and Grbl `$J=` jog
lines in sender macros (skipped with a warning); and the UGS hole-centre routine's `G53` links
under `G91` are taken as absolute machine coordinates with a warning. Not yet built: the Renishaw
`SIZE/ANG/POSN … ACTUAL … TOL … DEV` printout, which Fusion's importer also reads for Probe WCS /
Probe Geometry results - the highest-value second report format.

**The Renishaw printout — `report_format: "renishaw"`.** Fusion imports Probe WCS / Probe Geometry
results not as G800/G801 but as the Renishaw Inspection Plus print-out (verified from Autodesk's
result generator and the Inspection Plus manual, appendix G), so the same report renders as
`COMPONENT NO / FEATURE NO` blocks with `SIZE D<nominal>   ACTUAL <measured>   TOL <t>   DEV <d>`,
`POSN X/Y/Z … TOL TP … DEV`, and the `+++++OUT OF TOL+++++ ERROR` / `+++++OUT OF POS+++++ ERROR TP
… RADIAL` lines, inside the same `START … END` envelope. Points are reduced to FEATURES by their
`(PROBE group= role= feature= nominal_size= nominal_center= tol_size= tol_pos=)` metadata: roles
`x_minus`/`x_plus`/`y_minus`/`y_plus` give a size along the axis and a centre, a lone point a `POSN`
on the axis of its normal; sizes and centres are of the SURFACE (tip centre minus one tip radius
along each point's normal), so bosses and holes come out right with no special case. Unit-tested on
a 25 mm boss (surfaces one radius outside each tip centre), an out-of-tolerance case with the radial
error, and a hole with a missed point.

**Snapmaker firmware facts for the translator (2026-09-07, from Snapmaker/Snapmaker2-Controller and
the wiki's supported-gcode page).** The controller is a customised Marlin 2.0: `G0/G1` (with a `B`
word), `G4`, `G20/G21`, `G28`, `G53`, `G90/G91`, `G92` are supported and verified by Snapmaker;
`M3/M4` are "modified" (P = power). `G38_PROBE_TARGET` and `G38_PROBE_AWAY` are compiled in
(`Marlin/Configuration_adv.h`), so the firmware has a native `G38.2`–`G38.5` — but it probes the
Z-min probe endstop, the 3DP head's proximity sensor path, not the CNC touch probe on the MCP's GPIO.
The MCP therefore keeps translating every cycle into its own sensor-gated march and never sends a
G38 to the controller. Whatever dialect a program arrives in (Fusion post, Grbl sender macro,
LinuxCNC, hand-written), the parser maps it onto the codes the controller actually runs (`G90` /
`G53` / `G1` / `G54` batches and `G0 B` rotations) or refuses it by line.

**A probing-capable Fusion post: [docs/post/snapmaker-probing.cps](docs/post/snapmaker-probing.cps).**
Snapmaker's own posts are "all rights reserved" with no probing, so this one is written from
scratch (AGPL like the repository) to the review's outline: probing and Inspect Surface operations
only; each cycle becomes a law-2 approach (`G53 G0 Z<traverse>`, `G0 XY`, `G0 Z`), a `(PROBE …)`
comment with nominal, normal, tolerances, feature, group and role, and one `G38.2` whose target lies
a generous `minOvertravel` (15 mm) past the expected surface; 3+2 via `optimizeMachineAngles2(1)`
(post-transformed XYZ) and a bare `G0 B` after a raise; a `(RESULTS …)` comment per operation; no
M3/M6/G28/G92/arcs; simultaneous multi-axis and PCD cycles refused. Cycle geometry is written from
the Autodesk cycle parameters (`probeClearance`, `probeOvertravel`, `approach1/2`, `width1/2`,
`probeSpacing`, `depth`) and **has not been run in a Fusion installation** — verify each cycle type in
the post editor before trusting it; the rotary axis offset property must match the WCS origin.

**3+2 stations in a CAM program.** A bare `G0 B<angle>` line is a rotation: the translator raises
to the traverse height first (law 2, enumerated on the page) and runs `rotate_b` (absolute, direct
path, verified by M114 / the heartbeat's `b`); `B` with X/Y/Z, incremental `B` and `A`/`C` are
refused. The review found no probing-capable Snapmaker post exists: Snapmaker's 3-axis post is a
2018 Marlin post with no probing, and its "4-axis" post is an unmodified Autodesk Fanuc post with
Renishaw macros (refused line by line here) whose `writeRetract` emits no motion before a `B`
word. The review's patch outline for a `snapmaker-probing.cps` (post-transformed XYZ + bare `B`,
`G38.2` per cycle type with `(PROBE …)` metadata, raise before every rotation, no M3/G28/G92) is in
the same document.

**Traverse height beats a landmark clearance above it (job 34d787bdb2d7, 2026-09-06).** The
`rotary-axis` landmark declares clearance 328 (the homing height) while the operator's safe
traverse height is 320, so a sequence hop at 320 out of the rotary footprint was refused by the
new planner check and a six-op program lost its last op. Law 2 defines the traverse height as
safe for XY by decree: segments at or above `mcpSafeTraverseZ` are exempt from CROSSING landmarks
(`checkMotion({traverseZ})`); a program `keep_out` VOLUME can still refuse them (it is the
agent's explicit box). Marches (sensor-gated approaches that stop on contact) are exempt from
crossing landmarks too — probing INTO the rotary footprint from outside is the job — never from
volumes.

**A missed march is a measurement, not a fault (2026-09-06, job 5ad5fcce6b3a).** The agent's
six-op centre-finding program aborted on its LAST op because the first south-side march started
beyond a corner of the stock (width and step over-estimated) and found nothing within its
25 mm - five completed ops were thrown away with it. `probe_sequence` steps now take `on_miss`:
`continue` (default) records `{status: "no_contact", limitMachine, maxTravelMm}` for that probe,
retreats, raises and carries on; `abort` keeps the old behaviour. Results carry `status` on every
entry plus `contactCount` / `noContactProbes`; a later reference to a missed probe fails to resolve
and refuses that op (program stops raised, everything else kept). Surface scans already treated a
no-contact station this way.

**Stopping a procedure (fixed 2026-09-06, job 5ad5fcce6b3a).** `stop_gcode_job` only knew the
firmware's `stop_print`; a procedure is a server-driven loop, so three stop calls answered
`ok: false` while the scan kept stepping. Now `requestProcedureStop()` (probing.ts) records a
request that every motion primitive (`moveMachineSettled`, `senseAfter`, `rotateB`) checks
before sending: the runner throws `ProcedureStopped` at the next step boundary, its normal
abort path raises to the traverse height, and the job ends in state `stopped`. `ProcedureAbort`
now carries `partial` (completed stations / contacts / ops) and the runner wrapper stores it as
`job.result`, so the earlier promise "results are on the job record" is true for every abort,
not only for stops. A program treats a stop as program-wide regardless of `on_fail`. The tool
waits up to `wait_ms` (default 20 s) and returns `{ok: true, stopped | stopping, job}`.

## Safety model (operator-defined, non-negotiable)

- **Compound motion and all cutting goes out as gcode FILES** through the same
  `prepare_print`/`start_print` path as Luban's Start button, so the controller job state
  machine and the enclosure **door interlock** apply (fork issue #23). The direct
  (`execute_code`) path is reserved for single guarded actions.
- **Human confirm page** (`/confirm/<id>`, loopback + Origin-checked): shows validation,
  extents, warnings, and for direct moves a banner stating the interlock does NOT apply.
  Approval mints a one-time code (15 min TTL). Only the operator's click authorises motion:
  a model cannot approve its own job. By default (`mcpApprovalHandoff` = `agent`) an agent
  already waiting in `start_gcode_job wait_for_approval_ms` is started by that click and the
  page says "handed to the waiting agent" (the code is still printed small as a fallback);
  with `code` (or `LUBAN_MCP_APPROVAL_HANDOFF=code`) the code must be relayed by hand as
  before. Batch direct jobs: one approval covers an exact target list; each
  `start_gcode_job` call executes one step.
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
- **Heartbeat period is 2 s on WiFi** (`workers/heartBeat.ts` polls `/api/v1/status` every
  2000 ms with a 3 s timeout — not the ~1 s assumed until 2026-09-05), and a beat's position
  can be sampled before a synchronous move finished, so a settled-looking heartbeat can
  predate the motion (hence the verified-settle contract). `query_firmware_position` (M114)
  is the authoritative check. The HTTP channel sends each gcode line as its own request, so
  the engine's `G90` / `G53;` / `G1 …` / `G54;` is four requests and a status poll can land
  INSIDE the G53 window: that beat reports **machine coordinates in `pos`**, with the offset
  either still populated (a "frame flip"; `diagnostics` counts `heartbeat_frame_flip`) or read
  as **(0, 0, 0)** (`zeroOffsetBeats`; set aside by `judgeOffsetReport` until a zero offset
  persists for 3 beats) or missing (`missingOffsetBeats`; the cached offset is used).
- **Origin-offset transient (2026-09-05, job 44abebd9bab3)**: the SSTP status poll rebuilds
  `originOffset` from `offsetX/Y/Z` on every beat, and a beat inside a move's `G53…G54`
  window can carry none — `getPositionSnapshot` used to fall through to zero and reframe
  machine coordinates as work coordinates ((170, 199, 240) read as (119, 77, −88)), which
  aborted a probe_sequence march re-check after every step had verifiably settled. Now a
  missing offset reuses the last complete one (`originOffsetSource: cached`, with a
  warning). This session's work origin sat at machine (51, 122, 328) — negative offsets in
  the heartbeat; `machine = work − originOffset` holds.
- **Position of record (2026-09-05, job 1db4902a4cd6)**: the same afternoon a surface scan
  aborted at its station-4 re-check after three clean stations, on two bad beats in a row:
  one lagging (still the previous hop segment's position) and one frame-flipped
  (170, 207.571, 227.7 in `pos`, offset present → "machine (221, 329.6, 555.7)"), while the
  controller had echoed both hop segments at their targets. Rules now (`positionOfRecord.ts`,
  `probing.ts`):
  - every verified arrival (controller echo, or settled heartbeat) is the engine's **position
    of record**; any other gcode sent to the machine voids it;
  - a status report is judged in **either frame** — `pos − offset` (normal) or raw `pos`
    (G53-window beat) — for echoes, settle waits, `move_z` waits and re-checks;
  - a re-check passes on a matching report in either frame, or on the record while the
    latest report still predates it; it aborts only when **two distinct reports agree** the
    machine is elsewhere (real drift), or nothing matched within 4.5 s;
  - **operator rule**: a move of ≤ 1 mm that the controller accepted with no contradicting
    echo is taken as arrived after a 400 ms grace if the heartbeat has not caught up
    (`position-estimated` event) — inching is never paced by the 2 s poll. Larger moves
    still wait for verification.
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
- **Four-face survey (2026-09-05, 71.3 mm probe, machine coords, toolhead Z at contact)**: B0
  top 207.8, B180 206.9, B90 219.6, B270 219.9 at (170, 199); section ≈ 71.9 × 47.2; sides at
  B180 X134.2/133.5 (W) and 205.3/206.0 (E) at Y150/Y250; end Y129.2 at X190, Y128.7 at X150;
  stock centre X ≈ 169.7; **rotary axis physical Z ≈ 112.4, X ≈ 169.7** (now the geometry
  settings). Stock yawed ~0.4° (free end toward +X), centreline rising ~0.3 mm/100 mm toward the
  tailstock. Full report on the box: `~/luban-evidence/REPORT-four-face-scan-2026-09-05.md`.
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

## Tool surface (40)

`get_connection_status` · `get_machine_profile` (kinematics, module offsets) ·
`get_position` (both frames, warnings on incoherent reporting) ·
`query_firmware_position` (raw M114) · `validate_gcode` · `submit_gcode_job` →
`start_gcode_job` (procedures run detached: returns the result if it arrives within
`wait_ms`, default 25 s, else a `running` status) → `get_gcode_job_status` (event log +
stored result; long-poll with `wait_ms`/`since_event`) / `stop_gcode_job` (procedures: cooperative
stop at the next step boundary, raise, state `stopped`, partial `result` kept; file jobs: firmware
stop) · `move_z` (single or
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
new−old tool length difference — flow A only) · **touch-probe procedures** (all staged,
one approval per circuit, results in MACHINE coordinates): `probe_point` (one axis from the
current position) · `probe_vector` (any downward/lateral unit vector) · `probe_sequence`
(enumerated hop/descend/probe circuit, law-2 hops) · `probe_circle` (N radial marches +
least-squares fit, outside or inside a hole) · `probe_surface_path` (N −Z stations along a
line: per-station contact, best-fit line slope, flatness) · `probe_surface_grid` (serpentine
−Z grid: Z matrix, best-fit plane + residuals, ASCII height map) — the two surface scans hop
at `last contact + z_safe_delta_mm` (cap 20) within `max_hop_mm` (cap 60), see "Surface
scans" above · `survey_bed` (camera grid at gantry height).

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
  (#15 → #79 as of 2026-09-05, then `mcp/46-position-of-record` (#80), `mcp/47-timing-inline-g53` (#81),
  `mcp/48-new-stock-survey` (#82), `mcp/49-cam-probing-gcode` (#83), `mcp/50-simulator-spec` (#84, docs);
  next `mcp/51`. #70 stale-
  heartbeat, #71 probe_sequence, #72 GPIO probe feed, #73 Linux/mac packaging, #74 machine
  settings + docs, #75 sensor toggles + LAN, #76 job events + even survey, #77 offset
  transient + detached procedures, #78 surface scans, #79 console input leak, mcp/46 position
  of record + diagnostics; origin = Snapmaker/Luban is NEVER pushed). Mid-stack changes:
  amend + rebase the chain. commitlint enforces `Type: Sentence-case subject` (20–100
  chars).
- **Credentials**: active gh account is `tyeth-ai-assisted` (no push). Per-command
  override only: `GH_TOKEN=$(gh auth token -u tyeth)` for gh calls;
  `git -c "credential.helper=!f() { echo username=tyeth; echo password=$GH_TOKEN; }; f" push ...`.
  Never `gh auth switch`, never store the token.
- eslint judged against baseline (pre-existing errors in ConnectionManager/SstpHttpChannel
  stay); `npx tsc -p tsconfig-server.json --noEmit` filtered to `services/mcp` must be
  clean.
- **Timing diagnostics (`diagnostics.ts`, 2026-09-05)**: in job 1db4902a4cd6 the 0.1 mm fine
  steps took ~370 ms at the controller plus a 100 ms sensor window, yet one step in four
  idled 1.3–2.1 s between the controller's reply and the next send, and the resumptions fell
  on a strict ~4 s grid — every echo matched, so the settle wait was NOT involved; something
  periodic held the server's timers (event-loop block or CPU starvation on the Celeron box;
  the renderer console and GNOME Remote Desktop are suspects). Evidence is now recorded as
  **job events in sequence with the gcode traffic**: `event_loop_stall` (100 ms ticker > 250 ms
  late), `heartbeat_gap` (> 4.5 s between beats), `heartbeat_frame_flip`, `slow_step` (> 750 ms
  from the previous reply to the next send inside a job), `sense_overrun` (sensor window
  finished > 200 ms late), `position-estimated`; every `gcode` event carries `execMs`
  (send → reply) and `idleMs` (previous reply → this send); probe-feed readings carry
  `pipeMs` (GPIO monitor detection → server). Totals via `get_mcp_diagnostics` (also in
  GET `/api/mcp`). The job event log keeps 2000 events (was 400 — a scan overflowed it) and
  pages by `seq`, so `since_event` / `next_event_index` stay valid after the cap trims the
  middle. On GPIO the sensor lead over the controller reply was 5–144 ms on all 14 contacts
  of that job: `sensor_delay_ms` 50 is ample there; the surface-scan floor is 30.
  **Second run (job d8f6ec1b5c11, mcp/46 build)**: event loop clean (0 stalls, max lag 119 ms),
  heartbeat mean 1.99 s with 0 gaps, sensor pipe < 3 ms — yet 56 `slow_step` events totalling
  159 s of 492 s, every echo matching, each long one (3.5–4.6 s = two beats) landing ~2 s
  after a `heartbeat_frame_flip`, the short ones (1.1–1.6 s = one beat) every third
  descend/coarse step. The step path has no await but two timers, so the send events now
  carry the breakdown `replyToSenseEndMs` / `senseMs` / `senseWindowMs` / `senseEndToEngineMs`
  / `engineMs` to say which segment holds the time. **Third run (cdbc29371b97)**: the whole
  idle is `replyToSenseEndMs` (sense 50–52 ms, engine 0–1 ms) — i.e. between the controller's
  reply and the sensor window opening, inside the move's return path, with every echo
  matching in the work frame. The code there is synchronous plus promise resumptions, so the
  send events now also carry a `trace` of wall-clock marks (`reply-returned`, `echo-match` /
  `echo-miss` / `echo-absent`, `engine-exit`, `settled-exit`, `sense-start`, `sense-end`,
  `engine-enter`) and a `settle-wait` / `settle-done` event fires whenever the heartbeat
  fallback runs at all. **Fourth run (70b2b8c675a6, 11 stations, 587 s) named it**: all 84
  `settle-wait` events carried `offset: 0,0,0` from the heartbeat. A G53-window beat reports
  `offsetX/Y/Z` as **(0, 0, 0)** (not missing) with `pos` in machine coordinates, so the
  work-frame echo matched neither frame and the engine waited one beat (two after a flip) —
  ~180 s of that scan. The same beat, read by the runner before the descent to station 1,
  turned a verified Z320 into "Z−8", skipped the fast descent and aborted the scan at the
  station check (job 42df7b9351b7; GPT-5.6 agent's write-up
  `ROTARY_SCAN_POSITION_RECHECK_ISSUE.md` on the box). Fix: `judgeOffsetReport`
  (positionOfRecord.ts) — a zero offset that contradicts a non-zero offset seen on this
  connection is a transient until reported on 3 distinct beats in a row (a real zero origin
  persists); `getPositionSnapshot` uses the cached offset meanwhile (`originOffsetSource:
  cached`, warning); runners take their current Z from `knownMachinePosition()` (the
  position of record first) and abort if the toolhead is already BELOW the descent target;
  diagnostics count `zeroOffsetBeats`; `get_mcp_diagnostics.originOffset` shows the cache and
  streak. **Fifth run**: the descent fix held (`descend-from Z320 (record)`), but 28
  `settle-wait`s remained, all zero-offset, stations 47–54 s — a scan stepping every second
  keeps the poll inside G53 windows for beats in a row, so the 3-beat streak *accepted* the
  zero (125 zero-offset beats). Two more changes: (1) only QUIET beats count towards
  believing a zero — none while direct gcode is in flight or replied within 3 s
  (`directGcodeQuiet`); a real touchscreen re-zero happens idle and is believed after ~6 s;
  (2) the engine keeps its own **trusted offset** (the one that last proved an arrival via echo
  or settled heartbeat) and judges echoes with it FIRST, the heartbeat's offset second
  (`matchFrameWithOffsets`), so the echo path no longer depends on the per-beat value at all;
  `settle-wait` events print `trustedOffset`, `get_mcp_diagnostics.originOffset.trustedByEngine`
  shows it.
- **Stale post-hop beat read as drift (job de932e286afd, 133-station grid, aborted at r2c10
  after 29 contacts; GPT-5.6 agent's retest note)**: a 4 mm hop's echo verified X174 and set
  the record; the next status report, stamped ~750 ms later, still showed the previous
  station X178 (the poll samples the machine before its response is processed). The
  re-check read that ONE beat twice 250 ms apart, and `reportTime` derived as
  `Date.now() − reportAgeMs` differed by 1 ms between the reads, so "two distinct agreeing
  beats" fired and the scan aborted. Fixes: snapshots carry the beat's own `reportedAt`;
  two reports are distinct only ≥ 1 s apart; the record remembers `previousMachine`, and a
  report still showing that position is stale by definition (never drift evidence — the
  4.5 s deadline still aborts if nothing ever catches up). Unit checks replay the abort.
- **Buffer sizes** (Settings → MCP Server → Diagnostic buffers, or env): `mcpJobEventLimit` /
  `LUBAN_MCP_JOB_EVENT_LIMIT` (default 2000, 400–100000 events per job) and
  `mcpDiagnosticsRecentLimit` / `LUBAN_MCP_DIAGNOSTICS_RECENT_LIMIT` (default 40, 10–10000 per
  list). Applied immediately. Measured (cdbc29371b97, 8-station path, z_safe_delta 20, coarse 1,
  fine 0.1, 3 confirm passes): 763 events ≈ 100 fixed + ~85 per station; budget
  `100 + stations × 120` — the default covers ~15 stations, a 10 × 10 grid needs ~12 000.
  `job.result` is stored outside the log and is never trimmed; `eventsTotal > eventCount`
  flags a trimmed log. The cnc-probing skill tells agents to ask the operator to raise the
  limit before staging a scan that would overflow it (no MCP tool changes it, by design).
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

- ~~Procedure results only travel on the `start_gcode_job` response~~ — done 2026-09-05: the
  runner outcome is stored as `job.result`, every job carries an event log (state changes,
  runner phases, gcode traffic while active, file-job progress), and `get_gcode_job_status`
  long-polls (`wait_ms`, `since_event`) — agents no longer read server logs to learn how a
  job went. Still open: `probe_sequence` aborts drop completed marches into the error text
  (they are now in the events, but not structured).
- **`traverse_xy` staged batch tool** (law-2-compliant XY transport twin of `move_z`): hops
  currently need `submit_gcode_job` file jobs or `probe_sequence` hop steps.
- **Console bug**: MCP gcode broadcasts leak into the Workspace console INPUT element with
  raw ANSI codes.
- **#60 install size**: bundle/asar the main process, squeeze the remaining server externals.
- **`sensor_delay_ms` defaults are MQTT-sized** (200–300 ms); on the GPIO transport they can
  drop to ~50 ms — per call for now, a transport-aware default later.
