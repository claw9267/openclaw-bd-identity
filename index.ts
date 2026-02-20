/**
 * bd-identity plugin: Session-aware agent identity + project bead management + workspace memory + shared specs.
 *
 * Provides three tools:
 *
 * agent_self — Manage your own identity bead (personality, context, focus)
 *   AND workspace memory (per-agent daily files + SOUL.md + MEMORY.md).
 *   Gateway injects sessionKey/agentId. Agent cannot access other agents' beads or memory.
 *   Commands: whoami, show, comment, edit, comments, init,
 *             soul_read, soul_write, ltm_read, ltm_write,
 *             system_memory_write, agent_ltm_read,
 *             memory_write, memory_load, memory_read, memory_search, memory_search_all
 *
 * bd_project — Full bead access EXCEPT identity beads.
 *   For agents that need to manage project/task beads but must not tamper
 *   with any agent's identity. Checks the "agent-identity" label before writes.
 *   Commands: show, list, comment, edit, create, close, ready, query, label, sync
 *
 * specs — Read and write shared spec documents (PRDs, design docs, implementation plans).
 *   Specs live in workspace/specs/ and are shared across all agents.
 *   Commands: read, write (write is main agent only)
 */

import { execSync, spawnSync } from "child_process";
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

function bd(args: string[], timeoutMs = 10000): string {
  const result = spawnSync("bd", args, {
    cwd: WORKSPACE,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.error?.message || "unknown error";
    const signal = result.signal || "none";
    console.error(`[bd-identity] bd ${args.join(" ")} → status=${result.status} signal=${signal} error=${msg}`);
    throw new Error(`bd failed (signal=${signal}): ${msg}`);
  }
  return (result.stdout || "").trim();
}

function isIdentityBead(beadId: string): boolean {
  try {
    const result = bd(["label", "list", beadId]);
    return result.includes(IDENTITY_LABEL);
  } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
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
const SPECS_DIR = join(WORKSPACE, "specs");

/**
 * Get the memory directory for an agent.
 * Structure: workspace/memory/<agentId>/<year>/YYYY-MM-DD.md
 */
function agentMemoryDir(agentId: string): string {
  const dir = join(MEMORY_ROOT, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dateInTz(offset = 0): string {
  const tz = process.env.TZ || process.env.OPENCLAW_TZ || "America/Chicago";
  const now = new Date();
  if (offset !== 0) {
    now.setDate(now.getDate() + offset);
  }
  return now.toLocaleDateString("en-CA", { timeZone: tz }); // en-CA gives YYYY-MM-DD
}

function todayStr(): string {
  return dateInTz(0);
}

function yesterdayStr(): string {
  return dateInTz(-1);
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
    const tz = process.env.TZ || process.env.OPENCLAW_TZ || "America/Chicago";
    const dayName = new Date().toLocaleDateString("en-US", { 
      weekday: "long",
      timeZone: tz 
    });
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
      `curl -sf -X POST "${MEILI_URL}/indexes/memory-${agentId}/documents?primaryKey=id" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: doc, stdio: ["pipe", "pipe", "pipe"] },
    );

    // Update combined index
    execSync(
      `curl -sf -X POST "${MEILI_URL}/indexes/memory-all/documents?primaryKey=id" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: doc, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
    // Best effort — don't block on indexing failures
  }
}
/**
 * Index any memory file (LTM, system MEMORY.md) into MeiliSearch.
 * Used for ltm_write and system_memory_write.
 */
function indexFileDocument(filepath: string, agentId: string, indexName: string): void {
  try {
    if (!existsSync(filepath)) return;
    const fileContent = readFileSync(filepath, "utf-8").trim();
    if (!fileContent) return;

    const relPath = relative(WORKSPACE, filepath);
    const docId = relPath.replace(/[^a-zA-Z0-9]/g, "-");
    const filename = filepath.split("/").pop() || "";

    const doc = JSON.stringify([{
      id: docId,
      agentId,
      date: "ltm",
      path: relPath,
      filename,
      content: fileContent,
    }]);

    // Update specified index
    execSync(
      `curl -sf -X POST "${MEILI_URL}/indexes/${indexName}/documents?primaryKey=id" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: doc, stdio: ["pipe", "pipe", "pipe"] },
    );

    // Update combined index
    execSync(
      `curl -sf -X POST "${MEILI_URL}/indexes/memory-all/documents?primaryKey=id" -H 'Content-Type: application/json' --data-binary @-`,
      { encoding: "utf-8", timeout: 5000, input: doc, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (e: any) {
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
      const result = bd([
        "query", 
        `label=${IDENTITY_LABEL} AND label=${label}`, 
        "--json"
      ]);
      const beads = JSON.parse(result);
      if (Array.isArray(beads) && beads.length > 0 && beads[0].id) {
        return beads[0].id;
      }
    } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
      // next
    }
  }

  // For channel IDs, search all identity beads and match by substring
  for (const label of searchLabels) {
    if (/^\d{15,}$/.test(label)) {
      try {
        const result = bd(["query", `label=${IDENTITY_LABEL}`, "--json"]);
        const beads = JSON.parse(result);
        if (Array.isArray(beads)) {
          const match = beads.find(
            (b: any) =>
              Array.isArray(b.labels) &&
              b.labels.some((l: string) => l.includes(label)),
          );
          if (match?.id) return match.id;
        }
      } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
        // fall through
      }
    }
  }

  return null;
}

function createIdentityBead(label: string): string | null {
  try {
    const id = bd([
      "q", 
      `Agent Identity: ${label}`, 
      "--labels", 
      `${IDENTITY_LABEL},${label},session-context`
    ]);
    if (id) {
      bd([
        "update", 
        id, 
        "--description", 
        `Identity bead for '${label}'. Auto-created by bd-identity plugin.`
      ]);
    }
    return id || null;
  } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
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

Agent-specific personality and long-term memory:
- soul_read: Read layered identity: central SOUL.md + agent SOUL.md + identity bead body
- soul_write: Write/replace your personality file (memory/<agentId>/SOUL.md)
- ltm_read: Read your long-term memory (memory/<agentId>/MEMORY.md)
- ltm_write: Write/replace your long-term memory (memory/<agentId>/MEMORY.md) — used by nightly summarizer

Daily memory (per-agent, workspace-level — persists across sessions for the same agent):
- memory_write: Append text to today's daily file (memory/<agentId>/<year>/YYYY-MM-DD.md)
- memory_load: Read layered memory: central MEMORY.md → agent MEMORY.md → open topics summary
- memory_read: Read a specific day's daily file (pass date as text, e.g. "2026-02-07")
- memory_search: Search across all your daily files for a keyword/topic
- memory_search_all: Search across ALL agents' memory files (find if anyone else encountered something)

Nightly consolidation (main agent only):
- system_memory_write: Write/replace the shared system MEMORY.md (main only)
- agent_ltm_read: Read another agent's long-term memory (main only). Pass agent ID as text.

Short-term working memory (topics — your lifeline):
- topic_create: Create a topic for active work. One per work stream.
- topic_list: List your open topics
- topic_comment: Comment on a topic CONTINUOUSLY while working — decisions, findings, changes. This is how you resume if a session dies.
- topic_show: Show a topic with all comments
- topic_close: Close a topic when done (auto-consolidates comments to daily notes)

Tasks (todos — work items for now or later):
- task_create: Create a task (backlog by default, add #ready or #trivial to skip backlog)
- task_assign: Assign a task to an agent (sets parent to their identity bead)
- task_list: List tasks. Pass ready (bosun's queue), backlog, all (active, excludes backlog), or label:<name>. Default: tasks assigned to you.
- task_promote: Promote a backlog task to ready (requires spec reference unless #trivial). Main agent only.
- task_comment: Comment on a task — implementation details and considerations about the task itself (not working memory)
- task_show: Show a task with comments
- task_close: Close a completed task

Identity bead = who you are (experiential identity, layered on SOUL.md). NOT working memory.
Topics = short-term working memory (your lifeline). Comment continuously while working.
Tasks = todos. Create a topic when you start working a task.
Daily notes = permanent lab notebook. Topics auto-consolidate here on close.`,
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
                "soul_read",
                "soul_write",
                "ltm_read",
                "ltm_write",
                "system_memory_write",
                "agent_ltm_read",
                "memory_write",
                "memory_load",
                "memory_read",
                "memory_search",
                "memory_search_all",
                "topic_create",
                "topic_list",
                "topic_comment",
                "topic_show",
                "topic_close",
                "task_create",
                "task_assign",
                "task_list",
                "task_promote",
                "task_comment",
                "task_show",
                "task_close",
              ],
              description: "The identity command to run",
            },
            id: {
              type: "string",
              description:
                "Bead ID for topic_comment, topic_show, topic_close, task_assign, task_comment, task_show, task_close commands.",
            },
            text: {
              type: "string",
              description:
                "Text for comment, edit, memory_write, topic_create, task_create commands. For task_create: append #labels like 'title #security-finding #urgent'. For task_list: pass ready, backlog, all, unassigned, or label:<name> to filter (default: tasks assigned to you). Date string (YYYY-MM-DD) for memory_read. Query string for memory_search. For topic_comment/task_comment: the comment text. For task_assign: the target agent ID.",
            },
          },
          required: ["command"],
        },

        async execute(
          _id: string,
          params: { command: string; id?: string; text?: string },
        ) {
          const { command, id, text } = params;

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
              return textResult(bd(["show", beadId]));

            case "comment":
              if (!text)
                return errorResult("'text' parameter required for comment.");
              if (!beadId)
                return errorResult(
                  "No identity bead found. Run 'init' first.",
                );
              bd(["comments", "add", beadId, text]);
              return textResult(`Comment added to ${beadId}`);

            case "edit":
              if (!text)
                return errorResult("'text' parameter required for edit.");
              if (!beadId)
                return errorResult(
                  "No identity bead found. Run 'init' first.",
                );
              bd(["update", beadId, "--description", text]);
              return textResult(`Description updated on ${beadId}`);

            case "comments": {
              if (!beadId)
                return errorResult(
                  "No identity bead found. Run 'init' first.",
                );
              try {
                const output = bd(["comments", beadId]);
                return textResult(output || "No comments.");
              } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
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

            // ─── Agent-specific personality and memory ─────────

            case "soul_read": {
              const layers: string[] = [];

              // Layer 1: Central SOUL.md (shared Claw identity)
              const centralSoulPath = join(WORKSPACE, "SOUL.md");
              if (existsSync(centralSoulPath)) {
                const centralSoul = readFileSync(centralSoulPath, "utf-8").trim();
                if (centralSoul) {
                  layers.push(`# Central Identity (Claw)\n${centralSoul}`);
                }
              }

              // Layer 2: Agent SOUL.md (agent-specific personality)
              const agentSoulPath = join(agentMemoryDir(agentId), "SOUL.md");
              if (existsSync(agentSoulPath)) {
                const agentSoul = readFileSync(agentSoulPath, "utf-8").trim();
                if (agentSoul) {
                  layers.push(`# Agent Identity (${agentId})\n${agentSoul}`);
                }
              }

              // Layer 3: Identity bead body (current working state)
              if (beadId) {
                try {
                  const beadJson = bd(["show", beadId, "--json"]);
                  const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                  const desc = beadData.description?.trim();
                  if (desc) {
                    layers.push(`# Current Working State\n${desc}`);
                  }
                } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
                  // skip if bead can't be read
                }
              }

              if (layers.length === 0) {
                return textResult(`No identity layers found for agent ${agentId}. Run 'init' and set up SOUL.md files.`);
              }

              return textResult(layers.join("\n\n"));
            }

            case "soul_write": {
              if (!text)
                return errorResult("'text' parameter required for soul_write.");
              const soulPath = join(agentMemoryDir(agentId), "SOUL.md");
              writeFileSync(soulPath, text, "utf-8");
              const relPath = relative(WORKSPACE, soulPath);
              indexFileDocument(ltmPath, agentId, `memory-${agentId}`);
              return textResult(`Written to ${relPath}`);
            }

            case "ltm_read": {
              const ltmPath = join(agentMemoryDir(agentId), "MEMORY.md");
              if (!existsSync(ltmPath)) {
                return textResult(`No MEMORY.md file found for agent ${agentId}.`);
              }
              const content = readFileSync(ltmPath, "utf-8");
              return textResult(content);
            }

            case "ltm_write": {
              if (!text)
                return errorResult("'text' parameter required for ltm_write.");
              const ltmPath = join(agentMemoryDir(agentId), "MEMORY.md");
              writeFileSync(ltmPath, text, "utf-8");
              const relPath = relative(WORKSPACE, ltmPath);
              return textResult(`Written to ${relPath}`);
            }

            case "system_memory_write": {
              if (agentId !== "main") {
                return errorResult(
                  `Only the main agent can write system MEMORY.md. You are '${agentId}'.`,
                );
              }
              if (!text)
                return errorResult("'text' parameter required for system_memory_write.");
              const sysMemPath = join(WORKSPACE, "MEMORY.md");
              writeFileSync(sysMemPath, text, "utf-8");
              indexFileDocument(sysMemPath, "system", "memory-system");
              return textResult(`Written to MEMORY.md (system-wide shared memory)`);
            }

            case "agent_ltm_read": {
              if (agentId !== "main") {
                return errorResult(
                  `Only the main agent can read other agents' LTM. You are '${agentId}'.`,
                );
              }
              if (!text)
                return errorResult("'text' parameter required for agent_ltm_read (target agent ID).");
              const targetId = text.trim();
              // Validate agent ID to prevent path traversal
              if (!/^[a-zA-Z0-9_-]+$/.test(targetId)) {
                return errorResult(
                  `Invalid agent ID '${targetId}'. Only letters, numbers, hyphens, and underscores are allowed.`,
                );
              }
              const targetLtmPath = join(MEMORY_ROOT, targetId, "MEMORY.md");
              if (!existsSync(targetLtmPath)) {
                return textResult(`No MEMORY.md found for agent '${targetId}'. They may not have consolidated yet.`);
              }
              const targetContent = readFileSync(targetLtmPath, "utf-8");
              return textResult(targetContent);
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

              // 1. Central MEMORY.md (system-wide experience)
              const memoryMdPath = join(WORKSPACE, "MEMORY.md");
              if (existsSync(memoryMdPath)) {
                const memContent = readFileSync(memoryMdPath, "utf-8").trim();
                if (memContent) {
                  parts.push(`# System Experience (All Agents)\n${memContent}`);
                }
              }

              // 2. Agent MEMORY.md (agent-specific experience)
              const ltmPath = join(agentMemoryDir(agentId), "MEMORY.md");
              if (existsSync(ltmPath)) {
                const ltmContent = readFileSync(ltmPath, "utf-8").trim();
                if (ltmContent) {
                  parts.push(`# Agent Experience (${agentId})\n${ltmContent}`);
                }
              }

              // 3. Open topics summary
              try {
                const topicResult = bd([
                  "query",
                  `label=topic AND label=${agentId} AND status=open`,
                  "--json",
                ]);
                const topics = JSON.parse(topicResult);
                if (Array.isArray(topics) && topics.length > 0) {
                  const topicLines = topics.map((t: any) =>
                    `- ${t.id} ${t.title} (${t.comment_count || 0} comments)`
                  );
                  parts.push(`# Open Topics\n${topicLines.join("\n")}`);
                } else {
                  parts.push("# Open Topics\nNo open topics.");
                }
              } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
                parts.push("# Open Topics\nNo open topics.");
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

            // ─── Topic bead commands ───────────────────────

            case "topic_create": {
              if (!text) return errorResult("'text' parameter required for topic_create.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const newTopicId = bd([
                  "create", text,
                  "--parent", beadId,
                  "--labels", `${agentId},topic`,
                  "--silent",
                ]);
                return textResult(`Created topic: ${newTopicId}`);
              } catch (e: any) {
                return errorResult(`Failed to create topic: ${e.message}`);
              }
            }

            case "topic_list": {
              try {
                const result = bd([
                  "query",
                  `label=topic AND label=${agentId} AND status=open`,
                  "--json",
                ]);
                const beads = JSON.parse(result);
                if (!Array.isArray(beads) || beads.length === 0) {
                  return textResult("No open topics.");
                }
                const lines = beads.map((b: any) =>
                  `${b.id} ${b.title} (${b.comment_count || 0} comments)`
                );
                return textResult(lines.join("\n"));
              } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
                return textResult("No open topics.");
              }
            }

            case "topic_comment": {
              if (!id) return errorResult("'id' parameter required for topic_comment.");
              if (!text) return errorResult("'text' parameter required for topic_comment.");
              // Verify ownership: must have topic + agentId labels
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                const labels = beadData.labels || "";
                if (!labels.includes("topic") || !labels.includes(agentId)) {
                  return errorResult(`Topic ${id} does not belong to you.`);
                }
              } catch (e: any) {
                return errorResult(`Cannot verify topic: ${e.message}`);
              }
              bd(["comments", "add", id, text]);
              return textResult(`Comment added to ${id}`);
            }

            case "topic_show": {
              if (!id) return errorResult("'id' parameter required for topic_show.");
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                const labels = beadData.labels || "";
                if (!labels.includes("topic") || !labels.includes(agentId)) {
                  return errorResult(`Topic ${id} does not belong to you.`);
                }
                // Format display from JSON
                const lines = [
                  `${beadData.id} · ${beadData.title}   [${beadData.status || "open"}]`,
                  `Priority: ${beadData.priority ?? "unset"}`,
                  beadData.description ? `\nDescription:\n${beadData.description}` : "",
                  beadData.parent ? `Parent: ${beadData.parent}` : "",
                  `Labels: ${labels}`,
                ].filter(Boolean);
                const showOutput = lines.join("\n");
                let commentsOutput = "";
                try {
                  commentsOutput = bd(["comments", id]);
                } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
                  commentsOutput = "(no comments)";
                }
                return textResult(`${showOutput}\n\n--- Comments ---\n\n${commentsOutput}`);
              } catch (e: any) {
                return errorResult(`Cannot find topic: ${e.message}`);
              }
            }

            case "topic_close": {
              if (!id) return errorResult("'id' parameter required for topic_close.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                const labels = beadData.labels || "";
                if (!labels.includes("topic") || !labels.includes(agentId)) {
                  return errorResult(`Topic ${id} does not belong to you.`);
                }
                // Record topic closure in daily notes (ID only — agent should write summary separately)
                const closureNote = `## Topic closed: ${beadData.title || id} (${id})`;
                appendToDaily(agentId, closureNote);
                indexSingleDocument(agentId, todayStr());
              } catch (e: any) {
                return errorResult(`Cannot verify topic: ${e.message}`);
              }
              bd(["close", id]);
              return textResult(`Topic ${id} closed and consolidated to daily notes.`);
            }

            // ─── Task bead commands ───────────────────────────

            case "task_create": {
              if (!text) return errorResult("'text' parameter required for task_create.");
              try {
                // Parse #hashtag labels from end of text
                const hashtagRegex = /\s+#([\w-]+)/g;
                const extraLabels: string[] = [];
                let title = text;
                let match;
                while ((match = hashtagRegex.exec(text)) !== null) {
                  extraLabels.push(match[1]);
                }
                if (extraLabels.length > 0) {
                  title = text.replace(/\s+#[\w-]+/g, "").trim();
                }
                // Default to backlog unless #ready or #trivial is specified
                const hasReady = extraLabels.includes("ready");
                const hasTrivial = extraLabels.includes("trivial");
                const hasBacklog = extraLabels.includes("backlog");
                if (!hasReady && !hasBacklog) {
                  extraLabels.push("backlog");
                }
                const allLabels = ["task", ...extraLabels].join(",");
                const newTaskId = bd([
                  "create", title,
                  "--labels", allLabels,
                  "--silent",
                ]);
                const status = hasReady ? "ready" : (hasTrivial ? "backlog (trivial)" : "backlog");
                return textResult(`Created task: ${newTaskId} [${status}]`);
              } catch (e: any) {
                return errorResult(`Failed to create task: ${e.message}`);
              }
            }

            case "task_assign": {
              if (!id) return errorResult("'id' parameter required for task_assign.");
              if (!text) return errorResult("'text' parameter required for task_assign (target agent ID).");
              const targetAgentId = text.trim();
              // Find the target agent's identity bead
              const targetLabels = [targetAgentId];
              const targetBeadId = findIdentityBead(targetLabels);
              if (!targetBeadId) {
                return errorResult(`No identity bead found for agent '${targetAgentId}'.`);
              }
              // Verify the bead is a task
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                const taskLabels = beadData.labels || "";
                if (!taskLabels.includes("task")) {
                  return errorResult(`${id} is not a task bead.`);
                }
              } catch (e: any) {
                return errorResult(`Cannot find task: ${e.message}`);
              }
              // Set parent to target agent's identity bead and add agent label
              bd(["update", id, "--parent", targetBeadId]);
              bd(["label", "add", id, targetAgentId]);
              return textResult(`Task ${id} assigned to ${targetAgentId} (parent: ${targetBeadId})`);
            }

            case "task_list": {
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const mode = (text || "").trim().toLowerCase();
                let query: string;
                let emptyMsg: string;
                let filterMode: "ready" | "backlog" | "all" | "unassigned" | "mine" | "label" = "mine";

                // Support label filtering: "label:foo" or "label:foo,bar"
                const labelMatch = mode.match(/^label:([\w,-]+)$/);
                if (labelMatch) {
                  filterMode = "label";
                  const labelFilters = labelMatch[1].split(",").map((l: string) => `label=${l}`).join(" AND ");
                  query = `${labelFilters} AND label=task AND status=open`;
                  emptyMsg = `No open tasks with label: ${labelMatch[1]}`;
                } else if (mode === "ready") {
                  // Tasks promoted to ready (bosun's shopping list)
                  filterMode = "ready";
                  query = "label=task AND label=ready AND status=open";
                  emptyMsg = "No ready tasks.";
                } else if (mode === "backlog") {
                  // Backlog tasks (parked, not yet ready)
                  filterMode = "backlog";
                  query = "label=task AND label=backlog AND status=open";
                  emptyMsg = "No backlog tasks.";
                } else if (mode === "all") {
                  // All active tasks (excludes backlog)
                  filterMode = "all";
                  query = "label=task AND status=open";
                  emptyMsg = "No open tasks.";
                } else if (mode === "unassigned") {
                  // Tasks not assigned to any agent (no parent)
                  filterMode = "unassigned";
                  query = "label=task AND status=open";
                  emptyMsg = "No unassigned tasks.";
                } else {
                  // Default: tasks assigned to this agent
                  filterMode = "mine";
                  query = `parent=${beadId} AND label=task AND status=open`;
                  emptyMsg = "No open tasks assigned to you.";
                }

                const result = bd([
                  "query",
                  query,
                  "--json",
                ]);
                const beads = JSON.parse(result);
                if (!Array.isArray(beads) || beads.length === 0) {
                  return textResult(emptyMsg);
                }

                // Detect agent ownership from labels
                const agentIds = ["main", "forge", "scout", "courier", "watchdog", "bosun"];
                const getOwner = (b: any): string | null => {
                  const labels: string[] = b.labels || [];
                  const agentLabels = labels.filter((l: string) => agentIds.includes(l));
                  return agentLabels.length > 0 ? agentLabels[0] : null;
                };

                const hasLabel = (b: any, label: string): boolean => {
                  const labels: string[] = b.labels || [];
                  return labels.includes(label);
                };

                let filtered = beads;

                // For "all" mode, exclude backlog tasks
                if (filterMode === "all") {
                  filtered = beads.filter((b: any) => !hasLabel(b, "backlog"));
                }

                // For "unassigned" mode, filter to tasks with no agent label
                if (filterMode === "unassigned") {
                  filtered = beads.filter((b: any) => !getOwner(b) && !hasLabel(b, "backlog"));
                }

                if (filtered.length === 0) {
                  return textResult(emptyMsg);
                }

                // Format output with context
                const lines = filtered.map((b: any) => {
                  const ownerAgent = getOwner(b);
                  const statusLabels: string[] = [];
                  if (hasLabel(b, "backlog")) statusLabels.push("backlog");
                  if (hasLabel(b, "ready")) statusLabels.push("ready");
                  if (hasLabel(b, "in-progress")) statusLabels.push("in-progress");
                  if (hasLabel(b, "trivial")) statusLabels.push("trivial");
                  const statusTag = statusLabels.length > 0 ? ` {${statusLabels.join(",")}}` : "";

                  if (filterMode === "mine") {
                    return `${b.id} ${b.title}${statusTag}`;
                  }
                  const ownerTag = ownerAgent ? ` [${ownerAgent}]` : " [unassigned]";
                  return `${b.id} ${b.title}${ownerTag}${statusTag}`;
                });
                return textResult(lines.join("\n"));
              } catch (e: any) {
                return textResult("No open tasks.");
              }
            }

            case "task_promote": {
              if (!id) return errorResult("'id' parameter required for task_promote.");
              if (agentId !== "main") {
                return errorResult(`Only the main agent can promote tasks. You are '${agentId}'.`);
              }
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                const taskLabels: string[] = beadData.labels || [];
                if (!taskLabels.includes("task")) {
                  return errorResult(`${id} is not a task bead.`);
                }
                if (!taskLabels.includes("backlog")) {
                  return errorResult(`${id} is not in backlog.`);
                }
                if (taskLabels.includes("ready")) {
                  return errorResult(`${id} is already ready.`);
                }
                // Check for spec or trivial bypass
                const isTrivial = taskLabels.includes("trivial");
                if (!isTrivial) {
                  const desc = (beadData.description || "").toLowerCase();
                  const title = (beadData.title || "").toLowerCase();
                  const hasSpecRef = desc.includes("spec") || desc.includes("specs/") || title.includes("spec");
                  if (!hasSpecRef && !text) {
                    return errorResult(
                      `Task ${id} needs a spec reference before promotion. Either:\n` +
                      `- Add a spec reference: task_promote with text="spec: <spec-name>"\n` +
                      `- Or label it #trivial if no spec is needed.`
                    );
                  }
                  // If text provided, add it as spec reference in description
                  if (text) {
                    const currentDesc = beadData.description || "";
                    const newDesc = currentDesc ? `${currentDesc}\n\nSpec: ${text}` : `Spec: ${text}`;
                    bd(["update", id, "--description", newDesc]);
                  }
                }
                // Remove backlog, add ready
                bd(["label", "remove", id, "backlog"]);
                bd(["label", "add", id, "ready"]);
                return textResult(`Task ${id} promoted to ready.`);
              } catch (e: any) {
                return errorResult(`Failed to promote task: ${e.message}`);
              }
            }

            case "task_comment": {
              if (!id) return errorResult("'id' parameter required.");
              if (!text) return errorResult("'text' parameter required.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                if (beadData.parent !== beadId) {
                  return errorResult(`Task ${id} is not assigned to you.`);
                }
              } catch (e: any) {
                return errorResult(`Cannot verify task: ${e.message}`);
              }
              bd(["comments", "add", id, text]);
              return textResult(`Comment added to ${id}`);
            }

            case "task_show": {
              if (!id) return errorResult("'id' parameter required for task_show.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                if (beadData.parent !== beadId) {
                  return errorResult(`Task ${id} is not assigned to you.`);
                }
                // Format display from JSON
                const taskLabels = beadData.labels || "";
                const lines = [
                  `${beadData.id} · ${beadData.title}   [${beadData.status || "open"}]`,
                  `Priority: ${beadData.priority ?? "unset"}`,
                  beadData.description ? `\nDescription:\n${beadData.description}` : "",
                  beadData.parent ? `Parent: ${beadData.parent}` : "",
                  `Labels: ${taskLabels}`,
                ].filter(Boolean);
                const showOutput = lines.join("\n");
                let commentsOutput = "";
                try {
                  commentsOutput = bd(["comments", id]);
                } catch (e: any) {
    console.error(`[bd-identity] createIdentityBead failed for "${label}":`, e?.message || e);
                  commentsOutput = "(no comments)";
                }
                return textResult(`${showOutput}\n\n--- Comments ---\n\n${commentsOutput}`);
              } catch (e: any) {
                return errorResult(`Cannot find task: ${e.message}`);
              }
            }

            case "task_close": {
              if (!id) return errorResult("'id' parameter required for task_close.");
              if (!beadId) return errorResult("No identity bead found. Run 'init' first.");
              try {
                const beadJson = bd(["show", id, "--json"]);
                const beadData = Array.isArray(JSON.parse(beadJson)) ? JSON.parse(beadJson)[0] : JSON.parse(beadJson);
                if (beadData.parent !== beadId) {
                  return errorResult(`Task ${id} is not assigned to you.`);
                }
                // Record task closure in daily notes (ID only — agent should write summary separately)
                const taskClosureNote = `## Task closed: ${beadData.title || id} (${id})`;
                appendToDaily(agentId, taskClosureNote);
                indexSingleDocument(agentId, todayStr());
              } catch (e: any) {
                return errorResult(`Cannot verify task: ${e.message}`);
              }
              bd(["close", id]);
              return textResult(`Task ${id} closed.`);
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
              return textResult(bd(["show", id]));

            case "list":
              return textResult(bd(["list", "--limit", "20"]));

            case "ready":
              return textResult(bd(["ready"]));

            case "query":
              if (!text)
                return errorResult(
                  "'text' parameter required for query.",
                );
              return textResult(bd(["query", text]));

            case "comment":
              if (!id) return errorResult("'id' parameter required.");
              if (!text)
                return errorResult("'text' parameter required.");
              bd(["comments", "add", id, text]);
              return textResult(`Comment added to ${id}`);

            case "edit":
              if (!id) return errorResult("'id' parameter required.");
              if (!text)
                return errorResult("'text' parameter required.");
              bd(["update", id, "--description", text]);
              return textResult(`Description updated on ${id}`);

            case "create":
              if (!text)
                return errorResult(
                  "'text' parameter required (bead title).",
                );
              const newId = bd(["q", text]);
              return textResult(`Created bead: ${newId}`);

            case "close":
              if (!id) return errorResult("'id' parameter required.");
              if (isIdentityBead(id)) {
                return errorResult("Cannot close an identity bead.");
              }
              bd(["close", id]);
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
              bd(["label", "add", id, text]);
              return textResult(`Label '${text}' added to ${id}`);

            case "sync":
              return textResult(bd(["sync"]));

            default:
              return errorResult(`Unknown command: ${command}`);
          }
        },
      };
    },
  );
}

// ─── specs tool ───────────────────────────────────────────────────

function registerSpecsTool(api: any) {
  api.registerTool(
    (ctx: { sessionKey?: string; agentId?: string }) => {
      const agentId = ctx.agentId || "main";

      return {
        name: "specs",
        description: `Read and write spec documents. Specs are formal markdown documents that define work for agents — PRDs, design docs, implementation plans.

Specs live in workspace/specs/ and are shared across all agents.

Commands:
- read: Read a spec by name (available to all agents)
- write: Create or replace a spec (main agent only)

Specs are referenced by name (no extension needed). Main tracks which specs exist via task beads.`,
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["read", "write"],
              description: "The specs command to run",
            },
            name: {
              type: "string",
              description:
                'Spec name, e.g. "red-team". No .md extension needed.',
            },
            text: {
              type: "string",
              description:
                "Markdown content for the spec (required for write command).",
            },
          },
          required: ["command", "name"],
        },

        async execute(
          _toolCallId: string,
          params: { command: string; name: string; text?: string },
        ) {
          const { command, name, text } = params;

          switch (command) {
            case "read": {
              const safeName = name.replace(/\.md$/i, "");
              const specPath = join(SPECS_DIR, safeName + ".md");
              if (!existsSync(specPath)) {
                return errorResult(
                  `Spec '${name}' not found. Check the bead for the correct spec name.`,
                );
              }
              const content = readFileSync(specPath, "utf-8");
              return textResult(content);
            }

            case "write": {
              if (agentId !== "main") {
                return errorResult(
                  `Only the main agent can write specs. You are '${agentId}'.`,
                );
              }
              if (!text) {
                return errorResult(
                  "'text' parameter required for write command.",
                );
              }
              const safeName = name.replace(/\.md$/i, "");
              if (!/^[a-zA-Z0-9_-]+$/.test(safeName)) {
                return errorResult(
                  `Invalid spec name '${safeName}'. Only letters, numbers, hyphens, and underscores are allowed.`,
                );
              }
              mkdirSync(SPECS_DIR, { recursive: true });
              const specPath = join(SPECS_DIR, safeName + ".md");
              writeFileSync(specPath, text, "utf-8");
              return textResult(`Spec written: specs/${safeName}.md`);
            }

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
  registerSpecsTool(api);
  api.logger.info("bd-identity: registered agent_self + bd_project + specs tools");
}
