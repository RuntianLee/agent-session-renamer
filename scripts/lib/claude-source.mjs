import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Conversation, cleanText, meaningful, meaningfulUserGoal, parseJsonLines, readIfPresent } from "./context.mjs";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// Where the Claude desktop app keeps its Code session metadata.
export function defaultDesktopDir() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude-code-sessions");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude", "claude-code-sessions");
}

function listDir(path, step) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`${step} failed (${error.code || "read error"})`);
  }
}

// Top-level transcripts only; subagent transcripts live in nested folders.
function transcriptIndex(claudeDir) {
  const index = new Map();
  const projects = join(claudeDir, "projects");
  for (const project of listDir(projects, "transcript listing")) {
    if (!project.isDirectory()) continue;
    for (const file of listDir(join(projects, project.name), "transcript listing")) {
      const id = basename(file.name, ".jsonl");
      if (!file.isFile() || !file.name.endsWith(".jsonl") || !SESSION_UUID.test(id)) continue;
      const path = join(projects, project.name, file.name);
      let modifiedAtMs;
      try {
        modifiedAtMs = statSync(path).mtimeMs;
      } catch (error) {
        if (error.code === "ENOENT") continue; // Removed after the listing.
        throw new Error(`transcript listing failed (${error.code || "read error"})`);
      }
      index.set(id, { path, modifiedAtMs });
    }
  }
  return index;
}

// The app nests sessions as <account>/<organization>/local_*.json. Listing
// reads a single signed-in organization so other accounts stay out of scope;
// ownership checks read every organization so none is mistaken for terminal.
function desktopRecordFiles(desktopDir, allOrganizations) {
  const direct = listDir(desktopDir, "desktop session listing")
    .filter(entry => entry.isFile() && /^local_.+\.json$/.test(entry.name));
  if (direct.length) return direct.map(entry => join(desktopDir, entry.name));
  const organizations = [];
  for (const account of listDir(desktopDir, "desktop session listing")) {
    if (!account.isDirectory()) continue;
    for (const organization of listDir(join(desktopDir, account.name), "desktop session listing")) {
      if (!organization.isDirectory()) continue;
      const folder = join(desktopDir, account.name, organization.name);
      const files = listDir(folder, "desktop session listing")
        .filter(entry => entry.isFile() && /^local_.+\.json$/.test(entry.name))
        .map(entry => join(folder, entry.name));
      if (files.length) organizations.push(files);
    }
  }
  if (allOrganizations) return organizations.flat();
  if (organizations.length > 1) {
    throw new Error("desktop session listing failed (several accounts have sessions; pass --desktop-dir <account>/<organization>)");
  }
  return organizations[0] ?? [];
}

function desktopRecords(desktopDir, allOrganizations = false) {
  const records = [];
  for (const file of desktopRecordFiles(desktopDir, allOrganizations)) {
    let record;
    try {
      record = JSON.parse(readIfPresent(file, "desktop session read", "utf8") ?? "null");
    } catch {
      continue;
    }
    if (!record || typeof record.sessionId !== "string" || typeof record.cliSessionId !== "string") continue;
    const transcripts = [record.cliSessionId, ...(Array.isArray(record.priorCliSessionIds) ? record.priorCliSessionIds : [])]
      .filter(id => typeof id === "string");
    records.push({
      id: record.sessionId,
      transcripts,
      title: typeof record.title === "string" ? record.title : "",
      archived: record.isArchived === true,
      createdAtMs: Number(record.createdAt) || 0,
      recencyMs: Number(record.lastActivityAt) || Number(record.createdAt) || 0,
    });
  }
  return records;
}

function textBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

// Slash commands are recorded as <command-name> markup and their output as a
// separate <local-command-stdout> entry. Only a command with arguments says
// what the user wanted; the bare command and its output do not.
function userGoal(text) {
  if (/^\s*<local-command-stdout>/.test(text)) return "";
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim() ?? "";
    return args ? meaningfulUserGoal(`${command[1].trim()} ${args}`) : "";
  }
  return meaningfulUserGoal(text);
}

function conversationEntry(entry) {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary || entry.isApiErrorMessage) return null;
  const text = textBlocks(entry.message?.content);
  return entry.type === "user"
    ? { role: "user", text: userGoal(text) }
    : { role: "assistant", text: cleanText(text) };
}

function readTranscript(path, includeContext) {
  const conversation = new Conversation(includeContext);
  let customTitle = "";
  let firstAtMs = null;
  parseJsonLines(readIfPresent(path, "transcript read", "utf8") ?? "", entry => {
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      customTitle = entry.customTitle;
      return;
    }
    const turn = conversationEntry(entry);
    if (!turn) return;
    const atMs = Date.parse(entry.timestamp);
    if (Number.isFinite(atMs) && firstAtMs === null) firstAtMs = atMs;
    conversation.add(turn.role, turn.text, entry.timestamp);
  });
  return { conversation, customTitle, firstAtMs };
}

// Whether a transcript holds any meaningful user goal. Reads in chunks and
// stops at the first one, since goals almost always appear near the top.
function hasUserGoal(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error(`transcript read failed (${error.code || "read error"})`);
  }
  try {
    const chunk = Buffer.alloc(256 * 1024);
    let pending = Buffer.alloc(0);
    for (;;) {
      const bytes = readSync(descriptor, chunk, 0, chunk.length, null);
      const data = Buffer.concat([pending, chunk.subarray(0, bytes)]);
      const end = bytes ? data.lastIndexOf(0x0a) + 1 : data.length;
      let found = false;
      parseJsonLines(data.subarray(0, end).toString("utf8"), entry => {
        const turn = conversationEntry(entry);
        if (turn?.role === "user" && meaningful(turn.text)) found = true;
      });
      if (found) return true;
      if (!bytes) return false;
      pending = data.subarray(end);
    }
  } catch (error) {
    throw new Error(`transcript read failed (${error.code || "read error"})`);
  } finally {
    closeSync(descriptor);
  }
}

// Claude Code sessions with a local transcript, newest first.
// `claude-desktop` lists the desktop app's Code sessions, whose titles the
// app owns; `claude-cli` lists the remaining terminal and IDE transcripts,
// whose titles live in their `custom-title` records.
export function claudeSessions({ platform, claudeDir, desktopDir, ids, limit, offset, includeContext }) {
  const transcripts = transcriptIndex(claudeDir);
  let candidates;
  if (platform === "claude-desktop") {
    candidates = desktopRecords(desktopDir).flatMap(record => {
      const transcript = record.transcripts.map(id => transcripts.get(id)).find(Boolean);
      return transcript ? [{ ...record, path: transcript.path }] : [];
    });
  } else {
    const owned = new Set(desktopRecords(desktopDir, true).flatMap(record => record.transcripts));
    candidates = [...transcripts].filter(([id]) => !owned.has(id)).map(([id, transcript]) => ({
      id,
      path: transcript.path,
      archived: false,
      recencyMs: transcript.modifiedAtMs,
    }));
  }
  candidates.sort((a, b) => b.recencyMs - a.recencyMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const cache = new Map();
  const read = candidate => {
    if (!cache.has(candidate.id)) cache.set(candidate.id, readTranscript(candidate.path, includeContext));
    return cache.get(candidate.id);
  };
  // Terminal transcripts without a user goal (an immediate `/exit`, an
  // aborted start) have nothing to name.
  if (platform === "claude-cli") candidates = candidates.filter(candidate => hasUserGoal(candidate.path));
  const selected = ids
    ? candidates.filter(candidate => ids.includes(candidate.id))
    : candidates.slice(offset, offset + limit);
  return {
    total: candidates.length,
    sessions: selected.map(candidate => {
      const transcript = read(candidate);
      return {
        id: candidate.id,
        title: platform === "claude-desktop" ? candidate.title : transcript.customTitle,
        archived: candidate.archived,
        createdAtMs: candidate.createdAtMs || transcript.firstAtMs || candidate.recencyMs,
        conversation: () => transcript.conversation,
      };
    }),
  };
}

// Resolves a terminal transcript that is safe to retitle with a custom-title
// record: top-level, present, and not owned by the desktop app.
export function cliTranscriptPath({ id, claudeDir, desktopDir }) {
  if (!SESSION_UUID.test(id)) throw new Error("rename failed (session ID must be a lowercase UUID)");
  const transcript = transcriptIndex(claudeDir).get(id);
  if (!transcript) throw new Error("rename failed (transcript not found)");
  if (desktopRecords(desktopDir, true).some(record => record.transcripts.includes(id))) {
    throw new Error("rename failed (session belongs to the desktop app; rename it there)");
  }
  return transcript.path;
}
