# CAM probing programs: `run_probing_gcode`

Read this only when the operator hands you a probing program from Fusion 360, FreeCAD, a Grbl
sender macro or a hand-written file. Everything else about probing is in `SKILL.md`; the motion
laws are in `cnc-motion-rules`.

Pass the program text as `gcode` with a `reason`; it is **translated, never sent raw** (the
Snapmaker controller compiles G38 in but on the 3DP probe input, so a raw G38 never touches the
CNC probe):

- each `G38.2` / `G38.3` becomes a sensor-gated march to its target — the target is the travel
  limit, so post the cycles with GENEROUS travel (a short cycle silently misses, the same lesson
  as `probe_stock_outline`);
- `G38.4` / `G38.5` become a probe-away until release;
- `G0`/`G1` links follow law 2: `link_mode` `"raise"` (default; XY at the traverse height with
  guarded segmented descents) or `"stepped"` (a touch-probing traverse at the programmed height,
  lifting `hop_lift_mm` on contact);
- a bare `G0 B<angle>` line is a 3+2 station (raise, then the verified rotation); `B` with XYZ,
  incremental `B` and `A`/`C` are refused;
- feeds in the file are ignored; `M3`/`M4` (a spinning tool during a probe is a crash), `M0`/`M1`,
  `M6`, `G28`, `G92`, `G55`–`G59`, arcs and `#` macro variables are refused with the line number
  — fix the post, do not strip lines by hand without telling the operator.

Coordinates are the CAM WCS (work frame) unless `frame: "machine"`; the work origin must be live
and reliable on the heartbeat (the tool refuses a work-frame program while the offset is
`assumed-zero`).

Metadata: put `(PROBE id=.. name=.. group=.. role=.. nominal=x,y,z normal=i,j,k tol=u,l offset=..)`
before a cycle so the report carries nominals, normals, tolerances and the surface offset; a
`(RESULTS documentid=.. modelversion=.. toolpathid=1.00001 toolpath=NAME)` comment fills the
Fusion results envelope. Deviations are of the SURFACE (tip centre minus one tip radius along the
normal) and need `set_probe_geometry`'s tip diameter.

Reports: `reportText` in `report_format` — `fusion` (default; Fusion "inspection results"
G800/G801 text for Inspect Surface points), `renishaw` (the Inspection Plus print-out Fusion
imports for Probe WCS / Probe Geometry — needs `group=`/`role=` (`x_minus`, `x_plus`, `y_minus`,
`y_plus`) and `feature=`/`nominal_size=`/`nominal_center=`/`tol_size=`/`tol_pos=`), `csv`, `grbl`
(`[PRB:]` lines), `json`. `get_inspection_report` re-renders a finished or aborted run in any
format; the file lands under the app data dir `mcp-inspection/`.

The repo ships a Fusion post that writes all of this: `src/server/services/mcp/docs/post/snapmaker-probing.cps`
(unverified in Fusion; review in `docs/FUSION_POST_REVIEW.md`).
