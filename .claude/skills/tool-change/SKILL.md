---
name: tool-change
description: "Change the CNC tool and keep the work origin true — measure the old tool on the tool setter, park for a manual swap, measure the new tool, and shift the work origin Z by the length difference, all through the Luban MCP tool surface. Use whenever the user wants to change bits/tools mid-job-setup without re-touching the stock."
---

# Tool change without losing the work origin

A tool change replaces the one physical thing the work origin Z was calibrated
through: the tool tip. The tool setter (fixed switch on the bed, probe feed
channel `toolsetter`) measures each tool's trigger height, and the difference
between two measurements IS the length difference — so the work origin can be
shifted exactly, without ever re-touching the stock.

## Preconditions

- Probe feed connected (`get_probe_feed_status` to check; `connect_probe_feed`
  if not - the feed auto-connects at start when configured) and the machine
  homed and idle. If the status shows `unavailable: true` / `bridge: not
  detected`, the USB sensor bridge is unplugged - tell the operator, do not
  work around it. If a tool refuses with "the tool setter is disabled
  (Settings -> MCP Server)", the operator switched that sensor off in the app;
  ask them to enable it - never proceed without the sensor. The tool setter's overtravel switch is a tripwire ONLY while
  this procedure (or other MCP motion) is running: pushing the setter past
  contact mid-run latches the alarm; by hand with the machine idle it just
  flashes the Workspace pill. The Workspace -> Connection pills (Tool Setter /
  Setter Overtravel) should both read green before you start.
- Tool setter reference and the tool-change park position stored
  (`get_tool_setter_config`; the operator sets them once with
  `set_tool_setter_config` — on this machine the park is Z at the homing
  height, X at the far end, Y free).
- Every motion step below stages a job the OPERATOR approves on a confirm page;
  the one-time code they give you goes to `start_gcode_job`.

## Two flows — ask which one the operator is using

**A. MCP-managed offset** (operator at the computer): measure old → park → swap
→ measure new → `apply_tool_length_offset` shifts the work origin. Steps below.

**B. Touchscreen manual-swap wizard** (operator at the machine): the FIRMWARE
matches the tip positions itself, so no origin shift is applied by MCP — the
agent's job is only to find and HOLD the trigger height for each tool:

1. `run_tool_setter` with `stay_at_trigger: true` — one move up, over to the
   setter, measure, and hold the tip in contact. Send no other motion.
2. The operator confirms the position on the touchscreen and swaps the tool by
   hand; the wizard returns the new tool over the setter near height.
3. `run_tool_setter` again with `stay_at_trigger: true, start_from_current:
   true` (skips travel; verified over the centre within 1.5 mm). The operator
   confirms the matched position on the touchscreen — the firmware applies the
   offset. Do NOT also call `apply_tool_length_offset` (it would double-apply).
4. Only after the operator says the wizard is finished may motion resume.

If the new tool reads already-triggered before the second run (a longer tool
pressed into the setter by the wizard), the run refuses to start - the
operator raises it slightly from the touchscreen first.

## The sequence (flow A)

1. **Measure the old tool** — `run_tool_setter` with the operator-stated
   `bit_length_mm`. Skip only if the last stored measurement
   (`get_tool_setter_config` → `measurements.last`) is from this same tool,
   this session, and the operator confirms nothing has moved.
2. **Park** — `goto_tool_change_position`. One approval, two
   `start_gcode_job` calls: Z rises to the park height first, then X/Y.
3. **The operator swaps the tool by hand.** Wait for their word; never infer
   it. Ask them for the new tool's approximate length.
4. **Measure the new tool** — `run_tool_setter` with the new `bit_length_mm`.
   The measurement history now holds previous = old tool, last = new tool.
5. **Shift the work origin** — `apply_tool_length_offset` (defaults to those
   two measurements). It stages a single `G92` — nothing moves; the work frame
   shifts by `new − old`. A longer tool makes the current work Z read LOWER.
6. **Verify** — `get_position`: `originOffset.z` must have changed by the
   delta, and the operator should sanity-check the displayed work Z against
   physical reality before any cutting.

## Failure modes to respect

- The spread reported by `run_tool_setter` is the trust metric: passes that
  disagree by more than one fine step mean feed latency or a loose tool —
  re-measure before applying any offset.
- `apply_tool_length_offset` refuses deltas over 50 mm; if it triggers, the
  stored measurements are not an old/new pair (stale history, wrong bit
  declared). Pass `old_trigger_z`/`new_trigger_z` explicitly from known-good
  values instead of loosening anything.
- If the overtravel alarm latches at any point, everything stops until the
  operator physically inspects and explicitly clears it - the Clear alarm
  button on the ALARM pill in Workspace -> Connection, or
  `clear_overtravel_alarm` with their words as `reason`. Both refuse while the
  sensor still reads triggered.
