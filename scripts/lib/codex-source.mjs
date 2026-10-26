import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import { Conversation, cleanText, meaningfulUserGoal, parseJsonLines, readIfPresent } from "./context.mjs";

function readSQLite(db, query) {
  let raw;
  try {
    raw = execFileSync("sqlite3", ["-readonly", "-json", db, query], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const code = error.code || (Number.isInteger(error.status) ? `exit ${error.status}` : "query error");
    throw new Error(`SQLite metadata query failed (${code})`);
  }
  try {
    const result = raw.trim() ? JSON.parse(raw) : [];
    if (!Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new Error("SQLite metadata output failed (invalid JSON array)");
  }
}

function decompressZstd(compressed) {
  try {
    if (typeof zlib.zstdDecompressSync === "function") {
      return zlib.zstdDecompressSync(compressed).toString("utf8");
    }
    // Node releases before 22.15 / 23.8 lack built-in zstd support.
    return execFileSync("zstd", ["-dcq"], {
      input: compressed,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const code = error.code === "ENOENT" ? "zstd unavailable" : error.code || "decompress error";
    throw new Error(`rollout read failed (${code})`);
  }
}

function readRolloutOnce(path) {
  if (path.endsWith(".zst")) {
    const compressed = readIfPresent(path, "rollout read");
    return compressed === null ? null : decompressZstd(compressed);
  }
  const text = readIfPresent(path, "rollout read", "utf8");
  if (text !== null) return text;
  const compressed = readIfPresent(`${path}.zst`, "rollout read");
  return compressed === null ? null : decompressZstd(compressed);
}

// Codex compresses older rollouts in place to `<rollout_path>.zst` without
// updating `threads.rollout_path`, so try the recorded path before its archive.
// A second attempt covers Codex swapping the two forms between those reads.
function readRollout(path) {
  return readRolloutOnce(path) ?? readRolloutOnce(path) ?? "";
}

function readLatestTitles(sessionIndex) {
  const latestTitles = new Map();
  parseJsonLines(readIfPresent(sessionIndex, "session index read", "utf8") ?? "", entry => {
    if (typeof entry.id !== "string" || typeof entry.thread_name !== "string" || !entry.thread_name.trim()) return;
    const timestamp = typeof entry.updated_at === "string" ? Date.parse(entry.updated_at) : NaN;
    const dated = Number.isFinite(timestamp);
    if (!dated && entry.updated_at !== undefined && entry.updated_at !== null && entry.updated_at !== "") return;
    const previous = latestTitles.get(entry.id);
    if (!previous || (dated && (!previous.dated || timestamp >= previous.timestamp))
      || (!dated && !previous.dated)) {
      latestTitles.set(entry.id, { title: entry.thread_name, timestamp, dated });
    }
  });
  return latestTitles;
}

function messageText(payload) {
  if (typeof payload.content === "string") return payload.content;
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter(part => part && typeof part === "object" && !Array.isArray(part)
      && ["text", "input_text", "output_text"].includes(part.type))
    .map(part => [part.text, part.input_text, part.output_text].find(value => typeof value === "string") || "")
    .filter(Boolean)
    .join("\n");
}

function readConversation(rolloutPath, includeContext) {
  const conversation = new Conversation(includeContext);
  if (!rolloutPath) return conversation;
  parseJsonLines(readRollout(rolloutPath), event => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (event.type !== "response_item" || payload.type !== "message") return;
    if (payload.role === "user") {
      conversation.add("user", meaningfulUserGoal(messageText(payload)), event.timestamp);
    } else if (payload.role === "assistant" && payload.phase !== "commentary") {
      conversation.add("assistant", cleanText(messageText(payload)), event.timestamp);
    }
  });
  return conversation;
}

// Root Codex threads, newest first by the app's recency order.
export function codexSessions({ db, sessionIndex, ids, limit, offset, includeContext }) {
  const rootFilter = "COALESCE(thread_source, '') IN ('', 'user')";
  const counts = readSQLite(db, `SELECT COUNT(*) AS total FROM threads WHERE ${rootFilter};`);
  const total = counts[0]?.total;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("SQLite metadata count is invalid");
  const rows = readSQLite(db, `
    SELECT id, rollout_path, substr(title, 1, 81) AS title, archived,
      COALESCE(created_at_ms, created_at * 1000) AS created_at_ms, recency_at_ms
    FROM threads WHERE ${rootFilter}
      ${ids ? `AND id IN (${ids.map(id => `'${id}'`).join(",")})` : ""}
    ORDER BY recency_at_ms DESC, id DESC
    LIMIT ${ids ? ids.length : limit} OFFSET ${ids ? 0 : offset};
  `);
  const latestTitles = readLatestTitles(sessionIndex);
  return {
    total,
    sessions: rows.map(row => ({
      id: row.id,
      // SQLite titles arrive cut to 81 characters; anything that long already
      // exceeds every template's maximum, so the cut cannot hide a valid title.
      title: latestTitles.get(row.id)?.title ?? row.title ?? "",
      archived: Boolean(row.archived),
      createdAtMs: row.created_at_ms,
      conversation: () => readConversation(row.rollout_path, includeContext),
    })),
  };
}
