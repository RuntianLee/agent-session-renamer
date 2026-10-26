#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { claudeSessions, defaultClaudeDir, defaultDesktopDir } from "./lib/claude-source.mjs";
import { codexSessions } from "./lib/codex-source.mjs";
import { excerpt } from "./lib/context.mjs";
import {
  compliantTitle,
  defaultConfigPath,
  formatIsoDate,
  frame,
  resolveTemplate,
} from "./lib/title-template.mjs";

const PLATFORMS = ["codex", "claude-desktop", "claude-cli"];

function readOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: "string", default: "all" },
        platform: { type: "string", default: "codex" },
        "check-only": { type: "boolean", default: false },
        db: { type: "string", default: join(homedir(), ".codex", "state_5.sqlite") },
        "session-index": { type: "string", default: join(homedir(), ".codex", "session_index.jsonl") },
        limit: { type: "string" },
        offset: { type: "string" },
        ids: { type: "string" },
        template: { type: "string" },
        config: { type: "string", default: defaultConfigPath() },
        "claude-dir": { type: "string", default: defaultClaudeDir() },
        "desktop-dir": { type: "string", default: defaultDesktopDir() },
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
  if (!PLATFORMS.includes(values.platform)) {
    throw new Error(`arguments failed: --platform must be one of ${PLATFORMS.join(", ")}`);
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
    platform: values.platform,
    claudeDir: values["claude-dir"],
    desktopDir: values["desktop-dir"],
    checkOnly: values["check-only"],
    db: values.db,
    sessionIndex: values["session-index"],
    template: values.template,
    config: values.config,
    limit: integer(values.limit ?? "20", "limit", 1, 20),
    offset: ids ? null : integer(values.offset ?? "0", "offset", 0, Number.MAX_SAFE_INTEGER),
    ids,
  };
}

function main() {
  const { mode, platform, checkOnly, template: explicitTemplate, config, ...selection } = readOptions();
  const { source: templateSource, template } = resolveTemplate({ template: explicitTemplate, config });
  const options = { ...selection, platform, includeContext: !checkOnly };
  const { total, sessions: found } = platform === "codex" ? codexSessions(options) : claudeSessions(options);
  const { ids, offset } = selection;
  if (ids) {
    const byId = new Map(found.map(session => [session.id, session]));
    if (ids.some(id => !byId.has(id))) throw new Error("fixed batch lookup failed (requested root session unavailable)");
    found.splice(0, found.length, ...ids.map(id => byId.get(id)));
  }
  const sessions = found.map(item => {
    const rawTitle = item.title;
    const truncated = Array.from(rawTitle).length > 80;
    const title = truncated ? excerpt(rawTitle, 80) : rawTitle;
    const conversation = item.conversation();
    const dateMs = conversation.lastConversationAtMs ?? item.createdAtMs;
    const { prefix, suffix } = frame(template, dateMs);
    const session = {
      id: item.id,
      date: formatIsoDate(dateMs),
      titlePrefix: prefix,
      titleSuffix: suffix,
      currentTitle: title,
      archived: item.archived,
      compliant: compliantTitle(rawTitle, { prefix, suffix }),
    };
    if (truncated) session.currentTitleTruncated = true;
    if (!checkOnly) session.context = conversation.context(title);
    return session;
  });
  const nextOffset = !ids && offset + sessions.length < total
    ? offset + sessions.length
    : null;
  const noncompliantCount = sessions.filter(session => !session.compliant).length;

  process.stdout.write(JSON.stringify({
    mode,
    platform,
    checkOnly,
    template: template.source,
    templateSource,
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
