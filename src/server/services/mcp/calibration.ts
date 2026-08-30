import crypto from 'crypto';
import * as fs from 'fs-extra';
import path from 'path';

import DataStorage from '../../DataStorage';
import logger from '../../lib/logger';

const log = logger('service:mcp:calibration');

// Persisted pixel-to-machine calibration (#13). On the SM2 gantry the
// platform travels in Y, so a mapping derived from a frame is only valid
// at the machine Y it was captured at - entries are keyed by that Y (and
// record Z, since camera height changes scale).
//
// The 2x2 matrix maps a pixel delta (du, dv) to the machine XY move (mm)
// that cancels it: [dx, dy] = M . [du, dv]. Deriving M (rectification,
// parallax handling) is the calibrating agent's job; the store only keeps
// and serves it.

export interface CalibrationEntry {
    id: string;
    validAtY: number; // machine Y the frame was captured at
    z: number; // machine Z the frame was captured at
    matrix: [[number, number], [number, number]];
    notes: string | null;
    createdAt: number;
}

interface CalibrationFile {
    entries: CalibrationEntry[];
}

export class CalibrationStore {
    private filePath: string | null = null;

    private cache: CalibrationFile | null = null;

    private file(): string {
        if (!this.filePath) {
            this.filePath = path.join(DataStorage.userDataDir, 'mcp-camera-calibration.json');
        }
        return this.filePath;
    }

    private load(): CalibrationFile {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = fs.readJsonSync(this.file());
            this.cache = { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
        } catch (err) {
            this.cache = { entries: [] };
        }
        return this.cache;
    }

    private save(): void {
        try {
            fs.writeJsonSync(this.file(), this.cache, { spaces: 2 });
        } catch (err) {
            log.error(`Failed to persist camera calibration: ${err.message}`);
        }
    }

    public add(entry: Omit<CalibrationEntry, 'id' | 'createdAt'>): CalibrationEntry {
        const data = this.load();
        const full: CalibrationEntry = {
            ...entry,
            id: crypto.randomBytes(4).toString('hex'),
            createdAt: Date.now(),
        };
        data.entries.push(full);
        this.save();
        log.info(`Camera calibration ${full.id} stored (valid at Y ${full.validAtY}, Z ${full.z})`);
        return full;
    }

    public list(): CalibrationEntry[] {
        return this.load().entries;
    }

    public get(id: string): CalibrationEntry | null {
        return this.load().entries.find((entry) => entry.id === id) || null;
    }

    public remove(id: string): boolean {
        const data = this.load();
        const before = data.entries.length;
        data.entries = data.entries.filter((entry) => entry.id !== id);
        if (data.entries.length !== before) {
            this.save();
            return true;
        }
        return false;
    }

    /**
     * Nearest entry by |validAtY - y|, or null when none is within tolerance.
     */
    public findNearest(y: number, toleranceMm: number): { entry: CalibrationEntry; distance: number } | null {
        let best: { entry: CalibrationEntry; distance: number } | null = null;
        for (const entry of this.load().entries) {
            const distance = Math.abs(entry.validAtY - y);
            if (!best || distance < best.distance) {
                best = { entry, distance };
            }
        }
        return best && best.distance <= toleranceMm ? best : null;
    }
}

export const calibrationStore = new CalibrationStore();
