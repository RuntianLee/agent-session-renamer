import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_TEMPLATE = "{date}｜{topic}";
export const TOPIC_MIN_LENGTH = 10;
export const TOPIC_MAX_LENGTH = 28;
const MAX_FIXED_LENGTH = 20;
const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
const DATE_TOKEN = /YYYY|YY|MM|M|DD|D/g;

export const PRESETS = [
  { id: "default", template: DEFAULT_TEMPLATE },
  { id: "no-year", template: "{date:MM-DD}｜{topic}" },
  { id: "date-last", template: "{topic}｜{date}" },
  { id: "dotted", template: "{date:YYYY.MM.DD} {topic}" },
];

export function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "codex-session-renamer", "config.json");
}

const length = value => Array.from(value).length;

// Grammar: literal text plus exactly one `{topic}` and at most one
// `{date}` / `{date:FORMAT}`, where FORMAT uses YYYY, YY, MM, M, DD, and D.
export function parseTemplate(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("template failed: empty template");
  if (/[\u0000-\u001f\u007f]/.test(source)) throw new Error("template failed: control characters are not allowed");
  const parts = [];
  let topics = 0;
  let dates = 0;
  let rest = source;
  while (rest) {
    const open = rest.indexOf("{");
    const literal = open === -1 ? rest : rest.slice(0, open);
    if (literal.includes("}")) throw new Error("template failed: unmatched }");
    if (literal) parts.push({ type: "literal", text: literal });
    if (open === -1) break;
    const close = rest.indexOf("}", open);
    if (close === -1) throw new Error("template failed: unmatched {");
    const token = rest.slice(open + 1, close);
    if (token === "topic") {
      topics += 1;
      parts.push({ type: "topic" });
    } else if (token === "date" || token.startsWith("date:")) {
      const format = token === "date" ? DEFAULT_DATE_FORMAT : token.slice(5);
      if (!format.match(DATE_TOKEN) || format.includes("{")) {
        throw new Error("template failed: date format needs YYYY, YY, MM, M, DD, or D");
      }
      dates += 1;
      parts.push({ type: "date", format });
    } else {
      throw new Error(`template failed: unknown placeholder {${token}}`);
    }
    rest = rest.slice(close + 1);
  }
  if (topics !== 1) throw new Error("template failed: exactly one {topic} is required");
  if (dates > 1) throw new Error("template failed: at most one {date} is allowed");
  const template = { source, parts };
  // The widest rendering of every date token: two-digit month and day.
  const widest = frame(template, Date.UTC(2026, 11, 31, 12));
  if (length(widest.prefix) + length(widest.suffix) > MAX_FIXED_LENGTH) {
    throw new Error(`template failed: text around {topic} exceeds ${MAX_FIXED_LENGTH} characters`);
  }
  return template;
}

const formatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Calendar parts in the system's current local time zone.
function dateParts(milliseconds) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(milliseconds))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function formatIsoDate(milliseconds) {
  const { year, month, day } = dateParts(milliseconds);
  return `${year}-${month}-${day}`;
}

function formatDate(format, milliseconds) {
  const { year, month, day } = dateParts(milliseconds);
  const values = {
    YYYY: year,
    YY: year.slice(-2),
    MM: month,
    M: String(Number(month)),
    DD: day,
    D: String(Number(day)),
  };
  return format.replace(DATE_TOKEN, token => values[token]);
}

// The fixed text a title must carry on each side of its topic.
export function frame(template, milliseconds) {
  const rendered = { prefix: "", suffix: "" };
  let side = "prefix";
  for (const part of template.parts) {
    if (part.type === "topic") side = "suffix";
    else rendered[side] += part.type === "date" ? formatDate(part.format, milliseconds) : part.text;
  }
  return rendered;
}

export function compliantTitle(title, { prefix, suffix }) {
  if (!title.startsWith(prefix) || !title.endsWith(suffix)) return false;
  const topicLength = length(title) - length(prefix) - length(suffix);
  return topicLength >= TOPIC_MIN_LENGTH && topicLength <= TOPIC_MAX_LENGTH;
}

export function readConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { configured: false, template: DEFAULT_TEMPLATE };
    throw new Error(`config read failed (${error.code || "read error"})`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("config read failed (invalid JSON)");
  }
  if (!config || typeof config !== "object" || typeof config.template !== "string") {
    throw new Error("config read failed (missing template)");
  }
  parseTemplate(config.template);
  return { configured: true, template: config.template };
}

export function writeConfig(path, template) {
  parseTemplate(template);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, template }, null, 2)}\n`);
  renameSync(temporary, path);
}

// An explicit template wins over the saved one, which wins over the default.
export function resolveTemplate({ template, config }) {
  if (template !== undefined) return { source: "argument", template: parseTemplate(template) };
  const saved = readConfig(config);
  return {
    source: saved.configured ? "config" : "default",
    template: parseTemplate(saved.template),
  };
}
