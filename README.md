# codex-session-renamer

[English](README.md) | [中文](README.zh-CN.md)

Manually repair recent root Codex session titles as `YYYY-MM-DD｜Core topic summary`, scanning newest-first and stopping at the first fully compliant batch.

> **Disclaimer.** Each noncompliant batch is fully renamed and there is no built-in rollback. Read [SKILL.md](SKILL.md) before using it.

## What it does

| Capability | Behavior |
| --- | --- |
| Semantic titles | Uses the dominant theme across the full goal arc, refined by the actual outcome. |
| Last conversation date | Prefixes every title with the date of its last meaningful conversation in the system's current time zone. |
| Incremental manual run | Checks 20 newest-first; renames the whole batch when any title is invalid, then stops at the first fully compliant batch. |
| Conversation-aware language | By default, each title follows its own session's dominant user language. |
| Optional language | `language=<language>` forces one language for all titles and user-visible output. |
| Token efficiency | Prefers a token-efficient model when model selection is available and uses compact session context. |
| Scope protection | Excludes ChatGPT conversations and subagent sessions. |
| No automation | Runs only when you explicitly invoke the Skill. |

## Naming and language behavior

The title format is:

```text
YYYY-MM-DD｜Core topic summary
```

The date comes from the last meaningful user message or assistant answer. Progress commentary is ignored. If no valid conversation timestamp is available, the creation date is used instead.

Without a language option:

- each title follows the dominant user language of its own session;
- progress messages and the final report follow the language of the conversation that invoked the Skill;
- ambiguous sessions fall back to the current title language, then to the invoking conversation language.

With an explicit language:

```text
language=English
language=zh-CN
language=ja
```

The selected language applies to every generated title and all user-visible output. Project names, product names, code identifiers, and standard technical terms remain unchanged when appropriate.

## Requirements

- OpenAI Codex with access to local thread-management tools.
- A local Codex session catalog at `~/.codex/state_5.sqlite`.
- Node.js 20 or newer. Reading compressed rollouts needs Node.js 22.15+ / 23.8+, or the `zstd` command on `PATH` for older versions.
- `sqlite3` available on `PATH`.
- Tested on macOS.

## Install with Codex

Tell Codex:

```text
Install the codex-session-renamer Skill from the root of https://github.com/RuntianLee/codex-session-renamer.
```

Codex will use its built-in Skill Installer to place the Skill under `$CODEX_HOME/skills`. The installed Skill becomes available on the next turn.

## Usage

### Automatically choose languages

```text
Use $codex-session-renamer to repair recent root Codex session titles.
```

### Force one language

```text
Use $codex-session-renamer language=English to repair recent root Codex session titles.
```

Replace `English` with a language name or BCP-47 tag such as `zh-CN` or `ja`.

> **Important:** the Skill renames every session in a batch when any title in that batch is noncompliant. It has no scheduled mode, dry run, or automatic title backup.

## How it works

1. Orders root sessions by the app's `recency_at_ms`, newest first. Each title's date is calculated separately from that session's meaningful conversation timestamps.
2. Queries at most 20 sessions in SQLite read-only mode, reconciles titles with the newest dated session index entry, and returns `batchCompliant` plus `noncompliantCount`.
3. Stops immediately when every returned title is compliant.
4. If any title is invalid, retains the checked batch's IDs and next offset, reads context by those exact IDs, and renames every session in that batch.
5. Temporarily unarchives archived tasks, renames them, and restores their original archive state even if a write fails.
6. Rechecks those same IDs, verifying the actual titles and archive states. Retries an unpersisted write once and reports any remaining failure.
7. After a repaired batch passes verification, continues from its saved next offset until the next initially checked batch is compliant or the end is reached.

## What `agents/` and `scripts/` do

### `agents/`

This folder contains `openai.yaml`. It tells Codex how to display the Skill:

- its name;
- its short description;
- the example prompt shown when starting it.

It improves the experience in Codex, but it does not scan or rename sessions.

### `scripts/`

This folder contains the helper that checks titles and prepares session information for Codex.

In simple terms, the script:

1. finds normal root sessions in Codex's local session list;
2. skips ChatGPT conversations and subagent sessions;
3. reconciles stale database titles with the newest dated name in `session_index.jsonl`, then opens each selected conversation and keeps only the last meaningful conversation date, current title, up to four user requests sampled across the conversation, and the latest non-commentary outcome;
4. removes noisy content such as attached Skill text, code blocks, and page markup;
5. supports a lightweight `--check-only` pass that emits no conversation context while using the same date calculation as full mode.

The script only reads local files. It does not decide the new title, change the database, or rename anything by itself. Codex writes the title through its official session tools.

The collector rejects unknown options and invalid numeric arguments. `--limit` accepts 1-20 and `--offset` accepts a nonnegative integer. Use `--ids id1,id2,...` instead of positional pagination when reading or verifying an already checked batch; it preserves ID order and requires every requested root session to exist. `--check-only` can be combined with either selection mode. Legacy string message content is supported, and unrelated or incomplete JSON records are ignored. When Codex has compressed an older rollout to `<rollout_path>.zst`, the collector reads that archive instead; an uncompressed rollout always takes precedence.

Run the tests with `node --test tests/`.

## Safety and privacy

| Area | Guarantee |
| --- | --- |
| Session content | Read locally only to extract compact naming context. |
| Database | Queried for session metadata; titles are not written directly to SQLite. |
| Renaming | Uses official Codex thread tools. |
| Archived tasks | Restores the original archived state after renaming. |
| Exclusions | Never selects ChatGPT conversations or subagents. |
| Automation | Never creates or updates scheduled automations. |
| Deletion | Never deletes sessions, messages, memories, or project files. |

## Repository contents

```text
.
├── README.md
├── README.zh-CN.md
├── SKILL.md
├── agents/
│   └── openai.yaml
├── scripts/
│   └── collect-session-contexts.mjs
└── tests/
    └── collect-session-contexts.test.mjs
```

## Limitations

- Title quality depends on the meaningful context available in each session.
- The collector relies on Codex's current local file layout.
- There is no built-in title history or automatic rollback.

## License

MIT - see [LICENSE](LICENSE).
