#!/usr/bin/env node

import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { cliTranscriptPath, defaultClaudeDir, defaultDesktopDir } from "./lib/claude-source.mjs";

// Retitles a Claude Code terminal session the way the Agent SDK's
// renameSession() does: by appending a custom-title record to its transcript.
function main() {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        id: { type: "string" },
        title: { type: "string" },
        "claude-dir": { type: "string", default: defaultClaudeDir() },
        "desktop-dir": { type: "string", default: defaultDesktopDir() },
      },
    }));
  } catch (error) {
    throw new Error(`arguments failed (${error.code || "parse error"})`);
  }
  const { id, title } = values;
  if (typeof id !== "string" || typeof title !== "string") throw new Error("arguments failed: --id and --title are required");
  if (!title.trim() || /[\u0000-\u001f\u007f]/.test(title) || Array.from(title).length > 200) {
    throw new Error("arguments failed: --title must be 1-200 characters without control characters");
  }
  const path = cliTranscriptPath({ id, claudeDir: values["claude-dir"], desktopDir: values["desktop-dir"] });

  // Start on a fresh line even if the last record lacks its newline.
  let separator = "";
  const { size } = statSync(path);
  if (size > 0) {
    const last = Buffer.alloc(1);
    const descriptor = openSync(path, "r");
    try {
      readSync(descriptor, last, 0, 1, size - 1);
    } finally {
      closeSync(descriptor);
    }
    if (last[0] !== 0x0a) separator = "\n";
  }
  appendFileSync(path, `${separator}${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: id })}\n`);
  process.stdout.write(JSON.stringify({ id, title, renamed: true }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`claude-cli-rename failed: ${error.message}\n`);
  process.exitCode = 1;
}
