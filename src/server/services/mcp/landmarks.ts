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
            this.cache = { landmarks: Array.isArray(raw?.landmarks) ? raw.landmarks : [] };
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
