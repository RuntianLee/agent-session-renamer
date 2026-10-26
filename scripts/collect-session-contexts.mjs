#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: "string", default: "all" },
        "check-only": { type: "boolean", default: false },
        db: { type: "string", default: join(homedir(), ".codex", "state_5.sqlite") },
        "session-index": { type: "string", default: join(homedir(), ".codex", "session_index.jsonl") },
        limit: { type: "string" },
        offset: { type: "string" },
        ids: { type: "string" },
      },
    }));
  } catch (error) {
    throw new Error(`arguments failed (${error.code || "parse error"})`);
  }
  if (values.mode !== "all") {
    throw new Error(values.mode === "pending"
      ? "Unsupported mode: pending"
      : "Unsupported mode: only all is available");
  }
  const integer = (value, name, minimum, maximum) => {
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))
      || Number(value) < minimum || Number(value) > maximum) {
      throw new Error(`arguments failed: ${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return Number(value);
  };
  let ids = null;
  if (values.ids !== undefined) {
    if (values.limit !== undefined || values.offset !== undefined) {
      throw new Error("arguments failed: --ids cannot be combined with --limit or --offset");
    }
    ids = values.ids.split(",");
    if (ids.length > 20 || ids.some(id => !/^[A-Za-z0-9_-]+$/.test(id))
      || new Set(ids).size !== ids.length) {
      throw new Error("arguments failed: --ids requires 1-20 unique ASCII session IDs");
    }
  }
  return {
    mode: values.mode,
    checkOnly: values["check-only"],
    db: values.db,
    sessionIndex: values["session-index"],
    limit: integer(values.limit ?? "20", "limit", 1, 20),
    offset: ids ? null : integer(values.offset ?? "0", "offset", 0, Number.MAX_SAFE_INTEGER),
    ids,
  };
}

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

// Returns null for a missing file so callers can choose their own fallback.
function readIfPresent(path, step, encoding) {
  try {
    return readFileSync(path, encoding);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${step} failed (${error.code || "read error"})`);
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
  for (const line of (readIfPresent(sessionIndex, "session index read", "utf8") ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)
        && typeof entry.id === "string"
        && typeof entry.thread_name === "string"
        && entry.thread_name.trim()) {
        const timestamp = typeof entry.updated_at === "string" ? Date.parse(entry.updated_at) : NaN;
        const dated = Number.isFinite(timestamp);
        if (!dated && entry.updated_at !== undefined && entry.updated_at !== null && entry.updated_at !== "") continue;
        const previous = latestTitles.get(entry.id);
        if (!previous || (dated && (!previous.dated || timestamp >= previous.timestamp))
          || (!dated && !previous.dated)) {
          latestTitles.set(entry.id, { title: entry.thread_name, timestamp, dated });
        }
      }
    } catch {
      // Ignore incomplete or legacy index records.
    }
  }
  return latestTitles;
}
const formatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatDate(milliseconds) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(milliseconds))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function compliantTitle(title, date) {
  const prefix = `${date}｜`;
  if (!title.startsWith(prefix)) return false;
  const topicLength = Array.from(title.slice(prefix.length)).length;
  return topicLength >= 10
    && topicLength <= 28
    && Array.from(title).length <= 40;
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<skill>[\s\S]*?<\/skill>/gi, " ")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\$?[^\]]+\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulUserGoal(value) {
  let text = cleanText(value);
  const request = Array.from(text.matchAll(/(?:##\s*)?My request(?: for Codex)?:/g)).at(-1);
  if (request) {
    text = text.slice(request.index + request[0].length).trim();
  }

  if (!text || /^\[?Request interrupted by user/i.test(text)) return "";
  if (/^#?\s*AGENTS\.md instructions\b/i.test(text)) return "";
  if (/^These AGENTS\.md instructions\b/i.test(text)) return "";
  if (/^\d{4}-\d{2}-\d{2}\s+\S+\/\S+\s+\//.test(text)) return "";
  if (/\btoolu_[A-Za-z0-9]+\b/.test(text) && /\b(completed|failed|stopped)\b/i.test(text)) {
    return "";
  }
  return text;
}

// East Asian scripts pack a word into one or two characters, so weigh each
// like a wide terminal cell. "ok" or a two-character "continue" stays below
// the threshold, while a four-character goal such as a short CJK request
// passes it.
const WIDE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_MEANINGFUL_WEIGHT = 8;

function meaningfulWeight(text) {
  let weight = 0;
  for (const char of text) weight += WIDE_SCRIPT.test(char) ? 2 : 1;
  return weight;
}

function sampleAcross(values, maxSamples) {
  if (values.length <= maxSamples) return values;
  const indexes = Array.from({ length: maxSamples }, (_, index) =>
    Math.round(index * (values.length - 1) / (maxSamples - 1))
  );
  return indexes.map(index => values[index]);
}

function excerpt(value, maxLength) {
  const chars = Array.from(cleanText(value));
  if (chars.length <= maxLength) return chars.join("");
  const headLength = Math.floor(maxLength * 0.7);
  const tailLength = maxLength - headLength - 1;
  return `${chars.slice(0, headLength).join("")}…${chars.slice(-tailLength).join("")}`;
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

function collectSession(row, includeContext) {
  const users = [];
  const assistants = [];
  let lastConversationAtMs = null;

  if (row.rollout_path) {
    for (const line of readRollout(row.rollout_path).split("\n")) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)
        || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
      const payload = event.payload;
      if (event.type !== "response_item" || payload.type !== "message") continue;

      const messageAtMs = Date.parse(event.timestamp);
      const isUser = payload.role === "user";
      const isAssistantResult = payload.role === "assistant"
        && payload.phase !== "commentary";
      if (!isUser && !isAssistantResult) continue;

      const text = isUser
        ? meaningfulUserGoal(messageText(payload))
        : cleanText(messageText(payload));
      if (meaningfulWeight(text) < MIN_MEANINGFUL_WEIGHT) continue;
      if (Number.isFinite(messageAtMs)
        && (lastConversationAtMs === null || messageAtMs > lastConversationAtMs)) {
        lastConversationAtMs = messageAtMs;
      }
      if (includeContext && isUser) users.push(text);
      if (includeContext && isAssistantResult) assistants.push(text);
    }
  }

  if (!includeContext) {
    return { context: "", lastConversationAtMs };
  }

  const parts = [];
  const currentTitle = cleanText(row.title || "");
  if (currentTitle) parts.push(`Current title: ${excerpt(currentTitle, 80)}`);
  const sampledGoals = sampleAcross(users, 4);
  for (const [index, goal] of sampledGoals.entries()) {
    parts.push(`Session goal ${index + 1}/${sampledGoals.length}: ${excerpt(goal, 150)}`);
  }
  if (assistants.length) {
    parts.push(`Latest outcome: ${excerpt(assistants.at(-1), 320)}`);
  }
  return {
    context: parts.join("\n"),
    lastConversationAtMs,
  };
}

function main() {
  const { mode, checkOnly, db, sessionIndex, limit, offset, ids } = readOptions();
  const rootFilter = "COALESCE(thread_source, '') IN ('', 'user')";
  const counts = readSQLite(db, `SELECT COUNT(*) AS total FROM threads WHERE ${rootFilter};`);
  const total = counts[0]?.total;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("SQLite metadata count is invalid");
  const selectedRows = readSQLite(db, `
    SELECT id, rollout_path, substr(title, 1, 81) AS title, length(title) > 40 AS title_too_long, archived,
      COALESCE(created_at_ms, created_at * 1000) AS created_at_ms, recency_at_ms
    FROM threads WHERE ${rootFilter}
      ${ids ? `AND id IN (${ids.map(id => `'${id}'`).join(",")})` : ""}
    ORDER BY recency_at_ms DESC, id DESC
    LIMIT ${ids ? ids.length : limit} OFFSET ${ids ? 0 : offset};
  `);
  if (ids) {
    const byId = new Map(selectedRows.map(row => [row.id, row]));
    if (ids.some(id => !byId.has(id))) throw new Error("fixed batch lookup failed (requested root session unavailable)");
    selectedRows.splice(0, selectedRows.length, ...ids.map(id => byId.get(id)));
  }
  const latestTitles = readLatestTitles(sessionIndex);
  const sessions = selectedRows.map(row => {
    const indexedTitle = latestTitles.get(row.id)?.title;
    const rawTitle = indexedTitle ?? row.title ?? "";
    const rawLength = Array.from(rawTitle).length;
    const tooLong = indexedTitle !== undefined ? rawLength > 40 : Boolean(row.title_too_long);
    const truncated = rawLength > 80;
    const title = truncated ? excerpt(rawTitle, 80) : rawTitle;
    const collected = collectSession({ ...row, title }, !checkOnly);
    const date = formatDate(collected.lastConversationAtMs ?? row.created_at_ms);
    const session = {
      id: row.id,
      date,
      currentTitle: title,
      archived: Boolean(row.archived),
      compliant: !tooLong && compliantTitle(rawTitle, date),
    };
    if (truncated) session.currentTitleTruncated = true;
    if (!checkOnly) session.context = collected.context;
    return session;
  });
  const nextOffset = !ids && offset + sessions.length < total
    ? offset + sessions.length
    : null;
  const noncompliantCount = sessions.filter(session => !session.compliant).length;

  process.stdout.write(JSON.stringify({
    mode,
    checkOnly,
    offset,
    total,
    nextOffset,
    batchCompliant: noncompliantCount === 0,
    noncompliantCount,
    sessions,
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`collector failed: ${error.message}\n`);
  process.exitCode = 1;
}
