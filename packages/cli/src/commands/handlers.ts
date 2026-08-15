import type { Agent } from '@tiny-cli/core';
import fetch from 'node-fetch';
import https from 'https';

/**
 * Fetch the model ids available at the configured endpoint.
 *
 * Pure data fetch — no prompt UI. The TUI renders its own Ink picker over
 * the result; errors propagate to the caller.
 */
export async function fetchModels(config: {
  endpoint: string;
  apiKey?: string;
  insecure?: boolean;
}): Promise<string[]> {
  const baseUrl = config.endpoint.replace(/\/$/, '');
  const url = `${baseUrl}/models`;

  let httpsAgent;
  if (config.insecure && config.endpoint.startsWith('https:')) {
    httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey || 'none'}` },
    // @ts-ignore node-fetch accepts an https agent
    agent: httpsAgent,
  });

  if (!response.ok) {
    throw new Error(`API error (${response.status}): ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: { id: string }[] };
  return (json.data || []).map((m) => m.id);
}

/**
 * Print the tool definitions for a mode (used by headless /tools output).
 */
export async function handleToolsCommand(agent: Agent, mode: 'agent' | 'chat' | 'plan') {
  const tools = agent.getToolDefinitions(mode);
  for (const tool of tools) {
    console.log(`${tool.name}: ${tool.description}`);
  }
}
