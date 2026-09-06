/* eslint-disable camelcase */
// The `axis` namespace is read by agents through snake_case reference paths
// (axis.z_contact), matching the MCP argument convention.
import config from '../configstore';

// Jig and tool constants the operator measures once and a rotary program can
// reference (mcp/48): the rotary axis line and the touch probe's geometry.
// Set through the MCP tool `set_probe_geometry` (like landmarks: operator
// knowledge or a measurement, with a reason), overridable per box by
// environment variables, read back in `get_stored_state`. NOT in the app's
// settings pane and NEVER a prerequisite: only a reference to `axis.*`
// needs them, and then a missing value is a staging error naming the tool.
// Stock size is a property of the stock, not of the jig, so nothing about
// the stock lives here - a rotation's swept radius is a per-program argument.

export interface RotaryGeometry {
    /** Machine X of the rotary axis line (the stock runs along machine Y on this jig). */
    axisX: number;
    /** PHYSICAL machine Z of the axis (not a toolhead-contact Z). */
    axisZ: number;
}

export interface ProbeGeometry {
    /** Toolhead Z at contact minus this = physical surface Z. Re-measure after any re-fit. */
    effectiveLength: number;
    /** Side contacts are centre +/- tipDiameter / 2. */
    tipDiameter: number | null;
}

export const GEOMETRY_FIELDS = [
    { field: 'rotary_axis_x', key: 'mcpRotaryAxisX', env: 'LUBAN_MCP_ROTARY_AXIS_X', min: -50, max: 400 },
    { field: 'rotary_axis_z_physical', key: 'mcpRotaryAxisZ', env: 'LUBAN_MCP_ROTARY_AXIS_Z', min: 0, max: 400 },
    { field: 'probe_effective_length', key: 'mcpProbeEffectiveLength', env: 'LUBAN_MCP_PROBE_LENGTH', min: 1, max: 300 },
    { field: 'probe_tip_diameter', key: 'mcpProbeTipDiameter', env: 'LUBAN_MCP_PROBE_TIP_DIAMETER', min: 0.1, max: 30 },
] as const;

export type GeometryField = typeof GEOMETRY_FIELDS[number]['field'];

export interface GeometryEntry {
    value: number | null;
    source: 'env' | 'config' | 'unset';
    env: string;
    range: [number, number];
    note: string | null;
    setAt: number | null;
}

function readSetting(spec: typeof GEOMETRY_FIELDS[number]): { value: number | null; source: 'env' | 'config' | 'unset' } {
    const env = process.env[spec.env];
    if (env !== undefined && String(env).trim() !== '') {
        const n = Number(env);
        return { value: Number.isFinite(n) ? n : null, source: 'env' };
    }
    const stored = config.get(spec.key);
    if (stored === undefined || stored === null || stored === '') {
        return { value: null, source: 'unset' };
    }
    const n = Number(stored);
    return { value: Number.isFinite(n) ? n : null, source: 'config' };
}

export function geometryValue(field: GeometryField): number | null {
    const spec = GEOMETRY_FIELDS.find((f) => f.field === field);
    return spec ? readSetting(spec).value : null;
}

export function rotaryGeometry(): RotaryGeometry | null {
    const axisX = geometryValue('rotary_axis_x');
    const axisZ = geometryValue('rotary_axis_z_physical');
    if (axisX === null || axisZ === null) {
        return null;
    }
    return { axisX, axisZ };
}

export function probeGeometry(): ProbeGeometry | null {
    const effectiveLength = geometryValue('probe_effective_length');
    if (effectiveLength === null) {
        return null;
    }
    return { effectiveLength, tipDiameter: geometryValue('probe_tip_diameter') };
}

/**
 * Store operator-stated / measured values (set_probe_geometry). `null` or ''
 * clears a field. Env-overridden fields are refused so the stored value and
 * the live value never disagree silently.
 */
export function setGeometryValues(
    values: { [field: string]: unknown },
    note: string
): { updated: string[]; cleared: string[] } {
    const updated: string[] = [];
    const cleared: string[] = [];
    for (const spec of GEOMETRY_FIELDS) {
        if (!(spec.field in values) || values[spec.field] === undefined) {
            continue;
        }
        if (process.env[spec.env] !== undefined && String(process.env[spec.env]).trim() !== '') {
            throw new Error(`${spec.field} is overridden by the environment variable ${spec.env} on this box; change it there.`);
        }
        const raw = values[spec.field];
        if (raw === null || raw === '') {
            config.unset(spec.key);
            config.unset(`${spec.key}Note`);
            config.unset(`${spec.key}At`);
            cleared.push(spec.field);
            continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
            throw new Error(`${spec.field} must be a number in ${spec.min}..${spec.max} (got ${JSON.stringify(raw)}).`);
        }
        config.set(spec.key, n);
        config.set(`${spec.key}Note`, note);
        config.set(`${spec.key}At`, Date.now());
        updated.push(spec.field);
    }
    return { updated, cleared };
}

/** Everything stored, with provenance, for get_stored_state / set_probe_geometry. */
export function geometrySettings() {
    const fields: { [field: string]: GeometryEntry } = {};
    for (const spec of GEOMETRY_FIELDS) {
        const note = config.get(`${spec.key}Note`);
        const at = Number(config.get(`${spec.key}At`));
        fields[spec.field] = {
            ...readSetting(spec),
            env: spec.env,
            range: [spec.min, spec.max],
            note: note ? String(note) : null,
            setAt: Number.isFinite(at) && at > 0 ? at : null,
        };
    }
    return {
        fields,
        rotary: rotaryGeometry(),
        probe: probeGeometry(),
        note: 'Only programs that reference axis.* need these; B0-only and non-rotary work needs none of them. '
            + 'Set with set_probe_geometry after measuring (axis Z from an opposite-face pair, axis X from a side pair, '
            + 'probe length from run_tool_setter accept_probe_contact).',
    };
}

export interface AxisNamespace {
    x: number;
    z_physical: number;
    /** Toolhead Z at which the probe tip is on the axis line (z_physical + probe length). */
    z_contact: number;
    tip_radius: number | null;
    probe_length: number;
}

/**
 * Namespaces seeded into a program's results before op 1. `axis` exists only
 * when the rotary axis AND the probe length are known (z_contact needs both);
 * otherwise a reference to axis.* is refused at staging with the tool named.
 */
export function programSeedNamespaces(): { axis?: AxisNamespace } {
    const rotary = rotaryGeometry();
    const probe = probeGeometry();
    if (!rotary || !probe) {
        return {};
    }
    return {
        axis: {
            x: rotary.axisX,
            z_physical: rotary.axisZ,
            z_contact: Number((rotary.axisZ + probe.effectiveLength).toFixed(3)),
            tip_radius: probe.tipDiameter === null ? null : Number((probe.tipDiameter / 2).toFixed(3)),
            probe_length: probe.effectiveLength,
        },
    };
}

/** What a staging error should tell the agent when axis.* is referenced without the values. */
export function missingGeometryNote(): string {
    const missing = GEOMETRY_FIELDS
        .filter((f) => ['rotary_axis_x', 'rotary_axis_z_physical', 'probe_effective_length'].includes(f.field))
        .filter((f) => readSetting(f).value === null)
        .map((f) => f.field);
    return missing.length
        ? `The "axis" namespace needs ${missing.join(', ')}: measure them and store with set_probe_geometry `
            + '(or drop the axis.* reference - a program that references only its own earlier ops needs no geometry).'
        : '';
}
