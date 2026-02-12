# openclaw-bd-identity

OpenClaw plugin for **session-aware agent identity bead management** with layered workspace memory. Gives each agent a tamper-proof identity bead that persists personality, preferences, and context across sessions, plus per-agent SOUL.md and MEMORY.md files.

## How It Works

The plugin registers two tools:

1. **`agent_self`** — Identity bead management + workspace memory (secure, agent-scoped)
2. **`bd_project`** — Project bead management (identity beads are protected)

The key security property: **the gateway injects the session key and agent ID** into the tool context. The agent never provides or controls its identity — the platform does.

```
Agent calls:  agent_self(command: "show")
Gateway adds: { sessionKey: "agent:discord:discord:1467935902931222589", agentId: "discord" }
Tool derives: labels → searches beads with "agent-identity" + matching label → returns bead
```

No env vars, no config files, no mapping tables. The session key IS the identity.

## Commands

### Identity Bead Management (`agent_self`)

| Command | Description |
|---------|-------------|
| `whoami` | Show session key, agent ID, bead ID, and labels |
| `show` | Display identity bead content |
| `comment` | Add a comment to your identity bead |
| `edit` | Update your identity bead description |
| `comments` | List all comments on your identity bead |
| `init` | Create an identity bead if none exists |

### Agent-Specific Files (`agent_self`)

| Command | Description |
|---------|-------------|
| `soul_read` | Read your personality file (`memory/<agentId>/SOUL.md`) |
| `soul_write` | Write/replace your personality file |
| `ltm_read` | Read your long-term memory (`memory/<agentId>/MEMORY.md`) |
| `ltm_write` | Write/replace your long-term memory |

### Daily Memory (`agent_self`)

| Command | Description |
|---------|-------------|
| `memory_write` | Append text to today's daily file |
| `memory_load` | Read layered memory: shared MEMORY.md → agent SOUL.md → agent MEMORY.md → yesterday → today |
| `memory_read` | Read a specific day's daily file (pass date as YYYY-MM-DD) |
| `memory_search` | Search across your daily files |
| `memory_search_all` | Search across ALL agents' daily files |

### Project Management (`bd_project`)

| Command | Description |
|---------|-------------|
| `show` | Show a bead by ID |
| `list` | List open beads |
| `ready` | Show beads ready to work on |
| `query` | Search beads with query expression |
| `comment` | Add comment to a bead |
| `edit` | Update bead description |
| `create` | Create a new bead |
| `close` | Close a bead |
| `label` | Add label to a bead (cannot add 'agent-identity') |
| `sync` | Sync bead changes |

## Memory Architecture

The plugin implements a layered memory system:

### File Structure
```
workspace/
├── MEMORY.md                     # Shared long-term memory
└── memory/
    └── <agentId>/
        ├── SOUL.md               # Agent personality
        ├── MEMORY.md             # Agent long-term memory  
        └── <year>/
            ├── 2026-02-10.md     # Daily files
            └── 2026-02-11.md
```

### Loading Order (`memory_load`)
1. **Shared MEMORY.md** (workspace root) — shared context
2. **Agent SOUL.md** — your personality and preferences  
3. **Agent MEMORY.md** — your curated long-term memory
4. **Yesterday's daily file** — recent context
5. **Today's daily file** — current session notes

### Usage Patterns
- **Identity bead:** Current focus, active tasks, immediate context
- **SOUL.md:** Core personality, communication style, preferences
- **Agent MEMORY.md:** Learned lessons, important relationships, key facts
- **Daily files:** Session logs, detailed work notes, temporary context

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) 2026.2.x+
- [Beads CLI](https://github.com/steveyegge/beads) (`bd`) installed and on PATH
- Identity beads labeled with `agent-identity` + a session-derived label

## Installation

```bash
# Clone into OpenClaw extensions directory
git clone https://github.com/claw9267/openclaw-bd-identity.git ~/.openclaw/extensions/bd-identity

# Enable in config
openclaw config set plugins.entries.bd-identity.enabled true

# Restart gateway
openclaw gateway restart
```

Or manually add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "bd-identity": {
        "enabled": true
      }
    }
  }
}
```

## Identity Bead Setup

Each agent needs an identity bead with two labels:
- `agent-identity` (marks it as an identity bead)
- A session-derived label (e.g., `discord-main`, `devops`, `main-session`)

Create one:

```bash
bd q "Agent Identity: my-agent" --labels "agent-identity,my-agent,session-context"
```

Or have the agent run `bd_identity(command: "init")` — it auto-creates with the right labels.

## Session Key → Label Resolution

The plugin derives search labels from the gateway-injected session key:

| Session Key | Labels Searched |
|------------|----------------|
| `agent:main:main` | `main-session`, `main` |
| `agent:discord:discord:1467935902931222589` | `1467935902931222589`, `discord` |
| `agent:devops:subagent:abc123` | `devops` |

## Security Model

| Property | Value |
|----------|-------|
| Identity source | Gateway-injected `sessionKey` + `agentId` |
| Agent control | None — cannot choose or override identity |
| Cross-agent access | Impossible — tool scopes to own bead only |
| Config drift | None — no env vars or mapping files |

## License

MIT
