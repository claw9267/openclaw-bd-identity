# openclaw-bd-identity

OpenClaw plugin for **session-aware agent identity bead management**. Gives each agent a tamper-proof identity bead that persists personality, preferences, and context across sessions.

## How It Works

The plugin registers a `bd_identity` tool that uses [Beads](https://github.com/steveyegge/beads) for storage. The key security property: **the gateway injects the session key and agent ID** into the tool context. The agent never provides or controls its identity — the platform does.

```
Agent calls:  bd_identity(command: "show")
Gateway adds: { sessionKey: "agent:discord:discord:1467935902931222589", agentId: "discord" }
Tool derives: labels → searches beads with "agent-identity" + matching label → returns bead
```

No env vars, no config files, no mapping tables. The session key IS the identity.

## Commands

| Command | Description |
|---------|-------------|
| `whoami` | Show session key, agent ID, bead ID, and labels |
| `show` | Display identity bead content |
| `comment` | Add a comment to your identity bead |
| `init` | Create an identity bead if none exists |

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
