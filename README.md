# coco-connect

Up to four people, four Claude Code sessions, one repo. coco-connect is a Claude Code plugin that
pairs sessions on the same Wi-Fi with a short code. The agents then see what each other is
working on (branch, task, files with uncommitted changes), message each other, and are stopped
from editing a file a teammate has uncommitted changes in. Mac and Windows, in any mix.
No server, no account, nothing to run by hand.

```
Claude Code ── MCP + hooks ── coco node ◄══ encrypted WebSocket over Wi-Fi ══► coco node ── Claude Code
                              (one per session, lives and dies with it)
```

## Install

Needs Node.js 20 or newer on `PATH` (`node --version`). In Claude Code:

```
/plugin install coco-connect --marketplace 0xzcr/coco-connect
```

Or, on older Claude Code versions: `/plugin marketplace add 0xzcr/coco-connect`, then
`/plugin install coco-connect@coco-connect`. Restart Claude Code afterwards.

## Use

Just ask Claude.

- **Host:** "start a coco room". Claude shows a code like `20-482913`. Read it out.
- **Everyone else:** "join coco code 20-482913".
- Then work as usual. Agents announce their tasks, and an edit to a file a teammate is changing
  is blocked with a note to coordinate. Messages show up on their own, e.g. "tell Sam's agent
  I'm done with auth.ts".
- "who's working on what?" shows the room. "leave coco" leaves it, and so does closing Claude Code.

If the code alone can't find the host (some networks block discovery), the host's screen also
shows an address like `192.168.1.20:7778`: "join coco code 20-482913, host 192.168.1.20".

## First-time network setup

- **macOS:** allow incoming connections if asked. On macOS 15+, allow *Local Network* access
  for the app running Claude Code (Terminal, iTerm, VS Code...) when asked. If you said no:
  System Settings → Privacy & Security → Local Network.
- **Windows:** set the Wi-Fi to *Private* (Settings → Network & internet → Wi-Fi → your network)
  and click Allow when Windows Firewall asks about Node.js. On a *Public* network Windows blocks
  teammates.
- **Campus, hotel or office guest Wi-Fi** often stops laptops from talking to each other. Use a
  phone hotspot.

Not connecting? Ask Claude to "diagnose coco". It checks addresses, Bonjour, firewalls, the
Windows network profile and the macOS permission, and says what to fix.

## How it works

- **One node per session.** The plugin's MCP server *is* the node: Claude Code starts it with
  the session and stops it at the end. It opens no network port until you pair or join.
- **Finding each other.** Bonjour (mDNS) announces on every network adapter, because Windows
  often sends multicast out of a virtual adapter (WSL, Hyper-V, VPN) and a Mac never hears it.
  The number before the dash in the code is the host's last IP number, so a joiner can find
  the host even where Bonjour is blocked. A full address always works.
- **Pairing.** The six digits go through CPace, a password-authenticated key exchange: someone
  listening on the Wi-Fi learns nothing, and someone faking the host gets one guess per try. The
  host allows 5 wrong guesses per code, and codes expire after 10 minutes. On success the host
  hands over a random 256-bit room key.
- **Links.** Members connect to each other directly, proving they hold the room key with X25519 +
  HMAC. Everything after that is AES-256-GCM. Both sides dial, so a pair connects if either
  direction works (a Windows laptop that refuses incoming connections can still dial out).
  If two laptops can't reach each other at all, state and messages are passed through a third.
- **What's shared.** Your name, branch, announced task, the paths of files with uncommitted
  changes (from `git status`), and messages. Never file contents.
- **Blocking.** A PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit asks the node whether
  an online teammate *in the same repo* has uncommitted changes in that file. The repo counts as
  the same if the clones share a first commit or their origin URLs match. Files that differ only
  in line endings (CRLF vs LF) are not reported, so a Windows `autocrlf` mix-up can't block the
  whole repo.
- **Messages** are delivered once and retried until acknowledged. A teammate who drops off
  (sleep, Wi-Fi change) gets them on reconnecting, for up to an hour. They reach the agent
  through hooks, after tool calls and on each prompt, wrapped so the agent treats them as notes
  from people, not instructions.

## Good to know

- A file stays blocked until the teammate commits or reverts it, or goes offline.
- Edits made through Bash aren't blocked; the skill tells agents not to use Bash for those files.
- It blocks file conflicts, not logic conflicts. Keep using branches and PRs.
- Rooms are in memory. Restarting a session means joining again with a fresh code.
- Any member can make a new code for the room. Rooms hold up to 4 people.
- To hear from teammates while Claude is idle, ask it to "listen for coco messages". It runs a
  background command that wakes it when a message arrives.
- `COCO_DISCOVERY=0` turns Bonjour off (joining then needs the host address).

## Development

```sh
npm install
npm test               # 4 nodes on localhost, hooks, the MCP server, the plugin files
COCO_TEST_BONJOUR=1 npm test   # also real Bonjour on this machine's network
npm run test:lab       # the network lab (needs Docker), a few minutes
npm run typecheck
npm run build          # rebuilds dist/coco.mjs; commit it (a test fails if it's stale)
claude --plugin-dir .  # try the plugin from this checkout
```

Development needs Node 22.18+ (it runs the TypeScript directly). The built plugin runs on Node 20+.

**The network lab** (`test/lab.test.ts`) runs each laptop as a Docker container with its own
address, on one shared virtual Wi-Fi with real Bonjour, and drives the real bundle over MCP. It
recreates what goes wrong between Macs and Windows PCs: Windows Firewall before "Allow" (or a
Public network), the WSL adapter, macOS Local Network denied, guest Wi-Fi isolation, routers that
drop Bonjour, slow Wi-Fi, sleep and switching Wi-Fi. Containers are Linux, so Windows-only code is
tested on real Windows and macOS by CI (`.github/workflows/test.yml`), which also runs the lab.
