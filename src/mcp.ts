// MCP server that Claude Code launches over stdio. Each tool forwards to the local daemon.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callDaemon } from './local.ts';

// Calls the daemon and turns the answer into MCP text, including the "daemon is down" case.
async function forward(method: 'GET' | 'POST', route: string, body?: object) {
  try {
    const { data } = await callDaemon(method, route, body);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch {
    return {
      content: [{ type: 'text' as const, text: 'coco-connect daemon is not running. Start it with `coco-connect start`.' }],
      isError: true,
    };
  }
}

const server = new McpServer({ name: 'coco-connect', version: '0.1.0' });

server.registerTool(
  'announce',
  {
    description: "Tell your teammate's agent what task you are starting, and which areas you expect to touch.",
    inputSchema: { task: z.string() },
  },
  ({ task }) => forward('POST', '/announce', { task }),
);

server.registerTool(
  'peer_status',
  { description: "See your teammate's agent: its branch, task, and files with uncommitted changes." },
  () => forward('GET', '/status'),
);

server.registerTool(
  'send_message',
  {
    description: "Send a short note to your teammate's agent, e.g. to ask before editing a file they are changing.",
    inputSchema: { text: z.string() },
  },
  ({ text }) => forward('POST', '/send', { text }),
);

server.registerTool(
  'read_inbox',
  { description: "Read (and clear) messages from your teammate's agent." },
  () => forward('GET', '/inbox'),
);

await server.connect(new StdioServerTransport());
