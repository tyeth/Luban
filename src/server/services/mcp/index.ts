import http from 'http';

import pkg from '../../../package.json';
import logger from '../../lib/logger';
import config from '../configstore';
import { McpServer, isAllowedOrigin, isLocalSubnetAddress, isLocalSubnetOrigin, isLoopback, localSubnets } from './McpServer';
import { jobManager } from './jobs';
import { probeFeedService, resolveActiveProbeConfig } from './probeFeed';
import { ToolRegistry } from './registry';
import { registerCalibrationTools } from './tools/calibration';
import { registerCameraTools } from './tools/camera';
import { registerGcodeTools } from './tools/gcode';
import { registerLandmarkTools } from './tools/landmarks';
import { registerMachineTools } from './tools/machine';
import { registerProbeTools } from './tools/probe';
import { registerProbingTools } from './tools/probing';
import { registerStatusTools } from './tools/status';
import { registerToolSetterTools } from './tools/toolsetter';

const log = logger('service:mcp');

// Off by default. Enabled by setting a port, either through the environment
// or the server configstore. Loopback only by default - reachable by local
// processes but never from the LAN the machine sits on. mcpAllowLan /
// LUBAN_MCP_ALLOW_LAN opts into listening on every interface, still refusing
// any client that is not on one of this machine's own IPv4 subnets. There is
// no authentication: anyone on that subnet can then command the machine, so
// the Settings pane says so in red.
const PORT_ENV = 'LUBAN_MCP_PORT';
const ALLOW_LAN_ENV = 'LUBAN_MCP_ALLOW_LAN';
const PORT_CONFIG_KEY = 'mcpPort';
const ENABLED_CONFIG_KEY = 'mcpEnabled';
const ALLOW_LAN_CONFIG_KEY = 'mcpAllowLan';
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
    /** Accept clients from this machine's own IPv4 subnets, not just loopback. */
    allowLan: boolean;
    allowLanSource: 'env' | 'config' | 'default';
}

function resolveAllowLan(): { allowLan: boolean; source: 'env' | 'config' | 'default' } {
    const envRaw = process.env[ALLOW_LAN_ENV];
    if (envRaw !== undefined && String(envRaw).trim() !== '') {
        return { allowLan: ['1', 'true', 'yes', 'on'].includes(String(envRaw).trim().toLowerCase()), source: 'env' };
    }
    const configRaw = config.get(ALLOW_LAN_CONFIG_KEY);
    if (configRaw !== undefined && configRaw !== null) {
        return { allowLan: !!configRaw, source: 'config' };
    }
    return { allowLan: false, source: 'default' };
}

function resolveSettings(): McpSettings {
    const envRaw = process.env[PORT_ENV];
    if (envRaw) {
        const envPort = validPort(envRaw);
        if (envPort === null) {
            log.error(`Ignoring invalid ${PORT_ENV}: ${envRaw}`);
        } else {
            const lan = resolveAllowLan();
            return { enabled: true, port: envPort, source: 'env', allowLan: lan.allowLan, allowLanSource: lan.source };
        }
    }

    const configPort = validPort(config.get(PORT_CONFIG_KEY));
    const enabledRaw = config.get(ENABLED_CONFIG_KEY);
    // Legacy behaviour: before mcpEnabled existed, setting mcpPort enabled
    // the service. Keep that when the flag is absent.
    const enabled = (enabledRaw === undefined || enabledRaw === null)
        ? configPort !== null
        : !!enabledRaw;
    const lan = resolveAllowLan();
    return { enabled, port: configPort || DEFAULT_PORT, source: 'config', allowLan: lan.allowLan, allowLanSource: lan.source };
}

/**
 * LAN interfaces in the order an operator would expect: real subnets first,
 * point-to-point /32 addresses (VPN/tailnet interfaces) last - a /32 only
 * ever matches the machine itself, so it is a poor address to hand out.
 */
function orderedLanSubnets(): { address: string; netmask: string }[] {
    return [...localSubnets()].sort((a, b) => Number(a.netmask === '255.255.255.255') - Number(b.netmask === '255.255.255.255'));
}

/** Where a browser should open confirm pages: a LAN address when LAN mode is on, else loopback. */
function publicBaseUrl(port: number, allowLan: boolean): string {
    if (allowLan) {
        const subnet = orderedLanSubnets()[0];
        if (subnet) {
            return `http://${subnet.address}:${port}`;
        }
    }
    return `http://127.0.0.1:${port}`;
}

function lanUrls(port: number): string[] {
    return orderedLanSubnets().map((subnet) => `http://${subnet.address}:${port}/mcp`);
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
        // LAN URLs an agent on the same subnet can use (only meaningful when
        // allowLan is on AND the server is running with it).
        lanUrls: settings.allowLan ? lanUrls(settings.port) : [],
        // Sensor feed snapshot for the Workspace connection pills; live
        // updates arrive over mcp:activity (tool 'probe_feed').
        probeFeed: probeFeedService.status(),
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
    const baseUrl = () => publicBaseUrl(port, settings.allowLan);
    registerGcodeTools(registry, baseUrl);
    registerCameraTools(registry);
    registerCalibrationTools(registry);
    registerLandmarkTools(registry);
    registerProbeTools(registry);
    registerToolSetterTools(registry, baseUrl);
    registerProbingTools(registry, baseUrl);
    registeredToolCount = registry.list().length;

    broadcaster = socketServer || null;

    // Mirror tool activity to connected UI clients so the Workspace console
    // can show agent traffic (verbose toggle).
    const onActivity = (activity: object) => {
        mcpBroadcast('mcp:activity', activity);
    };

    const mcpServer = new McpServer(registry, 'snapmaker-luban', pkg.version, onActivity);

    httpServer = http.createServer((req, res) => {
        // Same trust boundary for every route: local processes only (plus, in
        // LAN mode, hosts on this machine's own subnets), and no browser
        // contexts other than localhost / the app's own scheme (or, in LAN
        // mode, a same-subnet host).
        const remote = req.socket.remoteAddress;
        const addressOk = isLoopback(remote) || (settings.allowLan && isLocalSubnetAddress(remote));
        const originOk = isAllowedOrigin(req.headers.origin) || (settings.allowLan && isLocalSubnetOrigin(req.headers.origin));
        if (!addressOk || !originOk) {
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
    const bindHost = settings.allowLan ? '0.0.0.0' : '127.0.0.1';
    httpServer.listen(port, bindHost, () => {
        runningPort = port;
        const reach = settings.allowLan
            ? ` and on the local subnets: ${lanUrls(port).join(', ') || '(no LAN interface found)'}`
            : ' (loopback only)';
        log.info(`MCP server listening at http://127.0.0.1:${port}/mcp${reach}`);
    });

    // Arm the external probe feed (and its overtravel tripwire) without any
    // agent involvement when it is fully configured. Failure is logged and
    // retried by the feed's own backoff; it must never break startup.
    if (resolveActiveProbeConfig().configured) {
        probeFeedService.connect().catch((err: Error) => {
            log.error(`Probe feed auto-connect failed: ${err.message}`);
        });
    }
}

export function stopMcpService(): void {
    if (httpServer) {
        httpServer.close();
        httpServer = null;
        runningPort = null;
    }
}
