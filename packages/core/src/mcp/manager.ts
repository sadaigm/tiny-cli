import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServerConfig, ToolDefinition } from '../types.js';

export interface McpTool {
  definition: ToolDefinition;  // name is `mcp__<server>__<toolName>`
  serverName: string;
  originalName: string;        // raw name from the MCP server
}

export class McpManager {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, McpTool[]> = new Map();  // keyed by server name
  private transports: Map<string, any> = new Map(); // Store transports for cleanup

  private pendingLogs: string[] = [];

  async connect(servers: McpServerConfig[]): Promise<void> {
    for (const server of servers) {
      try {
        await this.connectOne(server);
        this.pendingLogs.push(`✅ Connected to MCP server: ${server.name}`);
      } catch (err) {
        this.pendingLogs.push(`❌ Failed to connect to MCP server ${server.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  connectBackground(servers: McpServerConfig[]): void {
    for (const server of servers) {
      this.connectOne(server)
        .then(() => this.pendingLogs.push(`✅ Connected to MCP server: ${server.name}`))
        .catch(err => this.pendingLogs.push(`❌ Failed to connect to MCP server ${server.name}: ${err instanceof Error ? err.message : err}`));
    }
  }

  flushLogs(): string[] {
    const logs = this.pendingLogs;
    this.pendingLogs = [];
    return logs;
  }

  getDefinitions(): ToolDefinition[] {
    const allDefinitions: ToolDefinition[] = [];
    for (const serverTools of this.tools.values()) {
      for (const tool of serverTools) {
        allDefinitions.push(tool.definition);
      }
    }
    return allDefinitions;
  }

  async callTool(namespacedName: string, args: any): Promise<string> {
    // Find the tool and server
    let foundTool: McpTool | undefined;
    for (const serverTools of this.tools.values()) {
      foundTool = serverTools.find(t => t.definition.name === namespacedName);
      if (foundTool) break;
    }

    if (!foundTool) {
      throw new Error(`MCP tool not found: ${namespacedName}`);
    }

    const client = this.clients.get(foundTool.serverName);
    if (!client) {
      throw new Error(`MCP client not found for server: ${foundTool.serverName}`);
    }

    const result = await client.callTool({
      name: foundTool.originalName,
      arguments: args
    }) as any;

    // Stringify the result contents
    if (result.isError) {
      const errorText = (result.content as any[]).map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      throw new Error(`MCP tool error: ${errorText}`);
    }

    return (result.content as any[]).map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  }

  getStatus(name: string): 'connected' | 'disconnected' {
    return this.clients.has(name) ? 'connected' : 'disconnected';
  }

  getTools(name: string): McpTool[] {
    return this.tools.get(name) || [];
  }

  async reconnect(cfg: McpServerConfig): Promise<void> {
    await this.disconnect(cfg.name);
    await this.connectOne(cfg);
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    const transport = this.transports.get(name);

    if (client) {
      try {
        if (transport && 'terminateSession' in transport) {
          await transport.terminateSession();
        }
        await client.close();
      } catch (err) {
        console.error(`Error closing MCP client ${name}:`, err);
      } finally {
        this.clients.delete(name);
        this.tools.delete(name);
        this.transports.delete(name);
      }
    }
  }

  async close(): Promise<void> {
    const names = Array.from(this.clients.keys());
    for (const name of names) {
      await this.disconnect(name);
    }
  }

  private async connectOne(cfg: McpServerConfig): Promise<void> {
    if (cfg.type === 'stdio') {
      const transport = new StdioClientTransport({ 
        command: cfg.command!, 
        args: cfg.args, 
        env: { ...process.env, ...cfg.env } as Record<string, string>
      });
      const client = new Client({ name: 'tiny-cli', version: '1.0.0' });
      await client.connect(transport);
      this.clients.set(cfg.name, client);
      this.transports.set(cfg.name, transport);
      await this.loadTools(cfg.name, client);
      return;
    }

    if (cfg.type === 'http') {
      const url = new URL(cfg.url!);
      try {
        const client = new Client({ name: 'tiny-cli', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(url);
        await client.connect(transport);
        this.clients.set(cfg.name, client);
        this.transports.set(cfg.name, transport);
        await this.loadTools(cfg.name, client);
      } catch (err) {
        // Fallback to SSE
        const client = new Client({ name: 'tiny-cli', version: '1.0.0' });
        const transport = new SSEClientTransport(url);
        await client.connect(transport);
        this.clients.set(cfg.name, client);
        this.transports.set(cfg.name, transport);
        await this.loadTools(cfg.name, client);
      }
    }
  }

  private async loadTools(serverName: string, client: Client): Promise<void> {
    const response = await client.listTools();
    const mcpTools: McpTool[] = response.tools.map(tool => ({
      definition: {
        name: `mcp__${serverName}__${tool.name}`,
        description: tool.description || '',
        parameters: tool.inputSchema
      },
      serverName,
      originalName: tool.name
    }));
    this.tools.set(serverName, mcpTools);
  }
}
