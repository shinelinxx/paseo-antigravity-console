# Antigravity Console for Paseo（简体中文）

[English](README.md) | 简体中文

为 [Paseo](https://paseo.sh) 内置 Antigravity Provider 提供多账号管理、模型感知自动故障切换、配额与 API 成本分析、子 Agent 检视、交互式提问卡片以及 Orchestrator 模型编排控制。

支持 Paseo 桌面端、Web 端与移动端（iOS / Android），内置英文与简体中文（`zh-CN`）双语界面。

![Antigravity Console 用量统计](assets/console.png)

![Subagents 子 Agent 面板](assets/subagents.png)

![账号与设置](assets/accounts.png)

| 交互式 `ask_question` 卡片 | 时间线中的 Subagents 卡片 |
| --- | --- |
| ![交互式提问卡片](assets/questions.png) | ![子 Agent 卡片](assets/timeline.png) |

## 核心功能

- **多 Google 账号管理与会话迁移**
  - 在保留 `agy` 系统钥匙串登录的基础上，通过引导式浏览器 OAuth 授权码 / 回调 URL 流程添加任意数量的额外 Google 账号。
  - 支持调整账号优先级排序、设置新会话默认账号、重命名账号（包括为系统登录账号设置显示名）、重新登录、退出登录与移除账号。
  - 支持在对话中途切换当前活跃 Agent 的账号（运行中可选择**立即切换**或**当前回合结束后切换**），不丢失对话上下文。
  - 可查看指定账号下全部运行中的 Agent（**此账号上的 Agent…**），一键跳转或批量迁移至其他已登录账号（`回合结束后切换`、`跳过运行中` 或 `立即切换`）。
  - 随时检查并恢复独立账号 `HOME` 目录中保存的文件（**已保存的主目录文件…**）至 `~/Antigravity Console/<account>`，无需先移除账号。

- **模型感知自动故障切换与冷却机制**
  - 自动将失败回合分类为 `quota`（`429` / 限流）、`auth`（`401` / `403`）、`transient`（`5xx`、超时、网络异常、意外退出）及常规错误。
  - 临时故障先在当前账号重试（可配置 `0–3` 次），耗尽后自动切换至下一个可用账号并发送 `"Continue."` 无缝续跑。
  - 同时校验**模型可用性**（`agy models`）与**所属配额池**（`Gemini` 与 `Claude / GPT`），避免切换到不支持该模型或对应配额池已耗尽的账号。
  - 提供三种账号选择策略：**按优先级顺序**、**剩余配额最多**、**最早重置配额优先**（优先消耗即将重置的配额）。
  - 支持将单个账号设为**仅手动选择**（不参与自动故障切换），在账号卡片展示各配额池的实时冷却倒计时并支持一键解除冷却（**立即恢复**）；每次重试与切换都会记录在 Agent 时间线中。

- **实时配额表与 Paseo Usage 集成**
  - 展示每个账号的 Google AI 订阅方案（如通过 `agy acp` 获取的 `Google AI Pro` / `Google AI Ultra`）及 `5h`、`weekly`、`daily`、`monthly` 剩余配额进度条与重置倒计时。
  - 在**侧边栏底部**提供紧凑配额栏，一眼掌握默认账号的 `5H` 与 `7D` 剩余配额。
  - 将所有已添加账号注册为 Paseo 用量数据源，与系统登录账号一同展示在 Paseo 内置的 **Usage** 页面中。

- **用量分析与可定制 API 成本估算**
  - 提供 GitHub 风格的**每日 Token 热力日历**（覆盖近一年，窄屏自动缩减周数），按活跃日四分位数着色，统计活跃天数、最忙单日、活跃日均与当前连续天数，悬停或点击任意日期查看当日 Token、请求数与费用。
  - 按 **24 小时**（逐小时）、**7 天**（6 小时粒度）或 **30 天**（兼容夏令时的自然日）追踪总 Token（输入、缓存命中、输出）、估算美元成本、请求次数、输出速度（`tok/s`）、缓存命中率与首字延迟（TTFT）。
  - 支持按**会话范围**（`全部`、`主会话`、`子 Agent`）、**归属账号**（显示单账号请求数与成本）或**模型**（点击任意模型行即可联动过滤整个看板与热力日历）筛选。
  - 点击统计磁贴切换对应指标柱状图，悬停柱体查看该时段完整指标。
  - 按模型明细表支持任意列排序、展示各模型占比并在底部汇总。
  - 内置 Google AI Studio、Anthropic 与 OpenAI 官方 Token 定价（含定时调价与 `>200K` 长上下文阶梯价）；打开 **API 定价**（或点击任意模型费用）即可自定义输入/缓存/输出与 `>200K` 单价、新增自定义模型 Key 或恢复官方默认值。

- **Subagents 时间线卡片、工作区角标与检视面板**
  - 将时间线中原始的 `invoke_subagent` 工具调用替换为实时状态卡片，展示角色、类型、任务预览、当前工具或思考状态、步数、耗时、输出 Token 与估算费用；将 `manage_subagents`（`list`、`kill`、`kill_all`）折叠为单行摘要。
  - 当工作区存在运行中的子 Agent 时，在侧边栏工作区行上显示实时数量角标。
  - 专属 **Subagents** Agent 面板（桌面端主从分栏，移动端堆叠导航），支持嵌套层级缩进、搜索、状态筛选（`全部`、`运行中`、`失败`）、Token 构成条（`缓存`、`新输入`、`输出`）、可展开的任务与 Markdown 汇报、**插入到输入框**（将子 Agent 报告回填父会话提示词）、**产物（Artifacts）**浏览器（支持最大 256 KiB 的 Markdown/纯文本内联预览）、可筛选的逐步活动日志（`全部`、`工具`、`错误`、搜索、`跟随`自动滚动）以及一键复制完整 Markdown 对话记录。

- **交互式 `ask_question` 选择卡片**
  - 将 Antigravity 的 `ask_question` 工具调用渲染为交互式表单卡片，支持单选、多选、多问题分页标签、`Recommended` 推荐角标、`Other` 自定义输入、**跳过**与**在输入框中编辑**。
  - 自动隐藏 `agy acp` 重复输出的纯文本 `- [1] ...` 列表，通过 `steer` 投递回复以立即唤醒挂起回合且不打断运行中的工具或子 Agent，并将已回答或历史卡片折叠为紧凑只读摘要。

- **Orchestrator 规划器与执行器控制**
  - 全局配置 Antigravity Orchestrator 的 **Planner（规划器）** 与 **Executor（执行器）** 模型及思考强度（保存至 `~/.gemini/antigravity-cli/settings.json`），支持一键**快捷预设**（`agy 默认`、`最高质量`、`均衡`），当已登录账号缺少所选模型族时自动告警，并支持为单个独立账号配置**专属 Orchestrator 覆盖项**。
  - 在 `gemini-pro-orchestrator*` 会话中可通过输入框胶囊或 `/orchestrator` 随时动态调整。

- **上下文窗口仪表**
  - 当 Paseo 尚未为某 Agent 展示原生上下文仪表时，从 `agy` 会话日志读取上下文占用，并在输入框胶囊（`已用 / 窗口 · %`）及详情弹窗中展示 `缓存读取`、`新输入`、`输出`、窗口大小来源与最后更新时间。

## 在 Paseo 中的入口分布

| 位置 | 入口 / 操作 | 用途 |
| --- | --- | --- |
| **主页面与设置** | **Command Center** → `Antigravity Console`、**设置 → Antigravity Console**，或点击**侧边栏底部**配额栏 | 完整控制台：用量与 API 定价、账号网格、故障切换与 Orchestrator 设置 |
| **Command Center** | `Refresh Antigravity quotas`（`⌘K` / `Ctrl+K`） | 重新检查所有账号的登录状态、订阅方案与剩余配额 |
| **草稿输入框** | **账号**选择器 | 为新建的 Antigravity Agent 指定启动 Google 账号 |
| **Agent 输入框胶囊** | **账号**、**上下文**、**子 Agent**、**Orchestrator** | 切换账号、查看上下文 Token、打开子 Agent 面板或调整 Orchestrator 模型 |
| **斜杠命令** | `/account [名称或序号]` | 列出全部账号及当前选中项，或将当前 Agent 切换到另一账号 |
| **斜杠命令** | `/orchestrator [default\|quality\|balanced\|planner <model>\|executor <model>]` | 查看/修改 Orchestrator 规划器与执行器模型或应用预设 |
| **工作区侧边栏** | 运行中子 Agent 角标 | 显示各工作区当前活跃子 Agent 数量 |
| **Agent 时间线** | 子 Agent 卡片、提问卡片、故障切换记录 | 实时子 Agent 状态、交互式 `ask_question` 表单以及重试/切换审计行 |

## 安装

需要宿主 Daemon 运行 **Paseo `>=0.17.1`** 与 **Antigravity CLI**（`agy` `1.5.13` 及以上；Orchestrator 规划器/执行器设置需要 `1.5.14`）。已在 macOS 宿主机测试通过；客户端界面支持 macOS、Web、iOS 与 Android。

从 Paseo 插件市场（或 Paseo 内 **设置 → 插件**）安装：

```bash
paseo plugin add kel077/antigravity-console
```

或直接从 GitHub 安装：

```bash
paseo plugin add git:Kel077/paseo-antigravity-console
```

安装完成后，通过 Command Center 打开 **Antigravity Console**（或点击侧边栏底部配额条），选择 **添加账号** 即可开始使用。

## 工作原理与数据访问说明

Paseo 会为每个 Antigravity Agent 启动 `agy`，本插件在宿主机 Daemon 侧拦截并增强这些启动流程：

- **Profile 隔离**：每个额外添加的账号都在 `~/.paseo/plugin-data/antigravity-accounts/profiles/<id>/` 下拥有独立 `HOME`。顶层目录通过符号链接映射回你的真实主目录，保证 Agent 仍可访问原有文件与工具；而 `agy` 仅将该账号的文件登录凭据写入独立 profile，不触碰系统钥匙串。会话目录链接回 `~/.gemini/antigravity-cli`，因此多账号共享会话历史且支持对话中途无缝切换。若凭据意外落盘到 profile 之外，插件会自动禁用该 profile 以保护系统登录。
- **配置同步与覆盖**：以额外账号启动前，插件会原子同步 `~/.gemini/antigravity-cli/settings.json` 至对应 profile，并合并单账号 Orchestrator 覆盖配置。全局 Orchestrator 选项写入 `~/.gemini/antigravity-cli/settings.json` 的 `orchestrator` 字段。
- **安全文件恢复**：Agent 直接创建在 profile `HOME` 内的文件可随时恢复（或在移除账号时自动恢复）至 `~/Antigravity Console/<account name>`。跨卷恢复时会保留原文件副本，移除账号时仅清理经校验未变动的条目且不跟随符号链接。
- **纯本地读取、零额外外网请求**：配额（`agy -p /usage`）、订阅方案（`agy acp`）、模型列表（`agy models`）与登录均调用宿主机本地 `agy` 二进制文件；用量统计、上下文窗口与子 Agent 日志/产物（经 `lstat` 符号链接校验且预览上限 256 KiB）均读取本地 `~/.gemini/antigravity-cli`。提交或跳过交互式提问卡片仅通过 Paseo 向 Agent 发送回复消息。插件**自身不发起任何外部网络请求**、不读取 macOS 钥匙串，仅将账号列表、配额缓存、自定义定价（`pricing.json`）与会话账号归属（`conversation-turn-accounts.json`）保存在 `~/.paseo/plugin-data/antigravity-accounts/`。

完整插件市场介绍与已知限制请参阅 [OVERVIEW.md](OVERVIEW.md)（[简体中文](OVERVIEW.zh-CN.md)）。

## 本地开发

```bash
npm install
npm run typecheck
paseo plugin install "$PWD" --id antigravity-accounts   # 从本地目录安装
paseo plugin reload antigravity-accounts                # 修改后热重载
paseo plugin logs antigravity-accounts                  # 查看宿主机日志
```

本插件仅使用 Paseo 宿主提供的运行时模块（`react`、`react-native`、`@tanstack/react-query`、`zod`、`@getpaseo/plugin`），无运行时 `dependencies` 且无需构建步骤。

## 许可证

[MIT](LICENSE)

Antigravity 及 Antigravity 标志为 Google LLC 商标。本项目与 Google 或 Paseo 无官方隶属或背书关系。
