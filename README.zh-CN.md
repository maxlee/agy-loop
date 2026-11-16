<div align="center">

<img src="assets/logo.svg" alt="AGY Loop Logo" width="88" height="88" />

# AGY Loop (`agy-loop`)

**专为 Google Antigravity CLI (`agy`) 与桌面端打造的原生非阻塞 `/loop` 循环调度插件，基于内置 `schedule` 定时器、隔离子代理与 `loop.md` 热重载构建**

[![CI](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/maxlee/agy-loop/actions/workflows/ci.yml)
[![Release](https://github.com/maxlee/agy-loop/actions/workflows/release.yml/badge.svg)](https://github.com/maxlee/agy-loop/releases/latest)
[![Antigravity Plugin v1](https://img.shields.io/badge/Antigravity-Plugin_v1-38BDF8.svg)](plugin.json)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-22C55E.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[**English**](README.md) · [**简体中文**](README.zh-CN.md) · [**核心优势**](#-为什么选择-agy-loop) · [**快速安装**](#-安装指南) · [**命令与参数**](#-斜杠命令运行模式与参数参考) · [**`loop.md` 热重载**](#-agentsloopmd-热重载指南) · [**退出与停止**](#-如何退出或停止循环) · [**架构设计**](ARCHITECTURE.md)

</div>

---

**AGY Loop** 为 **Antigravity CLI (`agy`)** 与 **Antigravity 桌面端**带来真正非阻塞、上下文完全隔离的 `/loop` 斜杠命令。告别使用 Shell `sleep` 锁死主对话回合或将几十轮构建、测试与 CI 日志塞满主窗口的做法：`agy-loop` 将每一轮检查与修复派发给独立上下文的后台 `loop-worker`（或 `self`）子代理执行，并在轮次间隙通过 Antigravity 原生 `schedule` 工具挂起休眠，等待期间**零 Token 消耗、主会话随时可正常对话**。

> 设计灵感源自 Claude Code 的 [`/loop` 工作流](https://claude.com/resources/articles/getting-started-with-loops)，深度结合 Antigravity 的响应式子代理唤醒、秒级 `DurationSeconds` 定时器、`Idle` 有状态重唤醒与 Git Worktree 分支隔离机制原生实现。

---

## 📸 实时会话预览

```text
> /loop check current PR CI status and fix failures --stateful

⏺ 已派发 Loop #1/20 至后台 loop-worker（stateful，sandbox 隔离）。主输入框已释放，可随时继续对话。

  [42s 后 · 子代理完成响应式唤醒]
⏺ [Loop #1/20] 修复 src/render.test.ts 快照断言并推送提交 9c41e2b，CI 重新运行中 | Next wake-up in 45s (self-paced)

> 顺便帮我解释一下 src/auth.ts 里的 token 缓存逻辑
⏺ src/auth.ts 使用以 SHA-256 为键的 LRU Map 缓存已验签的 JWT Claims……
  （后台定时器以 0 token/s 静默等待，主对话上下文始终保持清爽。）

  [45s 后 · 定时器唤醒 -> 第 2 轮检查]
⏺ [Loop #2/20] 单元测试与 Lint 已绿灯，等待 e2e 矩阵完成（4/5 通过） | Next wake-up in 90s (self-paced)

  [90s 后 · 定时器唤醒 -> 第 3 轮检查]
⏺ [Loop #3/20] DONE: PR #42 全部 5 项 CI 检查已绿灯通过，定时任务已自动清理。
```

---

## ⚡ 为什么选择 AGY Loop？

| 对比维度 | Shell `sleep` 循环 | Claude Code `/loop` | AGY Loop (`agy-loop`) |
| :--- | :--- | :--- | :--- |
| **等待机制** | Shell `sleep` 阻塞回合 | 内置会话 Cron 队列 | 原生非阻塞 `schedule` 定时器与 Cron |
| **主会话可用性** | 等待期锁死，无法输入 | 轮次间隙可正常对话 | 轮次间隙**及子代理执行期间**均可自由对话 |
| **上下文隔离** | 构建/测试日志塞满主窗口 | 共享主会话历史记录 | 独立 `loop-worker` / `self` 干净窗口，主窗口仅留单行摘要 |
| **最小时间粒度** | `1s`（阻塞前台） | `1m` Cron 下限（`30s` 会向上取整为 `1m`） | 秒级 `DurationSeconds`（支持 `15s`、`30s`、`45s` 等亚分钟精度） |
| **动态退避调速** | 仅固定间隔 | 模型估算 `1m–1h` 延迟 | 子代理实测反馈 `NEXT_DELAY_SEC`（活跃 `30–60s`、排队 `120–300s`、空闲绿灯 `600–1800s`） |
| **`loop.md` 热重载** | 不支持 | `.claude/loop.md` 与 `~/.claude/loop.md` | 每轮实时重读：`.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置维护兜底 |
| **多轮修 Bug 记忆** | 全量日志堆积膨胀 | 混杂在主对话历史中 | 可选 `--stateful` 通过 `send_message` 唤醒 `Idle` 子代理，隔离保留排查上下文 |
| **高风险代码修改隔离** | 直接修改当前工作区 | 直接修改当前工作区 | 可选 `--worktree`（`branch` 独立 Git Worktree）或 `--share` 副本 |

---

## 📦 安装指南

### 环境要求

- **Antigravity CLI (`agy`)** `v1.5.0+`（已通过 `cli-1.5.9` 严格插件规范校验）或 **Antigravity 桌面端**
- **原生安装零 Node.js / npm 依赖**（使用 `agy plugin install` 或一行 `curl` 脚本安装无需任何运行时；仅使用 `npx` / `bunx` 桥接器时需 `Node.js >= 18` 或 `Bun`）

`agy-loop` 采用**双栖包架构（Dual-Habitat）**：仓库根目录既是符合严格 v1 规范的 Antigravity 原生插件（`plugin.json`、`skills/loop/SKILL.md`、`agents/loop-worker.md`），也是零外部依赖的 npm CLI 桥接器（`bin/agy-loop.mjs`）。安装完成后：

- 在 `agy` CLI 与 Antigravity 桌面端中，直接输入简写 **`/loop`** 或完整命名空间 **`/agy-loop:loop`** 均可调起命令。
- 在 Antigravity 桌面端（**Customizations -> Plugins** 或 **Marketplace** 插件卡片）中，可直接点击内置的 3 个快捷引导胶囊（`suggestedPrompts`）一键启动常用巡检或查看 `/loop status`。
- 若安装时 `agy` 会话已处于打开状态，先执行一次 **`/skills reload`** 即可在 `/` 自动补全菜单中立即看到 `/loop`。

### 方式一：通过 `npx` / `bunx` 安装（npm 零依赖桥接）

```bash
npx agy-loop
# 或使用 Bun：
bunx agy-loop
```

如果你此前手动创建过 `~/.gemini/config/skills/loop` 或 `~/.gemini/config/agents/loop-worker.md`，由于 Antigravity 加载个人全局目录的优先级高于插件目录，旧文件会遮蔽（Shadow）插件版本。追加 `--clean-shadow` 即可安装 `agy-loop` 并将旧文件自动安全归档至 `~/.gemini/config/.agy-loop-backup-<timestamp>/`：

```bash
npx agy-loop install --clean-shadow
```

### 方式二：通过 `agy` CLI 从 GitHub 直接安装

```bash
agy plugin install https://github.com/maxlee/agy-loop
```

### 方式三：一行 POSIX 脚本安装（macOS & Linux）

```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
```

安装同时自动备份并清理同名全局遮蔽文件：

```bash
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh -s -- --clean-shadow
```

### 方式四：克隆源码本地安装

```bash
git clone https://github.com/maxlee/agy-loop.git
cd agy-loop
agy plugin install .
```

---

## 🧭 斜杠命令、运行模式与参数参考

### 5 大调用模式

| 运行模式 | 命令示例 | 行为说明 |
| :--- | :--- | :--- |
| **1. 固定间隔 + 任务提示词** | `/loop 30s curl -fsS http://localhost:8080/health`<br>`/loop 5m check the deploy`<br>`/loop check PR #42 comments every 2h` | 按固定周期（`s`、`m`、`h`、`d`）执行。默认使用防重叠的单次 `DurationSeconds` 链式定时器（支持 `30s` 亚分钟及 `90s`、`7m` 等非整除间隔）；传入 `--cron` 时切换为 5 段式 `CronExpression`。 |
| **2. 动态自适应节奏（Self-Paced）** | `/loop check CI and fix failures`<br>`/loop run pytest and fix failing tests --stateful` | 省略时间间隔。每轮结束后由 `loop-worker` 根据现场状态返回 `NEXT_DELAY_SEC`（构建/验证期 `30–60s`、等待 CI 队列 `120–300s`、全绿静默巡检退避至 `600–1800s`）。 |
| **3. `loop.md` 热重载维护巡检** | `/loop`<br>`/loop 15m` | 省略内联提示词。每轮唤醒时按 `.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> 内置分支维护策略的顺序动态读取指令（`/loop` 为自适应间隔，`/loop 15m` 为固定间隔）。 |
| **4. 单次延时检查（One-Shot）** | `/loop in 20m verify staging smoke tests`<br>`/loop --once 10m check if docker build finished` | 创建单次非阻塞 `DurationSeconds` 定时器（`max_iterations = 1`），到点唤醒子代理执行一轮检查并汇报结果后自动结束。 |
| **5. 生命周期管理与诊断** | `/loop status`（或 `/loop list`）<br>`/loop stop [id\|all]`（或 `/loop cancel`）<br>`/loop doctor`<br>`/loop help` | 查看当前活跃定时器与子代理列表、按 ID 或全量终止循环（联动 `manage_task` 与 `manage_subagents`）、诊断同名全局遮蔽文件与 `skills.json` 过滤规则及当前生效的 `loop.md`，或输出 `/loop` 速查帮助。 |

### 参数（Flags）完整参考

所有参数均可放置在 `/loop` 命令的任意位置：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `--max <N>` | `20`（`--once` 时为 `1`） | 最大循环轮数安全上限，达标前若触顶将自动停止并汇总，防止无人值守时消耗过多配额。 |
| `--stateful` | `fresh` | 跨轮次复用同一个 `loop-worker` 会话 ID，通过 `send_message` 唤醒处于 `Idle` 状态的子代理，在不污染主窗口的前提下保留多轮排障记忆。 |
| `--worktree` | `inherit` | 在独立 Git 分支工作树（`Workspace: "branch"`）中运行子代理，确保实验性修复不会污染你正在编辑的本地工作区。 |
| `--share` | `inherit` | 在共享工作副本（`Workspace: "share"`）中运行子代理。 |
| `--model <tier>` | `flash`（`loop-worker`） | 覆盖子代理模型档位：支持 `inherit`、`flash_lite`、`flash`、`pro`。 |
| `--self` | `loop-worker` | 改用内置全功能 `self` 子代理执行每轮任务（当提示词以 `/` 开头调用其他斜杠技能如 `/loop 20m /code-review` 或需使用 MCP 工具时也会自动启用）。 |
| `--cron` | `false` | 当固定间隔 `>= 60s` 且可精确映射为标准 5 段 Cron（`1m`、`60m` 约数、`24h` 约数、`1d`）时，启用原生 `CronExpression` 周期调度。 |
| `--exact` | `false` | 配合 `--cron` 开启 `ExactTiming: true`，在整分时刻精确触发，关闭防惊群随机抖动（Jitter）。 |
| `--daemon` | `false` | 配合 `--cron` 开启 `IsDaemon: true`，作为常驻后台任务在当前前台目标完成后继续按周期触发。 |
| `--once` | `false` | 仅延时执行单轮检查（`max_iterations = 1`），汇报后立即退出。 |

---

## 🔄 `.agents/loop.md` 热重载指南

当直接运行 `/loop` 或仅指定间隔的 `/loop 15m`（未附带内联提示词）时，`agy-loop` 会在**每一轮唤醒时**按以下优先级动态解析巡检指令（单文件读取上限 `25,000` 字节）：

1. 当前工作区下的 **`.agents/loop.md`**（项目级团队或仓库巡检规范）
2. 当前工作区根目录下的 **`loop.md`**
3. 全局配置目录下的 **`~/.gemini/config/loop.md`**（跨仓库个人默认巡检策略）
4. **内置分支维护兜底协议**：依次检查仓库未完成改动与增量测试、通过 `gh`（若已安装登录）检查当前分支 PR 评审意见与最新 CI 状态；若全部正常则单行汇报绿灯。

由于每一轮唤醒都会重新调用 `skills/loop/scripts/loop-helper.sh resolve-task` 读取文件，你可以在后台循环运行期间随时保存修改 `.agents/loop.md`，下一轮唤醒将自动加载最新策略，无需取消或重启 `/loop`。

### `.agents/loop.md` 实用模板示例

```markdown
# 分支值守与自动修复策略

1. 优先运行当前改动关联的增量测试或 `npm test`。
2. 若测试失败，定位根因并做最小化代码修复，在同一轮内重新执行失败用例确认修复结果。
3. 若本机 `gh` 已登录且当前分支存在打开状态的 PR：
   - 执行 `gh pr checks` 检查是否有红灯 CI 任务；
   - 查看未解决的 Review 评论并处理明确的机械性修改建议。
4. 当本地测试通过且 PR 全部检查绿灯时返回 `LOOP_STATUS: DONE` 自动结束循环；若遇到需要人工拍板的架构分歧或缺少密钥凭证，返回 `LOOP_STATUS: BLOCKED`。
```

---

## 🛑 如何退出或停止循环

除满足条件自动退出外，你可以随时通过以下 4 种方式干净终止循环：

1. **斜杠命令一键停止（`/loop stop`）**
   输入 `/loop stop`（或 `/loop stop <taskId>`、`/loop cancel`），编排器会自动调用 `manage_task(Action="kill")` 销毁后台 `schedule` 定时器/Cron，并通过 `manage_subagents(Action="kill")` 终止运行中或空闲的 `loop-worker`。
2. **自然语言对话停止**
   直接在输入框发送：`取消当前的 loop 定时任务`（或 `等当前这一轮子代理返回后停止 loop`）。
3. **CLI 交互式管理面板（`/tasks` 与 `/agents`）**
   - 输入 **`/tasks`** 打开后台任务面板，选中对应的 `schedule` 定时器或 Cron 按 **`k`** 键取消后续触发（按 `x` 清理已完成记录）。
   - 输入 **`/agents`** 打开子代理面板，选中状态为 `running` 或 `idle` 的 `loop-worker` 按 **`k`** 键立即终止（`--worktree` 创建的临时分支工作区会自动回收）。子代理等待命令审批时，可按 **`Ctrl+K`** 快速放行，或按 **`Alt+J`** 瞬移进入子代理实时视图（按 `Esc` 返回主会话）。
4. **键盘中断当前回合（`Esc`）**
   在 `agy` CLI 中直接按 **`Esc`** 键可立即中断主代理当前正在执行的派发动作，控制权回到输入框且不会退出 CLI（连按两次 `Ctrl+C` 会退出整个 CLI）。

**内置自动退出保护**：当子代理返回 `LOOP_STATUS: DONE`（目标达成）、`LOOP_STATUS: BLOCKED`（缺少权限或需人工决策），或循环次数达到 `--max <N>`（默认 `20` 轮）时，调度器会自动清理残留定时任务并结束循环。

---

## 🧹 诊断、卸载与本地校验

### CLI 桥接器子命令一览（`npx agy-loop`）

| 命令 | 用途说明 |
| :--- | :--- |
| `npx agy-loop [install \| update]` | 调用 `agy plugin install` 安装或更新插件（自动检测同名全局遮蔽文件并告警） |
| `npx agy-loop install --clean-shadow` | 安装 `agy-loop` 并将遮蔽插件的用户级散落文件自动归档至 `~/.gemini/config/.agy-loop-backup-<timestamp>/` |
| `npx agy-loop doctor [--json]` | 检查 `agy` 版本、插件启用状态（`agy plugin list --json`）、同名遮蔽文件、`skills.json` 的 `include_only`/`exclude` 过滤规则及当前生效的 `loop.md`（支持 `status` 别名） |
| `npx agy-loop validate [--json]` | 对插件目录执行 `agy plugin validate --strict` 官方严格校验 |
| `npx agy-loop uninstall` | 调用 `agy plugin uninstall agy-loop` 干净卸载插件（支持 `remove` 别名） |

```bash
npx agy-loop doctor
# 输出结构化 JSON 诊断报告：
npx agy-loop doctor --json
```

### 零残留干净卸载

随时可通过任一方式完整卸载 `agy-loop`：

```bash
# 通过 npm 桥接器卸载：
npx agy-loop uninstall

# 通过 Antigravity 原生 CLI 卸载：
agy plugin uninstall agy-loop

# 通过一行远程脚本或本地脚本卸载：
curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/uninstall.sh | sh
./uninstall.sh
```

### 本地开发与严格校验

有关三回合响应式非阻塞状态机、任务与节奏解析流程、4 行无围栏输出契约以及沙箱/Worktree 隔离模型的完整技术细节，请参阅 [**ARCHITECTURE.md**](ARCHITECTURE.md)。

```bash
sh -n install.sh uninstall.sh skills/loop/scripts/loop-helper.sh  # 检查纯 POSIX sh 语法合规性
npm test                                                          # 运行隔离 HOME 的单元与端到端集成测试
agy plugin validate --strict .                                    # 执行 Antigravity v1 插件严格规范校验（0 告警）
```

---

## 📄 开源协议

基于 [**MIT License**](LICENSE) 协议开源发布，Copyright © Max。
