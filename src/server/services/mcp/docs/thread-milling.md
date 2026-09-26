# Thread-milling program import

`convert_thread_milling_gcode` converts Fanuc-style thread-milling output to an
explicit absolute G0/G1 program for Snapmaker. It runs offline: no connection,
origin modification, staging or motion. The source file is not modified.

The supplied regression fixture is the user's Machining Doctor program: 2.53 mm
programmed major diameter, 0.45 mm pitch, 5 mm thread length, 1.38 mm cutter diameter
and 2.25 mm multi-tooth cutting length. It contains nine arcs, including three full
helical turns. Its final cutting position is work Z +0.006 mm because of the
source's rounded increments; conversion preserves that result rather than changing
it to zero. The final rapid returns to the source's work Z20.

## Usage

```json
{
  "gcode": "<complete generator output>",
  "tool_center_path": true,
  "tool_length_applied": true,
  "spindle_mode": "cnc_200w_rpm",
  "chord_tolerance_mm": 0.002
}
```

For the standard CNC head, choose `spindle_mode: "power_percent"` and supply
`spindle_power_percent` (integer 1–100). This deliberately replaces source RPM;
it does not infer a motor calibration or rescale feeds. The 200 W RPM mode keeps
the source RPM and rejects values outside the firmware's 8000–18000 range instead
of silently clamping. Material, chip load and spindle settings need to agree in
the generator before importing.

The two required declarations have specific meanings:

- `tool_center_path`: the generator has already offset the path by cutter radius
  and the Fanuc D compensation value is zero. `D1` selects register 1; it is not a
  1 mm compensation. Nonzero radius/wear compensation is not implemented.
- `tool_length_applied`: the work origin already accounts for the fitted tool tip.
  The converter removes G43/H lookup but preserves the block's inherited move,
  including the sample's initial G0 Z20. It does not apply a tool-length offset.

Review `gcode`, `changes`, `warnings`, `sourceSpindleRpm` and `validation`. The
standard validator now sees all relative motion and full-circle bounds because
it inspects the actual emitted polygon. These are tool-centre bounds, not a swept
cutter/holder clearance calculation, and they exclude the unknown initial position.
The converter retains the source approach order and does not invent clearance.
After review, submit the returned program through `submit_gcode_job` with
`head_type: "cnc"` and `frame: "work"`; the existing approval flow applies.

## Generator option coverage

Reference: [Machining Doctor thread-milling generator](https://www.machiningdoctor.com/calculators/thread-milling-gcode-generator/).
The documented machining choices are represented by the source path; conversion
preserves them rather than generating new cutting parameters.

| Generator choice | Import behavior / verification |
| --- | --- |
| Internal / external | Preserve source centre, approach, cutting radius and retract; both covered by synthetic tests. |
| RH / LH, climb / conventional | Preserve G2/G3 direction and signed Z travel; all eight combinations tested. |
| Single tooth | Preserve repeated continuous helical turns. |
| Multi tooth, longer than thread | Preserve one full turn. |
| Multi tooth, shorter than thread | Preserve repeated approach/turn/retract and axial repositioning; exact supplied fixture plus synthetic tests. |
| Multiple radial passes | Preserve each pass and its feeds/radius; tested with both internal and external radii. |
| Dimensions, pitch, cutting length and offsets | Follow numeric XYZ/IJ values without hard-coded thread sizes; the matrix uses 0.7 mm pitch as well as the supplied 0.45 mm case. |
| Metric / inch | G20/G21 input converts to mm and mm/min; RPM remains RPM. |
| Material, feeds, entry feed and cutting conditions | Preserve source feeds; no machining recommendation or automatic feed correction. |
| Cutter flutes / axial forms | Do not infer one from the other. A three-flute cutter can still have a single axial thread form. |
| Tool-centre / zero compensation | Supported with the explicit declaration above; G40/G41/G42 and D selectors removed. |
| Nonzero controller compensation | Not implemented; known nonzero generator headers rejected even with a zero-compensation declaration. Regenerate a tool-centre path. |
| Coolant | M7/M8/M9 removed and reported; coolant is not controlled by the emitted file. |
| Tool change and length register | One initial M6 Tn removed; tool must already be fitted. Mid-program tool changes rejected. G43/H handled as above. |
| Controller selection | Fanuc-style numeric G-code subset. Unsupported dialects/commands return line-numbered errors. |

The live interactive form returned a Cloudflare HTTP 403 verification challenge in both HTTP retrieval and headless Playwright. The table is
coverage of the public documentation and the supplied Fanuc export, not a claim
that every live controller dropdown or export dialect has been exercised. The
24-case option matrix is synthetic and clearly labelled in tests. Additional
controller-specific exports are needed before claiming those dialects.

Unsupported input includes non-XY planes, G93/G95 feed modes, R-format arcs,
absolute arc centres, macros/subroutines, canned cycles, rotary axes, workspace
changes and origin writes. They fail explicitly rather than being discarded.
Unit-system changes after feed or motion are refused.
Only G54, explicitly declared units/distance mode/G17/G94, incremental I/J and
one pre-fitted tool are accepted. M2/M30 must terminate the program.

## Firmware evidence

Checked [Snapmaker2-Controller commit 314c167b](https://github.com/Snapmaker/Snapmaker2-Controller/tree/314c167b0a1ce331d867b10abd32e00908e4aa9c).
This is the checked upstream source, not a claim about the connected machine's
installed firmware version.

- [Configuration_adv.h](https://github.com/Snapmaker/Snapmaker2-Controller/blob/314c167b0a1ce331d867b10abd32e00908e4aa9c/Marlin/Configuration_adv.h):
  ARC_SUPPORT enabled, MM_PER_ARC_SEGMENT = 1, MIN_ARC_SEGMENTS = 24;
  ARC_P_CIRCLES, CNC_WORKSPACE_PLANES and GCODE_MOTION_MODES disabled.
- [G2_G3.cpp](https://github.com/Snapmaker/Snapmaker2-Controller/blob/314c167b0a1ce331d867b10abd32e00908e4aa9c/Marlin/src/gcode/motion/G2_G3.cpp):
  supports full XY circles with omitted XY and linear Z interpolation. Native arc
  support exists, but its fixed segmentation is not the importer's tolerance.
- [Snapmaker M3-M5.cpp](https://github.com/Snapmaker/Snapmaker2-Controller/blob/314c167b0a1ce331d867b10abd32e00908e4aa9c/snapmaker/src/gcode/M3-M5.cpp):
  standard CNC uses P percent (S alone does not select RPM); 200 W CNC has separate
  P percentage and S RPM paths. M4 does not provide a CNC direction reversal here,
  so the importer refuses M4.
- [toolhead_cnc_200w.h](https://github.com/Snapmaker/Snapmaker2-Controller/blob/314c167b0a1ce331d867b10abd32e00908e4aa9c/snapmaker/src/module/toolhead_cnc_200w.h):
  RPM limits 8000 and 18000; the implementation clamps to them.
- [gcode.cpp](https://github.com/Snapmaker/Snapmaker2-Controller/blob/314c167b0a1ce331d867b10abd32e00908e4aa9c/Marlin/src/gcode/gcode.cpp):
  no Fanuc G41/G43/G94 or M6 semantics. G42 is a mesh-positioning command when that
  feature is enabled. M30 means SD file deletion when SDSUPPORT is enabled;
  SDSUPPORT is disabled in the checked configuration. It is never Fanuc program
  end here. The importer emits explicit M5 instead.

Every emitted command occupies its own block. Arcs become G1 segments with a
0.002 mm default chord tolerance, at most 10 degrees and approximately 0.25 mm per
segment. Source endpoint radius mismatch up to the smaller of 0.002 mm or 1% of radius is separately reported
and linearly blended to retain exact endpoints; larger mismatch is refused.
Output coordinates use six decimal places. Segmentation tolerance describes
geometry, not machine accuracy. Input is capped at 2 MB and output at 200000 moves.

## Validation

The MCP suite includes the supplied export, full-circle winding/radius/pitch and
chord checks, partial helices, inch conversion, modal/compact blocks, feed/RPM
handling, the 24-case machining option matrix, parser refusal cases, and an offline
MCP registration test. No cutting run or machine acceptance test is performed by
these tests.
