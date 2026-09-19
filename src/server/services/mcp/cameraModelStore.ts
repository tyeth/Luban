import crypto from 'crypto';
import * as fs from 'fs-extra';
import path from 'path';

import DataStorage from '../../DataStorage';
import logger from '../../lib/logger';
import { CameraModel } from './cameraModel';

const log = logger('service:mcp:cameraModel');

// Persisted camera models. A new solve NEVER overwrites the previous one in
// place: the old model is kept `superseded` with its residuals, so "was the
// camera moved between these two jobs?" is answerable after the fact. Keeping
// them is cheap and the question is not.

interface ModelFile {
    models: CameraModel[];
}

const RETENTION = 20;

export class CameraModelStore {
    private filePath: string | null = null;

    private cache: ModelFile | null = null;

    private file(): string {
        if (!this.filePath) {
            this.filePath = path.join(DataStorage.userDataDir, 'mcp-camera-model.json');
        }
        return this.filePath;
    }

    private load(): ModelFile {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = fs.readJsonSync(this.file());
            this.cache = { models: Array.isArray(raw?.models) ? raw.models : [] };
        } catch (err) {
            this.cache = { models: [] };
        }
        return this.cache;
    }

    private save(): void {
        try {
            fs.writeJsonSync(this.file(), this.cache, { spaces: 2 });
        } catch (err) {
            log.error(`Failed to persist the camera model: ${err.message}`);
        }
    }

    /** The newest model that is not superseded, or null. */
    public current(): CameraModel | null {
        const live = this.load().models.filter((m) => m.state !== 'superseded');
        return live.length ? live[live.length - 1] : null;
    }

    public list(): CameraModel[] {
        return [...this.load().models].reverse();
    }

    public get(id: string): CameraModel | null {
        return this.load().models.find((m) => m.id === id) || null;
    }

    /** Store a freshly solved model; everything before it becomes superseded. */
    public add(model: Omit<CameraModel, 'id' | 'solvedAt' | 'state'>): CameraModel {
        const data = this.load();
        data.models = data.models.map((m) => (m.state === 'superseded' ? m : { ...m, state: 'superseded' as const }));
        const full: CameraModel = {
            ...model,
            id: crypto.randomBytes(4).toString('hex'),
            solvedAt: Date.now(),
            // Unverified until it has passed a pose that was not in its own
            // fit: a model that only agrees with the data it was fitted to has
            // demonstrated nothing.
            state: 'unverified',
        };
        data.models.push(full);
        if (data.models.length > RETENTION) {
            data.models = data.models.slice(-RETENTION);
        }
        this.save();
        log.info(`Camera model ${full.id} stored (unverified, ${full.residuals.nPoses} poses, rms ${full.residuals.rmsPx} px)`);
        return full;
    }

    /** Record a verification pass (or failure) against a pose outside the fit. */
    public recordVerification(
        id: string,
        verification: CameraModel['verification'],
        passed: boolean
    ): CameraModel | null {
        const data = this.load();
        const model = data.models.find((m) => m.id === id);
        if (!model || model.state === 'superseded') {
            return null;
        }
        model.verification = verification;
        model.state = passed ? 'verified' : 'unverified';
        this.save();
        log.info(`Camera model ${id} ${passed ? 'verified' : 'FAILED verification'}`);
        return model;
    }

    /** Mark the current model unverified again - a knock, a seam mismatch, a failed check. */
    public invalidate(id: string, reason: string): CameraModel | null {
        const data = this.load();
        const model = data.models.find((m) => m.id === id);
        if (!model || model.state === 'superseded') {
            return null;
        }
        model.state = 'unverified';
        this.save();
        log.info(`Camera model ${id} marked unverified: ${reason}`);
        return model;
    }
}

export const cameraModelStore = new CameraModelStore();
