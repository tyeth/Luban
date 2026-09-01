import crypto from 'crypto';
import * as fs from 'fs-extra';
import path from 'path';

import DataStorage from '../../DataStorage';
import logger from '../../lib/logger';

const log = logger('service:mcp:landmarks');

// Named scene landmarks (#50): expectedToolRegion solved "what is that blurry
// thing" for the endmill; this does the same for fixed scene features (tool
// height checker, rotary span, tool post). Set once from operator knowledge,
// persisted, and surfaced on every capture taken near their machine
// coordinates - so no agent re-derives an identity the operator already gave.

export interface Landmark {
    id: string;
    name: string;
    description: string;
    // Machine-coordinate XY extent of the feature on/over the bed.
    machine: { x0: number; y0: number; x1: number; y1: number };
    // Obstacle clearance: minimum safe TOOLHEAD machine Z when the XY path
    // crosses this landmark's box (operator accounts for tool length when
    // setting it). null = not an obstacle. Enforced by the direct XY move
    // guard - added after the 2026-09-01 probe crash, where a traverse at a
    // fabricated "clearance" height crossed the rotary and destroyed the
    // fitted touch probe.
    clearanceZ: number | null;
    notes: string | null;
    createdAt: number;
}

interface LandmarkFile {
    landmarks: Landmark[];
}

export class LandmarkStore {
    private filePath: string | null = null;

    private cache: LandmarkFile | null = null;

    private file(): string {
        if (!this.filePath) {
            this.filePath = path.join(DataStorage.userDataDir, 'mcp-landmarks.json');
        }
        return this.filePath;
    }

    private load(): LandmarkFile {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = fs.readJsonSync(this.file());
            const landmarks = (Array.isArray(raw?.landmarks) ? raw.landmarks : [])
                .map((l: Landmark) => ({ ...l, clearanceZ: Number.isFinite(Number(l.clearanceZ)) ? Number(l.clearanceZ) : null }));
            this.cache = { landmarks };
        } catch (err) {
            this.cache = { landmarks: [] };
        }
        return this.cache;
    }

    private save(): void {
        try {
            fs.writeJsonSync(this.file(), this.cache, { spaces: 2 });
        } catch (err) {
            log.error(`Failed to persist landmarks: ${err.message}`);
        }
    }

    public add(landmark: Omit<Landmark, 'id' | 'createdAt'>): Landmark {
        const data = this.load();
        // Same name replaces: landmarks are identities, not history.
        data.landmarks = data.landmarks.filter((l) => l.name !== landmark.name);
        const full: Landmark = {
            ...landmark,
            id: crypto.randomBytes(4).toString('hex'),
            createdAt: Date.now(),
        };
        data.landmarks.push(full);
        this.save();
        log.info(`Landmark stored: ${full.name} (${full.id})`);
        return full;
    }

    public list(): Landmark[] {
        return this.load().landmarks;
    }

    public remove(idOrName: string): boolean {
        const data = this.load();
        const before = data.landmarks.length;
        data.landmarks = data.landmarks.filter((l) => l.id !== idOrName && l.name !== idOrName);
        if (data.landmarks.length !== before) {
            this.save();
            return true;
        }
        return false;
    }

    /**
     * Obstacle landmarks (clearanceZ set) whose box - inflated by margin -
     * the straight XY segment from (x0,y0) to (x1,y1) touches, and whose
     * clearanceZ the given toolhead machine Z is BELOW. These are collisions
     * waiting to happen; the direct XY guard refuses them.
     */
    public obstaclesOnPath(
        x0: number, y0: number, x1: number, y1: number,
        toolheadZ: number, marginMm = 5
    ): Landmark[] {
        return this.load().landmarks.filter((l) => {
            if (l.clearanceZ === null || toolheadZ >= l.clearanceZ) {
                return false;
            }
            const bx0 = l.machine.x0 - marginMm;
            const by0 = l.machine.y0 - marginMm;
            const bx1 = l.machine.x1 + marginMm;
            const by1 = l.machine.y1 + marginMm;
            // 2D segment-vs-AABB slab test.
            const dx = x1 - x0;
            const dy = y1 - y0;
            let tMin = 0;
            let tMax = 1;
            for (const [p, d, lo, hi] of [[x0, dx, bx0, bx1], [y0, dy, by0, by1]] as [number, number, number, number][]) {
                if (Math.abs(d) < 1e-12) {
                    if (p < lo || p > hi) {
                        return false;
                    }
                } else {
                    let t1 = (lo - p) / d;
                    let t2 = (hi - p) / d;
                    if (t1 > t2) {
                        [t1, t2] = [t2, t1];
                    }
                    tMin = Math.max(tMin, t1);
                    tMax = Math.min(tMax, t2);
                    if (tMin > tMax) {
                        return false;
                    }
                }
            }
            return true;
        });
    }

    /**
     * Landmarks whose extent lies within `radius` mm of a machine XY point -
     * what a toolhead camera at that position could plausibly see.
     */
    public near(x: number, y: number, radius: number): Landmark[] {
        return this.load().landmarks.filter((l) => {
            const dx = Math.max(l.machine.x0 - x, 0, x - l.machine.x1);
            const dy = Math.max(l.machine.y0 - y, 0, y - l.machine.y1);
            return Math.hypot(dx, dy) <= radius;
        });
    }
}

export const landmarkStore = new LandmarkStore();
