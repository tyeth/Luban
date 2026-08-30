---
name: cnc-visual-alignment
description: "Measure CNC stock and position a toolhead from webcam frames — via the Luban MCP tool surface (capture, guarded moves, Y-keyed calibration, visual servo) with single-frame metric rectification and parallax handling as the vision core. Use whenever the user wants to locate stock, find a datum, set or verify a work origin visually, drive the toolhead to something seen on camera, or measure a part on the bed."
---

# CNC visual alignment from a toolhead camera

Turn webcam frames into real millimetres and drive the toolhead to something you can see.
The geometry is the easy half; the hard half is the failure modes that make a confident
number wrong, and the machine semantics that make a correct number mean the wrong thing.

This skill was first proven with every frame pasted by hand. The machine now runs a **Luban
MCP server** that automates capture and guarded motion — use it when present, but every
principle below survives if you are back to pasted frames and a human relaying gcode.

## First: what tooling is live?

Check for `mcp__luban__*` tools. If present (`get_connection_status` answers), the whole
loop below is automated. If not, ask how frames arrive and how gcode reaches the machine,
and budget for the fact that every hand-relayed iteration costs minutes — design for fewer,
better frames.

### The Luban MCP surface, by job

| Job | Tool | What matters |
|---|---|---|
| Orient yourself | `get_connection_status`, `get_machine_profile`, `get_position` | Profile carries kinematics and module offsets (bracing kit shifts the envelope). `get_position` reports BOTH coordinate systems, report age, and a `warnings` array — a non-empty `warnings` means position reporting is incoherent; stop and verify. |
| Authoritative frame check | `query_firmware_position` | Raw M114 from the controller. When heartbeat-derived numbers look wrong, this is the truth. |
| Frames | `list_cameras`, `capture_frame` | Every frame is stamped with the firmware-reported position it was taken at. That stamp is what makes calibration possible — never discard it. |
| Machine home | `home` | Sends `G53;G28;G54` like Luban's own button. **Homing also homes B: stock indexed on the rotary rotates.** Warn the operator before homing when a rotary is fitted. |
| Work origin | `goto_work_origin` | XY only, at the current Z. Distinct from homing — never conflate the two. |
| Single guarded move | `move_and_capture` | ONE bounded XY move at current Z, settle, capture. No Z parameter by design. |
| Servo step | `visual_servo` | One clamped correction per call; the loop lives in you, not the tool. |
| Calibration store | `set_/get_/delete_camera_calibration` | 2×2 pixel-delta→mm matrix, keyed by the machine Y and Z it was derived at. |
| Anything compound, and all Z | `validate_gcode`, `submit_gcode_job` → human confirm page → `start_gcode_job`, `get_gcode_job_status`, `stop_gcode_job` | Jobs run through the controller's own state machine and door interlock. The one-time confirm code exists so you cannot self-authorise motion — only the operator can. |

### Machine semantics you must not re-derive wrongly (verified on the A350)

- The controller has **G53 (machine workspace) and G54+ (numbered work workspaces)**; the
  heartbeat position is in the *currently selected* workspace. `machine = work − originOffset`.
- **Machine home is X−19 Y342 Z328** — the X switch sits 19 mm left of work-area zero, and
  **home is not the origin**. Homing takes ~15–20 s.
- **Work origins are operator-set per workspace and persist across homing.** Do not assume a
  home reset them, and do not assume they match the current stock setup either — verify.
- "Home"/"homing" ALWAYS means machine home. Going to work X0 Y0 is "goto work origin".
- The camera is **toolhead-mounted**: it rides X and Z; the **platform moves under it in Y**.
  So a pixel→machine mapping is valid only at the machine Y (scale also changes with Z) at
  which it was captured — which is exactly how the calibration store is keyed.
- The repeatable *board-viewing* camera pose is the pre-home park (machine X0 Y0), not
  machine home — at home the work area is out of frame entirely.

## Measuring: the pipeline

`scripts/board_metrology.py` implements single-frame metric rectification end to end. Read
it before writing your own.

```bash
python3 scripts/board_metrology.py frame.jpg \
    --quad 421,114 530,133 508,193 409,174 \
    --patch 360,180,560,340 --grid-cm 1.0
```

1. **Colour-mask the board** so line detection never sees metalwork.
2. **Flat-field** (divide by a heavy Gaussian) before Canny — raw edges find shading and
   wood grain, not grid lines.
3. **`HoughLinesP`**, split segments into the two angular families.
4. **Vanishing point per family** — SVD null-space of stacked homogeneous line coords.
5. **Affine-rectify** from the line at infinity through both VPs.
6. **Recover the final scale** by asserting a known-rectangular object really is rectangular.

### Two independent routes, or you have nothing

The anisotropy from step 6 must agree with the grid pitch from a Radon projection of the
rectified board. In the validating session both routes gave 1.71 — that agreement is the
*only* reason the number was trustworthy. Disagreement by ~2× means a peak-finder locked
onto a harmonic; other disagreement means an under-constrained vanishing point (usually the
family with fewer lines) — re-shoot with more bare board in frame rather than proceeding.

### The field-of-view sanity check is mandatory

Convert your scale back to px/cm, multiply out to the frame width, compare with the known
bed size. This check once caught a 1.25× pitch error that both other validations passed.

## The four things that make a confident number wrong

**Foreshortening.** One px/mm figure is valid along one direction only. An uncorrected pass
read a block 60 × 35 mm; rectified it was 58 × 45 — the error concentrated in one axis.

**Top-face magnification.** An elevated face images larger by `D/(D−h)` (D ≈ camera
standoff; at D≈290 mm a 40 mm block reads 16 % oversize). **Measure the base contact line**,
never the top face; if you must use the top face, ask for the thickness with calipers.

**Parallax.** At tilt θ, a point *h* above the board images `h·tan θ` from the point beneath
it — 0.70 mm per mm at 36°. This is why open-loop moves cannot be verified from high Z.

**Lens distortion.** Cheap webcams barrel-distort. If you can get a checkerboard on the
bed, do intrinsic calibration and skip the single-frame cleverness.

## Positioning: servo, do not compute-and-jump

Never compute a machine coordinate from one frame and drive to it. With the MCP:

1. Establish state: `get_connection_status` → `get_position` (warnings empty?) → if in any
   doubt, `query_firmware_position`.
2. If not homed, `home` — after warning the operator about the rotary, and knowing that
   `move_and_capture`/`visual_servo` refuse un-homed motion unless the operator has
   explicitly confirmed Z and path clearance (`operator_confirmed_clearance`, which you
   pass ONLY on the operator's word, never on your own judgment).
3. Derive the 2×2 matrix at the working Y and Z: command 2–3 known small XY offsets with
   `move_and_capture`, track one feature's pixel displacement, fit, store with
   `set_camera_calibration` (record residuals in `notes`).
4. Iterate `visual_servo` — each call is one clamped step and returns the frame; two or
   three passes converge. It auto-selects the nearest-Y calibration and warns when a step
   moves Y (self-invalidating) — re-derive or re-select when it does.

This loop is immune to lens distortion, unknown camera mounting, and an imperfect
homography, because it only ever measures a *difference* near the target.

Z positioning is not part of the servo: raise or lower Z via a one-line `submit_gcode_job`
through the operator's confirm page. Refuse to servo from a height where parallax exceeds
the tolerance you are claiming.

## Datums: check the landmark is actually in frame

A stated datum is worthless if it is outside the field of view. Verify visually before
building on it. When the datum fixes only one coordinate, say so and ask for one anchor
frame — do not extrapolate. Recover axis directions from evidence: a commanded +X moves the
*camera* over the scene; a commanded +Y moves the *scene* under the camera (platform axis).
If those look swapped, something is mislabeled — stop.

## Safety

- Motion tools enforce: idle machine, toolhead off, homed-first (or explicit operator
  clearance), per-call travel bound, build-envelope check. Do not look for ways around
  them; they encode operator rules.
- The endmill may always be in the collet — an XY move at low Z can drag it through stock
  or clamps. Read Z before moving in XY; when in doubt, raise Z via a confirmed job first.
- Never send a cutting move (spindle on, or Z below stock top) without fresh human
  confirmation — the job confirm page is that mechanism; a stale or reused code is not.
- Report every dimension with an uncertainty. A bare figure reads as authority it has not
  earned.
