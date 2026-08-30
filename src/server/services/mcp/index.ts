import http from 'http';

import pkg from '../../../package.json';
import logger from '../../lib/logger';
import config from '../configstore';
import { McpServer } from './McpServer';
import { ToolRegistry } from './registry';
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

export function startMcpService(): void {
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

    const mcpServer = new McpServer(registry, 'snapmaker-luban', pkg.version);

    httpServer = http.createServer(mcpServer.handleRequest);
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
