// Tiny client for the daemon's localhost API, shared by hooks and MCP tools.

const PORT = Number(process.env.COCO_PORT ?? 7777);

export async function callDaemon(method: 'GET' | 'POST', route: string, body?: object) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    // Hooks run on every edit, so never hang the agent waiting for a dead daemon.
    signal: AbortSignal.timeout(1000),
  });
  return { status: res.status, data: await res.json() };
}
