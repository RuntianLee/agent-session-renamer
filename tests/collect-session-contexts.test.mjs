import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";

const skillDir = new URL("..", import.meta.url).pathname;
const script = join(skillDir, "scripts", "collect-session-contexts.mjs");
const skillFile = join(skillDir, "SKILL.md");
const agentMetadata = join(skillDir, "agents", "openai.yaml");
const templateScript = join(skillDir, "scripts", "title-template.mjs");
const templateModule = join(skillDir, "scripts", "lib", "title-template.mjs");

// Keep a saved template on this machine from changing test results.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "codex-session-renamer-config-"));

function createDb(db, rows) {
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_at_ms INTEGER,
      recency_at_ms INTEGER NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL,
      thread_source TEXT
    );
    ${rows.join("\n")}`,
  ]);
}

function message(role, text, { timestamp, phase } = {}) {
  const event = {
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{
        type: role === "user" ? "input_text" : "output_text",
        text,
      }],
    },
  };
  if (timestamp) event.timestamp = timestamp;
  if (phase) event.payload.phase = phase;
  return JSON.stringify(event);
}

test("pending mode is unavailable", () => {
  fixture(({ invoke }) => {
    assert.throws(() => invoke(["--mode", "pending"]), error => {
      assert.match(error.stderr, /Unsupported mode: pending/);
      return true;
    });
  });
});

test("latest session index title overrides stale SQLite metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-renamer-"));
  const db = join(dir, "state.sqlite");
  const rollout = join(dir, "session.jsonl");
  const sessionIndex = join(dir, "session_index.jsonl");

  try {
    writeFileSync(rollout, message("user", "A meaningful session request", {
      timestamp: "2026-01-02T08:00:00Z",
    }));
    writeFileSync(sessionIndex, [
      JSON.stringify({
        id: "session",
        thread_name: "Earlier renamed title",
        updated_at: "2026-01-02T09:00:00Z",
      }),
      JSON.stringify({
        id: "session",
        thread_name: "2026-01-02｜Canonical session title",
        updated_at: "2026-01-02T10:00:00Z",
      }),
    ].join("\n"));
    createDb(db, [
      `INSERT INTO threads VALUES ('session','${rollout.replaceAll("'", "''")}',1,1000,1,'Raw first-message title',0,'user');`,
    ]);

    const result = JSON.parse(execFileSync("node", [
      script, "--db", db, "--session-index", sessionIndex,
      "--check-only", "--limit", "10",
    ], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } }));

    assert.equal(
      result.sessions[0].currentTitle,
      "2026-01-02｜Canonical session title",
    );
    assert.equal(result.sessions[0].compliant, true);
    assert.equal(result.batchCompliant, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default invocation includes dated and archived roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-renamer-"));
  const db = join(dir, "state.sqlite");
  const mainRollout = join(dir, "main.jsonl");

  try {
    writeFileSync(mainRollout, [
      message("user", "The first message is not the conversation's core topic"),
      message("assistant", "Starting work", { phase: "commentary" }),
      message("user", "Intermediate requirement: preserve compatibility"),
      message("user", "Final core goal: implement full session renaming"),
      message("assistant", "Final result: kept only manual full mode and verified every session."),
      message("assistant", "Later progress must not replace the outcome", { phase: "commentary" }),
    ].join("\n"));
    createDb(db, [
      "INSERT INTO threads VALUES ('dated','',1004,1004000,1004,'2026-07-24｜Existing title',0,'user');",
      "INSERT INTO threads VALUES ('archived','',1003,1003000,1003,'Archived root session',1,'user');",
      `INSERT INTO threads VALUES ('main','${mainRollout.replaceAll("'", "''")}',1002,1002000,1002,'First-message title',0,NULL);`,
      "INSERT INTO threads VALUES ('subagent','',1001,1001000,1001,'Subagent task',0,'subagent');",
    ]);

    const output = execFileSync("node", [
      script, "--db", db, "--session-index", join(dir, "missing-index.jsonl"),
      "--limit", "10",
    ], { encoding: "utf8" });
    const result = JSON.parse(output);

    assert.equal(result.mode, "all");
    assert.deepEqual(
      result.sessions.map(({ id }) => id),
      ["dated", "archived", "main"],
    );
    const main = result.sessions.find(({ id }) => id === "main");
    assert.match(main.context, /first message is not the conversation's core topic/i);
    assert.match(main.context, /Intermediate requirement: preserve compatibility/);
    assert.match(main.context, /Final core goal: implement full session renaming/);
    assert.match(main.context, /Final result: kept only manual full mode/);
    assert.doesNotMatch(main.context, /Later progress must not replace the outcome/);
    assert.match(main.context, /Current title:/);
    assert.match(main.context, /Session goal 1\/3:/);
    assert.match(main.context, /Latest outcome:/);
    assert.equal(result.nextOffset, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("last meaningful conversation dates use the system time zone", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-renamer-"));
  const db = join(dir, "state.sqlite");
  const createdAt = Date.parse("2026-01-01T00:30:00Z");
  const legacyRollout = join(dir, "legacy.jsonl");
  const currentRollout = join(dir, "current.jsonl");

  try {
    writeFileSync(legacyRollout, [
      message("user", "Start the legacy conversation", {
        timestamp: "2026-01-01T23:30:00Z",
      }),
      message("assistant", "Finish the legacy conversation", {
        timestamp: "2026-01-02T15:30:00Z",
      }),
      message("assistant", "Progress should not change the date", {
        timestamp: "2026-01-03T16:00:00Z",
        phase: "commentary",
      }),
    ].join("\n"));
    writeFileSync(currentRollout, [
      message("user", "Start the current conversation", {
        timestamp: "2026-01-02T15:30:00Z",
      }),
      message("assistant", "Finish the current conversation", {
        timestamp: "2026-01-03T15:30:00Z",
        phase: "final_answer",
      }),
      message("user", "OK", {
        timestamp: "2026-01-04T15:30:00Z",
      }),
      message("assistant", "Later progress should not change the date", {
        timestamp: "2026-01-05T15:30:00Z",
        phase: "commentary",
      }),
    ].join("\n"));
    createDb(db, [
      `INSERT INTO threads VALUES ('current','${currentRollout.replaceAll("'", "''")}',${Math.floor(createdAt / 1000)},${createdAt},3,'Current session',0,'user');`,
      `INSERT INTO threads VALUES ('legacy','${legacyRollout.replaceAll("'", "''")}',${Math.floor(createdAt / 1000)},${createdAt},2,'Legacy session',0,'user');`,
      `INSERT INTO threads VALUES ('fallback','',${Math.floor(createdAt / 1000)},${createdAt},1,'Fallback session',0,'user');`,
    ]);

    const output = execFileSync("node", [
      script, "--db", db, "--session-index", join(dir, "missing-index.jsonl"),
      "--limit", "10",
    ], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Tokyo" },
    });
    const result = JSON.parse(output);
    const checkOnly = JSON.parse(execFileSync("node", [
      script, "--db", db, "--session-index", join(dir, "missing-index.jsonl"),
      "--check-only", "--limit", "10",
    ], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Tokyo" },
    }));

    assert.equal(
      result.sessions.find(({ id }) => id === "current").date,
      "2026-01-04",
    );
    assert.equal(
      result.sessions.find(({ id }) => id === "legacy").date,
      "2026-01-03",
    );
    assert.equal(
      result.sessions.find(({ id }) => id === "fallback").date,
      "2026-01-01",
    );
    assert.deepEqual(
      checkOnly.sessions.map(({ id, date }) => ({ id, date })),
      result.sessions.map(({ id, date }) => ({ id, date })),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long sessions are sampled across the full goal arc", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-renamer-"));
  const db = join(dir, "state.sqlite");
  const rollout = join(dir, "long.jsonl");

  try {
    writeFileSync(rollout, Array.from({ length: 8 }, (_, index) =>
      message("user", `Meaningful goal ${index + 1}: project theme evidence`)
    ).join("\n"));
    createDb(db, [
      `INSERT INTO threads VALUES ('long','${rollout.replaceAll("'", "''")}',1000,1000000,1,'Long session',0,'user');`,
    ]);

    const output = execFileSync("node", [
      script, "--db", db, "--session-index", join(dir, "missing-index.jsonl"),
      "--limit", "10",
    ], { encoding: "utf8" });
    const context = JSON.parse(output).sessions[0].context;

    assert.match(context, /Meaningful goal 1:/);
    assert.match(context, /Meaningful goal 3:/);
    assert.match(context, /Meaningful goal 6:/);
    assert.match(context, /Meaningful goal 8:/);
    assert.equal((context.match(/Session goal/g) || []).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill documents only the manual incremental workflow", () => {
  const skill = readFileSync(skillFile, "utf8");

  assert.match(skill, /## Manual Incremental Workflow/);
  assert.doesNotMatch(skill, /## Default Workflow/);
  assert.doesNotMatch(skill, /--mode pending/);
  assert.doesNotMatch(skill, /scheduled automation/);
});

test("skill documents token-efficient model selection without overstating control", () => {
  const skill = readFileSync(skillFile, "utf8");

  assert.match(skill, /## Token Efficiency/);
  assert.match(
    skill,
    /When model selection is available, prefer a token-efficient model/,
  );
  assert.match(
    skill,
    /When model selection is unavailable, continue with the active Codex model/,
  );
});

test("skill uses the last meaningful conversation date for title prefixes", () => {
  const skill = readFileSync(skillFile, "utf8");

  assert.match(skill, /last meaningful conversation date/i);
  assert.match(skill, /system's current local time zone/);
  assert.doesNotMatch(skill, /with its creation date/);
  assert.doesNotMatch(skill, /Format the creation date/);
});

test("language selection is explicit and production skill content is English", () => {
  const skill = readFileSync(skillFile, "utf8");
  const productionContent = [
    skill,
    readFileSync(script, "utf8"),
    readFileSync(templateScript, "utf8"),
    readFileSync(templateModule, "utf8"),
    readFileSync(agentMetadata, "utf8"),
  ].join("\n");

  assert.match(skill, /Optional language: `language=<language>`/);
  assert.match(
    skill,
    /When omitted, choose each title's language from that session's dominant user-conversation language\./,
  );
  assert.match(
    skill,
    /An explicit language applies to both titles and the final report\./,
  );
  assert.match(
    skill,
    /otherwise in the invoking conversation's language\./,
  );
  assert.doesNotMatch(productionContent, /[\u3400-\u9fff]/);
});

function fixture(callback, rows = []) {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-renamer-regression-"));
  const db = join(dir, "state.sqlite");
  const sessionIndex = join(dir, "index.jsonl");
  const invoke = (args = []) => execFileSync("node", [
    script, "--db", db, "--session-index", sessionIndex, ...args,
  ], { encoding: "utf8", stdio: "pipe", env: { ...process.env, TZ: "UTC" } });
  try {
    createDb(db, rows);
    callback({ dir, db, sessionIndex, invoke });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("strict CLI rejects unknown, incomplete and noninteger batch arguments", () => {
  fixture(({ invoke }) => {
    for (const args of [
      ["--unknown"], ["--limit"], ["--offset"], ["--limit", "2junk"],
      ["--limit", "0"], ["--limit", "21"], ["--limit", "1.5"],
      ["--offset", "-1"], ["--offset", "1x"], ["--offset", "9007199254740992"],
    ]) assert.throws(() => invoke(args));
  });
});

test("SQLite reads only the requested metadata page and leaves missing databases absent", () => {
  fixture(({ db, dir, sessionIndex, invoke }) => {
    execFileSync("sqlite3", [db, `
      WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < 1100)
      INSERT INTO threads SELECT printf('session-%04d',n),'',1,1000,n,hex(zeroblob(1000)),0,'user' FROM sequence;
    `]);
    const result = JSON.parse(invoke(["--check-only", "--limit", "2", "--offset", "10"]));
    assert.equal(result.total, 1100);
    assert.deepEqual(result.sessions.map(({ id }) => id), ["session-1090", "session-1089"]);
    assert.equal(result.nextOffset, 12);
    const missing = join(dir, "missing.sqlite");
    assert.throws(() => execFileSync("node", [script, "--db", missing, "--session-index", sessionIndex],
      { encoding: "utf8", stdio: "pipe" }), error => {
      assert.match(error.stderr, /SQLite metadata/);
      assert.doesNotMatch(error.stderr, /execFileSync|stderr:|stdout:|at /);
      return true;
    });
    assert.equal(existsSync(missing), false);
    execFileSync("sqlite3", [db, "UPDATE threads SET title='Anonymous large title '||hex(zeroblob(35000));"]);
    const compactOutput = invoke(["--check-only"]);
    const compact = JSON.parse(compactOutput);
    assert.equal(compact.sessions.length, 20);
    assert.ok(compact.sessions.every(session => session.compliant === false
      && Array.from(session.currentTitle).length <= 80 && session.currentTitleTruncated === true));
    assert.ok(compactOutput.length < 10000);
  });
});

test("rollout primitives and malformed content are safely ignored while legacy text is collected", () => {
  fixture(({ db, dir, invoke }) => {
    const rollout = join(dir, "anonymous.jsonl");
    writeFileSync(rollout, [
      "null", "42", '"primitive"', "[]", "{", JSON.stringify({ type: "response_item", payload: null }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: { text: "Ignore object" } } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [null, 3, "unknown", { text: 8 }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-01-02T10:00:00Z",
        payload: { type: "message", role: "user", content: "Legacy anonymous request survives" } }),
      message("assistant", "The anonymous fixture completed safely", { timestamp: "2026-01-03T10:00:00Z" }),
    ].join("\n"));
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${rollout}',1,1000,1,'Anonymous title',0,'user');`]);
    const result = JSON.parse(invoke());
    assert.match(result.sessions[0].context, /Legacy anonymous request survives/);
    assert.doesNotMatch(result.sessions[0].context, /Ignore object/);
    assert.equal(result.sessions[0].date, "2026-01-03");
  });
});

test("invalid rollout and session-index paths fail clearly instead of pretending to collect", () => {
  fixture(({ db, dir, sessionIndex, invoke }) => {
    const rollout = join(dir, "rollout-directory");
    mkdirSync(rollout);
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${rollout}',1,1000,1,'Anonymous secret sentinel',0,'user');`]);
    assert.throws(() => invoke(), error => {
      assert.match(error.stderr, /rollout read/);
      assert.doesNotMatch(error.stderr, /Anonymous secret sentinel|at collectSession/);
      return true;
    });
    execFileSync("sqlite3", [db, `UPDATE threads SET rollout_path='${join(dir, "missing-rollout.jsonl")}';`]);
    const missingContext = JSON.parse(invoke());
    const missingCheck = JSON.parse(invoke(["--check-only"]));
    assert.equal(missingContext.sessions[0].date, "1970-01-01");
    assert.equal(missingCheck.sessions[0].date, missingContext.sessions[0].date);
    mkdirSync(sessionIndex);
    assert.throws(() => invoke(), error => {
      assert.match(error.stderr, /session index read/);
      return true;
    });
  });
});

function sqlString(value) {
  return value.replaceAll("'", "''");
}

function writeZstd(path, text) {
  if (typeof zlib.zstdCompressSync === "function") {
    writeFileSync(path, zlib.zstdCompressSync(Buffer.from(text)));
  } else {
    execFileSync("zstd", ["-qfo", path], { input: text });
  }
}

test("compressed rollouts are read when the recorded path was replaced by .zst", () => {
  fixture(({ db, dir, sessionIndex, invoke }) => {
    const rollout = join(dir, "compressed.jsonl");
    writeZstd(`${rollout}.zst`, [
      message("user", "Compressed session request survives", { timestamp: "2026-01-02T10:00:00Z" }),
      message("assistant", "Compressed outcome was collected", { timestamp: "2026-01-04T10:00:00Z" }),
    ].join("\n"));
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${sqlString(rollout)}',1,1000,1,'Compressed title',0,'user');`]);

    const context = JSON.parse(invoke());
    assert.match(context.sessions[0].context, /Compressed session request survives/);
    assert.match(context.sessions[0].context, /Compressed outcome was collected/);
    assert.equal(context.sessions[0].date, "2026-01-04");
    assert.equal(JSON.parse(invoke(["--check-only"])).sessions[0].date, "2026-01-04");

    // Older Node releases fall back to the zstd CLI.
    const withoutZlibZstd = `data:text/javascript,${encodeURIComponent(
      'import zlib from "node:zlib"; delete zlib.zstdDecompressSync;',
    )}`;
    const cli = JSON.parse(execFileSync("node", [
      "--import", withoutZlibZstd, script, "--db", db, "--session-index", sessionIndex,
    ], { encoding: "utf8", stdio: "pipe", env: { ...process.env, TZ: "UTC" } }));
    assert.deepEqual(cli.sessions, context.sessions);

    execFileSync("sqlite3", [db, `UPDATE threads SET rollout_path='${sqlString(`${rollout}.zst`)}';`]);
    assert.equal(JSON.parse(invoke()).sessions[0].date, "2026-01-04");
  });
});

test("an uncompressed rollout wins over .zst and corrupt archives fail clearly", () => {
  fixture(({ db, dir, invoke }) => {
    const rollout = join(dir, "both.jsonl");
    writeFileSync(rollout, message("user", "Live rollout request is preferred", { timestamp: "2026-01-05T10:00:00Z" }));
    writeZstd(`${rollout}.zst`, message("user", "Stale compressed request", { timestamp: "2026-01-02T10:00:00Z" }));
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${sqlString(rollout)}',1,1000,1,'Anonymous secret sentinel',0,'user');`]);
    const result = JSON.parse(invoke());
    assert.match(result.sessions[0].context, /Live rollout request is preferred/);
    assert.doesNotMatch(result.sessions[0].context, /Stale compressed request/);
    assert.equal(result.sessions[0].date, "2026-01-05");

    rmSync(rollout);
    writeFileSync(`${rollout}.zst`, "not a zstd frame");
    assert.throws(() => invoke(), error => {
      assert.match(error.stderr, /rollout read failed/);
      assert.doesNotMatch(error.stderr, /Anonymous secret sentinel|at decompressZstd/);
      return true;
    });
  });
});

test("index title selection uses updated_at then physical order with legacy-only fallback", () => {
  fixture(({ db, sessionIndex, invoke }) => {
    execFileSync("sqlite3", [db, `
      INSERT INTO threads VALUES ('dated','',1,1000,9999999999999,'SQLite stale',0,'user');
      INSERT INTO threads VALUES ('legacy','',1,1000,1,'SQLite legacy',0,'user');
    `]);
    writeFileSync(sessionIndex, [
      { id: "dated", thread_name: "Newest dated title", updated_at: "2026-01-03T10:00:00Z" },
      { id: "dated", thread_name: "Older dated title physically later", updated_at: "2026-01-02T10:00:00Z" },
      { id: "dated", thread_name: "Equal timestamp later title", updated_at: "2026-01-03T10:00:00Z" },
      { id: "dated", thread_name: "Legacy must not override dated" },
      { id: "dated", thread_name: "Invalid timestamp must not override", updated_at: "invalid" },
      { id: "legacy", thread_name: "Earlier legacy title" },
      { id: "legacy", thread_name: "Last legacy title" },
      { id: "legacy", thread_name: "Malformed date is not legacy", updated_at: "invalid" },
    ].map(JSON.stringify).join("\n"));
    const result = JSON.parse(invoke(["--check-only"]));
    assert.equal(result.sessions[0].currentTitle, "Equal timestamp later title");
    assert.equal(result.sessions[1].currentTitle, "Last legacy title");
  });
});

test("long index titles remain noncompliant and compact without altering valid titles", () => {
  fixture(({ sessionIndex, invoke }) => {
    const canonical = "1970-01-01｜Canonical regression title";
    writeFileSync(sessionIndex, [
      { id: "valid", thread_name: canonical },
      { id: "long", thread_name: "1970-01-01｜Long anonymous topic" + "<skill>" + "A".repeat(70000) + "</skill>" },
    ].map(JSON.stringify).join("\n"));
    const output = invoke(["--check-only"]);
    const result = JSON.parse(output);
    const valid = result.sessions.find(session => session.id === "valid");
    const long = result.sessions.find(session => session.id === "long");
    assert.equal(valid.currentTitle, canonical);
    assert.equal(valid.compliant, true);
    assert.equal(valid.currentTitleTruncated, undefined);
    assert.equal(long.compliant, false);
    assert.equal(long.currentTitleTruncated, true);
    assert.ok(Array.from(long.currentTitle).length <= 80);
    assert.ok(output.length < 1000);
  }, [
    "INSERT INTO threads VALUES ('valid','',1,1000,2,'Old anonymous title',0,'user');",
    "INSERT INTO threads VALUES ('long','',1,1000,1,'Another old title',0,'user');",
  ]);
});

test("fixed IDs retain request order and reject invalid, duplicate or unavailable roots", () => {
  fixture(({ invoke }) => {
    const result = JSON.parse(invoke(["--ids", "older,newer", "--check-only"]));
    assert.deepEqual(result.sessions.map(({ id }) => id), ["older", "newer"]);
    assert.equal(result.nextOffset, null);
    for (const args of [
      ["--ids", "older,older"], ["--ids", "older,missing"], ["--ids", "subagent"],
      ["--ids", "older,newer", "--offset", "0"], ["--ids", "older", "--limit", "1"],
      ["--ids", "older,'"], ["--ids", ""], ["--ids", Array.from({ length: 21 }, (_, i) => `id-${i}`).join(",")],
    ]) assert.throws(() => invoke(args));
  }, [
    "INSERT INTO threads VALUES ('newer','',1,1000,3,'Newer anonymous',0,'user');",
    "INSERT INTO threads VALUES ('older','',1,1000,2,'Older anonymous',0,'user');",
    "INSERT INTO threads VALUES ('subagent','',1,1000,1,'Excluded anonymous',0,'subagent');",
  ]);
});

test("generic client request wrappers expose the actual user goal", () => {
  fixture(({ db, dir, invoke }) => {
    const rollout = join(dir, "wrapper.jsonl");
    writeFileSync(rollout, [
      message("user", "# AGENTS.md instructions\nAnonymous wrapper context\n## My request:\nImplement the anonymous parser regression"),
      message("user", "Anonymous context before request\nMy request:\nVerify the anonymous fixed batch safely"),
    ].join("\n"));
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${rollout}',1,1000,1,'Anonymous wrapper',0,'user');`]);
    const context = JSON.parse(invoke()).sessions[0].context;
    assert.match(context, /Implement the anonymous parser regression/);
    assert.match(context, /Verify the anonymous fixed batch safely/);
    assert.doesNotMatch(context, /Anonymous wrapper context|Anonymous context before request/);
  });
});

test("short CJK goals count by character width while filler stays filtered", () => {
  fixture(({ db, dir, invoke }) => {
    const rollout = join(dir, "short-cjk.jsonl");
    writeFileSync(rollout, [
      message("user", "阿比西尼亚猫", { timestamp: "2026-01-02T10:00:00Z" }),
      message("user", "备选方案", { timestamp: "2026-01-03T10:00:00Z" }),
      message("user", "继续", { timestamp: "2026-01-04T10:00:00Z" }),
      message("user", "ok", { timestamp: "2026-01-05T10:00:00Z" }),
      message("assistant", "好的", { timestamp: "2026-01-06T10:00:00Z" }),
    ].join("\n"));
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${rollout.replaceAll("'", "''")}',1,1000,1,'Short goals',0,'user');`]);
    const session = JSON.parse(invoke()).sessions[0];
    assert.match(session.context, /Session goal 1\/2: 阿比西尼亚猫/);
    assert.match(session.context, /Session goal 2\/2: 备选方案/);
    assert.doesNotMatch(session.context, /继续|Session goal \d\/\d: ok|好的/);
    assert.equal(session.date, "2026-01-03");
  });
});

function runTemplate(args) {
  return JSON.parse(execFileSync("node", [templateScript, ...args], {
    encoding: "utf8", stdio: "pipe", env: { ...process.env, TZ: "UTC" },
  }));
}

test("templates reject malformed placeholders and oversized fixed text", () => {
  const config = join(mkdtempSync(join(tmpdir(), "codex-session-renamer-template-")), "config.json");
  for (const template of [
    "", "{date}", "{topic} {topic}", "{date} {date} {topic}", "{title} {topic}", "{date:XX} {topic}",
    "{date {topic}", "date} {topic}", "{date}\n{topic}", `${"x".repeat(21)}{topic}`,
  ]) {
    assert.throws(() => runTemplate(["preview", "--template", template, "--config", config]), error => {
      assert.match(error.stderr, /title-template failed: template failed/);
      return true;
    }, template);
  }
  assert.throws(() => runTemplate(["save", "--template", "{date}", "--config", config]));
  assert.equal(existsSync(config), false);
});

test("template helper shows presets, previews, and saves an atomic config", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-session-renamer-template-"));
  const config = join(dir, "nested", "config.json");
  try {
    const shown = runTemplate(["show", "--config", config]);
    assert.equal(shown.configured, false);
    assert.equal(shown.active.template, "{date}｜{topic}");
    assert.match(shown.active.example, /^\d{4}-\d{2}-\d{2}｜<topic>$/);
    assert.deepEqual(shown.presets.map(({ id }) => id), ["default", "no-year", "date-last", "dotted"]);
    assert.match(shown.presets[1].example, /^\d{2}-\d{2}｜<topic>$/);

    const preview = runTemplate(["preview", "--template", "{topic}（{date:M/D}）", "--config", config]);
    assert.match(preview.preview.example, /^<topic>（\d{1,2}\/\d{1,2}）$/);
    assert.equal(preview.configured, false);

    const saved = runTemplate(["save", "--template", "{date:MM-DD}｜{topic}", "--config", config]);
    assert.equal(saved.configured, true);
    assert.equal(saved.active.template, "{date:MM-DD}｜{topic}");
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { version: 1, template: "{date:MM-DD}｜{topic}" });

    for (const args of [["show", "--template", "{topic}"], ["preview"], ["save"], ["reset"], ["show", "extra"]]) {
      assert.throws(() => runTemplate([...args, "--config", config]), args.join(" "));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collector checks titles against the saved or explicit template", () => {
  fixture(({ db, dir, sessionIndex, invoke }) => {
    const rollout = join(dir, "template.jsonl");
    writeFileSync(rollout, message("user", "A meaningful template request", { timestamp: "2026-01-02T10:00:00Z" }));
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('session','${rollout.replaceAll("'", "''")}',1,1000,1,'unused',0,'user');`]);
    const config = join(dir, "config.json");
    const setTitle = title => writeFileSync(sessionIndex, JSON.stringify({ id: "session", thread_name: title }));
    const check = (...args) => JSON.parse(invoke(["--check-only", "--config", config, ...args]));

    setTitle("2026-01-02｜Canonical session title");
    let result = check();
    assert.equal(result.templateSource, "default");
    assert.equal(result.sessions[0].compliant, true);
    assert.equal(result.sessions[0].titlePrefix, "2026-01-02｜");
    assert.equal(result.sessions[0].titleSuffix, "");

    runTemplate(["save", "--template", "{date:MM-DD}｜{topic}", "--config", config]);
    result = check();
    assert.equal(result.template, "{date:MM-DD}｜{topic}");
    assert.equal(result.templateSource, "config");
    assert.equal(result.sessions[0].date, "2026-01-02");
    assert.equal(result.sessions[0].titlePrefix, "01-02｜");
    assert.equal(result.sessions[0].compliant, false);
    setTitle("01-02｜Canonical session title");
    assert.equal(check().sessions[0].compliant, true);

    setTitle("Canonical session title（1/2）");
    result = check("--template", "{topic}（{date:M/D}）");
    assert.equal(result.templateSource, "argument");
    assert.equal(result.sessions[0].titleSuffix, "（1/2）");
    assert.equal(result.sessions[0].compliant, true);
    setTitle("Too short（1/2）");
    assert.equal(check("--template", "{topic}（{date:M/D}）").sessions[0].compliant, false);
    setTitle(`${"A".repeat(29)}（1/2）`);
    assert.equal(check("--template", "{topic}（{date:M/D}）").sessions[0].compliant, false);

    writeFileSync(config, "{not json");
    assert.throws(() => check(), error => {
      assert.match(error.stderr, /config read failed \(invalid JSON\)/);
      return true;
    });
    assert.throws(() => check("--template", "{date}"), /template failed/);
  });
});

test("skill settles the title template before scanning and warns before switching", () => {
  const skill = readFileSync(skillFile, "utf8");
  assert.match(skill, /## Title Template/);
  assert.match(skill, /title-template\.mjs show/);
  assert.match(skill, /`titlePrefix`, then the topic, then its `titleSuffix`/);
  assert.match(skill, /rename every root session/);
  assert.match(skill, /Never edit the config file directly/);
  assert.doesNotMatch(skill, /40 characters or fewer/);
});
