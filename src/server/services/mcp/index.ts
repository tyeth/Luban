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

let httpServer: http.Server | null = null;

function resolvePort(): number | null {
    const raw = process.env[PORT_ENV] || config.get(PORT_CONFIG_KEY);
    if (!raw) {
        return null;
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        log.error(`Ignoring invalid MCP port: ${raw}`);
        return null;
    }
    return port;
}

export interface McpBroadcaster {
    broadcast: (eventName: string, options?: object) => void;
}

export function startMcpService(socketServer?: McpBroadcaster): void {
    if (httpServer) {
        return;
    }

    const port = resolvePort();
    if (port === null) {
        return;
    }

    const registry = new ToolRegistry();
    registerStatusTools(registry);
    registerMachineTools(registry);
    registerGcodeTools(registry, () => `http://127.0.0.1:${port}`);
    registerCameraTools(registry);
    registerCalibrationTools(registry);

    // Mirror tool activity to connected UI clients so the Workspace console
    // can show agent traffic (verbose toggle).
    const onActivity = (activity: object) => {
        socketServer && socketServer.broadcast('mcp:activity', activity);
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
    });
    httpServer.listen(port, '127.0.0.1', () => {
        log.info(`MCP server listening at http://127.0.0.1:${port}/mcp`);
    });
}

export function stopMcpService(): void {
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}
