import { currentToolProtrusion } from './clearanceContext';
import { landmarkStore } from './landmarks';
import { motionFloorZ } from './tools/machine';

/**
 * A route-specific collision envelope. With an active fitted tool, known
 * physical landmarks determine the required toolhead Z for this XY corridor.
 * Without one, retain the legacy unknown-scene floor rather than pretending a
 * historic measurement identifies the tool that is currently in the collet.
 */
export interface RouteClearance {
    minimumZ: number;
    source: 'computed-landmarks' | 'legacy-unknown-scene';
    activeToolMm: number | null;
    obstacles: Array<{ name: string; requiredZ: number | null; topZ: number | null }>;
    note: string;
}

export function routeClearanceForPath(
    from: { x: number; y: number },
    to: { x: number; y: number },
    marginMm?: number
): RouteClearance {
    const protrusion = currentToolProtrusion();
    const active = protrusion.source === 'active-tool';
    if (!active) {
        return {
            minimumZ: motionFloorZ(),
            source: 'legacy-unknown-scene',
            activeToolMm: protrusion.mm,
            obstacles: [],
            note: `No active fitted tool is confirmed; retain the legacy unknown-scene floor Z${motionFloorZ()}.`,
        };
    }
    const obstacles = landmarkStore.obstaclesOnPath(
        from.x,
        from.y,
        to.x,
        to.y,
        0,
        marginMm,
        protrusion.mm,
    );
    const requirements = obstacles.map((obstacle) => obstacle.requiredZ);
    const unknown = requirements.some((required) => required === null);
    const minimumZ = unknown ? Number.POSITIVE_INFINITY : Math.max(0, ...requirements as number[]);
    let note: string;
    if (unknown) {
        note = 'A physical obstacle lies on this route but its required Z cannot be computed until the active tool length is known.';
    } else if (obstacles.length) {
        note = `Computed from ${obstacles.length} intersected landmark(s) and active tool protrusion ${protrusion.mm} mm.`;
    } else {
        note = `No stored obstacle intersects this route; active tool protrusion ${protrusion.mm} mm is established.`;
    }
    return {
        minimumZ,
        source: 'computed-landmarks',
        activeToolMm: protrusion.mm,
        obstacles: obstacles.map((obstacle) => ({
            name: obstacle.name,
            requiredZ: obstacle.requiredZ,
            topZ: obstacle.clearanceZ,
        })),
        note,
    };
}
