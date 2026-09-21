/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
//
// Every bound a procedure planner applies to its arguments, named once and
// with its reason next to it. Until 2026-09-21 these lived inline as
// `Math.min(Math.max(Number(args.x) || 1, 0.2), 1)` in eight planners, and
// a reader could not tell a deliberate variation (probe_circle's 2 mm
// radial step, the surface scans' 0.5 mm floor, the GPIO transport's 30 ms
// sensor floor) from a copy-paste drift.
//
// A named constant is not a resolved one: these are caps on what an agent
// may ask for, not statements about the machine. Anything that describes
// where the toolhead can go belongs in machineTravel.ts; anything that
// describes where an obstacle is belongs in a landmark.
//
// Pure: no server imports. surfaceScan.ts and envelopeChecks.ts import it,
// so it must stay that way.

export interface Range {
    min: number;
    max: number;
}

export interface Bounded extends Range {
    /** Used when the argument is absent, not a number, or 0 - `Number(x) || default`, as every planner always read it. */
    default: number;
}

/** `Number(raw) || default`, then clamped into [min, max] - the one idiom every planner used, unchanged. */
export function clampTo(raw: unknown, limit: Bounded): number {
    return Math.min(Math.max(Number(raw) || limit.default, limit.min), limit.max);
}

/** clampTo for a count. */
export function clampCount(raw: unknown, limit: Bounded): number {
    return Math.min(Math.max(Math.round(Number(raw) || limit.default), limit.min), limit.max);
}

/** Is `value` inside [min, max]? For the refusal-style checks (a range the caller must meet, not one it is clamped into). */
export function within(value: number, range: Range): boolean {
    return Number.isFinite(value) && value >= range.min && value <= range.max;
}

// ---------------------------------------------------------------------------
// The sensor-gated march (march.ts): coarse steps to contact, retreat to
// release, fine steps, confirm cycles.
// ---------------------------------------------------------------------------

/**
 * The caller's LOGICAL advance between sensor verdicts. The operator law of
 * 2026-09-05 (job cdbc29371b97, "never 2 mm") is about the PHYSICAL move: no
 * single gcode move toward the work may press further into the probe than
 * one sensor-checked segment (MARCH_SEGMENT_MM, enforced by
 * probing.marchInSegments whatever the coarse step is). The 1 mm cap here is
 * the value the planners have carried since that day; probe_circle's 2 mm
 * is its own, below.
 */
export const COARSE_STEP_MM: Bounded = { default: 1, min: 0.2, max: 1 };
/**
 * The surface scans floor the coarse step at 0.5: their slow zone
 * (surfaceScan.slowZoneFor) takes the approach over near the expected
 * contact, so a finer coarse step only costs time. Value as found at
 * extraction.
 */
export const SURFACE_COARSE_STEP_MM: Bounded = { default: 1, min: 0.5, max: COARSE_STEP_MM.max };
/**
 * probe_circle's radial marches default to 0.5 mm (the feature's diameter is
 * bounded by the operator, so the ladder is short) and may be asked for up to
 * 2 mm: the coarse step is a logical advance, and the physical moves that
 * make it up are segmented and sensor-checked regardless (MARCH_SEGMENT_MM).
 */
export const CIRCLE_COARSE_STEP_MM: Bounded = { default: 0.5, min: COARSE_STEP_MM.min, max: 2 };
export const FINE_STEP_MM: Bounded = { default: 0.1, min: 0.02, max: 0.5 };
/** After contact the probe retreats this far before the fine approach; never less than a fine step. */
export const BACKOFF_MM: Bounded = { default: 1, min: FINE_STEP_MM.min, max: 3 };
/** The tool setter's disc is a small target: a short backoff keeps the bit over it. */
export const TOOL_SETTER_BACKOFF_MM: Bounded = { default: 0.3, min: FINE_STEP_MM.min, max: 2 };
/** How long after a move settles the probe feed is given to report a contact. */
export const SENSOR_DELAY_MS: Bounded = { default: 300, min: 100, max: 10000 };
/**
 * Floor 30 ms for the planners that run on the GPIO transport: there the
 * trigger led the controller reply on every contact of jobs 1db4/d8f6
 * (tightest lead 5 ms). The MQTT-era floor of 100 ms stays for the rest.
 */
export const GPIO_SENSOR_DELAY_MS: Bounded = { default: SENSOR_DELAY_MS.default, min: 30, max: SENSOR_DELAY_MS.max };
/** 200 ms default tuned to the operator's local-broker latency; the hard floor and the overtravel tripwire backstop a missed message. */
export const TOOL_SETTER_SENSOR_DELAY_MS: Bounded = { default: 200, min: SENSOR_DELAY_MS.min, max: SENSOR_DELAY_MS.max };
/** Lift-and-retest cycles after the fine contact; the median is the result. */
export const CONFIRM_PASSES: Bounded = { default: 3, min: 1, max: 10 };
/** probe_circle confirms every azimuth, so fewer passes per point. */
export const CIRCLE_CONFIRM_PASSES: Bounded = { default: 2, min: 1, max: 5 };
/**
 * Release-type checks wait out the feed's real-world latency (the release
 * message has been observed arriving ~1 s after the motion); a short window
 * caused a false "hysteresis" abort on tool-setter run 2.
 */
export const RELEASE_TIMEOUT_DELAY_FACTOR = 4;
export const RELEASE_TIMEOUT_MIN_MS = 3500;
export const TOOL_SETTER_RELEASE_TIMEOUT_MIN_MS = 2500;

export function releaseTimeoutFor(sensorDelayMs: number, minMs: number = RELEASE_TIMEOUT_MIN_MS): number {
    return Math.max(sensorDelayMs * RELEASE_TIMEOUT_DELAY_FACTOR, minMs);
}

/** How far a single march may run before it aborts with no contact. */
export const MARCH_TRAVEL_MM: Range = { min: 1, max: 150 };
/** start_z_machine - floor_z_machine: the deepest a -Z search may go. */
export const MAX_DESCENT_BAND_MM = 150;
/** A stepped traverse lifts this much on contact. */
export const HOP_LIFT_MM: Bounded = { default: 2, min: 0.5, max: 10 };

export interface MarchArgs {
    coarse_step_mm?: unknown;
    fine_step_mm?: unknown;
    backoff_mm?: unknown;
    sensor_delay_ms?: unknown;
    confirm_passes?: unknown;
}

export interface ResolvedMarchParams {
    coarseStepMm: number;
    fineStepMm: number;
    backoffMm: number;
    sensorDelayMs: number;
    confirmPasses: number;
}

/**
 * The five march parameters from a tool's arguments, clamped to the named
 * limits. A planner with a reason to differ passes its own Bounded for that
 * one parameter and leaves the rest shared.
 */
export function resolveMarchParams(
    args: MarchArgs,
    over: Partial<{ coarse: Bounded; backoff: Bounded; delay: Bounded; passes: Bounded }> = {}
): ResolvedMarchParams {
    const fineStepMm = clampTo(args.fine_step_mm, FINE_STEP_MM);
    const backoff = over.backoff || BACKOFF_MM;
    return {
        coarseStepMm: clampTo(args.coarse_step_mm, over.coarse || COARSE_STEP_MM),
        fineStepMm,
        // Never less than the fine step actually in use: the retreat has to clear the release.
        backoffMm: clampTo(args.backoff_mm, { ...backoff, min: Math.max(backoff.min, fineStepMm) }),
        sensorDelayMs: clampTo(args.sensor_delay_ms, over.delay || SENSOR_DELAY_MS),
        confirmPasses: clampCount(args.confirm_passes, over.passes || CONFIRM_PASSES),
    };
}

// ---------------------------------------------------------------------------
// Operator-stated machine quantities: sanity ranges on what may be TYPED,
// not statements about the machine.
// ---------------------------------------------------------------------------

/** No Snapmaker's Z travel reaches this; a stated machine Z above it is a typo or a frame mix-up. */
export const MAX_STATED_MACHINE_Z_MM = 400;
/** A program's transient keep_out list. */
export const MAX_KEEP_OUT_BOXES = 20;
export const B_AXIS_DEG: Range = { min: -360, max: 360 };
/** Largest reach of stock and clamping about the rotary axis anyone should state (the A350 bed is 350 wide). */
export const MAX_SWEPT_RADIUS_MM = 200;
/** A dwell in a probing program is capped so a mistyped P cannot park the job. */
export const MAX_DWELL_S = 60;
/** A stated bit protrusion above this is not a bit. */
export const MAX_BIT_LENGTH_MM = 300;

// ---------------------------------------------------------------------------
// Surface scans (surfaceScan.ts / probeSurface.ts)
// ---------------------------------------------------------------------------

/** expected_profile.circle: the cylinder's radius and the probe tip's. */
export const MAX_PROFILE_RADIUS_MM = 200;
export const MAX_TIP_RADIUS_MM = 15;
/** A path longer than the bed is a coordinate mistake. */
export const MAX_PATH_LENGTH_MM = 400;
export const MIN_PATH_LENGTH_MM = 1;
/** Station count is a time / event budget, not a safety line. */
export const MAX_GRID_LINES_PER_AXIS = 40;
export const MAX_GRID_STATIONS = 400;
/** A hop or a drop allowance under a millimetre plans a scan that cannot move. */
export const MIN_HOP_MM = 1;
export const MIN_DROP_MM = 1;
/** Coarse steps stop this far above the expected contact; the cap is the scan's own z_safe_delta. */
export const SURFACE_SLOW_ZONE_MM: { default: number; min: number } = { default: 1, min: 0.3 };

// ---------------------------------------------------------------------------
// probe_stock_outline
// ---------------------------------------------------------------------------

/**
 * Side marches are generous by default (25 mm): the on-box agent's first
 * outline lost a whole side to an 11 mm march when the estimate's centre was
 * 3.85 mm off - a short march silently turns estimate error into a missed
 * face, a generous one only costs time. Never less than what reaches the
 * estimate itself plus SIDE_TRAVEL_BEYOND_ESTIMATE_MM.
 */
export const SIDE_MAX_TRAVEL_MM: Range = { min: 5, max: MARCH_TRAVEL_MM.max };
export const SIDE_DEFAULT_TRAVEL_MM = 25;
export const SIDE_TRAVEL_BEYOND_ESTIMATE_MM = 10;
/** A side march must at least reach the estimated face with this to spare, or it cannot find it. */
export const SIDE_MIN_REACH_MARGIN_MM = 5;

// ---------------------------------------------------------------------------
// probe_circle
// ---------------------------------------------------------------------------

export const CIRCLE_POINTS: Bounded = { default: 8, min: 4, max: 16 };
export const CIRCLE_APPROACH_CLEARANCE_MM: Bounded = { default: 5, min: 1, max: 20 };
export const CIRCLE_PROBE_DEPTH_MM: Bounded = { default: 3, min: 0.5, max: 20 };
/** The operator's diameter bounds: a post or hole wider than this is not what this tool measures. */
export const MAX_CIRCLE_DIAMETER_MM = 100;
/** Outside mode needs room between the approach start radius and the min-diameter abort floor. */
export const MIN_RADIAL_APPROACH_MM = 1;
/** A fit residual above this means an out-of-round tip or feature, or a bad contact. */
export const CIRCLE_RESIDUAL_WARN_MM = 0.2;

// ---------------------------------------------------------------------------
// Tool setter
// ---------------------------------------------------------------------------

export const TOOL_SETTER_START_CLEARANCE_MM: Bounded = { default: 30, min: 10, max: 150 };
/** Coarse steps stop this far above the expected trigger and fine steps take over. */
export const TOOL_SETTER_SLOW_ZONE_MM: Bounded = { default: 1, min: FINE_STEP_MM.min, max: 10 };
/** start_from_current: how far off the setter centre the head may sit and still be "over" it. */
export const TOOL_SETTER_CENTRE_TOLERANCE_MM = 1.5;
/** Below the expected trigger the search may continue this far before it aborts as "no setter". */
export const TOOL_SETTER_FLOOR_MARGIN_MM: Bounded = { default: 3, min: 0.5, max: 20 };
/** An old/new tool length difference above this is not a pair of measurements of the same setup. */
export const MAX_TOOL_LENGTH_DELTA_MM = 50;

// ---------------------------------------------------------------------------
// Camera: survey_bed and camera_bootstrap
// ---------------------------------------------------------------------------

/** MAXIMUM grid spacing; each axis is divided evenly into steps no larger than it. */
export const SURVEY_PITCH_MM: Bounded = { default: 80, min: 20, max: 160 };
/** Inset of the default bounds from the toolhead travel. */
export const SURVEY_MARGIN_MM: Bounded = { default: 10, min: 0, max: 50 };
/** Each level is a full pass of the grid. */
export const MAX_SURVEY_LEVELS = 6;
export const MAX_OVERLAP_FRACTION = 0.9;
/** Links between waypoints run faster than a procedure's travel feed: nothing is expected to be in the way. */
export const SURVEY_LINK_FEED_FACTOR = 4;
/** The search stage's band either side of the tool setter, before the travel clips it. */
export const BOOTSTRAP_REACH_MM: Bounded = { default: 200, min: 40, max: 400 };
export const BOOTSTRAP_SEARCH_PITCH_MM: Bounded = { default: 40, min: 10, max: 120 };
export const BOOTSTRAP_Y_SPAN_MM: Bounded = { default: 0, min: 0, max: 300 };
export const MAX_BOOTSTRAP_POSES = 12;
/** Z step of the pose sweep's parallax baseline. */
export const BOOTSTRAP_SWEEP_STEP_MM = 2;

// ---------------------------------------------------------------------------
// Direct moves and job waits (tools/gcode.ts, tools/camera.ts)
// ---------------------------------------------------------------------------

export const MOVE_Z_FEED: Bounded = { default: 300, min: 50, max: 600 };
export const TRAVERSE_FEED: Bounded = { default: 1500, min: 50, max: 3000 };
export const DIRECT_MOVE_FEED: Bounded = { default: 1500, min: 100, max: 3000 };
/** move_z z_targets: one approval, this many steps at most. */
export const MAX_Z_TARGETS = 20;
/** The longest any tool call blocks waiting on an approval, a settle or an event. */
export const MAX_WAIT_MS = 120000;
export const EVENT_POLL_MS = 250;
export const STOP_WAIT_DEFAULT_MS = 20000;
/** "At the target": the controller's position echo against the commanded one. */
export const SETTLE_MATCH_MM = 0.15;

// ---------------------------------------------------------------------------
// Feature tracking (track_feature)
// ---------------------------------------------------------------------------

/** Odd, so the patch has a centre pixel. */
export const TRACK_PATCH_PX: Bounded = { default: 41, min: 11, max: 101 };
export const TRACK_SEARCH_RADIUS_PX: Bounded = { default: 120, min: 20, max: 250 };
