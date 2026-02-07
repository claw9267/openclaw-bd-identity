/**
 * bd-identity plugin: Session-aware agent identity bead management.
 *
 * Security model:
 * - The gateway injects sessionKey and agentId into the tool context.
 * - The agent never provides or controls its identity — the platform does.
 * - Identity beads are discovered by matching labels: "agent-identity" + a
 *   session-derived label.
 * - Write operations are scoped to the agent's own bead only.
 *
 * This replaces the bash bd-identity script with a tamper-proof tool.
 */

import { execSync } from "child_process";

const IDENTITY_LABEL = "agent-identity";

/**
 * Derive a bead label from a session key.
 *
 * Examples:
 *   "agent:discord:discord:1467935902931222589" → tries channel ID match
 *   "agent:main:main" → "main-session"
 *   "agent:devops:subagent:abc123" → "devops"
 *   "agent:main:discord:channel:1467935902931222589" → tries channel ID match
 */
function sessionKeyToLabels(sessionKey: string, agentId?: string): string[] {
  const labels: string[] = [];

  // Extract agent name from session key (second segment)
  const parts = sessionKey.split(":");
  if (parts.length >= 2) {
    const agent = parts[1];
    if (agent === "main" && parts[2] === "main") {
      labels.push("main-session");
    }

    // Discord channel sessions: look for channel ID
    // Patterns: agent:X:discord:CHANNEL_ID or agent:X:discord:channel:CHANNEL_ID
    const discordIdx = parts.indexOf("discord");
    if (discordIdx >= 0) {
      // The channel ID is usually the last numeric segment
      for (let i = parts.length - 1; i > discordIdx; i--) {
        if (/^\d{15,}$/.test(parts[i])) {
          labels.push(parts[i]); // raw channel ID for flexible matching
          break;
        }
      }
    }
  }

  // Also try the agentId directly if provided
  if (agentId) {
    labels.push(agentId);
  }

  return labels;
}

/**
 * Find an identity bead by searching for label intersections.
 */
function findBead(searchLabels: string[]): string | null {
  // Strategy 1: Try each label with agent-identity
  for (const label of searchLabels) {
    try {
      const result = execSync(
        `bd query "label=${IDENTITY_LABEL} AND label=${label}" --json 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();

      const beads = JSON.parse(result);
      if (Array.isArray(beads) && beads.length > 0 && beads[0].id) {
        return beads[0].id;
      }
    } catch {
      // Try next label
    }
  }

  // Strategy 2: For channel IDs, search all identity beads and match by ID in labels
  for (const label of searchLabels) {
    if (/^\d{15,}$/.test(label)) {
      try {
        const result = execSync(
          `bd query "label=${IDENTITY_LABEL}" --json 2>/dev/null`,
          { encoding: "utf-8", timeout: 5000 },
        ).trim();

        const beads = JSON.parse(result);
        if (Array.isArray(beads)) {
          const match = beads.find(
            (b: any) =>
              Array.isArray(b.labels) && b.labels.some((l: string) => l.includes(label)),
          );
          if (match?.id) return match.id;
        }
      } catch {
        // Fall through
      }
    }
  }

  return null;
}

/**
 * Create an identity bead with the given label.
 */
function createBead(label: string): string | null {
  try {
    const id = execSync(
      `bd q "Agent Identity: ${label}" --labels "${IDENTITY_LABEL},${label},session-context" 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    if (id) {
      execSync(
        `bd update "${id}" --description "Identity bead for '${label}'. Auto-created by bd-identity plugin." 2>/dev/null`,
        { timeout: 5000 },
      );
    }
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Run a bd command and return output.
 */
function bd(args: string): string {
  try {
    return execSync(`bd ${args}`, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch (e: any) {
    throw new Error(`bd command failed: ${e.message}`);
  }
}

export default function register(api: any) {
  // Use ToolFactory pattern to get session context
  api.registerTool(
    (ctx: {
      sessionKey?: string;
      agentId?: string;
      config?: any;
      sandboxed?: boolean;
    }) => {
      const sessionKey = ctx.sessionKey;
      const agentId = ctx.agentId;

      if (!sessionKey) {
        api.logger.warn("bd-identity: no sessionKey in context, tool will be limited");
      }

      return {
        name: "bd_identity",
        description: `Manage your agent identity bead. Your identity is automatically resolved from your session — you cannot access other agents' identity beads.

Commands:
- whoami: Show your session key, agent ID, and identity bead
- show: Display your identity bead content
- comment: Add a comment to your identity bead (for personality notes, preferences, context)
- init: Find or create your identity bead (run once on first use)

Your identity bead persists across sessions and stores your personality, preferences, and context.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["whoami", "show", "comment", "init"],
              description: "The identity command to run",
            },
            text: {
              type: "string",
              description: "Text for the comment command",
            },
          },
          required: ["command"],
        },

        async execute(_toolCallId: string, params: { command: string; text?: string }) {
          const { command, text } = params;

          if (!sessionKey) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: No session context available. Cannot resolve identity.",
                },
              ],
            };
          }

          // Derive search labels from session key
          const labels = sessionKeyToLabels(sessionKey, agentId);

          switch (command) {
            case "whoami": {
              const beadId = findBead(labels);
              return {
                content: [
                  {
                    type: "text",
                    text: [
                      `Session Key: ${sessionKey}`,
                      `Agent ID:    ${agentId ?? "unknown"}`,
                      `Bead ID:     ${beadId ?? "<not found — run init>"}`,
                      `Labels:      ${labels.join(", ")}`,
                      `Sandboxed:   ${ctx.sandboxed ?? "unknown"}`,
                    ].join("\n"),
                  },
                ],
              };
            }

            case "show": {
              const beadId = findBead(labels);
              if (!beadId) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `No identity bead found for session "${sessionKey}". Run 'init' to create one.`,
                    },
                  ],
                };
              }
              const output = bd(`show ${beadId}`);
              return { content: [{ type: "text", text: output }] };
            }

            case "comment": {
              if (!text) {
                return {
                  content: [{ type: "text", text: "Error: 'text' parameter required for comment." }],
                };
              }
              const beadId = findBead(labels);
              if (!beadId) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `No identity bead found. Run 'init' first.`,
                    },
                  ],
                };
              }
              const output = bd(`comments add ${beadId} "${text.replace(/"/g, '\\"')}"`);
              return {
                content: [{ type: "text", text: output || `Comment added to ${beadId}` }],
              };
            }

            case "init": {
              const existing = findBead(labels);
              if (existing) {
                return {
                  content: [
                    { type: "text", text: `Identity bead already exists: ${existing}` },
                  ],
                };
              }
              // Use the most specific label for creation
              const createLabel =
                labels.find((l) => l.startsWith("discord-")) ||
                labels.find((l) => !l.match(/^\d+$/)) ||
                agentId ||
                "unknown";
              const newId = createBead(createLabel);
              if (!newId) {
                return {
                  content: [{ type: "text", text: "Failed to create identity bead." }],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Created identity bead: ${newId} (label: ${createLabel})`,
                  },
                ],
              };
            }

            default:
              return {
                content: [
                  { type: "text", text: `Unknown command: ${command}. Use: whoami, show, comment, init` },
                ],
              };
          }
        },
      };
    },
  );

  api.logger.info("bd-identity: plugin registered");
}
