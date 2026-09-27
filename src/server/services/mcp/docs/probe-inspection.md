# Probe inspection with synchronized camera evidence

An asynchronous `capture_frame` is a current view, not a photograph tied to a particular
probe contact. The runner may have retracted by the time the call executes. Use stationary
captures inside the measurement operation when the image must show the probe at that spot.

## Contact captures

A `probe_sequence` probe step (also in a `probe_program` sequence) accepts:

```json
{"kind":"probe","name":"rim","dz":-1,"max_travel_mm":5,
 "capture":{"label":"rim contact","settle_ms":500}}
```

The example is a step fragment: its approach position and travel must already be planned
from measured or operator-stated geometry. It is not a standalone motion instruction.

`probe_surface_path` and `probe_surface_grid`, including their program op forms, accept:

```json
{"capture":{"stations":[1,4,7],"label":"channel transitions","settle_ms":500}}
```

Indices refer to the final scan plan, start at 1, are unique and must be within its station
count. Up to 60 photographs may be selected per scan. The delay defaults to 500 ms and is
bounded to 0–5000 ms. No motion fields are accepted inside `capture`.

The runner waits for reliable idle position reports and the requested damping delay, then
photographs after the final confirm pass, before the normal retreat; a continuing miss
is photographed at its search limit. A first-station miss that aborts a scan does not capture.
The probe channel remains expected during the stationary photo. The result's `capture` records
`status`, persistent `file`, `frameId`, `capturedAt`, actual toolhead `machine` coordinates,
`b`, position `reliability`, and camera `device`/`provider`/`source`. This pose is the final pass,
which can differ from the measurement's median contact. Old stream frames from before settling
are rejected. `get_frame {file}` reads saved images after the 12-frame memory cache expires.

Camera/capture-storage failures are recorded as `capture.status: "failed"` and do not discard
measurements or prevent their normal retreat. Stop requests and safety alarms still abort.
The confirm preview describes the selected photographs, and program event estimates include
those frames. A separate program `capture` op after a measurement remains useful for overview
photos but sees the preceding operation's raised finish position.

## Continuous observation

`list_cameras.stream` exposes `stream_url` (`/camera`, viewer), `mjpeg_url`
(`/camera/stream.mjpeg`) and `snapshot_url` (`/camera/snapshot.jpg`) when enabled.
`/camera/status.json` reports running/client/freshness state. The live viewer and tool snapshots
share the same source, avoiding competing opens of a USB camera. An open viewer may stay up
throughout probing. Plain observation needs no metric calibration; pixel-to-machine conversion
and model-based view positioning still require a verified camera model.

## Stepped shoulder recovery

The 2026-09-27 B0 inspection (`7685888d887d`, station 20) moved from machine Y259 to Y259.5
at toolhead Z194.2, backed to Y259, then rose repeatedly. Probe transitions during the rises
were not checked before the next XY step. At Z200.2 the probe remained triggered after the
backoff. The old error claimed 1 mm although the actual link/backoff was 0.5 mm. The surface
runner recorded `abort-held`; the outer program nevertheless commanded toolhead Z328.

The corrected behavior:

- Stepped surface links may add up to one stored ball radius (`probe_tip_diameter / 2`)
  beyond the standard backoff, in 0.25 mm steps with release checks. This is ball size, not
  exposed stylus length. Missing geometry disables the extra margin.
- Additional retreat stays in a verified straight corridor at the same toolhead Z, including
  contiguous incoming scan links. Turning a grid corner or changing height invalidates that
  history. A lift starts a new clearance history at its actual backed-off position.
- Top-link rises use 0.5 mm sensor-checked segments. A monotonic probe-trigger counter also
  catches a touch-and-release during a controller command. Any lift contact holds before
  another sideways move; even a subsequent release does not turn that hold into an automatic
  recovery raise. Pocket wall links retain their reverse-path/block behavior.
- Error messages report the actual backoff distance. Persistent contact with no verified
  retreat left holds. The outer program preserves a nested hold, including with `on_fail: skip`,
  and reports recovery failure/hold rather than claiming an unverified raise succeeded.

The extra retreat is bounded recovery within the approved scan, not permission to move around
an unknown obstruction. Completed stations remain available on the partial job result.

## Efficient inspection planning

Define the missing cut boundaries, depths, retained material and fixture clearances first.
Reuse valid measurements from the unchanged tool/setup/B angle. With applicable measured
height evidence, approach through the guarded descent rather than repeating a fine air search
from the park height. Find unknown surfaces with a sensor-gated march. Bracket transitions
coarsely and refine them to the required tolerance; avoid dense resampling of known flat banks.
Use the previous job response's `next_event_index` for long-polling `since_event`.

Validation is offline: simulated-machine traversal regressions, real runner tests with mocked
machine/camera IO, camera failure/freshness tests and held-abort tests. These changes do not
restart the running machine service or qualify the current fixture for milling.
