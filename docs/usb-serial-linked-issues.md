# A350 USB serial: linked issues

Published in `tyeth/Luban` on 2026-11-01: [#336](https://github.com/tyeth/Luban/issues/336), [#337](https://github.com/tyeth/Luban/issues/337), [#338](https://github.com/tyeth/Luban/issues/338), and [#339](https://github.com/tyeth/Luban/issues/339). They are cross-linked in their bodies and from the [#265 tracker](https://github.com/tyeth/Luban/issues/265#issuecomment-6562377371). The sections below preserve the report text.

The observations below are from the 2026-11-01 A350 text-serial trial, with Luban's installed package reporting 4.15.2. The deployed `app.asar` differs from this checkout; fix work must first reconcile matching source and installed build. The [USB trial plan](usb-serial-probing-test-plan.md) records the broader review and test matrix. No contact trial was run over USB.

## [Issue #336](https://github.com/tyeth/Luban/issues/336) — USB text serial reports queued G-code as completed motion

**Title:** `MCP: A350 USB text serial reports queued G-code as completed motion`

**Body:**

On the A350 USB text-serial channel, `TextSerialChannel.executeGcode()` calls `controller.command(...)` and immediately returns `{ result: 0, text: 'ok' }` (`src/server/services/machine/channels/TextSerialChannel.ts:116-125`). This reports successful enqueue, not firmware acknowledgement or physical completion. MCP motion and unexpected-contact guards use that return as the end of an in-flight operation.

In the live USB trial, an approved direct camera-placement operation moved from machine X-19 Y342 Z328 to X60 Y150 Z328. Its command API `execMs` was 6 ms, while the procedure needed about 21.26 s of subsequent settling and 24.1 s overall. The final camera capture and position were correct; the timing demonstrates that `execMs` was queue acceptance, not arrival. No contact occurred in this trial.

**Expected:** The channel exposes distinct enqueue, attributable firmware acknowledgement, and independently established physical completion states. MCP must keep the contact/crash bracket active until completion, or refuse sensor-gated approach on this transport. A timed-out, failed, disconnected, or cancelled batch must not release the next motion step.

**Acceptance:** Add simulated serial/controller tests for delayed ACK, ACK before movement completes, no ACK, disconnect during movement, failed line with queued tail, and a sensor trip after enqueue but before arrival. Prove that no next probe increment is issued until completion plus sensor verdict. Run a non-contact hardware qualification before any USB contact probe.

Related: [#265](https://github.com/tyeth/Luban/issues/265), [#337](https://github.com/tyeth/Luban/issues/337), [#339](https://github.com/tyeth/Luban/issues/339).

## [Issue #337](https://github.com/tyeth/Luban/issues/337) — M114 queries have no attributable text-serial reply

**Title:** `MCP: correlate A350 USB text-serial M114 replies with their requests`

**Body:**

After connecting the A350 over USB text serial and homing, MCP `query_firmware_position` returned the literal raw text `ok`, without an attributable M114 position line. Background Marlin telemetry later supplied a trusted position and work offset, but the direct query API could not independently verify the requested response or measure its latency. `TextSerialChannel.executeGcode()` returns an immediate synthetic `ok` (`src/server/services/machine/channels/TextSerialChannel.ts:116-125`); the shared Marlin controller also issues autonomous M114/M1007 queries and can interleave a query on `ok` (`src/server/controllers/Marlin/MarlinController.js:140-163,545-595`).

The existing closed [#299](https://github.com/tyeth/Luban/issues/299) established text-serial **position trust** from M114 and fresh M1007. This issue concerns **request/reply correlation** and an explicit query result. Do not weaken the homing or fresh-offset gate. In this trial, position was correctly `awaiting-resync` until homing, and trusted machine coordinates returned afterward.

**Expected:** A read-only query returns its own firmware response or an explicit `unsupported/unattributable` capability result. It does not report synthetic `ok` as the raw M114 reply. Concurrent UI/background queries, fragmented lines, error replies and reconnects cannot satisfy another caller's request. Expose the age and source of any position used as an alternative.

**Acceptance:** Simulate interleaved M114/M1007, fragmented and delayed lines, duplicate `ok`, timeout, error, and old-session replies. Verify that the MCP query is either correctly correlated or explicitly refused, and that a stale or contradictory position never qualifies a probe step.

Related: [#265](https://github.com/tyeth/Luban/issues/265), [#299](https://github.com/tyeth/Luban/issues/299), [#336](https://github.com/tyeth/Luban/issues/336).

## [Issue #338](https://github.com/tyeth/Luban/issues/338) — File G-code staging is unavailable over A350 USB text serial

**Title:** `MCP: support or clearly expose file-job staging capability on A350 USB text serial`

**Body:**

In the live USB trial, `submit_gcode_job` refused a simple absolute XY job because the active text-serial channel has no MCP file-upload path. Nothing was staged or sent. The same requested placement had to be represented as a `probe_program` camera-capture operation, then explicitly approved and run. This is a channel capability gap and should not be mistaken for a machine rejection of the G-code.

**Expected:** Either support an approval-gated, ordered direct/file job on this channel with proper completion and cancellation semantics, or expose `file_upload: unsupported` at preflight so callers can choose the supported staged direct-operation path before preparing a file job. Never silently fall back to an unapproved direct send.

**Acceptance:** Test capability reporting, stage refusal with no machine write, approval binding, ordered execution and failure handling on text serial. Keep file jobs blocked from sensor-gated probing until [#336](https://github.com/tyeth/Luban/issues/336) and [#339](https://github.com/tyeth/Luban/issues/339) are resolved.

Related: [#265](https://github.com/tyeth/Luban/issues/265), [#336](https://github.com/tyeth/Luban/issues/336), [#339](https://github.com/tyeth/Luban/issues/339).

## [Issue #339](https://github.com/tyeth/Luban/issues/339) — Qualify A350 USB stop and queued-command cancellation

**Title:** `MCP: qualify physical stop and queue cancellation for A350 USB direct motion`

**Body:**

This is a safety qualification gap, not a claim that a live stop failed. The reviewed `TextSerialChannel` has no `stopGcodeJob` method, and `connectionClose()` closes the controller without sending a CNC stop (`src/server/services/machine/channels/TextSerialChannel.ts:93-112`). The installed build has transport-specific stop wrappers elsewhere, so the exact deployed A350 text-serial behavior must be verified. A procedure state of `stopped`, USB close, or a withdrawn future leg does not prove that the current planner movement stopped.

The closed [#320](https://github.com/tyeth/Luban/issues/320) addressed withdrawal **between** direct-batch legs on Ray/Original. This issue addresses an A350 USB movement **already in flight** and any queued tail after an error or unexpected sensor trigger.

**Expected:** Define and report distinct outcomes for (1) withdrawing unsent legs, (2) stopping active physical motion, and (3) flushing already queued commands. If the exact channel cannot stop active movement with a bounded, verified response, MCP must refuse sensor-gated motion over it. On contact or transport loss, preserve a held/unknown position state and never auto-retreat without reliable stop and frame evidence.

**Acceptance:** Use mock serial/controller streams first: delayed ACK, queued tail, unexpected GPIO trigger after enqueue, stop command failure, disconnect and reconnect, old callbacks, and UI query interleaving. Assert no further G-code is emitted after a stop request and that the reported stop state matches simulated physical state. Only then design a separately reviewed, non-contact hardware stop demonstration.

Related: [#265](https://github.com/tyeth/Luban/issues/265), [#320](https://github.com/tyeth/Luban/issues/320), [#336](https://github.com/tyeth/Luban/issues/336).
