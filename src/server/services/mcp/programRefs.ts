// Pure helpers for probe_program references (no machine, no server
// imports) so they can be unit-tested: RefSpec parsing, dotted-path lookup
// into earlier op results, bounded resolution, argument substitution.

export class RefResolveError extends Error {}

export interface RefSpec {
    /** "<opId>.<path>" into an earlier op's result, e.g. "c90.top.z" (sequence probe by name) or "ns90.summary.zMean". */
    from: string;
    plus?: number;
    minus?: number;
    /** REQUIRED operator-approved bounds on the resolved value (after plus/minus). */
    between: [number, number];
}

export function isRef(value: unknown): value is RefSpec {
    return !!value && typeof value === 'object' && typeof (value as RefSpec).from === 'string';
}

export function round3(value: number): number {
    return Number(value.toFixed(3));
}

/** Walk an object by dotted path; arrays may be indexed by number or by an item's name/label. */
export function lookupPath(root: unknown, path: string[]): unknown {
    let cursor: unknown = root;
    for (const token of path) {
        if (cursor === null || cursor === undefined) {
            return undefined;
        }
        if (Array.isArray(cursor)) {
            if (/^\d+$/.test(token)) {
                cursor = cursor[Number(token)];
            } else {
                cursor = cursor.find((item) => item && typeof item === 'object'
                    && ((item as { name?: string }).name === token || (item as { label?: string }).label === token));
            }
            continue;
        }
        if (typeof cursor !== 'object') {
            return undefined;
        }
        cursor = (cursor as { [key: string]: unknown })[token];
    }
    return cursor;
}

/**
 * Resolve one reference against the results so far. Sequence probe results
 * are addressable as "<seqId>.<probeName>.z" (contactMachine.z) as well as
 * by the raw shape.
 */
export function resolveRef(ref: RefSpec, results: { [opId: string]: unknown }): { value: number; source: string } {
    const parts = ref.from.split('.');
    const opId = parts[0];
    if (!(opId in results)) {
        throw new RefResolveError(`Reference "${ref.from}": op "${opId}" has no result yet (order the program so it runs first).`);
    }
    let raw = lookupPath(results[opId], parts.slice(1));
    if ((raw === undefined || raw === null) && parts.length >= 3) {
        // Shorthands for sequence probes: "<seq>.<probe>.z" or
        // "<seq>.results.<probe>.z" mean results[<probe>].contactMachine.z.
        const last = parts[parts.length - 1];
        const head = parts.slice(1, -1);
        const candidates = [
            [...head, 'contactMachine', last],
            ['results', ...head, 'contactMachine', last],
            ['results', ...head, last],
        ];
        for (const candidate of candidates) {
            raw = lookupPath(results[opId], candidate);
            if (raw !== undefined && raw !== null) {
                break;
            }
        }
    }
    const numeric = Number(raw);
    if (raw === undefined || raw === null || !Number.isFinite(numeric)) {
        throw new RefResolveError(`Reference "${ref.from}" did not resolve to a number (got ${JSON.stringify(raw)}).`);
    }
    let value = numeric + (Number(ref.plus) || 0) - (Number(ref.minus) || 0);
    value = round3(value);
    const [lo, hi] = ref.between;
    if (value < lo - 1e-9 || value > hi + 1e-9) {
        throw new RefResolveError(`Reference "${ref.from}" resolved to ${value}, outside the approved bounds [${lo}, ${hi}] - refusing the op.`);
    }
    return { value, source: `${ref.from}${ref.plus ? ` + ${ref.plus}` : ''}${ref.minus ? ` - ${ref.minus}` : ''} = ${value}` };
}

export function refMidpoint(ref: RefSpec): number {
    return round3((ref.between[0] + ref.between[1]) / 2);
}

/** Replace every reference in an args object (one level deep, plus `steps[].z`) with `pick(ref)`. */
export function substituteRefs(
    args: { [key: string]: unknown },
    pick: (ref: RefSpec, path: string) => number
): { args: { [key: string]: unknown }; refs: { path: string; ref: RefSpec }[] } {
    const refs: { path: string; ref: RefSpec }[] = [];
    const out: { [key: string]: unknown } = {};
    for (const [key, value] of Object.entries(args)) {
        if (isRef(value)) {
            refs.push({ path: key, ref: value });
            out[key] = pick(value, key);
        } else if (key === 'steps' && Array.isArray(value)) {
            out[key] = value.map((step, index) => {
                if (step && typeof step === 'object') {
                    const copy: { [k: string]: unknown } = { ...(step as object) };
                    for (const [sk, sv] of Object.entries(copy)) {
                        if (isRef(sv)) {
                            refs.push({ path: `steps[${index}].${sk}`, ref: sv });
                            copy[sk] = pick(sv, `steps[${index}].${sk}`);
                        }
                    }
                    return copy;
                }
                return step;
            });
        } else {
            out[key] = value;
        }
    }
    return { args: out, refs };
}

export function validateRef(ref: RefSpec, where: string): void {
    if (!Array.isArray(ref.between) || ref.between.length !== 2
        || !Number.isFinite(Number(ref.between[0])) || !Number.isFinite(Number(ref.between[1]))
        || Number(ref.between[0]) >= Number(ref.between[1])) {
        throw new RefResolveError(`${where}: a reference needs operator-approved bounds "between": [low, high] (law 3 - the page shows the range).`);
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*\./.test(ref.from)) {
        throw new RefResolveError(`${where}: "from" must be "<opId>.<path>" (e.g. "c90.top.z", "ns90.summary.zMean").`);
    }
}

