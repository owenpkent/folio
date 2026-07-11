/**
 * PLANNED / EXPERIMENTAL: Folio as a Model Context Protocol client.
 *
 * This lets the in-app assistant call external MCP tools. The interface is
 * defined so features and docs can be built against it, but the transport is
 * not implemented yet. See docs/ai.md and ROADMAP.md (v0.5).
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface McpClientOptions {
  /** Server command/URL to connect to (stdio or HTTP transport). */
  endpoint: string;
}

const NOT_IMPLEMENTED =
  'The MCP client is planned but not implemented yet. See docs/ai.md and ROADMAP.md.';

export class McpClient {
  constructor(private readonly options: McpClientOptions) {
    void this.options;
  }

  async listTools(): Promise<McpTool[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async callTool(_name: string, _args: Record<string, unknown>): Promise<unknown> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
