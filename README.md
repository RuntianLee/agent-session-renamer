# codex-session-renamer

[English](README.md) | [中文](README.zh-CN.md)

Manually repair recent root Codex and Claude Code session titles as `YYYY-MM-DD｜Core topic summary` (or your own template), scanning newest-first and stopping at the first fully compliant batch.

> **Disclaimer.** Each noncompliant batch is fully renamed and there is no built-in rollback. Read [SKILL.md](SKILL.md) before using it.

## What it does

| Capability | Behavior |
| --- | --- |
| Codex and Claude Code | Works in Codex, in the Claude desktop app's Code tab, and in Claude Code in a terminal or IDE. |
| Semantic titles | Uses the dominant theme across the full goal arc, refined by the actual outcome. |
| Last conversation date | Dates every title with its last meaningful conversation in the system's current time zone. |
| Incremental manual run | Checks 20 newest-first; renames the whole batch when any title is invalid, then stops at the first fully compliant batch. |
| Custom title template | Choose a preset or your own template on first run, such as `{date:MM-DD}｜{topic}` without the year. |
| Conversation-aware language | By default, each title follows its own session's dominant user language. |
| Optional language | `language=<language>` forces one language for all titles and user-visible output. |
| Token efficiency | Prefers a token-efficient model when model selection is available and uses compact session context. |
| Scope protection | Excludes ChatGPT conversations and subagent sessions. |
| No automation | Runs only when you explicitly invoke the Skill. |

## Naming and language behavior

The default title format is:

```text
YYYY-MM-DD｜Core topic summary
```

### Title template

On first run the Skill offers these presets and saves your choice to `~/.config/codex-session-renamer/config.json` (or `$XDG_CONFIG_HOME/codex-session-renamer/config.json`):

| Preset | Template | Example |
| --- | --- | --- |
| `default` | `{date}｜{topic}` | `2026-10-26｜Core topic summary` |
| `no-year` | `{date:MM-DD}｜{topic}` | `10-26｜Core topic summary` |
| `date-last` | `{topic}｜{date}` | `Core topic summary｜2026-10-26` |
| `dotted` | `{date:YYYY.MM.DD} {topic}` | `2026.10.26 Core topic summary` |

A custom template needs exactly one `{topic}` and at most one `{date}` or `{date:FORMAT}`; FORMAT combines `YYYY`, `YY`, `MM`, `M`, `DD`, and `D` with separators (Latin words go outside the braces), and other text is kept as written. The text around the topic may total at most 20 characters, and the topic stays 10-28 characters.

> **Changing the template renames everything.** Titles in the old format no longer match, so the following scans rename every root session. The Skill warns and asks before saving a new template. Titles without a year are ambiguous across years.

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

- One of:
  - OpenAI Codex with access to local thread-management tools and a local session catalog at `~/.codex/state_5.sqlite`;
  - the Claude desktop app (Code tab), whose `set_session_title` tool renames sessions;
  - Claude Code in a terminal or IDE, with transcripts under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).
- Node.js 20 or newer. Reading compressed rollouts needs Node.js 22.15+ / 23.8+, or the `zstd` command on `PATH` for older versions.
- `sqlite3` available on `PATH` (Codex only).
- Tested on macOS.

## Install with Codex

Tell Codex:

```text
Install the codex-session-renamer Skill from the root of https://github.com/RuntianLee/codex-session-renamer.
```

Codex will use its built-in Skill Installer to place the Skill under `$CODEX_HOME/skills`. The installed Skill becomes available on the next turn.

## Install for Claude Code

Clone the repository into your personal skills folder; the desktop app's Code tab and terminal Claude Code both read it:

```bash
git clone https://github.com/RuntianLee/codex-session-renamer ~/.claude/skills/codex-session-renamer
```

Then run `/codex-session-renamer` or ask Claude to repair recent session titles. The Skill detects whether it runs in the desktop app or a terminal; `platform=claude-desktop` or `platform=claude-cli` overrides that.

## Usage

The examples use Codex's `$codex-session-renamer`. In Claude Code, type `/codex-session-renamer` followed by the same options, for example `/codex-session-renamer language=English`.

### Automatically choose languages

```text
Use $codex-session-renamer to repair recent root Codex session titles.
```

### Force one language

```text
Use $codex-session-renamer language=English to repair recent root Codex session titles.
```

Replace `English` with a language name or BCP-47 tag such as `zh-CN` or `ja`.

### Change the title template

```text
Use $codex-session-renamer template={date:MM-DD}｜{topic} to repair recent root Codex session titles.
```

You can also ask it to change or reset the template; it previews the result and confirms before saving.

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

This folder contains the helpers that check titles and prepare session information. `collect-session-contexts.mjs --platform codex|claude-desktop|claude-cli` reads Codex's catalog, the Claude desktop app's session list, or terminal Claude Code transcripts; the platform-specific readers live in `scripts/lib/`.

In simple terms, the script:

1. finds normal root sessions in Codex's local session list;
2. skips ChatGPT conversations and subagent sessions;
3. reconciles stale database titles with the newest dated name in `session_index.jsonl`, then opens each selected conversation and keeps only the last meaningful conversation date, current title, up to four user requests sampled across the conversation, and the latest non-commentary outcome;
4. removes noisy content such as attached Skill text, code blocks, and page markup;
5. supports a lightweight `--check-only` pass that emits no conversation context while using the same date calculation as full mode.

The collector only reads local files. It does not decide the new title, change the database, or rename anything by itself. Codex and the Claude desktop app write titles through their official session tools. Two scripts write: `title-template.mjs` saves only its own config file, and `claude-cli-rename.mjs` only appends a `custom-title` record to one terminal transcript. The collector applies the saved template, or a one-off `--template`, and returns each session's `titlePrefix` and `titleSuffix`.

The collector rejects unknown options and invalid numeric arguments. `--limit` accepts 1-20 and `--offset` accepts a nonnegative integer. Use `--ids id1,id2,...` instead of positional pagination when reading or verifying an already checked batch; it preserves ID order and requires every requested root session to exist. `--check-only` can be combined with either selection mode. Legacy string message content is supported, and unrelated or incomplete JSON records are ignored. When Codex has compressed an older rollout to `<rollout_path>.zst`, the collector reads that archive instead; an uncompressed rollout always takes precedence.

Run the tests with `node --test tests/`.

## Safety and privacy

| Area | Guarantee |
| --- | --- |
| Session content | Read locally only to extract compact naming context. |
| Database | Queried for session metadata; titles are not written directly to SQLite. |
| Renaming | Codex and the Claude desktop app rename through their official tools. Terminal Claude Code sessions get a `custom-title` record appended to their transcript, the same record the Claude Agent SDK's `renameSession()` writes; nothing else in the transcript changes. |
| Archived tasks | Restores the original archived state after renaming. |
| Exclusions | Never selects ChatGPT conversations, claude.ai cloud sessions, or subagents. Terminal renames refuse sessions the desktop app owns. |
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
│   ├── collect-session-contexts.mjs
│   ├── title-template.mjs
│   ├── claude-cli-rename.mjs
│   └── lib/
│       ├── claude-source.mjs
│       ├── codex-source.mjs
│       ├── context.mjs
│       └── title-template.mjs
└── tests/
    └── collect-session-contexts.test.mjs
```

## Limitations

- Title quality depends on the meaningful context available in each session.
- The collectors rely on the current local file layouts of Codex, the Claude desktop app, and Claude Code transcripts.
- In the Claude desktop app, renaming a title you set yourself asks for your approval each time unless the session runs in bypass permissions mode. Declined renames are reported as skipped.
- The desktop app and terminal Claude Code keep separate session lists. Sessions created in the desktop app are renamed there; the terminal mode renames only the rest.
- There is no built-in title history or automatic rollback.
- Only sessions stored on this computer are renamed. Codex keeps its threads locally, so a renamed title does not appear on another computer that has its own sessions; run the skill on each computer. Phones and other devices that open this computer's threads through a [connected host](https://openai.com/index/work-with-codex-from-anywhere/) read them from here and show the new titles after they refresh.
- ChatGPT Work conversations that sync across web, mobile, and desktop are separate from Codex history ([OpenAI docs](https://learn.chatgpt.com/docs/projects)) and are never renamed.

## License

MIT - see [LICENSE](LICENSE).
