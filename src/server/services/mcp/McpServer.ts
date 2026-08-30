import http from 'http';

import logger from '../../lib/logger';
import { McpToolError, ToolRegistry } from './registry';

const log = logger('service:mcp');

// MCP Streamable HTTP transport, stateless mode, implemented directly:
// the official SDK requires Node >= 18 and Electron 15 embeds Node 16.
//
// Scope: JSON-RPC 2.0 over POST /mcp. No session ids, no SSE stream (GET
// returns 405, which the spec permits for servers that don't offer one).
const PROTOCOL_VERSION = '2025-03-26';

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: { [key: string]: unknown };
}

function rpcResult(id: number | string, result: object): object {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id: number | string | null, code: number, message: string): object {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

// Requests from browsers carry an Origin header; a permitted one is only
// ever localhost (or the app's own luban:// scheme). Anything else is a
// DNS-rebinding attempt on a loopback-only server, per MCP spec guidance.
export function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) {
        return true;
    }
    return /^(luban:\/\/|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$)/.test(origin);
}

export function isLoopback(address: string | undefined): boolean {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export class McpServer {
    private registry: ToolRegistry;

    private serverName: string;

    private serverVersion: string;

    public constructor(registry: ToolRegistry, serverName: string, serverVersion: string) {
        this.registry = registry;
        this.serverName = serverName;
        this.serverVersion = serverVersion;
    }

    public handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        // Bound to loopback; re-check per request as defense in depth.
        if (!isLoopback(req.socket.remoteAddress)) {
            this.respond(res, 403, { error: 'loopback only' });
            return;
        }
        if (!isAllowedOrigin(req.headers.origin)) {
            log.warn(`MCP request with disallowed origin rejected: ${req.headers.origin}`);
            this.respond(res, 403, { error: 'origin not allowed' });
            return;
        }

        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/mcp') {
            this.respond(res, 404, { error: 'not found' });
            return;
        }
        if (req.method !== 'POST') {
            // No SSE stream is offered (GET) and no sessions exist to end (DELETE).
            res.writeHead(405, { Allow: 'POST' });
            res.end();
            return;
        }

        this.readBody(req, res, (body) => {
            this.handlePost(body, res);
        });
    };

    private readBody(req: http.IncomingMessage, res: http.ServerResponse, callback: (body: string) => void): void {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                req.destroy();
                this.respond(res, 413, { error: 'body too large' });
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!res.writableEnded) {
                callback(Buffer.concat(chunks).toString('utf8'));
            }
        });
        req.on('error', (err) => {
            log.warn(`MCP request error: ${err.message}`);
        });
    }

    private async handlePost(body: string, res: http.ServerResponse): Promise<void> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch (err) {
            this.respond(res, 400, rpcError(null, JSONRPC_PARSE_ERROR, 'Parse error'));
            return;
        }

        const messages: JsonRpcMessage[] = Array.isArray(parsed) ? parsed : [parsed as JsonRpcMessage];
        if (messages.length === 0) {
            this.respond(res, 400, rpcError(null, JSONRPC_INVALID_REQUEST, 'Empty batch'));
            return;
        }

        const responses = [];
        for (const message of messages) {
            // eslint-disable-next-line no-await-in-loop
            const response = await this.handleMessage(message);
            if (response) {
                responses.push(response);
            }
        }

        if (responses.length === 0) {
            // Notifications only
            res.writeHead(202);
            res.end();
        } else if (Array.isArray(parsed)) {
            this.respond(res, 200, responses);
        } else {
            this.respond(res, 200, responses[0]);
        }
    }

    private async handleMessage(message: JsonRpcMessage): Promise<object | null> {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return rpcError((message && message.id) || null, JSONRPC_INVALID_REQUEST, 'Invalid request');
        }

        // Notification: no response
        if (message.id === undefined || message.id === null) {
            return null;
        }

        const { id, method, params } = message;
        try {
            switch (method) {
                case 'initialize':
                    return rpcResult(id, {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: {
                            tools: { listChanged: false },
                        },
                        serverInfo: {
                            name: this.serverName,
                            version: this.serverVersion,
                        },
                    });
                case 'ping':
                    return rpcResult(id, {});
                case 'tools/list':
                    return rpcResult(id, { tools: this.registry.list() });
                case 'tools/call':
                    return await this.handleToolCall(id, params);
                default:
                    return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
            }
        } catch (err) {
            log.error(`MCP ${method} failed: ${err.message}`);
            return rpcError(id, JSONRPC_INTERNAL_ERROR, 'Internal error');
        }
    }

    private async handleToolCall(id: number | string, params: JsonRpcMessage['params']): Promise<object> {
        const name = params && params.name;
        if (typeof name !== 'string') {
            return rpcError(id, JSONRPC_INVALID_PARAMS, 'tools/call requires a tool name');
        }
        if (!this.registry.has(name)) {
            return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
        }

        // One line per call, arguments elided (they can carry whole gcode
        // files); enough to follow agent activity from the server log.
        const startedAt = Date.now();
        try {
            const result = await this.registry.call(name, ((params && params.arguments) as object) || {});
            log.info(`tool ${name} ok in ${Date.now() - startedAt}ms`);
            // A tool that returns non-text content (e.g. an image) supplies
            // the MCP content array itself via mcpContent.
            const content = (result as { mcpContent?: object[] })?.mcpContent
                || [{ type: 'text', text: JSON.stringify(result) }];
            return rpcResult(id, {
                content,
                isError: false,
            });
        } catch (err) {
            // Tool failures are results, not protocol errors, so the model
            // calling the tool can read them.
            const text = err instanceof McpToolError ? err.message : `Tool failed: ${err.message}`;
            log.warn(`tool ${name} failed in ${Date.now() - startedAt}ms: ${text}`);
            return rpcResult(id, {
                content: [{ type: 'text', text }],
                isError: true,
            });
        }
    }

    private respond(res: http.ServerResponse, status: number, payload: object): void {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    }
}
