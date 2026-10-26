# coco-connect

Two people, two Claude Code agents, one repo. coco-connect lets each agent see what the other is
working on (branch, task, files with uncommitted changes), message it, and stops one agent from editing
a file the other has uncommitted changes in. It runs over your Wi-Fi, laptop to laptop.
No server, no database.

```
Claude Code ──localhost──► daemon ◄══ WebSocket over Wi-Fi ══► daemon ◄──localhost── Claude Code
```

## Setup (do this on both laptops)

Needs Node 22.18 or newer.

1. **Install**
   ```sh
   git clone <this repo> ~/coco-connect && cd ~/coco-connect && npm install
   ```

2. **Shared secret.** Put the same secret on both machines:
   ```sh
   mkdir -p ~/.coco-connect && echo 'pick-something-long' > ~/.coco-connect/secret
   ```

3. **Start the daemon** inside the repo you're both working on. Use different names.
   ```sh
   node ~/coco-connect/src/cli.ts start --name umang
   ```
   The daemons find each other with Bonjour. If your Wi-Fi blocks that, one of you passes the
   other's IP (`ipconfig getifaddr en0`): `--peer 192.168.1.20:7778`.
   macOS asks once to allow incoming connections. Click Allow.

4. **Add the MCP tools** to Claude Code:
   ```sh
   claude mcp add coco -- node ~/coco-connect/src/cli.ts mcp
   ```

5. **Add the hooks** to the shared repo's `.claude/settings.json`:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
           "hooks": [{ "type": "command", "command": "node ~/coco-connect/src/cli.ts hook pre" }] }
       ],
       "PostToolUse": [
         { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
           "hooks": [{ "type": "command", "command": "node ~/coco-connect/src/cli.ts hook post" }] }
       ],
       "SessionStart": [
         { "hooks": [{ "type": "command", "command": "node ~/coco-connect/src/cli.ts hook session" }] }
       ]
     }
   }
   ```

6. **Tell the agents** by adding to the repo's `CLAUDE.md`:
   > Before starting work, call `peer_status` and `announce` your task. Check `read_inbox` between steps.
   > If an edit is blocked by coco-connect, `send_message` the teammate instead of working around it.

## Tools the agent gets

| Tool | What it does |
|---|---|
| `announce(task)` | Tells the teammate's agent what you're working on |
| `peer_status()` | Teammate's branch, task, and files with uncommitted changes |
| `send_message(text)` | Sends a note to the teammate's agent |
| `read_inbox()` | Reads and clears notes from the teammate |

## Not connecting?

```sh
node ~/coco-connect/src/cli.ts doctor                    # uses Bonjour to find the teammate
node ~/coco-connect/src/cli.ts doctor --peer 192.168.1.20
```

It checks your daemon, Bonjour, the network path, and the handshake in that order, and tells you
which one failed. Hostel and campus Wi-Fi usually fail the network step (client isolation): use a
phone hotspot.

## Good to know

- A file stays blocked until the teammate commits or reverts it.
- If the daemon or the teammate is offline, nothing is blocked and agents work normally.
- Messages sent while the teammate is offline are lost (nothing is stored).
- It blocks file conflicts, not logic conflicts. Keep using branches and PRs.
- Local ports: 7777 (hooks/MCP, localhost only, override with `COCO_PORT`), 7778 (Wi-Fi).

## Development

```sh
npm test         # two daemons on localhost
npm run typecheck
```
