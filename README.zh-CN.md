# agent-session-renamer

[English](README.md) | [中文](README.zh-CN.md)

手动修复近期 Codex 和 Claude Code 根会话标题，统一生成 `YYYY-MM-DD｜核心内容总结`（也可以换成自己的模板）。按会话活跃时间从新到旧扫描，遇到首个全合规批次就停止；标题日期单独按有效对话时间计算。

原名 `codex-session-renamer`，升级方法见[从 codex-session-renamer 升级](#从-codex-session-renamer-升级)。

> **免责声明。** 只要一个批次中存在不合规标题，就会重命名该批全部会话，且没有内置回滚功能。使用前请先阅读 [SKILL.md](SKILL.md)。

## 它能做什么

| 能力 | 行为 |
| --- | --- |
| Codex 与 Claude Code | 可在 Codex、Claude 桌面 App 的 Code 页，以及终端或 IDE 里的 Claude Code 中使用。 |
| 语义化标题 | 根据完整会话的目标演进识别核心主题，再用实际结果补充。 |
| 最后对话日期 | 按系统当前时区，在标题中加入对应会话最后一次有效对话的日期。 |
| 手动增量执行 | 每批检查 20 条；发现任一不合规标题就重命名整批，首个全合规批次立即停止。 |
| 自定义标题模板 | 首次运行时选择预设或自定义模板，例如不带年份的 `{date:MM-DD}｜{topic}`。 |
| 按会话选择语言 | 默认让每个标题跟随对应会话的主要用户语言。 |
| 显式指定语言 | `language=<language>` 可强制所有标题和用户可见输出使用同一种语言。 |
| Token 控制 | 运行环境支持模型选择时，优先使用低消耗模型，并只读取精简的会话上下文。 |
| 范围保护 | 排除 ChatGPT 对话、claude.ai 云端会话和子代理会话。 |
| 不创建自动化 | 只有你明确调用 Skill 时才会执行。 |

## 命名与语言规则

默认标题格式：

```text
YYYY-MM-DD｜核心内容总结
```

### 标题模板

首次运行时，Skill 会提供下面几个预设，并把你的选择保存到 `~/.config/agent-session-renamer/config.json`（设置了 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/agent-session-renamer/config.json`）：

| 预设 | 模板 | 示例 |
| --- | --- | --- |
| `default` | `{date}｜{topic}` | `2026-10-26｜核心内容总结示例` |
| `no-year` | `{date:MM-DD}｜{topic}` | `10-26｜核心内容总结示例` |
| `date-last` | `{topic}｜{date}` | `核心内容总结示例｜2026-10-26` |
| `dotted` | `{date:YYYY.MM.DD} {topic}` | `2026.10.26 核心内容总结示例` |

自定义模板必须恰好包含一个 `{topic}`，最多包含一个 `{date}` 或 `{date:格式}`；日期格式由 `YYYY`、`YY`、`MM`、`M`、`DD`、`D` 加分隔符组成（英文单词要写在花括号外，`{date:M月D日}` 这类中文可以），其余文字原样保留。主题两侧的固定文字合计不超过 20 个字符，主题本身仍为 10–28 个字符。

> **更换模板会重命名全部会话。** 旧格式的标题不再合规，之后的扫描会把所有根会话都重命名一遍。保存新模板前，Skill 会提醒并征求确认。不带年份的日期在跨年时会有歧义。

日期取自最后一条有效用户消息或助手回复，执行过程中的进度播报不会改变日期。如果找不到有效的对话时间，则回退到创建日期。

未指定语言时：

- 每个标题使用对应会话自己的主要用户语言；
- 进度信息和最终报告使用当前触发 Skill 的对话语言；
- 如果会话语言不明确，则依次回退到当前标题语言、触发会话语言。

显式指定语言时：

```text
language=English
language=zh-CN
language=ja
```

指定语言会同时作用于所有新标题和所有用户可见输出。项目名、产品名、代码标识符和通用技术术语会在合适时保留原文。

## 环境要求

- 以下任一环境：
  - OpenAI Codex，可以使用本地会话管理工具，并且本地存在 `~/.codex/state_5.sqlite` 会话目录；
  - Claude 桌面 App 的 Code 页，用它的 `set_session_title` 工具改名；
  - 终端或 IDE 里的 Claude Code，会话记录位于 `~/.claude/projects`（或 `$CLAUDE_CONFIG_DIR/projects`）。
- Node.js 20 或更高版本。读取压缩后的会话记录需要 Node.js 22.15+ / 23.8+；更早的版本需要 `PATH` 中有 `zstd` 命令。
- `sqlite3` 已加入 `PATH`（仅 Codex 需要）。
- 已在 macOS 上测试。Windows（`%APPDATA%\Claude\claude-code-sessions`）和 Linux（`~/.config/Claude/claude-code-sessions`）上的 Claude 桌面 App 会话目录是按惯例推断的，未经测试。

## 告诉 Codex 安装

直接告诉 Codex：

```text
请从 https://github.com/RuntianLee/agent-session-renamer 仓库根目录安装 agent-session-renamer Skill。
```

Codex 会使用内置的 Skill Installer，把 Skill 安装到 `$CODEX_HOME/skills`。安装完成后，下一轮对话即可使用。

## 在 Claude Code 中安装

把仓库克隆到个人 skills 目录，桌面 App 的 Code 页和终端里的 Claude Code 都会读取它：

```bash
git clone https://github.com/RuntianLee/agent-session-renamer ~/.claude/skills/agent-session-renamer
```

之后运行 `/agent-session-renamer`，或者直接让 Claude 修复近期会话标题。Skill 会自动判断当前是在桌面 App 还是终端里运行；也可以用 `platform=claude-desktop` 或 `platform=claude-cli` 指定。

## 从 codex-session-renamer 升级

增加 Claude Code 支持后，这个 Skill 改了名。旧的 GitHub 地址会自动跳转到这里，但已安装的副本仍是旧目录和旧名称，需要重新安装：

1. 删除旧目录：Codex 的是 `~/.codex/skills/codex-session-renamer`（或 `$CODEX_HOME/skills` 下的同名目录），Claude Code 的是 `~/.claude/skills/codex-session-renamer`。两个都留着的话，同一个 Skill 会出现两次。
2. 按上文重新安装。
3. 调用方式改为 Codex 中的 `$agent-session-renamer`、Claude Code 中的 `/agent-session-renamer`。

旧版本保存在 `~/.config/codex-session-renamer/config.json` 的模板会继续生效；之后再保存模板时，会写到 `~/.config/agent-session-renamer/config.json`。

## 使用方法

下面的示例使用 Codex 的 `$agent-session-renamer`。在 Claude Code 中改用 `/agent-session-renamer`，参数写法相同，例如 `/agent-session-renamer language=English`。

### 自动判断语言

```text
使用 $agent-session-renamer 修复近期 Codex 根会话标题。
```

### 强制使用同一种语言

```text
使用 $agent-session-renamer language=English 修复近期 Codex 根会话标题。
```

可将 `English` 换成语言名称或 BCP-47 标签，例如 `zh-CN`、`ja`。

### 更换标题模板

```text
使用 $agent-session-renamer template={date:MM-DD}｜{topic} 修复近期 Codex 根会话标题。
```

也可以直接说“更换模板”或“重设模板”；Skill 会先预览效果，确认后再保存。

> **重要：** 如果某批存在一个不合规标题，该批所有会话都会被重新总结和重命名。该 Skill 不提供定时模式、dry-run 或自动标题备份。

## 工作原理

1. 确定标题模板：首次运行时提供预设供选择，之后使用已保存的模板。
2. 根据当前运行的客户端确定平台，再把该平台的根会话按从新到旧排列：

   | 平台 | 会话范围 | 排序依据 | 当前标题来源 |
   | --- | --- | --- | --- |
   | `codex` | Codex 根会话 | App 的 `recency_at_ms` | `session_index.jsonl` 中时间最新的记录，没有时用 SQLite |
   | `claude-desktop` | 有本地会话记录的 Code 会话，取自唯一有会话的那个桌面 App 账号 | App 中的最后活跃时间 | 桌面 App 显示的标题 |
   | `claude-cli` | 不属于任何桌面 App 账号、且包含用户目标的终端或 IDE 会话记录 | 会话记录文件的修改时间 | 最新一条 `custom-title` 记录 |

3. 每批最多检查 20 个会话，返回 `batchCompliant` 和 `noncompliantCount`；每个标题的日期单独按该会话的有效对话时间计算。
4. 如果返回的标题全部合规，立即停止。
5. 如果存在任一不合规标题，保存该批 ID 和下一批 offset，按这些固定 ID 读取上下文并重命名整批：Codex 用 `set_thread_title`，桌面 App 用 `set_session_title`，终端用 `claude-cli-rename.mjs`。
6. 对已归档的 Codex 会话或桌面 App 会话临时解除归档，重命名后恢复原状态；写入失败时也恢复归档状态。你在桌面 App 中拒绝的改名记为跳过。
7. 按同一批 ID 复查实际标题和归档状态；未持久化的写入重试一次，仍失败则报告并停止。
8. 修复批次验证通过后，按原先保存的 offset 继续；遇到下一批原本就全合规的标题或到达末尾时停止。

## `agents/` 和 `scripts/` 是做什么的

### `agents/`

这个文件夹里只有 `openai.yaml`，负责告诉 Codex 如何展示这个 Skill：

- 显示名称；
- 简短说明；
- 启动时显示的示例提示词。

它用于改善 Codex 中的使用体验，不负责扫描或重命名会话。Claude Code 不读取这个文件，名称和说明取自 `SKILL.md` 开头的 front matter。

### `scripts/`

这个文件夹存放检查标题、准备会话信息的辅助脚本。`collect-session-contexts.mjs --platform codex|claude-desktop|claude-cli` 分别读取 Codex 的会话目录、Claude 桌面 App 的会话列表或终端 Claude Code 的会话记录；各平台的读取逻辑在 `scripts/lib/` 里。

简单来说，脚本会：

1. 按“工作原理”中的规则找出当前平台的根会话，跳过 ChatGPT 对话、没有本地会话记录的 claude.ai 云端会话和子代理会话；
2. 打开当前批次的 Codex 会话记录或 Claude Code 会话记录，只保留最后有效对话日期、当前标题、从会话全过程分层抽取的最多四条用户要求，以及最后一条非进度类结果；
3. 去掉附带的 Skill 原文、代码块和页面标记等无关内容；在 Claude Code 会话记录中，还会跳过工具结果、思考过程、sidechain 和注入的条目、上下文压缩摘要、`<system-reminder>` 块、不带参数的 slash 命令和命令输出；
4. 支持轻量 `--check-only` 检查，不输出会话上下文，并与完整模式使用同一套日期计算方法。

采集器只读取本地文件。它不会自己决定标题、修改数据库或执行重命名。Codex 和 Claude 桌面 App 的标题由各自的官方会话工具写入。只有两个脚本会写文件：`title-template.mjs` 只写自己的配置文件，`claude-cli-rename.mjs` 只向单个终端会话记录追加一条 `custom-title` 记录。采集器按已保存的模板（或单次传入的 `--template`）检查标题，并返回每个会话的 `titlePrefix` 和 `titleSuffix`。

采集器会拒绝未知参数和非法数值。`--limit` 接受 1–20，`--offset` 接受非负整数。读取或复查已选定批次时，用 `--ids id1,id2,...` 固定身份，保持传入顺序，并要求所有 ID 都对应现存根会话；它不能与位置分页参数混用。两种选择方式均可加 `--check-only`。历史字符串消息内容可以读取，无关或不完整 JSON 记录会跳过。Codex 会把较旧的会话记录压缩为 `<rollout_path>.zst`，此时采集器改读压缩文件；未压缩的原文件始终优先。如果 Codex 已退出，而采集器又不能在 `state_5.sqlite` 所在目录写文件（例如在沙箱中运行），它会以 immutable 只读方式打开已完整落盘的数据库；如果还留有 `-wal` 文件，则报错停止。在桌面 App 中，采集器只读取一个账号的会话；如果多个账号都有会话，它会停止并要求传入 `--desktop-dir <account>/<organization>`。

运行测试：`node --test tests/`。

## 安全与隐私

| 范围 | 保证 |
| --- | --- |
| 会话内容 | 只在本地读取，用于提取精简的命名上下文。 |
| 数据库 | 只查询会话元数据，不直接向 SQLite 写入标题。 |
| 重命名 | Codex 和 Claude 桌面 App 使用各自的官方会话工具。终端里的 Claude Code 会话，只在会话记录末尾追加一条 `custom-title` 记录（与 Claude Agent SDK 的 `renameSession()` 写入的记录相同），记录里的其他内容不变。 |
| 归档任务 | 重命名后恢复原来的归档状态。 |
| 排除范围 | 永不选择 ChatGPT 对话、claude.ai 云端会话和子代理会话。终端模式拒绝修改归桌面 App 管理的会话。 |
| 自动化 | 永不创建或更新定时自动化。 |
| 删除操作 | 永不删除会话、消息、记忆或项目文件。 |

## 仓库内容

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

## 已知限制

- 标题质量取决于每个会话中可用的有效上下文。
- 收集脚本依赖 Codex、Claude 桌面 App 和 Claude Code 会话记录当前的本地文件结构。
- 在 Claude 桌面 App 中，修改你自己设置过的标题时，每次都会请你确认（bypass permissions 模式除外）；被拒绝的改名记为跳过。
- 桌面 App 和终端 Claude Code 各有一份会话列表。在桌面 App 里创建的会话在桌面 App 里改名；终端模式只处理其余会话。
- 没有内置标题历史或自动回滚。
- 只重命名保存在本机的会话。Codex 的会话存在本地，在一台电脑上改名后，另一台电脑上它自己的会话不会跟着变；需要在每台电脑上分别运行。手机等设备如果是通过 [connected host](https://openai.com/index/work-with-codex-from-anywhere/) 远程查看本机会话，读取的就是本机数据，刷新后能看到新标题。
- 在网页、手机和桌面之间同步的 ChatGPT Work 对话与 Codex 历史是分开的（[OpenAI 文档](https://learn.chatgpt.com/docs/projects)），本 Skill 不会重命名它们。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
