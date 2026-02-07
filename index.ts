/**
 * bd-identity plugin: Session-aware agent identity + project bead management.
 *
 * Provides two tools:
 *
 * bd_identity — Manage your own identity bead (personality, context, focus).
 *   Gateway injects sessionKey/agentId. Agent cannot access other agents' beads.
 *   Commands: whoami, show, comment, edit, comments, prune, init
 *
 * bd_project — Full bead access EXCEPT identity beads.
 *   For agents that need to manage project/task beads but must not tamper
 *   with any agent's identity. Checks the "agent-identity" label before writes.
 *   Commands: show, list, comment, edit, create, close, ready, query
 */

import { execSync } from "child_process";

const IDENTITY_LABEL = "agent-identity";

// ─── Shared helpers ───────────────────────────────────────────────

function bd(args: string, timeoutMs = 10000): string {
  try {
    return execSync(`bd ${args}`, {
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trim();
  } catch (e: any) {
    const msg = e.stderr?.trim() || e.message;
    throw new Error(`bd failed: ${msg}`);
  }
}

function isIdentityBead(beadId: string): boolean {
  try {
    const result = bd(`label list ${beadId}`);
    return result.includes(IDENTITY_LABEL);
  } catch {
    return false;
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

// ─── Identity bead discovery ──────────────────────────────────────

function sessionKeyToLabels(sessionKey: string, agentId?: string): string[] {
  const labels: string[] = [];
  const parts = sessionKey.split(":");

  if (parts.length >= 2) {
    const agent = parts[1];
    if (agent === "main" && parts[2] === "main") {
      labels.push("main-session");
    }

    // Discord: find channel ID (long numeric string)
    const discordIdx = parts.indexOf("discord");
    if (discordIdx >= 0) {
      for (let i = parts.length - 1; i > discordIdx; i--) {
        if (/^\d{15,}$/.test(parts[i])) {
          labels.push(parts[i]);
          break;
        }
      }
    }
  }

  if (agentId) labels.push(agentId);
  return labels;
}

function findIdentityBead(searchLabels: string[]): string | null {
  // Try direct label match first
  for (const label of searchLabels) {
    try {
      const result = bd(
        `query "label=${IDENTITY_LABEL} AND label=${label}" --json`,
      );
      const beads = JSON.parse(result);
      if (Array.isArray(beads) && beads.length > 0 && beads[0].id) {
        return beads[0].id;
      }
    } catch {
      // next
    }
  }

  // For channel IDs, search all identity beads and match by substring
  for (const label of searchLabels) {
    if (/^\d{15,}$/.test(label)) {
      try {
        const result = bd(`query "label=${IDENTITY_LABEL}" --json`);
        const beads = JSON.parse(result);
        if (Array.isArray(beads)) {
          const match = beads.find(
            (b: any) =>
              Array.isArray(b.labels) &&
              b.labels.some((l: string) => l.includes(label)),
          );
          if (match?.id) return match.id;
        }
      } catch {
        // fall through
      }
    }
  }

  return null;
}

function createIdentityBead(label: string): string | null {
  try {
    const id = bd(
      `q "Agent Identity: ${label}" --labels "${IDENTITY_LABEL},${label},session-context"`,
    );
    if (id) {
      bd(
        `update "${id}" --description "Identity bead for '${label}'. Auto-created by bd-identity plugin."`,
      );
    }
    return id || null;
  } catch {
    return null;
  }
}

// ─── bd_identity tool ─────────────────────────────────────────────

function registerIdentityTool(api: any) {
  api.registerTool(
    (ctx: {
      sessionKey?: string;
      agentId?: string;
      sandboxed?: boolean;
    }) => {
      const sessionKey = ctx.sessionKey;
      const agentId = ctx.agentId;
      const labels = sessionKey ? sessionKeyToLabels(sessionKey, agentId) : [];

      return {
        name: "bd_identity",
        description: `Manage your agent identity bead. Your identity is automatically resolved from your session — you cannot access other agents' beads.

Commands:
- whoami: Show your session key, agent ID, and identity bead
- show: Display your identity bead content
- comment: Add a comment to your identity bead
- edit: Update your identity bead description (replaces entire description)
- comments: List all comments on your identity bead
- init: Find or create your identity bead

Keep your bead lean: current focus, active tasks, recent decisions, personality. Move long-term knowledge to memory files.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["whoami", "show", "comment", "edit", "comments", "init"],
              description: "The identity command to run",
            },
            text: {
              type: "string",
              description: "Text for comment or edit commands",
            },
          },
          required: ["command"],
        },

        async execute(_id: string, params: { command: string; text?: string }) {
          const { command, text } = params;

          if (!sessionKey) {
            return errorResult("No session context. Cannot resolve identity.");
          }

          const beadId = findIdentityBead(labels);

          switch (command) {
            case "whoami":
              return textResult(
                [
                  `Session Key: ${sessionKey}`,
                  `Agent ID:    ${agentId ?? "unknown"}`,
                  `Bead ID:     ${beadId ?? "<not found — run init>"}`,
                  `Labels:      ${labels.join(", ")}`,
                  `Sandboxed:   ${ctx.sandboxed ?? "unknown"}`,
                ].join("\n"),
              );

            case "show":
              if (!beadId) return errorResult(`No identity bead found. Run 'init' first.`);
              return textResult(bd(`show ${beadId}`));

            case "comment":
              if (!text) return errorResult("'text' parameter required for comment.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              bd(`comments add ${beadId} "${text.replace(/"/g, '\\"')}"`);
              return textResult(`Comment added to ${beadId}`);

            case "edit":
              if (!text) return errorResult("'text' parameter required for edit.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              bd(`update ${beadId} --description "${text.replace(/"/g, '\\"')}"`);
              return textResult(`Description updated on ${beadId}`);

            case "comments": {
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const output = bd(`comments ${beadId}`);
                return textResult(output || "No comments.");
              } catch {
                return textResult("No comments.");
              }
            }

            case "init": {
              if (beadId) return textResult(`Identity bead already exists: ${beadId}`);
              const createLabel =
                labels.find((l) => l.startsWith("discord-")) ||
                labels.find((l) => !l.match(/^\d+$/)) ||
                agentId ||
                "unknown";
              const newId = createIdentityBead(createLabel);
              if (!newId) return errorResult("Failed to create identity bead.");
              return textResult(`Created identity bead: ${newId} (label: ${createLabel})`);
            }

            default:
              return errorResult(`Unknown command: ${command}`);
          }
        },
      };
    },
  );
}

// ─── bd_project tool ──────────────────────────────────────────────

function registerProjectTool(api: any) {
  api.registerTool(
    (ctx: {
      sessionKey?: string;
      agentId?: string;
    }) => {
      return {
        name: "bd_project",
        description: `Manage project and task beads. Full bead access EXCEPT agent identity beads — writes to identity beads are blocked.

Commands:
- show <id>: Show a bead
- list: List open beads
- ready: Show beads ready to work on
- query <expr>: Search beads with a query expression
- comment <id> <text>: Add a comment to a bead
- edit <id> <text>: Update a bead's description
- create <title>: Create a new bead
- close <id>: Close a bead
- label <id> <label>: Add a label to a bead (cannot add 'agent-identity')
- sync: Sync bead changes

Use this for project work, task tracking, and collaboration. Identity beads are managed exclusively through bd_identity.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["show", "list", "ready", "query", "comment", "edit", "create", "close", "label", "sync"],
              description: "The project command to run",
            },
            id: {
              type: "string",
              description: "Bead ID (for show, comment, edit, close, label)",
            },
            text: {
              type: "string",
              description: "Text content (for comment, edit, create, query, label)",
            },
          },
          required: ["command"],
        },

        async execute(_toolCallId: string, params: { command: string; id?: string; text?: string }) {
          const { command, id, text } = params;

          // Write commands that target a specific bead — check identity protection
          const writeCommands = ["comment", "edit", "close", "label"];
          if (writeCommands.includes(command) && id) {
            if (isIdentityBead(id)) {
              return errorResult(
                `Bead '${id}' is an agent identity bead. Use bd_identity to manage your own identity bead.`,
              );
            }
          }

          switch (command) {
            case "show":
              if (!id) return errorResult("'id' parameter required.");
              return textResult(bd(`show ${id}`));

            case "list":
              return textResult(bd("list --limit 20"));

            case "ready":
              return textResult(bd("ready"));

            case "query":
              if (!text) return errorResult("'text' parameter required for query.");
              return textResult(bd(`query "${text.replace(/"/g, '\\"')}"`));

            case "comment":
              if (!id) return errorResult("'id' parameter required.");
              if (!text) return errorResult("'text' parameter required.");
              bd(`comments add ${id} "${text.replace(/"/g, '\\"')}"`);
              return textResult(`Comment added to ${id}`);

            case "edit":
              if (!id) return errorResult("'id' parameter required.");
              if (!text) return errorResult("'text' parameter required.");
              bd(`update ${id} --description "${text.replace(/"/g, '\\"')}"`);
              return textResult(`Description updated on ${id}`);

            case "create":
              if (!text) return errorResult("'text' parameter required (bead title).");
              const newId = bd(`q "${text.replace(/"/g, '\\"')}"`);
              return textResult(`Created bead: ${newId}`);

            case "close":
              if (!id) return errorResult("'id' parameter required.");
              if (isIdentityBead(id)) {
                return errorResult("Cannot close an identity bead.");
              }
              bd(`close ${id}`);
              return textResult(`Closed ${id}`);

            case "label":
              if (!id) return errorResult("'id' parameter required.");
              if (!text) return errorResult("'text' parameter required (label name).");
              if (text.trim() === IDENTITY_LABEL) {
                return errorResult(
                  `Cannot add '${IDENTITY_LABEL}' label. Identity beads are managed by the platform.`,
                );
              }
              bd(`label add ${id} "${text.replace(/"/g, '\\"')}"`);
              return textResult(`Label '${text}' added to ${id}`);

            case "sync":
              return textResult(bd("sync"));

            default:
              return errorResult(`Unknown command: ${command}`);
          }
        },
      };
    },
  );
}

// ─── Plugin entry point ───────────────────────────────────────────

export default function register(api: any) {
  registerIdentityTool(api);
  registerProjectTool(api);
  api.logger.info("bd-identity: registered bd_identity + bd_project tools");
}
