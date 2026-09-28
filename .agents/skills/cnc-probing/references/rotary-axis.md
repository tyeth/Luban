# The stored rotary axis: historical until checked

Read before any CAM rotates geometry about `geometry.rotary`, before mixing readings taken at
different B angles, and before quoting `axis.*` in a program. Motion rules apply unchanged.

## What the store holds

`get_stored_state → geometry.rotary` (`axis.x`, `axis.z_physical`) was written by
`set_probe_geometry` from one measurement, with a reason string as its only provenance: no date
field, no probe-length field, no clamping. `axis.z_contact` adds the CURRENTLY stored probe
length to that physical Z — two eras in one number if the probe was re-fitted since.

Treat it as a historical estimate tied to the probe length, clamping and stock it was measured
with. On this jig it came from the 2026-09-05 four-face survey with a 71.3 mm probe on the raw
stock; the 2026-09-27 contacts on the same job, with a 70.95 mm probe and re-clamped work, put
it about 0.8 mm off in X and about 1 mm off in physical Z. These discrepancies do not by
themselves diagnose mechanical axis movement or its cause.
The later saved-contact fit for that mounting gave X169.325 / physical Z113.800, with held-out
residuals up to 0.15 mm. Neither historical value is a new setup default. Axis-location error
propagates as (I-R) times the error; at B180 the transverse contribution doubles.

`axis.z_physical` is a PHYSICAL height: the toolhead sits a whole probe or tool length above it
at contact. It is never a toolhead target or a `move_z` argument, and does not by itself
establish work Z0; a derived datum requires the measured registration in `work-datums.md`.

## Check it against opposite-face contacts before CAM rotates about it

First recover and reconcile saved opposite-face and side contacts under the
[measurement-evidence rules](../../cnc-motion-rules/references/measurement-evidence.md).
This check is an offline calculation when those records suffice, not an instruction to probe
again. State the measurement-time probe-length basis of every number, then:

- **Z from opposite tops.** A −Z contact on the B0 top and on the B180 top at the same stock
  point (mirror the X about the axis, same Y), both toolhead Z with the same probe: axis contact
  Z = (top0 + top180 − T) / 2, where T is the MEASURED thickness there — B90/B270 side-silhouette
  width minus one ball diameter, or the operator's calipers — never the CAD nominal. Physical
  axis Z = that − probe length. Keeping a stored value that would need a thickness the part does
  not have is the tell.
- **X from opposite sides.** Side contacts at B90 and B270 on the same feature: the silhouette
  centre at each angle is (west + east) / 2 (tip-centre; the ball radius cancels for the centre,
  not for the width), and axis X = (c90 + c270) / 2. Compare existing Y stations where available;
  require another station only if the operation needs an otherwise unbounded axis tilt.
- **What agrees with what.** (top180 − top0) / 2 against (c90 − c270) / 2 tests the indexing and
  the section's squareness; it says nothing about the absolute axis Z — only T carries that.
- **Assumptions to write down:** exact 180° between the paired angles, flat parallel faces at
  the contact points, nothing re-clamped between readings, the B direction identified from a
  known feature (the 9 mm groove did that on 2026-09-27), and the stated agreement tolerance
  (the cut's engagement/clearance tolerance, with propagated uncertainty). Outside it: resolve
  calibration, frame, B, mounting and inference conflicts using saved evidence first. Fit the
  axis and inferred faces jointly; check held-out contacts. Do not retain an estimated axis
  by discarding contradictory measured faces. New probing requires a specifically unresolved
  constraint under the evidence rules, not merely a bad model fit. If recording a reconciled
  calibration is authorized, use `set_probe_geometry` with job IDs, measurement-time probe
  length, clamping, date and residuals in the reason — never a hand edit of the store.

## Readings at other angles live in the rotated pose

A contact taken at B θ is a point on the stock as it stands rotated; to use it beside B0
readings, rotate it by −θ about the measured axis line (X = axis X, Z = physical axis Z, along
Y), with the sign fixed by the identified B direction — not about the CAD origin, and not by
relabelling a B180 physical Z as a B0 coordinate. Each indexed visit is its own setup
(`cnc-motion-rules/references/cutting-programs.md`).
