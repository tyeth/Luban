import http from 'http';

import pkg from '../../../package.json';
import logger from '../../lib/logger';
import config from '../configstore';
import { McpServer, isAllowedOrigin, isLoopback } from './McpServer';
import { jobManager } from './jobs';
import { ToolRegistry } from './registry';
import { registerCalibrationTools } from './tools/calibration';
import { registerCameraTools } from './tools/camera';
import { registerGcodeTools } from './tools/gcode';
import { registerMachineTools } from './tools/machine';
import { registerStatusTools } from './tools/status';

const log = logger('service:mcp');

// Off by default. Enabled by setting a port, either through the environment
// or the server configstore; loopback only, so reachable by local processes
// but never from the LAN the machine itself sits on.
const PORT_ENV = 'LUBAN_MCP_PORT';
const PORT_CONFIG_KEY = 'mcpPort';
const ENABLED_CONFIG_KEY = 'mcpEnabled';
const DEFAULT_PORT = 40889;

let httpServer: http.Server | null = null;
let runningPort: number | null = null;
let registeredToolCount = 0;
let broadcaster: McpBroadcaster | null = null;

/**
 * Broadcast an MCP-related event to connected UI clients (verbose console).
 * No-op until the service starts.
 */
export function mcpBroadcast(eventName: string, options?: object): void {
    broadcaster && broadcaster.broadcast(eventName, options);
}

function validPort(raw: unknown): number | null {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }
    return port;
}

interface McpSettings {
    enabled: boolean;
    port: number;
    source: 'env' | 'config';
}

function resolveSettings(): McpSettings {
    const envRaw = process.env[PORT_ENV];
    if (envRaw) {
        const envPort = validPort(envRaw);
        if (envPort === null) {
            log.error(`Ignoring invalid ${PORT_ENV}: ${envRaw}`);
        } else {
            return { enabled: true, port: envPort, source: 'env' };
        }
    }

    const configPort = validPort(config.get(PORT_CONFIG_KEY));
    const enabledRaw = config.get(ENABLED_CONFIG_KEY);
    // Legacy behaviour: before mcpEnabled existed, setting mcpPort enabled
    // the service. Keep that when the flag is absent.
    const enabled = (enabledRaw === undefined || enabledRaw === null)
        ? configPort !== null
        : !!enabledRaw;
    return { enabled, port: configPort || DEFAULT_PORT, source: 'config' };
}

/**
 * Status of the MCP service for this run. Settings changes apply at the
 * next start; `running`/`port` describe what is actually live now.
 */
export function getMcpStatus() {
    const settings = resolveSettings();
    return {
        running: !!httpServer,
        port: runningPort,
        toolCount: registeredToolCount,
        settings,
    };
}

export interface McpBroadcaster {
    broadcast: (eventName: string, options?: object) => void;
}

export function startMcpService(socketServer?: McpBroadcaster): void {
    if (httpServer) {
        return;
    }

    const settings = resolveSettings();
    if (!settings.enabled) {
        return;
    }
    const port = settings.port;

    const registry = new ToolRegistry();
    registerStatusTools(registry);
    registerMachineTools(registry);
    registerGcodeTools(registry, () => `http://127.0.0.1:${port}`);
    registerCameraTools(registry);
    registerCalibrationTools(registry);
    registeredToolCount = registry.list().length;

    broadcaster = socketServer || null;

    // Mirror tool activity to connected UI clients so the Workspace console
    // can show agent traffic (verbose toggle).
    const onActivity = (activity: object) => {
        mcpBroadcast('mcp:activity', activity);
    };

    const mcpServer = new McpServer(registry, 'snapmaker-luban', pkg.version, onActivity);

    httpServer = http.createServer((req, res) => {
        // Same trust boundary for every route: local processes only, and no
        // browser contexts other than localhost or the app's own scheme.
        if (!isLoopback(req.socket.remoteAddress) || !isAllowedOrigin(req.headers.origin)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
        }

        const url = new URL(req.url, 'http://localhost');
        if (url.pathname.startsWith('/confirm')) {
            // Human job-confirmation pages (jobs.ts)
            jobManager.handleConfirmRequest(req, res, url.pathname);
            return;
        }

        mcpServer.handleRequest(req, res);
    });
    httpServer.on('error', (err) => {
        log.error(`MCP server error: ${err.message}`);
        httpServer = null;
        runningPort = null;
    });
    httpServer.listen(port, '127.0.0.1', () => {
        runningPort = port;
        log.info(`MCP server listening at http://127.0.0.1:${port}/mcp`);
    });
}

export function stopMcpService(): void {
    if (httpServer) {
        httpServer.close();
        httpServer = null;
        runningPort = null;
    }
}
