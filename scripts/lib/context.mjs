import { readFileSync } from "node:fs";

// Returns null for a missing file so callers can choose their own fallback.
export function readIfPresent(path, step, encoding) {
  try {
    return readFileSync(path, encoding);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${step} failed (${error.code || "read error"})`);
  }
}

export function parseJsonLines(text, visit) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && typeof record === "object" && !Array.isArray(record)) visit(record);
  }
}

export function cleanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<skill>[\s\S]*?<\/skill>/gi, " ")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, " ")
    // Claude Code injects reminders and a fixed caveat around slash commands;
    // the command and its output stay because they may be the whole session.
    .replace(/<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\$?[^\]]+\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function meaningfulUserGoal(value) {
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

export function meaningful(text) {
  let weight = 0;
  for (const char of text) {
    weight += WIDE_SCRIPT.test(char) ? 2 : 1;
    if (weight >= MIN_MEANINGFUL_WEIGHT) return true;
  }
  return false;
}

function sampleAcross(values, maxSamples) {
  if (values.length <= maxSamples) return values;
  const indexes = Array.from({ length: maxSamples }, (_, index) =>
    Math.round(index * (values.length - 1) / (maxSamples - 1))
  );
  return indexes.map(index => values[index]);
}

export function excerpt(value, maxLength) {
  const chars = Array.from(cleanText(value));
  if (chars.length <= maxLength) return chars.join("");
  const headLength = Math.floor(maxLength * 0.7);
  const tailLength = maxLength - headLength - 1;
  return `${chars.slice(0, headLength).join("")}…${chars.slice(-tailLength).join("")}`;
}

// Accumulates the meaningful turns of one session in conversation order.
export class Conversation {
  constructor(includeContext) {
    this.includeContext = includeContext;
    this.users = [];
    this.assistants = [];
    this.lastConversationAtMs = null;
  }

  add(role, text, timestamp) {
    if (!meaningful(text)) return;
    const messageAtMs = Date.parse(timestamp);
    if (Number.isFinite(messageAtMs)
      && (this.lastConversationAtMs === null || messageAtMs > this.lastConversationAtMs)) {
      this.lastConversationAtMs = messageAtMs;
    }
    if (this.includeContext) (role === "user" ? this.users : this.assistants).push(text);
  }

  context(title) {
    const parts = [];
    const currentTitle = cleanText(title || "");
    if (currentTitle) parts.push(`Current title: ${excerpt(currentTitle, 80)}`);
    const sampledGoals = sampleAcross(this.users, 4);
    for (const [index, goal] of sampledGoals.entries()) {
      parts.push(`Session goal ${index + 1}/${sampledGoals.length}: ${excerpt(goal, 150)}`);
    }
    if (this.assistants.length) {
      parts.push(`Latest outcome: ${excerpt(this.assistants.at(-1), 320)}`);
    }
    return parts.join("\n");
  }
}
