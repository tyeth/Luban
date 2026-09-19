/* eslint-disable camelcase */
// MCP tool arguments are snake_case by convention.
import crypto from 'crypto';

import { captureFrame } from '../camera';
import {
    CameraFingerprint,
    CameraModel,
    CameraModelContext,
    Matrix3,
    Vec3,
    judgeCameraModel,
} from '../cameraModel';
import { machineToPixel, viewPose } from '../cameraGeometry';
import { cameraModelStore } from '../cameraModelStore';
import { decodeToGray } from '../tracking';
import { McpToolError, ToolRegistry } from '../registry';
import { connectionEpoch, getPositionSnapshot, requireReliableMachine } from './machine';
import { connectionManager } from '../../machine/ConnectionManager';

/**
 * What the camera looks like RIGHT NOW, from a frame taken right now. A
 * fingerprint from anything older would be evidence about the past.
 */
export async function liveFingerprint(): Promise<CameraFingerprint & { frameId: string }> {
    const frame = await captureFrame();
    const image = decodeToGray(Buffer.from(frame.imageBase64, 'base64'));
    return {
        deviceId: frame.device,
        width: image.width,
        height: image.height,
        referenceFrameHash: crypto.createHash('sha1').update(frame.imageBase64).digest('hex').slice(0, 16),
        frameId: frame.frameId,
    };
}

export function modelContext(fingerprint: CameraFingerprint | null): CameraModelContext {
    return {
        fingerprint,
        connectionEpoch: connectionEpoch(),
        machineIdentifier: connectionManager.getConnectionStatus().machineIdentifier || null,
        now: Date.now(),
    };
}

/**
 * The verified model, or a refusal that names what to do. Every tool that
 * turns pixels into machine coordinates starts here.
 */
export function requireCameraModel(what: string): CameraModel {
    const model = cameraModelStore.current();
    // No capture here: judging costs a frame, and the callers that need one
    // take it themselves. A fingerprint mismatch is caught by the verification.
    const judgement = judgeCameraModel(model, modelContext(null));
    if (!judgement.usable || !model) {
        throw new McpToolError(`Refusing ${what}: ${judgement.reasons.join(' ')} `
            + `Next: ${judgement.remedy === 'none' ? 'retry' : judgement.remedy}.`);
    }
    return model;
}

function parseMatrix3(raw: unknown, field: string): Matrix3 {
    if (!Array.isArray(raw) || raw.length !== 3 || raw.some((row) => !Array.isArray(row) || row.length !== 3)) {
        throw new McpToolError(`${field} must be a 3x3 row-major array.`);
    }
    const m = (raw as number[][]).map((row) => row.map(Number));
    if (m.some((row) => row.some((v) => !Number.isFinite(v)))) {
        throw new McpToolError(`${field} must contain finite numbers.`);
    }
    // Orthonormal within a loose tolerance: a rotation that is not a rotation
    // silently skews every conversion made through it.
    for (let i = 0; i < 3; i++) {
        const col = [m[0][i], m[1][i], m[2][i]];
        const norm = Math.hypot(col[0], col[1], col[2]);
        if (Math.abs(norm - 1) > 0.01) {
            throw new McpToolError(`${field} column ${i} has length ${norm.toFixed(4)}, not 1: the columns must be the `
                + 'camera\'s axes in machine axes, so they form an orthonormal frame.');
        }
    }
    const dot = (a: number, b: number) => (m[0][a] * m[0][b]) + (m[1][a] * m[1][b]) + (m[2][a] * m[2][b]);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
        if (Math.abs(dot(a, b)) > 0.01) {
            throw new McpToolError(`${field} columns ${a} and ${b} are not perpendicular (dot ${dot(a, b).toFixed(4)}).`);
        }
    }
    return m as Matrix3;
}

function parseVec3(raw: unknown, field: string): Vec3 {
    const v = raw as { x?: unknown; y?: unknown; z?: unknown };
    const out = { x: Number(v?.x), y: Number(v?.y), z: Number(v?.z) };
    if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.z)) {
        throw new McpToolError(`${field} must be {x, y, z} in millimetres.`);
    }
    return out;
}

export function registerCameraModelTools(registry: ToolRegistry): void {
    registry.register({
        name: 'get_camera_model',
        description: 'The current camera model and whether it may still be used. The camera is SESSION STATE, not a '
            + 'rig constant: it can sit differently after a power cycle, be knocked, be re-aimed, or be a different '
            + 'camera entirely. So this reports a state (verified | unverified | superseded) and, when it is not '
            + 'usable, WHY and which tool fixes it (verify_camera_model for a check, camera_bootstrap for a full '
            + 'solve). Read-only, no motion, no capture. Plain captures never need a model - a frame finds things, it '
            + 'clears nothing.',
        inputSchema: {
            type: 'object',
            properties: {
                history: { type: 'boolean', description: 'Include superseded models, newest first.' },
            },
            additionalProperties: false,
        },
        handler: async (args: { history?: boolean }) => {
            const model = cameraModelStore.current();
            const judgement = judgeCameraModel(model, modelContext(null));
            return {
                model,
                usable: judgement.usable,
                state: judgement.state,
                reasons: judgement.reasons,
                next: judgement.remedy,
                history: args.history ? cameraModelStore.list() : undefined,
            };
        },
    });

    registry.register({
        name: 'set_camera_model',
        description: 'Store a camera model solved from a bootstrap frame set (scripts/camera_bootstrap.py). Stored '
            + 'UNVERIFIED: a model that has only ever agreed with the data it was fitted to has demonstrated nothing, '
            + 'so verify_camera_model must pass it against a pose that was not in the fit before anything converts '
            + 'through it. The previous model is kept as superseded rather than overwritten, so "was the camera moved '
            + 'between these two jobs?" stays answerable. Takes a frame to fingerprint the camera it describes.',
        inputSchema: {
            type: 'object',
            properties: {
                offset: {
                    type: 'object',
                    description: 'Optical centre relative to the TOOLHEAD control point, machine axes, mm.',
                    properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                    required: ['x', 'y', 'z'],
                },
                rotation: {
                    type: 'array',
                    description: '3x3 row-major; the COLUMNS are the camera axes in machine axes, and the camera looks along its own +Z.',
                    items: { type: 'array', items: { type: 'number' } },
                },
                intrinsics: {
                    type: 'object',
                    description: 'Pinhole, in pixels. k1 only when the targets spanned enough frame to constrain it; otherwise null.',
                    properties: {
                        fx: { type: 'number' },
                        fy: { type: 'number' },
                        cx: { type: 'number' },
                        cy: { type: 'number' },
                        k1: { type: ['number', 'null'] },
                    },
                    required: ['fx', 'fy', 'cx', 'cy'],
                },
                valid_band_z: {
                    type: 'array',
                    description: '[min, max] machine Z the poses actually covered. Outside it the model extrapolates and says so.',
                    items: { type: 'number' },
                },
                central_region: {
                    type: 'number',
                    description: 'Fraction of the frame the fit genuinely constrains (0-1). Pixels outside it are '
                        + 'refused rather than silently converted - keep it small when k1 could not be fitted.',
                },
                residuals: {
                    type: 'object',
                    properties: {
                        rms_px: { type: 'number' },
                        max_px: { type: 'number' },
                        rms_mm: { type: 'number' },
                        n_points: { type: 'number' },
                        n_poses: { type: 'number' },
                    },
                    required: ['rms_px', 'max_px', 'rms_mm', 'n_points', 'n_poses'],
                },
                survey_id: { type: ['string', 'null'], description: 'Bootstrap frame set this was solved from.' },
                targets: { type: 'array', items: { type: 'string' }, description: 'Which known features were solved against.' },
            },
            required: ['offset', 'rotation', 'intrinsics', 'valid_band_z', 'central_region', 'residuals'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            const intrinsics = args.intrinsics as { [k: string]: unknown };
            const numbers = ['fx', 'fy', 'cx', 'cy'].map((k) => Number(intrinsics?.[k]));
            if (numbers.some((n) => !Number.isFinite(n)) || numbers[0] <= 0 || numbers[1] <= 0) {
                throw new McpToolError('intrinsics.fx/fy/cx/cy must be finite, with positive focal lengths.');
            }
            const band = (args.valid_band_z as number[] || []).map(Number);
            if (band.length !== 2 || band.some((n) => !Number.isFinite(n)) || band[0] > band[1]) {
                throw new McpToolError('valid_band_z must be [min, max] machine Z.');
            }
            const central = Number(args.central_region);
            if (!Number.isFinite(central) || central <= 0 || central > 1) {
                throw new McpToolError('central_region must be a fraction in (0, 1].');
            }
            const r = args.residuals as { [k: string]: number };
            const fingerprint = await liveFingerprint();
            const stored = cameraModelStore.add({
                fingerprint: {
                    deviceId: fingerprint.deviceId,
                    width: fingerprint.width,
                    height: fingerprint.height,
                    referenceFrameHash: fingerprint.referenceFrameHash,
                },
                boundTo: {
                    connectionEpoch: connectionEpoch(),
                    machineIdentifier: connectionManager.getConnectionStatus().machineIdentifier || null,
                },
                extrinsics: { offset: parseVec3(args.offset, 'offset'), rotation: parseMatrix3(args.rotation, 'rotation') },
                intrinsics: {
                    fx: numbers[0],
                    fy: numbers[1],
                    cx: numbers[2],
                    cy: numbers[3],
                    k1: intrinsics.k1 === undefined || intrinsics.k1 === null ? null : Number(intrinsics.k1),
                },
                validBandZ: [band[0], band[1]],
                centralRegion: central,
                residuals: {
                    rmsPx: Number(r.rms_px),
                    maxPx: Number(r.max_px),
                    rmsMm: Number(r.rms_mm),
                    nPoints: Number(r.n_points),
                    nPoses: Number(r.n_poses),
                },
                solvedFrom: {
                    surveyId: args.survey_id ? String(args.survey_id) : null,
                    targets: Array.isArray(args.targets) ? (args.targets as string[]).map(String) : [],
                    poses: [],
                },
                verification: null,
            });
            return {
                model: stored,
                next_step: 'The model is UNVERIFIED and converts nothing yet. Run verify_camera_model against a target '
                    + 'at a pose that was NOT in the fit, and report the residual it returns.',
            };
        },
    });

    registry.register({
        name: 'verify_camera_model',
        description: 'Check the stored camera model against a target whose machine coordinates are known, at the '
            + 'CURRENT toolhead position, and record the residual. This is the first camera call of any session: the '
            + 'camera may have been knocked, re-aimed or replaced since the last one, and nothing about it survives a '
            + 'power cycle on trust. Pass where the target appears in the frame you just captured (pixel_u/pixel_v) '
            + 'and where it is in machine coordinates; the tool reports how far the model was out, in pixels and '
            + 'millimetres, and marks the model verified or unverified accordingly. NO MOTION - position the toolhead '
            + 'first with traverse_xy.',
        inputSchema: {
            type: 'object',
            properties: {
                target: {
                    type: 'object',
                    description: 'The known machine coordinates of the feature (e.g. the tool setter centre and its plate top).',
                    properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                    required: ['x', 'y', 'z'],
                },
                pixel_u: { type: 'number', description: 'Where it actually appears in the frame, x pixels.' },
                pixel_v: { type: 'number', description: 'Where it actually appears in the frame, y pixels.' },
                tolerance_px: { type: 'number', description: 'Pass threshold, default 8 px.' },
                note: { type: 'string', description: 'Which target, and how its pixel was located.' },
            },
            required: ['target', 'pixel_u', 'pixel_v'],
            additionalProperties: false,
        },
        handler: async (args: { [key: string]: unknown }) => {
            const model = cameraModelStore.current();
            if (!model) {
                throw new McpToolError('No camera model is stored; run camera_bootstrap first.');
            }
            const position = getPositionSnapshot();
            requireReliableMachine(position, 'a camera model verification');
            const { x, y, z } = position.machine;
            if (x === null || y === null || z === null) {
                throw new McpToolError('Current machine position unknown.');
            }
            const target = parseVec3(args.target, 'target');
            const observed = { u: Number(args.pixel_u), v: Number(args.pixel_v) };
            if (!Number.isFinite(observed.u) || !Number.isFinite(observed.v)) {
                throw new McpToolError('pixel_u and pixel_v must be finite pixel coordinates.');
            }
            const fingerprint = await liveFingerprint();
            const tolerance = Number(args.tolerance_px) > 0 ? Number(args.tolerance_px) : 8;

            // The model must be readable to predict anything; verify against a
            // provisional copy so an unverified model can prove itself.
            const provisional: CameraModel = { ...model, state: 'verified' };
            const predicted = machineToPixel(provisional, { x, y, z }, target);
            const residualPx = Math.hypot(predicted.u - observed.u, predicted.v - observed.v);
            const fov = viewPose(provisional, target, z);
            const mmPerPx = fov.standoffMm / provisional.intrinsics.fx;
            const residualMm = residualPx * mmPerPx;
            const passed = residualPx <= tolerance
                && (fingerprint.width === model.fingerprint.width && fingerprint.height === model.fingerprint.height);

            const updated = cameraModelStore.recordVerification(
                model.id,
                { at: Date.now(), pose: { x, y, z }, residualPx: Number(residualPx.toFixed(2)), residualMm: Number(residualMm.toFixed(3)) },
                passed
            );
            return {
                passed,
                residual_px: Number(residualPx.toFixed(2)),
                residual_mm: Number(residualMm.toFixed(3)),
                tolerance_px: tolerance,
                predicted_pixel: { u: Number(predicted.u.toFixed(1)), v: Number(predicted.v.toFixed(1)) },
                observed_pixel: observed,
                toolhead: { x, y, z },
                frame_id: fingerprint.frameId,
                model: updated,
                note: passed
                    ? `The model predicts this target to within ${residualPx.toFixed(1)} px (${residualMm.toFixed(2)} mm) `
                        + 'and is marked verified for this connection.'
                    : `The model is ${residualPx.toFixed(1)} px out (${residualMm.toFixed(2)} mm), beyond the ${tolerance} px `
                        + 'tolerance, and stays UNVERIFIED. The camera has most likely been moved or re-aimed: run '
                        + 'camera_bootstrap. Do not convert any pixel through this model meanwhile.',
            };
        },
    });
}
