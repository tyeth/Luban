/**
 * MCP tool registry.
 *
 * Tools are registered at service start and exposed over the MCP endpoint
 * via tools/list and tools/call. Handlers receive already-parsed arguments
 * and return a JSON-serializable result; throw McpToolError for failures
 * that should surface as a tool error rather than a protocol error.
 */

export class McpToolError extends Error {
}

export interface McpToolDefinition {
    name: string;
    description: string;

    // JSON Schema for the tool arguments
    inputSchema: object;

    handler: (args: object) => Promise<object>;
}

export class ToolRegistry {
    private tools = new Map<string, McpToolDefinition>();

    public register(tool: McpToolDefinition): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`MCP tool already registered: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    }

    public list(): object[] {
        return [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
    }

    public has(name: string): boolean {
        return this.tools.has(name);
    }

    public async call(name: string, args: object): Promise<object> {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new McpToolError(`Unknown tool: ${name}`);
        }
        return tool.handler(args || {});
    }
}
