/**
 * bd-identity plugin: Session-aware agent identity + project bead management + workspace memory.
 *
 * Provides two tools:
 *
 * agent_self — Manage your own identity bead (personality, context, focus)
 *   AND workspace memory (per-agent daily files).
 *   Gateway injects sessionKey/agentId. Agent cannot access other agents' beads or memory.
 *   Commands: whoami, show, comment, edit, comments, init,
 *             memory_write, memory_load, memory_read, memory_search
 *
 * bd_project — Full bead access EXCEPT identity beads.
 *   For agents that need to manage project/task beads but must not tamper
 *   with any agent's identity. Checks the "agent-identity" label before writes.
 *   Commands: show, list, comment, edit, create, close, ready, query, label, sync
 */

import { execSync } from "child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, relative } from "path";
import { homedir } from "os";
// MeiliSearch queried via curl (simpler than http module in plugin context)

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

// ─── Workspace memory ─────────────────────────────────────────────

// Workspace root — where memory/ lives
const WORKSPACE = join(homedir(), ".openclaw", "workspace");
const MEMORY_ROOT = join(WORKSPACE, "memory");

/**
 * Get the memory directory for an agent.
 * Structure: workspace/memory/<agentId>/<year>/YYYY-MM-DD.md
 */
function agentMemoryDir(agentId: string): string {
  const dir = join(MEMORY_ROOT, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function todayStr(): string {
  // Format: YYYY-MM-DD in local time
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function yesterdayStr(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function yearFromDate(dateStr: string): string {
  return dateStr.substring(0, 4);
}

function dailyFilePath(agentId: string, dateStr: string): string {
  const year = yearFromDate(dateStr);
  const dir = join(agentMemoryDir(agentId), year);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${dateStr}.md`);
}

function readDailyFile(agentId: string, dateStr: string): string {
  const filepath = dailyFilePath(agentId, dateStr);
  if (!existsSync(filepath)) return "";
  return readFileSync(filepath, "utf-8");
}

function appendToDaily(agentId: string, text: string): string {
  const date = todayStr();
  const filepath = dailyFilePath(agentId, date);

  if (!existsSync(filepath)) {
    // Create with header
    const dayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
    writeFileSync(filepath, `# ${date} (${dayName})\n\n${text}\n`, "utf-8");
  } else {
    appendFileSync(filepath, `\n${text}\n`, "utf-8");
  }

  return filepath;
}

// ─── MeiliSearch integration ──────────────────────────────────────

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";

/**
 * Query MeiliSearch and return formatted results.
 * Falls back to grep-based search if MeiliSearch is unavailable.
 */
function searchMeili(
  indexName: string,
  query: string,
  limit = 10,
): string {
  try {
    const body = JSON.stringify({
      q: query,
      limit,
      attributesToRetrieve: ["agentId", "date", "path", "filename"],
      attributesToCrop: ["content"],
      cropLength: 200,
      showMatchesPosition: false,
    });

    // Use curl for reliable HTTP from plugin context
    // Write body to stdin to avoid shell escaping issues
    const result = execSync(
      `curl -sf "${MEILI_URL}/indexes/${indexName}/search" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: body },
    ).trim();

    const parsed = JSON.parse(result);

    if (!parsed.hits || parsed.hits.length === 0) {
      return `No results for "${query}" in ${indexName}.`;
    }

    const lines: string[] = [
      `Found ${parsed.hits.length} result(s) for "${query}" (${parsed.processingTimeMs}ms):`,
      "",
    ];

    for (const hit of parsed.hits) {
      const cropped =
        hit._formatted?.content || "(no preview)";
      lines.push(`--- ${hit.path} (${hit.date || hit.filename}) ---`);
      lines.push(cropped);
      lines.push("");
    }

    return lines.join("\n");
  } catch (e: any) {
    // MeiliSearch unavailable — fall back to grep
    return searchMemoryGrep(indexName.replace("memory-", ""), query);
  }
}

/**
 * Recursively collect all .md files under a directory.
 */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Fallback grep-based search when MeiliSearch is unavailable.
 */
function searchMemoryGrep(
  agentId: string,
  query: string,
  maxResults = 20,
): string {
  const dir = agentId === "all"
    ? MEMORY_ROOT
    : agentMemoryDir(agentId);
  const files = collectMarkdownFiles(dir);
  const queryLower = query.toLowerCase();
  const matches: string[] = [];

  for (const filepath of files) {
    const content = readFileSync(filepath, "utf-8");
    const lines = content.split("\n");
    const relPath = relative(MEMORY_ROOT, filepath);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 2);
        const snippet = lines.slice(start, end + 1).join("\n");
        matches.push(`--- ${relPath}:${i + 1} ---\n${snippet}`);

        if (matches.length >= maxResults) break;
      }
    }
    if (matches.length >= maxResults) break;
  }

  if (matches.length === 0) {
    return `No results for "${query}" in ${agentId}'s memory. (grep fallback)`;
  }

  return `Found ${matches.length} match(es) for "${query}" (grep fallback):\n\n${matches.join("\n\n")}`;
}

/**
 * Index a single daily file into MeiliSearch (both agent index and memory-all).
 * Called after memory_write — only updates the one document that changed.
 */
function indexSingleDocument(agentId: string, dateStr: string): void {
  try {
    const filepath = dailyFilePath(agentId, dateStr);
    if (!existsSync(filepath)) return;

    const content = readFileSync(filepath, "utf-8").trim();
    if (!content) return;

    const relPath = relative(MEMORY_ROOT, filepath);
    const docId = `${agentId}_${dateStr}`.replace(/[/.]/g, "_");

    const doc = JSON.stringify([{
      id: docId,
      agentId,
      date: dateStr,
      path: relPath,
      filename: dateStr,
      content,
    }]);

    // Update agent-specific index
    execSync(
      `curl -sf -X POST "${MEILI_URL}/indexes/memory-${agentId}/documents" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: doc, stdio: ["pipe", "pipe", "pipe"] },
    );

    // Update combined index
    execSync(
      `curl -sf -X POST "${MEILI_URL}/indexes/memory-all/documents" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: doc, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // Best effort — don't block on indexing failures
  }
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

// ─── agent_self tool ──────────────────────────────────────────────

function registerIdentityTool(api: any) {
  api.registerTool(
    (ctx: {
      sessionKey?: string;
      agentId?: string;
      sandboxed?: boolean;
    }) => {
      const sessionKey = ctx.sessionKey;
      const agentId = ctx.agentId || "main";
      const labels = sessionKey ? sessionKeyToLabels(sessionKey, agentId) : [];

      return {
        name: "agent_self",
        description: `Manage your agent identity bead and per-agent workspace memory. Your identity is automatically resolved from your session — you cannot access other agents' beads or memory.

Commands:
- whoami: Show your session key, agent ID, and identity bead
- show: Display your identity bead content
- comment: Add a comment to your identity bead
- edit: Update your identity bead description (replaces entire description)
- comments: List all comments on your identity bead
- init: Find or create your identity bead

Memory (per-agent, workspace-level — persists across sessions for the same agent):
- memory_write: Append text to today's daily file (memory/<agentId>/<year>/YYYY-MM-DD.md)
- memory_load: Read MEMORY.md + today's + yesterday's daily files
- memory_read: Read a specific day's daily file (pass date as text, e.g. "2026-02-07")
- memory_search: Search across all your daily files for a keyword/topic
- memory_search_all: Search across ALL agents' memory files (find if anyone else encountered something)

Keep your bead lean: current focus, active tasks, recent decisions, personality. Move long-term knowledge to daily memory files.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: [
                "whoami",
                "show",
                "comment",
                "edit",
                "comments",
                "init",
                "memory_write",
                "memory_load",
                "memory_read",
                "memory_search",
                "memory_search_all",
              ],
              description: "The identity command to run",
            },
            text: {
              type: "string",
              description:
                "Text for comment, edit, memory_write commands. Date string (YYYY-MM-DD) for memory_read. Query string for memory_search.",
            },
          },
          required: ["command"],
        },

        async execute(
          _id: string,
          params: { command: string; text?: string },
        ) {
          const { command, text } = params;

          if (!sessionKey) {
            return errorResult("No session context. Cannot resolve identity.");
          }

          const beadId = findIdentityBead(labels);

          switch (command) {
            // ─── Identity bead commands ────────────────────────

            case "whoami":
              return textResult(
                [
                  `Session Key: ${sessionKey}`,
                  `Agent ID:    ${agentId}`,
                  `Bead ID:     ${beadId ?? "<not found — run init>"}`,
                  `Labels:      ${labels.join(", ")}`,
                  `Sandboxed:   ${ctx.sandboxed ?? "unknown"}`,
                  `Memory Dir:  memory/${agentId}/`,
                ].join("\n"),
              );

            case "show":
              if (!beadId)
                return errorResult(
                  `No identity bead found. Run 'init' first.`,
                );
              return textResult(bd(`show ${beadId}`));

            case "comment":
              if (!text)
                return errorResult("'text' parameter required for comment.");
              if (!beadId)
                return errorResult(
                  "No identity bead found. Run 'init' first.",
                );
              bd(
                `comments add ${beadId} "${text.replace(/"/g, '\\"')}"`,
              );
              return textResult(`Comment added to ${beadId}`);

            case "edit":
              if (!text)
                return errorResult("'text' parameter required for edit.");
              if (!beadId)
                return errorResult(
                  "No identity bead found. Run 'init' first.",
                );
              bd(
                `update ${beadId} --description "${text.replace(/"/g, '\\"')}"`,
              );
              return textResult(`Description updated on ${beadId}`);

            case "comments": {
              if (!beadId)
                return errorResult(
                  "No identity bead found. Run 'init' first.",
                );
              try {
                const output = bd(`comments ${beadId}`);
                return textResult(output || "No comments.");
              } catch {
                return textResult("No comments.");
              }
            }

            case "init": {
              if (beadId)
                return textResult(
                  `Identity bead already exists: ${beadId}`,
                );
              const createLabel =
                labels.find((l) => l.startsWith("discord-")) ||
                labels.find((l) => !l.match(/^\d+$/)) ||
                agentId ||
                "unknown";
              const newId = createIdentityBead(createLabel);
              if (!newId)
                return errorResult("Failed to create identity bead.");
              return textResult(
                `Created identity bead: ${newId} (label: ${createLabel})`,
              );
            }

            // ─── Workspace memory commands ────────────────────

            case "memory_write": {
              if (!text)
                return errorResult(
                  "'text' parameter required for memory_write.",
                );
              const filepath = appendToDaily(agentId, text);
              const relPath = relative(WORKSPACE, filepath);
              // Index just this document into MeiliSearch
              indexSingleDocument(agentId, todayStr());
              return textResult(`Appended to ${relPath}`);
            }

            case "memory_load": {
              const parts: string[] = [];

              // 1. MEMORY.md (long-term curated memory)
              const memoryMdPath = join(WORKSPACE, "MEMORY.md");
              if (existsSync(memoryMdPath)) {
                const content = readFileSync(memoryMdPath, "utf-8");
                parts.push(
                  `=== MEMORY.md (long-term) ===\n${content}`,
                );
              } else {
                parts.push("=== MEMORY.md === (not found)");
              }

              // 2. Yesterday's daily file
              const yesterday = yesterdayStr();
              const yesterdayContent = readDailyFile(agentId, yesterday);
              if (yesterdayContent) {
                parts.push(
                  `=== ${yesterday} (yesterday) ===\n${yesterdayContent}`,
                );
              }

              // 3. Today's daily file
              const today = todayStr();
              const todayContent = readDailyFile(agentId, today);
              if (todayContent) {
                parts.push(
                  `=== ${today} (today) ===\n${todayContent}`,
                );
              } else {
                parts.push(
                  `=== ${today} (today) === (no entries yet)`,
                );
              }

              return textResult(parts.join("\n\n"));
            }

            case "memory_read": {
              if (!text)
                return errorResult(
                  "'text' parameter required for memory_read (date as YYYY-MM-DD).",
                );
              // Validate date format
              const dateMatch = text.trim().match(/^\d{4}-\d{2}-\d{2}$/);
              if (!dateMatch) {
                return errorResult(
                  `Invalid date format: "${text}". Use YYYY-MM-DD.`,
                );
              }
              const content = readDailyFile(agentId, text.trim());
              if (!content) {
                return textResult(
                  `No memory file for ${text.trim()} (${agentId}).`,
                );
              }
              return textResult(content);
            }

            case "memory_search": {
              if (!text)
                return errorResult(
                  "'text' parameter required for memory_search (search query).",
                );
              const searchResult = searchMeili(
                `memory-${agentId}`,
                text.trim(),
              );
              return textResult(searchResult);
            }

            case "memory_search_all": {
              if (!text)
                return errorResult(
                  "'text' parameter required for memory_search_all (search query).",
                );
              const allResult = searchMeili("memory-all", text.trim());
              return textResult(allResult);
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
    (ctx: { sessionKey?: string; agentId?: string }) => {
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
              enum: [
                "show",
                "list",
                "ready",
                "query",
                "comment",
                "edit",
                "create",
                "close",
                "label",
                "sync",
              ],
              description: "The project command to run",
            },
            id: {
              type: "string",
              description:
                "Bead ID (for show, comment, edit, close, label)",
            },
            text: {
              type: "string",
              description:
                "Text content (for comment, edit, create, query, label)",
            },
          },
          required: ["command"],
        },

        async execute(
          _toolCallId: string,
          params: { command: string; id?: string; text?: string },
        ) {
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
              if (!text)
                return errorResult(
                  "'text' parameter required for query.",
                );
              return textResult(
                bd(`query "${text.replace(/"/g, '\\"')}"`),
              );

            case "comment":
              if (!id) return errorResult("'id' parameter required.");
              if (!text)
                return errorResult("'text' parameter required.");
              bd(
                `comments add ${id} "${text.replace(/"/g, '\\"')}"`,
              );
              return textResult(`Comment added to ${id}`);

            case "edit":
              if (!id) return errorResult("'id' parameter required.");
              if (!text)
                return errorResult("'text' parameter required.");
              bd(
                `update ${id} --description "${text.replace(/"/g, '\\"')}"`,
              );
              return textResult(`Description updated on ${id}`);

            case "create":
              if (!text)
                return errorResult(
                  "'text' parameter required (bead title).",
                );
              const newId = bd(
                `q "${text.replace(/"/g, '\\"')}"`,
              );
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
              if (!text)
                return errorResult(
                  "'text' parameter required (label name).",
                );
              if (text.trim() === IDENTITY_LABEL) {
                return errorResult(
                  `Cannot add '${IDENTITY_LABEL}' label. Identity beads are managed by the platform.`,
                );
              }
              bd(
                `label add ${id} "${text.replace(/"/g, '\\"')}"`,
              );
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
  api.logger.info("bd-identity: registered agent_self + bd_project tools");
}
