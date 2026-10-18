# Luban MCP multi-machine overhaul - reviewed plan

Status: reviewed by the lead (Opus) on 2026-10-18. The planning draft (sections 1-4 below, written by a
Fable planning agent) is kept verbatim for its findings, capability table and inventories. **Where
this review section conflicts with the draft, this section wins.** Tracking issue: see the PR that adds
this file.

## Lead review - amendments (authoritative)

**R1. The Original has no position feed today (blocking for "full support").** `Channel.getLatestMachineState()`
returns `null` in the base class (`src/server/services/machine/channels/Channel.ts:75`) and
`TextSerialChannel` does not override it, so on USB text-serial every MCP tool that reads
`getPositionSnapshot()` (`tools/machine.ts:509`) refuses with "No heartbeat received yet". The draft
assumed a heartbeat. New package **WPC (connection layer)** owns `src/server/services/machine/**`:
a text-serial machine state built from the Marlin controller's position/status reports (M114 replies
and the controller's periodic status poll; no new polling the operator has not seen Luban do), the
device identity in the Ready payload (`deviceSerial` from SACP `masterControlSerialNumber`, `host` for
SSTP-HTTP) and both in `getConnectionStatus()`. WP2 no longer edits the channel files.

**R2. Wave-1 file overlap.** The draft had WP1 and WP2 both editing `connectedMachine.ts`. Only WP1 edits
it in wave 1; WP2's `connectedDevice()` / `machineKey` live in the new `machineStore.ts`.

**R3. Device keying: one record set per model, devices as aliases, conflicts asked (replaces 2.2's
"device-first then model fallback").** Device-first lookup forks one physical machine's records across
transports (the A350 over SACP has a serial number, over SSTP a host, over USB nothing), and the model-level
fallback would then silently apply an older record. Instead:
- The store is keyed by `machineIdentifier` (`mcpMachines.machines["Snapmaker 2.0 A350"]`). Each entry
  keeps `devices: [{id: "sn:123" | "host:192.168.1.20", firstSeen, lastSeen}]`.
- A connect whose device id is of a type already recorded for that model and *differs* from every recorded
  id raises `deviceConflict`: the entry's safety records (stated travel, landmarks, tool setter, rotary,
  probe geometry, z policy) are reported `unconfirmed`, nothing auto-executes, and the landmark review
  asks "is this the same machine?". The operator answers through the staged confirm page
  (`assign_machine_device {same_machine: true}` adds the alias; `false` creates a separate entry
  `"<identifier>#sn:<n>"` that starts empty). Different id types never conflict (SACP sn vs SSTP host vs
  none). The operator owns one of each model today, so in practice this never prompts; two same-model
  machines are still never silently merged.
- Landmarks/calibrations files: records keep `machineIdentifier`; a split entry tags new records with the
  split key. No device-level fallback anywhere.

**R4. Landmark confirmation comes from the operator, never the agent.** An agent-callable
`confirm_landmarks {confirmed: true}` would let the agent confirm its own question. `confirm_landmarks`
**stages** a review page (same approval mechanism and confirm code as staged jobs) listing every applying
landmark with heights and basis; `landmarksConfirmedAt` is written only on the operator's approval.
Validity: until disconnect or 24 h, whichever comes first (per-machine policy `landmarkConfirmTtlHours`),
and reset by any landmark edit or a device conflict. The structured question in tool results stays as
in 2.6 (`landmark_review`), with `answer_with` pointing at the staged confirmation.

**R5. Rotary chuck/tailstock heights are rotary geometry, not landmark naming conventions.** WP2 adds
`chuckTopZ` and `tailstockTopZ` (physical, machine Z) to the per-machine `rotary` section with setter args
on the existing geometry tool; WP6's `rotarySafeHeight()` takes them as inputs. Stock stays a per-call arg.

**R6. Split WP4 and move cross-cutting wiring into WP8.** WP4a = generic motion dialect dispatch
(`gcodeForms.ts`, traverse/move_z/goto_work_origin/move_and_capture/home/restore_work_frame/recovery
cleanup), including: **Original/J1 never receive G53/G54** - Original home = `G28` alone (today
`homeCommandFor` sends `G53;\nG28;\nG54;` to every non-SACP machine). WP4b = capability gates on CNC
procedures (tool setter, probing, survey, workspace, cam, camera bootstrap, pendant). Injecting
`landmark_review`, `describeAppliedRecords()` and the `stock` arg into motion results moves to WP8
(integration), so WP3, WP4a, WP4b and WP5 can run in parallel.

**R7. Stacking (no self-merge).** Every PR bases on the branch it depends on; after #264 merges each is
retargeted. Wave 1 on `fix/ray-machine-aware-motion` (#264). WP3/WP4a/WP4b on WP1; WP5 on WP2; WP7 on WP3;
WP8 on a merge of all, its body listing the PRs it contains. Shared files across parallel packages are
limited to `tests/run.ts`, `docs/TOOLS.md` (append-only) and `tools/gcode.ts` (WP3 = validate/submit/upload
handlers, WP4a = move_z/traverse_xy handlers; WP3 merges first).

**R8. Validator refusals must not break existing translation paths.** G38 and other SM2-"incompatible"
codes are refused only in bodies that will actually be sent; probe programs and thread-milling conversion
translate before staging (`tools/cam.ts:15`) and must keep working. Header comparison uses the exact
strings Luban writes (`generateGcode.js`), and a file for another *model* of the same family (A250 file on
an A350) is refused - bed sizes differ.

**R9. `set_machine_policy` (safe traverse Z / motion floor for non-A350 Z machines)** is agent-callable
like `set_probe_geometry`, records `source` and `setAt`, and never enables auto-execute on a machine whose
dialect is not `verifiedOnHardware`. The A350 defaults (328 / 320 / auto at top Z) are unchanged.

**R10. Process constraints for every package** (verbatim to each agent): no whole-repo eslint or
`npm run lint`; lint only changed files with `npx eslint --no-eslintrc -c .eslintrc.js --ext .js --ext .ts
<file>` one or two at a time; `npm run test:mcp` at most once per package; push with `--no-verify`; commit
with `-c core.hooksPath=/dev/null` if hooks block; no G-code or motion to any machine; no deploys; usage
checked between tool calls with a hard stop at 99 %.

### Final package list and waves

| Wave | Package | Branch | Base | Summary |
|---|---|---|---|---|
| 1 | WP1 | `mcp/mm-dialect-table` | #264 | `gcodeDialect.ts`, `MachineCapability.dialect/supports`, `requireCapability` |
| 1 | WP2 | `mcp/mm-machine-store` | #264 | `machineStore.ts` keyed per model + device aliases + migration; consumers switched; `set_machine_policy`; rotary chuck/tailstock fields |
| 1 | WPC | `mcp/mm-connection-identity` | #264 | text-serial machine state (Original), device serial/host in Ready + `getConnectionStatus()` |
| 1 | WP6 | `mcp/mm-rotary-safe-height` | #264 | pure `rotaryClearance.ts` + tests |
| 2 | WP3 | `mcp/mm-validator` | WP1 | machine-aware validator rules, header parse, confirm-page Machine row |
| 2 | WP4a | `mcp/mm-motion-dialect` | WP1 | `gcodeForms.ts`, dialect dispatch for generic motion; Original relative steps + G28 home |
| 2 | WP4b | `mcp/mm-procedure-gates` | WP1 | `requireCapability` gates on CNC procedures, clear refusals |
| 2 | WP5 | `mcp/mm-landmark-review` | WP2 | `landmarkReview.ts`, staged `confirm_landmarks`, update semantics, physical basis restatement |
| 3 | WP7 | `mcp/mm-laser-tools` | WP3 | `laser_frame`, `set_air_assist`, `set_crosshair`, `laser_focus` refusal |
| 3 | WP8 | `mcp/mm-integration` | all | review + applied records + `stock` arg in every motion/staging result, rotary safe height wired, confirm-page rows, `get_*` visibility, README/skill |

### Open questions for the operator (amended)
Q1-Q4, Q6-Q8 as in section 4 of the draft. Q5 is replaced by R4's default (until disconnect or 24 h) -
say if you want a different cadence.

---

# Planning draft (Fable agent, verbatim)

Planning base: worktree `C:\dev\software\snapmaker\Luban\.claude\worktrees\wp-264-fix` = PR #264
`fix/ray-machine-aware-motion` (HEAD 6b4ca4878) on `startup/base`. All paths below are relative to
`src/server/services/mcp/` unless they start with `src/`. Written 2026-10-18; no code changed.

---

## 1. Findings

### 1.1 What PR #264 already does (the base)

| Area | Where | What it gives us |
|---|---|---|
| Capability | `machineCapability.ts` (pure) | `deriveMachineCapability(def)` -> `{identifier, type, size, hasZ, known}`; `hasZ = size.z > 0`; unknown machine = assumed Z. `LEGACY_MACHINE_IDENTIFIER = 'Snapmaker 2.0 A350'`, `recordMachineScope / appliesToMachine / isLegacyScope`. `homeCommandFor()` -> `$H` (Ray over SACP), SACP home request (Artisan/J1), `G53;\nG28;\nG54;` otherwise. |
| Live binding | `connectedMachine.ts` | `MACHINES`, `findMachine`, `connectedMachineIdentifier()` (defensive read of `connectionManager.getConnectionStatus().machineIdentifier`), `connectedMachineCapability()`, `describeConnectedMachine()`, `connectedMachineTag()`. |
| Transport form | `traversePlan.ts:56-80` `TraverseMachine {hasZ, gcode: 'snapmaker-2' \| 'grbl-relative'}`; `tools/machine.ts:134` `traverseMachine()` reads `metadata.gcodeFlavor === 'grbl'` | GRBL machines get `G91 / G1 dX dY F / G90` steps with `; mcp-settle machine X Y` (parsed by `parseSettleComment`, `traversePlan.ts:90`), verified against the heartbeat per step. A350 steps byte-identical (`G90\nG53;\nG1 X.. Y.. F..;\nG54;`, `traversePlan.ts:235`). |
| Z laws | `traversePlan.ts`, `directMovePlan.ts:131`, `safeZPolicy.ts`, `tools/machine.ts:145 requireZAxis` | No floor check / no traverse height on `hasZ:false`; `move_z`, `goto_tool_change_position`, `survey_bed` refuse on Z-less; safe-Z auto-execute never applies on Z-less. |
| Scoped records | `landmarks.ts` (`Landmark.machineIdentifier`, `legacyScope`, `listFor`, `obstacleBoxes()` default to connected machine), `calibration.ts` (same), `rotaryGeometry.ts:286-318` (`mcpTravelMachine` companion key, `statedTravel(id)`) | Untagged = A350 by rule. **Travel is single-scope**: stating any end for machine B retires A's ends (`travelScope()`), the defect scope item 5 fixes. |
| Travel | `machineTravel.ts` (`modelTravel`, `resolveTravel`, `DEFAULT_TRAVEL_FUDGE_MM = 25`, `TRAVEL_EPSILON_MM 0.05`), `tools/machine.ts:474 travelFudge()`, `:492 machineBounds()`, `:607 planningTravel()`, `:640 requirePlanningTravel`, `:658 assertWithinTravel` | model size +/- fudge (`mcpTravelFudgeMm`, `..XMm/..YMm`, env wins), stated ends = tighter override only; no Z range on Z-less. |
| Visibility | `get_position.connectedMachine {identifier,type,hasZ}`, `get_machine_profile.hasZ/travel`, `get_stored_state.machineScope / limits.zLawsApply / limits.travel / limits.travelFudge` (`tools/landmarks.ts:325-445`); `traverse_xy/move_z/move_and_capture/goto_work_origin` -> `connected_machine`, refusals carry `machineTag`. | Missing: dialect, device id, which per-machine records applied, on most procedure/staging results. |
| Validator | `validator.ts:592 resolveJobFrame` admits a server body under `relativeTransport` only when every motion line is relative and G90 restored; `:351` warns inline G53 (A350 rule, not machine-aware). | No machine awareness, no S range, no header read. |

### 1.2 Per-machine G-code capability table

Sources: **[RAY]** https://wiki.snapmaker.com/en/Snapmaker_Luban/manual/ray_supported_gcode_references (firmware v1.7.4+);
**[SM2]** https://wiki.snapmaker.com/en/Snapmaker_Luban/manual/2_supported_gcode_references (Marlin 2.0.x base);
**[ART]** https://wiki.snapmaker.com/en/Snapmaker_Luban/manual/artisan_supported_gcode_references;
**[J1]** https://wiki.snapmaker.com/en/Snapmaker_Luban/manual/j1_j1s_supported_gcode_references (fw 2.7.2+).
The wiki index page https://wiki.snapmaker.com/en/Snapmaker_Luban/gcode_references renders empty without JS (fetched twice, title only); the four
machine pages were reached through a text-render proxy. **There is no Original page**; Original rows are *from Luban generators /
controllers, unverified against wiki*. Luban generator citations: `src/server/lib/GcodeGenerator/GcodeGenerator.js` (GG),
`src/server/services/task-manager/workers/generateGcode.js` (GEN), `src/app/ui/widgets/ConnectionControl/ControlPanel.tsx` (CP),
`src/app/ui/widgets/RaySetOriginWidget/SetOriginView.tsx` (RSO), `src/app/lib/generateLaserFocusGcode.js` (LF).

**Ray** (`identifier 'Ray'`, `src/app/machines/snapmaker-ray.ts:8-16,63`: 600 x 400 x **0**, `MachineType.Laser`, `gcodeFlavor: GRBL`; SACP type 5 `src/app/constants/machines.ts:431`; serial `Machine Size: Ray2023` `MarlinController.js:378`)

| Feature | Ray | Source |
|---|---|---|
| Motion | G0 (laser off, max rate), G1 X Y A/B F S; G2/G3 not listed; G4 **P seconds** (GRBL form; GG:91 converts Marlin ms) | RAY; GG:67-119 |
| Units/plane | G20/G21 (mm default); G17 only | RAY |
| Frames | **G53 non-modal, SAME-LINE prefix** (`G53 G0 X.. Y..`); G54-G59 (G59.1-3 unsupported); G92 / G92.1; Luban jog uses `G91 / G1 X Y F / G90` and never G53/G54 (CP:145-155); RSO sets origin with `G92 X0 Y0 B0` | RAY; CP; RSO |
| Distance | G90 default / G91 | RAY |
| Homing | `$H` (CP:110); SACP 0x01/0x35 never answered (PR #264) | RAY; CP |
| Status | `?` (GRBL status report), `$G` parser state, `$#` offsets; over SACP the MCP uses the subscription/heartbeat; M114 not listed for Ray | RAY |
| Laser | M3 Sn constant, M4 Sn dynamic (power scales with speed), **S 0-1000** (S0 off); M5 waits then off; no S = last power. GEN:137 `maxPowerNumber = 1000` for grbl, GG:87/100 `S = S255 * 1000/255`, GG:102 `P% -> S = P*10` | RAY; GEN; GG |
| Air assist | M8 on / M9 off | RAY |
| Module M-codes | M2000 L12 P0-255 toolhead fan; L13 crosshair (RSO:56 `M2000 L13 P1`); L15 main laser power; L23 40W half-power; L30 2W standby; W1/W2 enclosure light/fan 0-100; W40/W42/W44 purifier; M2003/M2004 crosshair-offset pair; M1005 info (incl. **product SN**) | RAY; RSO |
| Jobs | `$SD/Run=ray.nc`, `$SD/Run=boundary.nc` (Luban "Run Boundary" uploads `boundary.nc`, `laser-workspace-ray/index.tsx:246-268`), `!` pause, `~` resume, Ctrl-X + M5 stop | RAY |
| Header Luban writes | `;machine: Ray`, `;gcode_flavor: grbl`, `;header_type: laser`, `;max_power: <= 1000` (GEN:202-248, 137) | GEN |
| Z | none (size.z 0); Luban hides Z jog (CP:335 `enableZAxis={!isConnectedRay}`) | ray.ts; CP |
| Verified on hardware by this MCP | `$H`, relative XY steps (PR #264 acceptance pending) | #264 |

**Snapmaker 2.0 A150 / A250 / A350** (`'Snapmaker 2.0 A150'` 160x160x140, `'Snapmaker 2.0 A250'` 230x250x230, `'Snapmaker 2.0 A350'` 320x350x325 - `src/app/machines/snapmaker-a{150,250,350}.ts`; SACP types 0/1/2; serial `Machine Size: S/M/L` `MarlinController.js:385-392`; SSTP-HTTP `series` -> identifier `SstpHttpChannel.ts:250-252`)

| Feature | SM2 | Source |
|---|---|---|
| Motion | G0/G1 E F S X Y Z **B**; G2/G3 *unverified*; G4 P ms / S s; G42 mesh | SM2 |
| Units | G20/G21 | SM2 |
| Frames | **G53 own-line OR same-line prefix** per wiki; this MCP has observed the inline form ignored on the A350 (`validator.ts:351`, `:493-495` moves it to its own line) -> keep own-line `G53;` as the only emitted form; G54-G59.3 (only G53/G54 recommended); G92 X Y Z E (no G92.1); firmware source `Marlin/src/gcode/geometry/{G53-G59,G92}.cpp` (`workspace.ts:3`) | SM2; validator |
| Distance | G90 default / G91 | SM2 |
| Homing | G28 (O/X/Y/Z); Luban Home = `G53;\nG28;\nG54;` (`machineCapability.ts:152`); homes B too (`programEnvelope.ts:123`); home park = machine X-19 Y342 Z328 on the A350 | SM2; MCP |
| Status | M114 (modified: includes stepper Count - `a350-status` memory: Count = machine + (19,4,0)), M115, M119; SACP/SSTP heartbeat for the MCP | SM2 |
| Laser | M3 constant / M4 dynamic; **P 0-100 % and S 0-255 PWM, P wins**; M5 waits then off; G0 and G28 also turn the laser off. Luban: `M3 P${fixedPower} S${powerStrength}` with S = floor(P*255/100) (GG:237, LF:38) | SM2; GG |
| CNC spindle | M3/M4 identical; 50 W: P 0-100 %; 200 W: P % or S rpm (~8000-18000), C sets target without starting; parameterless M3 refused on CNC (ART note) | SM2; ART |
| Air assist / fans | M7/M8 on, M9 off (20 W/40 W laser only); M106/M107 3DP only; M2002 T2 laser fan 0-255; M2002 T3 crosshair; M2000 L23/L30 | SM2 |
| Enclosure / purifier | M1010 S3 P0-100 light, S4 P0-100 fan (Luban `src/app/flux/machine/index.js:426-429` M1010 door detection); M1011 F0-3 purifier | SM2 |
| Unverified | G2 G3 G27 G30 M17 M18 M84 M110 M113 M421 | SM2 |
| Incompatible (never emit/accept) | G29 **G38** M25 M31 M42 M75 M77 M81 M85 M112 M117 M120 M121 M206 M217 M218 M226 M303 M401 M402 M410 M413 M428 M851 M999 (the MCP already translates G38 instead of sending it, `tools/cam.ts:15`) | SM2 |
| Header Luban writes | `;machine: Snapmaker 2.0 A350` etc., `;gcode_flavor: marlin`, `;header_type: cnc\|laser\|3dp`, `;is_rotate:`, `;max_power: <= 255` (GEN) | GEN |
| Rotary | B axis word on G0/G1 (A350 observed homed to B0 by G28) | SM2; MCP |

**Artisan** (`identifier 'A400'`, 400x400x400, `snapmaker-artisan.ts:29-37`; SACP type 3; serial `Machine Size: A400`)

| Feature | Artisan | Source |
|---|---|---|
| Motion / units | G0/G1 E F S X Y Z B; G4; **G21 only (G20 unsupported)**; G28 L O R X Y Z | ART |
| Frames | G53 same-line modifier, alone "returns to native space"; G54-G59.3 (only G53/G54 recommended); G92 + **G92.1** resets selected workspace | ART |
| Distance | G90/G91 | ART |
| Homing | SACP home request (#264 `homeCommandFor`) / G28 | ART; #264 |
| Status | M114 (modified), M115, M119, M1005 (**serial number**), M1006 | ART |
| Laser | M3/M4 P 0-100 % S 0-255 (P wins); M5; M7/M8 air on, M9 off | ART |
| CNC | M3/M4 P % or S 8000-18000 rpm; parameterless not allowed | ART |
| Module | M2000 L1 safety lock (limits laser power when locked), L12 fan, L13 crosshair, L15 main power, L23, L30, **C21 CNC fan**, W1/W2 enclosure, W40/W42/W44 purifier | ART |
| Rotary | no dedicated command; B on G0/G1, M92/M201/M203 B | ART |
| Unverified / incompatible | G2 G3 G27 G29 G30 M110 M113 M122 M200 M421 M906 / M17 M18 M31 M42 M75 M76 M77 M81 M84 M85 M112 M120 M121 M206 M217 M218 M226 M290 M303 M401 M402 M410 M428 M569 M710 M851 M997 M999 | ART |

**J1 / J1s** (`'Snapmaker J1'`, 324x200x200, `MachineType.Printer`, `snapmaker-j1.ts:24-31`; SACP type 4)

| Feature | J1 | Source |
|---|---|---|
| Motion / units | G0/G1 E F X Y Z; G4; G21 only; G28 O X Y Z; G90/G91; G92 X Y Z E (no G92.1) | J1 |
| Frames | **G53/G54 not documented at all** -> treat as unsupported: refuse frame-declaring moves | J1 |
| Status | M114 modified, M115, M119 | J1 |
| Laser / spindle / air | none (printer); T0/T1 IDEX, M605 | J1 |
| Homing | SACP home request (#264) | #264 |

**Original / Original Extended** (`'Original'` 125x125x125, `'Original Long Z-axis'`? - `DEFAULT_MACHINE_ORIGINAL_LONG_Z_AXIS` 125x125x221, `snapmaker-original*.ts`; **USB text-serial only**; identified by the *absence* of a `Machine Size:` reply, `MarlinController.js:466-470`; firmware `Snapmaker-Base-2.x` `Marlin.js:43-45` = Marlin 1.x lineage) - **no wiki page; from Luban generators/controllers, unverified against wiki**

| Feature | Original | Source |
|---|---|---|
| Motion | G0/G1 X Y Z F; G4 P ms; G90/G91; G92 | GG:120-221 (`parseAsLaser` emits `G0 Z.. F150`, `G90`), LF:31-53 |
| Frames | **G53/G54 unknown** (Marlin 1.x has no workspace select) -> MCP must not emit or rely on them; origin is G92-based | assumption, verify on hardware with `M115` + a `G54` echo test |
| Homing | G28 (text-serial `executeGcodeAutoHome`, CP:112) | CP |
| Status | M114 (MarlinController parses `X:.. Y:.. Z:..`) | MarlinController |
| Laser | `M3 P<percent> S<0-255>` then M5 (LF:38, GG:237); M4 unknown | LF; GG |
| CNC | M3 P % (Luban CNC generator `parseAsCNC`, GG:22-66) | GG |
| Air assist / enclosure | none | - |
| Header | `;machine: Original`, `;gcode_flavor: marlin` | GEN |

### 1.3 Device identity Luban exposes per connection

- `ConnectionManager.getConnectionStatus()` (`src/server/services/machine/ConnectionManager.ts:254-262`): `{connected, channelName ('sstp-http'|'sacp-tcp'|'sacp-udp'|'sacp-serial'|'text-serial'), connectionType, protocol, machineIdentifier, machineReady}`. **No host, serial number or token is exposed.** `machineIdentifier` is set from `ChannelEvent.Ready` (`:342-349`) and cleared on close (`:446, :646`).
- `ConnectionOpenOptions` (`:68-80`): `address`, `host?`, `token?`, `port?`, `baudRate?`, `protocol?` - held only for the call; the token must never leave the server (SstpHttpChannel redacts it from errors, `:360`).
- SACP (`SacpUdpChannel.ts:82-93`, `SacpTcpChannel.ts:108-120`, `SacpSerialChannel.ts:88-96`): `getMachineInfo()` returns `MachineInfo {type, masterControlHardwareVersion, masterControlSerialNumber: number, masterControlFirmwareVersion: string}` (`node_modules/@snapmaker/snapmaker-sacp-sdk/.../MachineInfo.d.ts`); only `type -> SACP_TYPE_SERIES_MAP` reaches the Ready payload. **`masterControlSerialNumber` is the per-device id we want** - it is read on every SACP connect and simply dropped. Ray's `M1005` also reports a product SN (RAY) but that is a text query; the SACP field is enough.
- SSTP-HTTP (`SstpHttpChannel.ts:250-252, 324-326`): identity = `series` -> identifier; the app keeps a saved-machine list `server.machines[] {name, address, token, lastConnectedAt}` (`src/app/flux/workspace/actions-connect.ts:95-135`, matched by address then name). Per-device id available server-side: the `host` the channel was opened with (DHCP-brittle) - no SN over SSTP.
- Text serial (Original, and A350/Ray over USB): `port` path only (`COM3`), no SN. Original has *no* identity beyond "not a 2.0".

### 1.4 MCP configstore keys - full inventory and classification

Configstore = `src/server/services/configstore` (`config.get/set`). File stores under `DataStorage.userDataDir`: `mcp-landmarks.json` (`landmarks.ts:67`), `mcp-camera-calibration.json` (`calibration.ts:55`), `mcp-camera-model.json` (`cameraModelStore.ts:29`), `mcp-jobs-inbox/` (`jobs.ts:108`).

**PER-MACHINE (must be keyed, coexist across machines)**

| Key | Read at | Why per-machine |
|---|---|---|
| `mcpTravelXMin/XMax/YMin/YMax` + `mcpTravelMachine` | `rotaryGeometry.ts:86-89, 286` | stated travel is one machine's measured ends (#264 single-scope defect) |
| `mcpTravelFudgeMm`, `mcpTravelFudgeXMm`, `mcpTravelFudgeYMm` | `tools/machine.ts:475-477` | the A350 needs 25 for X-19; the Ray may want 5 |
| `mcpSafeTraverseZ` (default 328), `mcpMotionFloorZ` (default 320) | `tools/machine.ts:173, 197` | A350 park/floor numbers; meaningless on Z-less, wrong on Original (Z 125) |
| `mcpTraverseWithoutApprovalAtSafeZ` | `tools/machine.ts:226, 238` | policy; auto-execute should only be allowed on a machine verified on hardware |
| `mcpRotaryAxisX/Z`, `mcpRotaryTailstockY`, `mcpRotaryChuckFaceY`, `mcpRotaryAxisPoints`, `mcpBedPlaneZ` | `rotaryGeometry.ts:71-79, 96` | jig constants of one bed (A350 today; Artisan shares the rotary unit but at different machine coordinates) |
| `mcpProbeEffectiveLength`, `mcpProbeTipDiameter`, `mcpProbeStylusExposed`, `mcpProbeBodyDiameter` | `rotaryGeometry.ts:75-78` | probe fitted to one machine's toolhead (could be shared across A350/Artisan - keep per machine, allow copy) |
| `mcpToolSetter` (centre, triggerZ, datum, changeX/Y/Z, toolheadClearanceBound, ...) | `toolSetter.ts:73,104,145`, `toolDatumState.ts:9` | setter box lives on one bed |
| `mcpActiveTool` | `activeTool.ts:27` | the tool in *this* spindle |
| `mcpToolRegion` | `tools/camera.ts:249,1369`, `tools/landmarks.ts:336` | expected tool pixel region per camera/machine rig |
| `mcpMaxJogDistance` | `tools/camera.ts:457`, `tools/landmarks.ts:399` | jog cap sensible per bed size |
| `mcpRotaryGravityCalibration` | `vibrationCaptures.ts:68` | calibration of the accelerometer on one rotary (per machine the rotary is mounted on) |
| landmarks file (already tagged `machineIdentifier`), camera calibrations file (tagged), `mcp-camera-model.json` (**untagged** - camera intrinsics are per camera, extrinsics per rig; tag with machine + camera device) | `landmarks.ts`, `calibration.ts`, `cameraModelStore.ts` | #264 did the first two |
| `mcpCameraUrl`, `mcpCameraDevice`, `mcpCameraLastGood` | `camera.ts:208-504` | the camera on the A350 rig is not the Ray's; keep a *per-machine preference* with a global fallback (camera selection memory says never memorise the camera offset) |
| frame latch persisted (`persistFrameLatch`, `tools/machine.ts:338`) | | per connection; already cleared on disconnect - leave, but tag with machine key so a Ray reconnect never inherits an A350 G53 latch |

**GLOBAL (process/host settings - unchanged)**: `mcpEnabled`, `mcpPort`, `mcpAllowLan` (`index.ts:50-52`), `mcpHttpsCaFile`, `mcpApprovalHandoff`, `mcpJobInboxDir`, `mcpDiagnosticsRecentLimit`, `mcpFfmpegPath`, `mcpCameraStreamEnabled/Fps/MaxClients`, `mcpProbeTransport`, `mcpProbeToolEnabled`, `mcpToolSetterEnabled` (feeds are box-side; the GPIO bridge is physically wired to one machine but the *transport* config is host-level - note: `mcpToolSetterEnabled` gating should additionally require the connected machine to *have* a tool-setter record), `mcpGpio*`, `mcpMqtt*`, `mcpAudioDevice`, `mcpSpindle*`, `mcpTelemetrySampleLimit`, `mcpJobEventLimit`, `mcpVibration*`. Env `LUBAN_MCP_*` mirrors stay global pins (an env pin applies to whatever machine is connected and is reported `source: 'env'`, as today).

### 1.5 Every G-code emitter in the MCP and its current dialect

All emit the **Snapmaker 2.0 Marlin** form (own-line `G53;` / `G54;`, absolute `G90`) unless noted. "Gated" = refused up-front on a Z-less machine by #264.

| File:function | Emits | Machine awareness today |
|---|---|---|
| `traversePlan.ts:235 buildStep` / `:265 header` | `G90\nG53;\nG1 X Y F;\nG54;` or `G91/G1 dXdY/G90` + settle comment | `TraverseMachine.gcode` (#264) |
| `directMovePlan.ts:131 planGotoWorkOrigin/gateDirectXy` | via traversePlan | #264 |
| `moveZPlan.ts` + `tools/gcode.ts:1448 move_z` | `G90\nG53;\nG1 Z.. F;\nG54;` | gated (`requireZAxis`) - no relative-Z form for GRBL/Original |
| `tools/gcode.ts:1692 traverse_xy` | traversePlan | #264 |
| `tools/camera.ts:382 raiseBeforeXy` | `G90 / G53; / G1 Z F / G54;` | none (used by move_and_capture; Z gate skipped on Z-less, but this helper still assumes G53) |
| `tools/camera.ts:570 executeDirectStep` | `G53;\n${move};\nG54;` or `G54;\n${move}` | relative verified via settle comment (#264) |
| `tools/camera.ts:1460 restore_work_frame` / `frameRecovery.ts:25 WORK_FRAME_RESTORE_GCODE` | `G90\nG54;` | none - wrong on Ray (G54 valid GRBL but not Luban's form) and Original |
| `tools/camera.ts:1617 home` -> `homeMachine` | `$H` / SACP request / `G53;G28;G54;` | #264 |
| `tools/camera.ts:1657 goto_work_origin`, `:1693 move_and_capture` | traversePlan / direct | #264 |
| `tools/toolsetter.ts:458 goto_tool_change_position` | `G90\nG53;\nG0 X Y;\nG54;` | gated Z-less |
| `tools/toolsetter.ts:239 run_tool_setter` -> `toolSetter.ts:289 describePlanAsGcode` | `G90 / G53; / G0 XY / G1 Z.. F100/60 ... / G54;` (server-driven march, description only) | none (needs Z + setter record) |
| `tools/toolsetter.ts:488/546 apply_tool_length_offset` | `G92 Z..` | none |
| `tools/workspace.ts:72 set_workspace_origin` -> `workspace.ts:179,206` | `G21\nG53;` then `G92 X Y Z\nM114` | none; assumes G54-59.3 (`workspace.ts:8`) |
| `tools/probing.ts:733 survey_bed`, `probing.ts:505 enterMachineFrame` | `G90\nG53;` | gated Z-less |
| `probeTool.ts:159`, `probeCircle.ts:248`, `probeCorner.ts:252`, `probeSurface.ts:519`, `probeVector.ts:191`, `probeWallFollow.ts:261`, `probeOutline.ts:365`, `probeSequence.ts:351`, `probeTracePerimeter.ts:365`, `approachHold.ts:289/335`, `probeCam.ts:430 describeProbeCamPlanAsGcode` | plan descriptions `G53; ... G54;` + sensor-gated marches | none (CNC+probe procedures) |
| `programEnvelope.ts:123/196 describeHomeOp` | `G53; G28; G54` as last op | none |
| `cameraBootstrap.ts:250`, `cameraProgram.ts:403` | `G90 / G53; ... G54;` | none |
| `threadMilling.ts:105` | `G21 G90 G54` header for converted files | n/a (file conversion for SM2) |
| `tools/gcode.ts:918 submit_gcode_job` + `validator.ts` | passes files through; `suggestGcode` (`:482-495`) rewrites inline G53 to own-line | A350 rule only |
| `pendantRuntime.ts:877,1302` | `G53` windows + M114 chains for the USB pendant | A350 only (M114 Count fields) |
| `failureRecovery.ts:735,1011` | cleanup sends `G54`/`G90` | assumes SM2 |
| `tools/enclosure.ts:56` | `connectionManager.setEnclosureLevel` (SSTP/SACP API or serial M1010) | channel-aware already; Ray M2000 W1/W2 not covered |

---

## 2. Design

### 2.1 Machine profile and dialect (extend `machineCapability.ts`)

Add one **pure** table module `gcodeDialect.ts` and widen `MachineCapability` (owned by WP1; nothing else edits `machineCapability.ts` in wave 1):

```ts
export type DialectId = 'sm2-marlin' | 'artisan-marlin' | 'j1-marlin' | 'original-marlin' | 'ray-grbl' | 'unknown';
export interface GcodeDialect {
  id: DialectId;
  family: 'marlin' | 'grbl';
  frames: { g53: 'own-line' | 'same-line' | 'none'; workspaces: string[] /* 'G54'..'G59.3' or [] */; g92: boolean; g921: boolean };
  distance: { g90: true; g91: true };
  home: { form: 'G28' | '$H' | 'sacp-request'; homesB: boolean };
  status: 'M114' | 'grbl-?' | 'sacp-only';
  laser: null | { modes: ('M3' | 'M4')[]; s: { min: 0; max: 255 | 1000 }; p: 'percent' | null; precedence: 'P' | 'S'; air: { on: 'M8' | null; off: 'M9' | null }; crosshair: string | null };
  spindle: null | { p: 'percent'; s: { min: number; max: number } | null };
  supported: Set<string>; unverified: Set<string>; incompatible: Set<string>;   // from the wiki rows in 1.2
  transportForm: 'sm2' | 'relative-steps';   // what the MCP emits for its own steps
  verifiedOnHardware: boolean;               // true only for 'sm2-marlin' (A350) today
  sources: string[];                         // wiki URL / "Luban generators (unverified)"
}
export function dialectFor(definition: MachineDefinitionLike | null): GcodeDialect;   // identifier -> row; unknown -> 'unknown' (refuse everything that emits)
```
`MachineCapability` gains `dialect: GcodeDialect`, `supports: { probing, toolSetter, rotary, laser, spindle, workspaces, zAxis }` derived from the row + `hasZ` + Luban `metadata.toolHeads` (A150/A250/A350/Artisan: CNC+laser; Ray: laser; J1: none; Original: laser+CNC). `MachineSummary` gains `dialect: DialectId`. `TraverseMachine.gcode` keeps its two literals but is now *derived* from `dialect.transportForm` (`'sm2'` -> `'snapmaker-2'`, `'relative-steps'` -> `'grbl-relative'`), so #264's planners need no change. Original and J1 use `'relative-steps'` (frame-independent, verified per step by the settle comment - the only form safe on a machine whose G53 support is unverified).

`requireCapability(what: keyof supports, action: string)` in `connectedMachine.ts` -> `McpToolError` with the machine tag and the table source ("the J1 is a printer; this MCP has no probing on it").

### 2.2 Per-machine keyed store and migration (`machineStore.ts`, new)

**Machine key** = `machineIdentifier` + optional device qualifier:
- `connectedDevice(): { machineIdentifier, deviceId: string | null, deviceSource: 'sacp-serial-number' | 'sstp-host' | null, machineKey }`
- `deviceId`: SACP -> `sn:<masterControlSerialNumber>` (new field `deviceSerial` on the channel Ready payload and in `getConnectionStatus()`); SSTP-HTTP -> `host:<address>`; text-serial -> `null` (COM ports are not identity).
- `machineKey` = `deviceId ? `${identifier}#${deviceId}` : identifier`.

**Record scope rule**: every per-machine record carries `machineIdentifier` and `deviceId: string | null`. Lookup for the connected machine returns, in order: records with the same `deviceId`, then **model-level** records (`deviceId: null`) with `scope: 'model'`. Writes while a device id is known are device-tagged; writes without one are model-level. Two same-model machines therefore only collide on model-level records, and `get_stored_state.machineScope` says which level each applied record came from. **Unknown device id** (text serial): everything is model-level, reported as `deviceScope: 'model (no device id on text-serial)'`.

**Shape** - one configstore key `mcpMachines`:
```json
{ "version": 1,
  "machines": {
    "Snapmaker 2.0 A350": { "deviceId": null, "travel": {"xMin":-19,"xMax":339,"yMin":0,"yMax":342}, "travelFudge": {"mm":25,"x":null,"y":null},
       "zPolicy": {"safeTraverseZ":328,"motionFloorZ":320,"traverseWithoutApprovalAtSafeZ":true},
       "rotary": {"axisX":..,"axisZ":..,"tailstockY":..,"chuckFaceY":..,"axisPoints":[...],"bedPlaneZ":..},
       "probe": {"effectiveLength":..,"tipDiameter":..,"stylusExposed":..,"bodyDiameter":..},
       "toolSetter": {...the mcpToolSetter object...}, "activeTool": {...}, "toolRegion": {...}, "maxJogDistanceMm": 100,
       "camera": {"url":..,"device":..,"lastGood":..}, "rotaryGravityCalibration": {...},
       "landmarksConfirmedAt": null, "updatedAt": 0 },
    "Ray#sn:12345": { ... }
  },
  "migratedFrom": { "legacyKeys": true, "pr264TravelMachine": "Ray|null", "at": 1760000000 } }
```
Access: `machineStore.get(section)` / `.set(section, value)` for the *connected* key, `.getFor(machineKey, section)`, `.list()`. `rotaryGeometry.ts` `readSetting`, `toolSetter.ts rawConfig`, `activeTool.ts raw()`, `tools/machine.ts travelFudge/safeTraverseZ/motionFloorZ/traverseWithoutApprovalAtSafeZ` switch their `config.get(key)` to `machineStore.get(section)`; the env override order is unchanged (env > per-machine > default).

**Migration** (run once at first `machineStore` load, idempotent):
1. If `mcpMachines` exists -> nothing.
2. Else build `machines['Snapmaker 2.0 A350']` from every legacy key in 1.4 that is set; **except** travel: if `mcpTravelMachine` names another machine (a #264 user stated the Ray's travel), the four ends go under that identifier (model-level) and the A350 gets none.
3. Write `mcpMachines` with `migratedFrom`; **legacy keys are left in place** (never deleted - rollback to #264 must keep working) and are ignored from then on. Log one info line listing what moved.
4. A second run sees `mcpMachines` and does nothing; a legacy key edited *after* migration is ignored (documented; `get_stored_state.migration` shows the snapshot).
File stores: `Landmark`/`CalibrationEntry` gain `deviceId?: string | null` (absent = model-level); no migration beyond #264's legacy rule.

**Policy per machine** (`zPolicy`): defaults exist only for the A350 (328/320/true - unchanged). Any other Z machine (A150/A250/Artisan/Original) **refuses** `traverse_xy`/`move_z` until the operator states `safe_traverse_z` and `motion_floor_z` via a new `set_machine_policy` tool (no invented bounds; the model's `size.z` is a travel limit, not a park height). `traverseWithoutApprovalAtSafeZ` is honoured only when `dialect.verifiedOnHardware` - everything else stages.

### 2.3 Validator rule engine

`validateGcode(gcode, options?: { dialect?: GcodeDialect; machineIdentifier?: string | null; travel?: TravelLimits | null })` - omitted = today's behaviour (A350 rules; `sm2-marlin`). Report gains `machine: { identifier, dialect, rulesApplied: string[] }` and `header: { machine, headerType, gcodeFlavor, isRotate, maxPower } | null` (parsed from `;Header Start..End` the way `parseGcodeHeader.js:11-24` does; MCP-side pure parser `gcodeHeader.ts`). New pure `dialectRules.ts`, each rule `(report, dialect, ctx) -> {warnings, refusals}` with a stable id:
- `unknown-command`: code not in `supported` -> warning (`unverified`) or **refusal** (`incompatible`, e.g. G38 on SM2, G18 on Ray).
- `frame-form`: SM2 -> inline G53 warning stays; **GRBL** -> own-line `G53;` is a *refusal* ("non-modal on GRBL: no effect, the next move runs in G54"), same-line accepted; `frames.g53 === 'none'` -> any G53/G54 refused.
- `s-range`: S > `laser.s.max` refusal (S1000 on an SM2 file is 4x over PWM; S255 on a Ray is 25 % - *warning* "did you mean S1000?" when `header.gcodeFlavor` disagrees with the dialect); P outside 0-100 refusal.
- `laser-mode-dynamic-short-segments`: in M4 with S > 0, count XY segments shorter than `L_min` at the programmed F. Power in M4 is scaled by *achieved* speed, and a segment shorter than the acceleration distance never reaches F, so it never reaches S - the 2026-10 kiss-cut (M4 S120 F3000, short openings) did not fire. Warn with the count, the median segment, and the fix ("M3 for cuts, or lower F"); refuse nothing (the operator may want it). `L_min` = `(F/60)^2 / (2 * a)` with `a` = 1000 mm/s^2 default (Ray `$X/Acceleration` unknown - reported in the warning as an assumption, not a bound).
- `z-on-zless`: any Z word with `hasZ:false` -> refusal.
- `travel`: extents vs model +/- fudge (`machineTravel.outsideTravel`) -> refusal naming the axis and the fudge, same text as `assertWithinTravel`.
- `header-machine`: `;machine:` present and != connected identifier -> **refusal at submit**, warning at validate; `;gcode_flavor` != dialect family -> refusal; `;is_rotate: true` on a machine without `supports.rotary` -> refusal.
- `homing-form`: `$H` in a file on Marlin, `G28` in a file on Ray -> refusal.
`resolveJobFrame` keeps #264's `relativeTransport` exemption and adds `frames.g53 === 'none'` handling (relative-only bodies are the only admissible server bodies there). `tools/staging.ts validateStagedEnvelope` passes the connected dialect; `tools/gcode.ts validate_gcode/submit_gcode_job` pass it and surface `machine.rulesApplied` + `header`. The confirm page (`jobs.ts:639-699`) gets a **Machine** row ("Ray (ray-grbl) - rules: frame-form, s-range, ...").

### 2.4 Emitter dispatch (`gcodeForms.ts`, new, pure)

```ts
machineFrameMove(d: GcodeDialect, words: string, feed?: number): string[]   // sm2: ['G90','G53;',`G1 ${words} F`,'G54;']; grbl: ['G90',`G53 G1 ${words} F`]; none: throws
relativeStep(d, dx, dy, dz, feed): string[]                                  // ['G91', `G1 X.. Y.. Z.. F..`, 'G90'] + settle comment (Z allowed only when hasZ)
workFrameRestore(d): string | null                                           // sm2: 'G90\nG54;'; grbl: 'G90' (no workspace reselect - Luban's form never selects one); none: 'G90'
homeSequence(d) -> homeCommandFor (unchanged)
```
Rule: **generic motion tools dispatch; procedures gate.** `traverse_xy`, `move_z` (new relative-Z form for `relative-steps` machines, verified by the settle comment extended with Z), `goto_work_origin`, `move_and_capture` (+ `raiseBeforeXy`), `home`, `restore_work_frame`, `failureRecovery` cleanup use `gcodeForms`. Every CNC procedure (`run_tool_setter`, `goto_tool_change_position`, `apply_tool_length_offset`, probing tools, `survey_bed`, `camera_bootstrap`, `set_workspace_origin`/`select_workspace`, pendant) calls `requireCapability()` at the tool boundary and keeps its SM2 description unchanged - "refuse rather than translate". Results of every dispatching tool carry `gcode_form: 'sm2' | 'relative-steps'` and `connected_machine` (already in #264 for four tools).

### 2.5 Ray laser toolset (new `tools/laser.ts`, pure plan in `laserPlan.ts`)

- `laser_frame {x0,y0,x1,y1 | job_id | gcode_header, power: 0 (default) | <= 5 % , feed, repeat}`: bounding-box trace at laser-off (`M5`, G0 moves - G0 is laser-off by definition on Ray [RAY]) or `M3 S<=50` (5 % of 1000, cap in `procedureLimits.ts` `LASER_FRAME_S_MAX`), relative steps with settle comments, staged through the same approval page, `safeZPolicy` never auto-executes (no Z). Box from the args, from a staged job's extents, or from the validator report; refused outside model +/- fudge.
- `set_air_assist {on}` -> `M8`/`M9` staged (Ray, SM2 20 W/40 W, Artisan; refused elsewhere). `set_crosshair {on}` -> `M2000 L13 P` (Ray/SM2 M2002 T3/Artisan). `laser_focus` -> **refused** on Ray ("no Z axis: focus is set mechanically on the module") and deferred elsewhere.
- No power above `LASER_FRAME_S_MAX` ever comes from the MCP; a job file's power is the file's business (validator rules).

### 2.6 Landmark review flow

Pure `landmarkReview.ts`: `reviewLandmarks({ landmarks (applying), confirmedAt, now, ttlDays, legacyBasisNames, machine })` -> 
```json
{ "status": "empty" | "unconfirmed" | "stale" | "legacy-basis" | "confirmed",
  "machine": {"identifier":"Snapmaker 2.0 A350","machineKey":"Snapmaker 2.0 A350#sn:123"},
  "landmarks": [{"name":"rotary","box":{...},"obstacle_top_z":null,"clearance_z":280,"basis":"toolhead","requiredToolheadZ":280,"deviceScope":"model"}],
  "question": "Before motion on Snapmaker 2.0 A350: these 2 landmarks will be enforced. Is this what is on the bed right now? 'rotary' and 'tool-setter' are on the legacy basis (toolhead Z 280 with a tool baked in) - state each one's PHYSICAL top (obstacle_top_z) if you can.",
  "answer_with": [
     "confirm_landmarks {confirmed: true}  - as listed",
     "set_landmark {name, obstacle_top_z, ...}  - restate / add, then confirm_landmarks",
     "delete_landmark {name}  - it is no longer on the bed" ],
  "stale_after_days": 7 }
```
Where it appears: `get_stored_state.landmark_review` (always), `get_position.landmark_review` only when not `confirmed`, and on **every staging/motion result** (`traverse_xy`, `move_z`, `goto_work_origin`, `move_and_capture`, every probe/setter staging result) as `landmark_review` when not confirmed. Behaviour: `safeZPolicy` gains `landmarksConfirmed: boolean`; when false the move is **staged, never auto-executed** (reason text names the review) - the operator's click is the confirmation of record for that one move, and the confirm page lists the applying landmarks in a **Landmarks** row (jobs.ts). `confirm_landmarks {confirmed: true, note?}` writes `landmarksConfirmedAt` on the machine key; any `set_landmark`/`delete_landmark` after it resets to `unconfirmed`; `stale` after `ttlDays` (per-machine policy, default 7) or on the first connect of a *different deviceId*. `set_landmark` gains update semantics (name exists -> fields optional; box kept) and `source: 'operator' | 'measured'` with a `measured_by` job id for setter/probe-derived heights. Guided restatement = the `legacy-basis` status + the `restatement` hint already in `landmarkClearance.ts:53` + `get_stored_state.landmarkClearances.legacyConsequences` (exists). After restatement the legacy `clearanceZ` is kept in `legacy: {clearanceZ, basis:'toolhead', retiredAt}` for audit, not enforced.

### 2.7 Physical-height model and rotary safe height

Existing (kept): `Landmark.clearanceBasis 'toolhead' | 'physical'`, `requiredToolheadZ(top, basis, protrusion, margin=5)` (`landmarkClearance.ts:81`), `currentToolProtrusion()` (`clearanceContext.ts:13`, protrusion from `activeTool` only when `clearanceBasis === 'toolhead_reference'`, else the setter's `toolheadClearanceBound`), `routeClearanceForPath` (`routeClearance.ts:19`), transient keep-out boxes in `probeProgram.ts:162,215`.

New pure `rotaryClearance.ts`:
```ts
rotarySafeHeight({ axisZPhysical, chuckFaceY, tailstockY, stock: {radiusMm, topZPhysical?} | null,
                   chuckTopZPhysical | null, tailstockTopZPhysical | null, toolProtrusionMm | null, marginMm = 5, fallbackTopZ })
 -> { zMm, basis: 'computed' | 'fallback-top', components: {...}, reasons: string[], wouldLowerIf: string[] }
```
`physicalTop = max(axisZ + stock.radius (or stock.topZPhysical), chuckTopZ, tailstockTopZ)` over the span `[chuckFaceY, tailstockY]`; `zMm = physicalTop + toolProtrusion + margin`. Any `null` among {axisZ, stock, chuck top, tailstock top, protrusion} -> `basis: 'fallback-top'`, `zMm = fallbackTopZ` (the machine's `safeTraverseZ`, 328 on the A350) and `wouldLowerIf` lists exactly which measurement would lower it ("run run_tool_setter (protrusion unknown)", "give stock.radius_mm", "set_landmark rotary-tailstock obstacle_top_z"). The planner result carries the whole object. Inputs: `rotary.*` from the machine store; chuck/tailstock tops = the `rotary-chuck` / `rotary-tailstock` landmarks on the **physical** basis (names fixed by convention, documented); stock = per-call args (`stock: {radius_mm, top_z_physical?}`) on `traverse_xy`, `goto_work_origin`, `move_and_capture`, probe programs - never a stored knob (memory: stock properties are per-program args). The rotary span landmark (legacy `clearanceZ 280`) is superseded by the computed box for the same XY extent when the computation succeeds; otherwise the legacy requirement stands (A350 unchanged until inputs exist).

### 2.8 Agent visibility (`appliedRecords.ts`, new)

`describeAppliedRecords()` -> `{ connected_machine: {identifier, type, hasZ, dialect, deviceId, machineKey, verifiedOnHardware}, records: { travel: 'stated (device)' | 'stated (model)' | 'model+fudge', travelFudge, zPolicy: 'A350 defaults' | 'stated' | 'missing', landmarks: [names], landmarkReview: status, toolSetter: 'device' | 'model' | 'none', probeGeometry, rotaryGeometry, activeTool, camera } }` - spread into every motion/staging result, `get_position`, `get_stored_state`, `get_machine_profile`, `get_connection_status` (adds `deviceSerial`, `machineKey`).

---

## 3. Work packages

All branches `mcp/mm-<topic>`, base = `fix/ray-machine-aware-motion` (PR #264) unless stated; one issue per PR, `Closes #N`, no self-merge; CI `Checks` is the result of record; `npm run test:mcp` locally; never whole-repo eslint; no G-code to any machine during development. **Shared file rule**: `tests/run.ts` is the one file every WP touches - each WP appends exactly one `['<suite>', <suite>Tests]` line at the END of `suites` and one import at the end of the import block, rebases before merge. No other file is shared between packages of the same wave. `docs/TOOLS.md`: each WP edits only its own tools' entries (new tools appended at the end).

### Wave 1 (parallel, independent)

**WP1 - Dialect table** `mcp/mm-dialect-table`
- Files: `gcodeDialect.ts` (new), `machineCapability.ts` (add `dialect`, `supports`, `MachineSummary.dialect`), `connectedMachine.ts` (`requireCapability`, `connectedDialect()`), `tests/gcodeDialect.test.ts` (new), `tests/machineCapability.test.ts`, `tests/run.ts`.
- Not touched: `traversePlan.ts` (keeps its two literals; `tools/machine.ts traverseMachine()` is rewired in WP4).
- Tests: one row per machine from 1.2 (G53 form, S max, home form, supports flags, Z-less), unknown identifier -> `'unknown'` dialect refusing emit, `supports.*` for all eight definitions, `verifiedOnHardware` true only for `sm2-marlin`.
- A350 behaviour: **none** (pure additions).
- Hardware acceptance: none (no tool reads it yet); `get_machine_profile` unchanged.

**WP2 - Device identity + per-machine store + migration** `mcp/mm-machine-store`
- Files: `src/server/services/machine/channels/SacpUdpChannel.ts`, `SacpTcpChannel.ts`, `SacpSerialChannel.ts` (Ready payload `+ deviceSerial: String(machineInfo.masterControlSerialNumber)`), `src/server/services/machine/ConnectionManager.ts` (`deviceSerial`, `host` in state + `getConnectionStatus()`, cleared on close), `connectedMachine.ts` (`connectedDevice()`, `machineKey`), `machineStore.ts` (new), `rotaryGeometry.ts` (read/write via store; delete `TRAVEL_MACHINE_KEY` scoping, `statedTravel(machineKey)`), `toolSetter.ts`, `toolDatumState.ts`, `activeTool.ts`, `tools/machine.ts` (`travelFudge`, `safeTraverseZ`, `motionFloorZ`, `traverseWithoutApprovalAtSafeZ` per machine; new `set_machine_policy` tool; `get_machine_profile` shows the policy + machineKey), `landmarks.ts` + `calibration.ts` (`deviceId`, device-first lookup), `cameraModelStore.ts` (machine + camera tag), `camera.ts` (per-machine camera preference with global fallback), `vibrationCaptures.ts:68` (gravity calibration per machine key), tests: `tests/machineStore.test.ts` (new), `tests/machineTravel.test.ts`, `tests/sacpConnection.test.ts` / `tests/sstpConnection.test.ts` / `tests/connectionGeneration.test.ts` (stub `getMachineInfo`), `tests/run.ts`.
- Dependencies: none (WP1 not needed - the key is identifier + serial).
- Tests: migration from (a) pre-#264 globals, (b) #264 globals with `mcpTravelMachine: 'Ray'`, (c) already migrated (idempotent, second run writes nothing), (d) legacy key edited after migration is ignored; stating the Ray's travel leaves the A350's ends intact; device-first then model lookup; text-serial -> model-level; env pin still wins and reports `env`; non-A350 Z machine refuses motion until `set_machine_policy`.
- A350 behaviour: **storage format changes** (keys move under `mcpMachines`, values identical, verified by a migration test that round-trips the operator's current key set); motion unchanged. Call-out: the A350 over SACP becomes `Snapmaker 2.0 A350#sn:<n>` and its migrated records are model-level - they apply (model fallback) and `get_stored_state` shows `deviceScope: 'model'`.
- Hardware acceptance (no motion): **A350** connect -> `get_connection_status.deviceSerial` populated, `get_stored_state` shows every previous value under the A350 key with `migration` snapshot, `get_machine_profile.travel` identical to before. **Ray** connect -> own key, no A350 records applying, `set_probe_geometry {travel_x_min: 0}` then reconnect A350 -> A350 travel still `-19..339`. **Original** over USB -> key `Original`, `deviceSerial: null`, `get_machine_profile.zPolicy: 'missing'`.

**WP6 - Physical heights and rotary safe height (pure)** `mcp/mm-rotary-safe-height`
- Files: `rotaryClearance.ts` (new), `landmarkClearance.ts` (export `physicalTopOf(landmark)`, keep API), `clearanceContext.ts` (`rotaryInputs()` reading geometry + the two named landmarks; `clearanceOptions()` unchanged signature), `routeClearance.ts` (accept an optional computed rotary box that supersedes a same-extent legacy box), `tests/rotaryClearance.test.ts` (new), `tests/landmarkClearance.test.ts`, `tests/run.ts`.
- Dependencies: none (reads `rotaryGeometry.geometryValue` which WP2 keeps as the API).
- Tests: computed height = top + protrusion + 5 with each input; each missing input -> fallback 328 with the matching `wouldLowerIf`; computed box supersedes legacy only when `basis: 'computed'`; a plan without `stock` arg never lowers below the legacy requirement.
- A350 behaviour: **none until a caller passes `stock`** (WP4 wires the arg) - then a rotary crossing may plan below 328 *only* with measured protrusion and stated stock/chuck/tailstock tops; reported in the result.
- Hardware acceptance (A350, after WP4): `run_tool_setter`, `set_landmark rotary-chuck {obstacle_top_z}` + `rotary-tailstock`, then `traverse_xy {..., stock: {radius_mm: 25}}` across the rotary -> result shows `rotary_clearance.basis: 'computed'`, `zMm` < 328, staged (not auto); execute and confirm the head clears by eye at the computed height with the operator's hand on the stop.

### Wave 2 (parallel; base = #264 + wave 1 merged)

**WP3 - Machine-aware validator** `mcp/mm-validator`
- Files: `gcodeHeader.ts` (new), `dialectRules.ts` (new), `validator.ts` (options param, `machine`/`header` on the report, `resolveJobFrame` for `frames.g53 === 'none'`), `tools/staging.ts`, `tools/gcode.ts` **only** `validate_gcode` + `submit_gcode_job` + `begin/finish_gcode_upload` handlers (lines 877-1100 region), `jobs.ts` (Machine row on the confirm page), `tests/validator.test.ts`, `tests/dialectRules.test.ts` (new), `tests/gcodeHeader.test.ts` (new), `tests/run.ts`, `docs/TOOLS.md` (validate/submit entries).
- Dependencies: WP1.
- Tests: every rule in 2.3 with a Ray file (`;machine: Ray`, S1000, M4 short segments at F3000 -> warning count), an A350 CNC file byte-identical report to today's plus the two new fields, header mismatch refusal at submit but warning at validate, GRBL own-line G53 refusal, `$H` in a Marlin file, Z word on the Ray, `;is_rotate` on the Ray.
- A350 behaviour: **new**: (a) M4-short-segment warning can appear on A350 laser files; (b) a file whose `;machine:` names another machine is now refused at submit (was accepted); (c) `incompatible` codes (SM2 list) are now refusals (today only warnings/none). Each is the point; listed in the PR.
- Hardware acceptance: Ray - `validate_gcode` on the kiss-cut file that failed to fire -> `laser-mode-dynamic-short-segments` warning with the segment count; `submit_gcode_job` of a Luban-exported Ray job -> accepted, confirm page Machine row reads `Ray (ray-grbl)`; an A350 CNC file on the Ray -> refused (`header-machine`). A350 - a previously accepted CNC job validates with identical extents/frame and two new fields. Original - a Luban Original laser export validates (M3 P form accepted, no refusals).

**WP5 - Landmark review flow** `mcp/mm-landmark-review`
- Files: `landmarkReview.ts` (new), `landmarks.ts` (update semantics, `source`, `legacy` audit block, `confirmedAt` via `machineStore` section `landmarksConfirmedAt`), `tools/landmarks.ts` (`set_landmark` update mode, `confirm_landmarks` new, `get_stored_state.landmark_review`), `appliedRecords.ts` (new - `describeAppliedRecords()`), `safeZPolicy.ts` (`landmarksConfirmed` input), `tests/landmarkReview.test.ts` (new), `tests/safeZPolicy.test.ts`, `tests/landmarks*.test.ts`, `tests/run.ts`, `docs/TOOLS.md` (landmark entries).
- Dependencies: WP2 (machine key). Does not touch `tools/gcode.ts`, `tools/camera.ts`, `jobs.ts` (WP4/WP3 own them) - the wiring of `landmark_review` into motion results and the confirm-page Landmarks row happen in WP4/WP8.
- Tests: status matrix (empty/unconfirmed/stale/legacy-basis/confirmed), reset on set/delete, stale on new device id, `safeZPolicy` refuses auto-execute when unconfirmed with the review text, `set_landmark` update keeps the box.
- A350 behaviour: **changed, by design**: until `confirm_landmarks` is called once per machine key (and again after 7 days or any landmark edit), a top-Z traverse is *staged* instead of auto-executed. First session after upgrade needs one `confirm_landmarks`. Legacy `rotary`/`tool-setter` boxes keep applying exactly as before.
- Hardware acceptance (no motion): A350 - `get_stored_state.landmark_review.status: 'legacy-basis'` listing both boxes with the restatement hint; `confirm_landmarks` -> `confirmed`; `set_landmark tool-setter {obstacle_top_z: <measured>}` -> `unconfirmed` again, `requiredToolheadZ` = top + protrusion + 5 once the setter has run. Ray - `status: 'empty'` with the question "what is on the bed?".

### Wave 3 (parallel; base = wave 2 merged)

**WP4 - Emitter dispatch, capability gates, visibility on motion results** `mcp/mm-emitters`
- Files: `gcodeForms.ts` (new), `tools/machine.ts` `traverseMachine()` only (derive from dialect) - *the rest of tools/machine.ts was WP2's and is merged by now*, `traversePlan.ts`, `directMovePlan.ts`, `moveZPlan.ts` (relative-Z form), `frameRecovery.ts`, `failureRecovery.ts` (cleanup via `workFrameRestore`), `tools/gcode.ts` (`move_z`, `traverse_xy`: dispatch, `stock` arg -> WP6, `landmark_review` + `describeAppliedRecords()` in results), `tools/camera.ts` (`home`, `goto_work_origin`, `move_and_capture`, `restore_work_frame`, `raiseBeforeXy`, `executeDirectStep` Z settle), `tools/toolsetter.ts`, `tools/probing.ts`, `tools/cameraModel.ts`, `tools/workspace.ts`, `tools/cam.ts`, `tools/probe.ts`, `pendant.ts` entry (`requireCapability` gates + applied records on their staging results), `tests/traversePlan.test.ts`, `tests/directMovePlan.test.ts`, `tests/moveZPlan.test.ts`, `tests/gcodeForms.test.ts` (new), `tests/run.ts`, `docs/TOOLS.md` (those tools' entries), `README.md` law-2 paragraph.
- Dependencies: WP1, WP2, WP3 (staged bodies validated with the dialect), WP5 (review + applied records), WP6 (`stock` arg).
- Tests: A350 step bytes unchanged (existing snapshot tests); Ray `move_z` refused, `restore_work_frame` emits `G90` only; Original `traverse_xy` -> relative steps + settle, `move_z` -> `G91/G1 Z/G90` with Z settle verification, refused while `zPolicy` missing; J1 every motion tool but `home` refused with the printer text; Artisan traverse staged never auto (unverified on hardware); every result carries `connected_machine.dialect`, `records`, `landmark_review`.
- A350 behaviour: **none in bytes**; results gain fields.
- Hardware acceptance: **Ray** - #264's steps 1-5 rerun (`$H`, staged relative traverses, X650 refused), plus `restore_work_frame` -> `G90` accepted by the firmware, `move_z` refused naming the Ray. **A350** - #264 step 6 rerun (G53 steps byte-identical, top-Z auto-execute after `confirm_landmarks`, floor refusal at Z0), `run_tool_setter` still works. **Original** (USB) - `home` -> G28 completes; `set_machine_policy {safe_traverse_z: 120, motion_floor_z: 110}` (operator numbers, from the machine); `move_z {z: 120}` staged -> executes as a relative step and `get_position` agrees within 0.05; `traverse_xy` 20 mm staged -> relative step verified; nothing emits G53/G54 (check the gcode log).

**WP7 - Ray laser toolset** `mcp/mm-laser-tools`
- Files: `laserPlan.ts` (new), `tools/laser.ts` (new: `laser_frame`, `set_air_assist`, `set_crosshair`, `laser_focus` refusal), `procedureLimits.ts` (`LASER_FRAME_S_MAX`, `LASER_FRAME_FEED`), `index.ts` (`registerLaserTools`), `tests/laserPlan.test.ts` (new), `tests/run.ts`, `docs/TOOLS.md` (appended section).
- Dependencies: WP1, WP3 (staging with the dialect), WP2 (travel per machine). Parallel with WP4: no shared files (`tools/staging.ts` is consumed, not edited; the relative-step builder is used from `traversePlan.ts` as merged in wave 2 - WP7 must not edit it; if WP4 changes its signature, WP7 rebases after WP4).
- Tests: box from args / from a job's validator extents; S cap clamps and reports (`clampReported`); laser-off frame uses G0 only; M8/M9 refused on J1/Original; crosshair M-code per dialect; refused beyond model +/- fudge; `safeZPolicy` never auto.
- A350 behaviour: `set_air_assist` / `set_crosshair` become available for the 20 W/40 W module (new tools; no existing tool changes).
- Hardware acceptance: Ray - `laser_frame` of a 50x50 box at power 0 -> staged, confirm page shows G0 relative steps + `M5`; approve, head traces the box, laser dark; repeat with `power_percent: 2` -> `M3 S20`, visible dot; `set_air_assist {on: true}` audible; `laser_focus` refused. A350 (laser module fitted, operator-confirmed): `set_air_assist` -> `M8` accepted (no module = refused by the capability check on the connected head).

### Wave 4

**WP8 - Visibility sweep, confirm page rows, docs/skills** `mcp/mm-visibility`
- Files: `jobs.ts` (Landmarks row + applied records on the confirm page), `tools/machine.ts` (`get_position`, `get_machine_profile`), `tools/status.ts` (`get_connection_status` adds `deviceSerial`, `machineKey`, `dialect`), `tools/landmarks.ts` (`get_stored_state.records`), `diagnostics.ts` (machine key in diagnostics), `README.md`, `.agents/skills/cnc-motion-rules/SKILL.md` (machine-aware checklist item 0: "which machine; `landmark_review` must be `confirmed`"), `docs/TOOLS.md`.
- Dependencies: all of the above. Tests: snapshot tests for the three read-only tools; `jobs.test`/`jobDashboard.test` for the rows.
- A350 behaviour: none (reporting only).
- Hardware acceptance: connect each machine in turn (A350, Ray, Original) and read `get_connection_status` / `get_position` / `get_stored_state`: identifier, dialect, machineKey, records, review status all name the right machine; no motion.

Parallelism summary: wave 1 = WP1 ‖ WP2 ‖ WP6; wave 2 = WP3 ‖ WP5; wave 3 = WP4 ‖ WP7; wave 4 = WP8. Hardware tests run only when a wave is merged and deployed (memory: operator often deploys merged builds themselves - check the box before redeploying).

---

## 4. Risks, open questions, what is rudimentary / deferred

**Open questions for the operator**
1. **Original frames**: does `Snapmaker-Base-2.x` accept `G53`/`G54` at all? Plan assumes *no* and uses relative steps everywhere. A one-line hardware check (`G54` then `M114`, watch for `echo:Unknown command`) before WP4 would let the Original use absolute forms later.
2. **Original park/floor heights**: the plan refuses motion until `set_machine_policy` states them (no invented bounds). Confirm you prefer that over a model-derived default (`size.z` = 125 / 221 Extended).
3. **Ray G53**: wiki says same-line `G53 G0 X Y` works; nothing has verified it on the Ray's firmware. Plan keeps relative steps (verified form) and only *accepts* same-line G53 in submitted files. Do you want a hardware test of `G53 G0` to allow absolute moves later?
4. **Dynamic-power rule constant**: the acceleration used for the "segment never reaches F" estimate (1000 mm/s^2) is an assumption; `$X/Acceleration` can be read with `$S` on the Ray - want the MCP to read it once per connect (a `$S` query over `executeGcode`) and store it per machine instead?
5. **Landmark confirmation cadence**: 7-day TTL and "re-ask on a new device id" - acceptable, or confirm once per connect?
6. **Device key for SSTP-HTTP** is the host address (DHCP-brittle). Alternative: Luban's saved-machine `name`. Which?
7. **Auto-execute at safe Z** stays A350-only (`verifiedOnHardware`). Artisan/A250 owners would have to flip the flag after a hardware session - fine?
8. The camera-model store is untagged today; tagging by machine + camera device id is in WP2 - confirm the A350 rig's current model should be attributed to the A350 (same legacy rule).

**Risks**
- SACP Ready payload change touches the connection layer (three channels + ConnectionManager); the test harnesses stub `getMachineInfo` - CI is the arbiter (no local whole-repo lint).
- Migration edge: an operator who already stated the Ray's travel on #264 (`mcpTravelMachine: 'Ray'`) - covered by migration case (b), but the A350 then has *no* stated ends until restated (as on #264 today).
- `tests/run.ts` merge conflicts across waves are trivial but certain; the append-at-end rule keeps them one-line.
- The M4 short-segment rule can be noisy on raster engraving (thousands of short segments by design) - the rule only fires for `S` above a threshold with `movementMode`/`renderMethod: line` in the header, and reports one summary line, not per segment.
- Relative-Z on the Original relies on the settle comment + M114 agreement at 0.05 mm; the Original's M114 precision is unverified (open question 1's check covers it).

**Rudimentary by design (J1, Artisan, A150/A250)**
- J1: detection, profile, `home` (SACP request), status; every other motion tool refuses ("printer, no procedures").
- Artisan: SM2 dialect row from its wiki page, SACP home, rotary path shared with the 2.0 (same `rotary.*` geometry sections keyed to the Artisan's machine key), travel = 400x400x400 +/- fudge, `zPolicy` must be stated, everything staged (never auto); probing/tool setter allowed only once a setter/probe record exists for its key. No hardware test possible - marked unverified in every result.
- A150/A250: profile rows only (sizes from `src/app/machines`), same gates as Artisan.

**Deferred**
- Translating CNC procedures (probing, tool setter, survey, camera bootstrap) to non-SM2 dialects - they refuse instead.
- Ray job control (`$SD/Run`, `!`, `~`) through the MCP - jobs still go through Luban's upload path.
- Enclosure/purifier on the Ray via `M2000 W*` (today's `set_enclosure_*` is channel-API based and refuses when the API has no enclosure).
- Reading `$S`/`$G` on the Ray for parser state (would let the MCP confirm G90/G54 after a job).
- Per-machine *camera calibrations* beyond #264's tag (already scoped) and the confirm-page camera preview for the Ray.
- A `laser_focus` procedure for Z machines with a laser module (needs the module's focal-length table).
