# Antigravity Console for Paseo

Multi-account management, model-aware automatic fallback, quota and API cost analytics, subagent inspection, interactive question cards, and Orchestrator model control for [Paseo](https://paseo.sh)'s built-in Antigravity provider.

Works across Paseo desktop, web, and mobile (iOS & Android), with English and Simplified Chinese (`zh-CN`) localization.

![Usage in Antigravity Console](assets/console.png)

![Subagents panel](assets/subagents.png)

![Accounts and settings](assets/accounts.png)

| Interactive `ask_question` cards | Subagents in the timeline |
| --- | --- |
| ![Interactive question cards](assets/questions.png) | ![Subagent cards](assets/timeline.png) |

## Features

- **Multiple Google accounts & agent migration**
  - Add any number of Google accounts alongside the system sign-in stored in `agy`'s keychain, using a guided browser OAuth code / redirect-URL flow.
  - Reorder account priority, choose the default account for new agents, rename accounts (including display name for the system sign-in), sign in again, sign out, or remove accounts.
  - Switch an active agent's account mid-conversation (**immediately** or **after the current turn** when running) without losing conversation history.
  - Inspect all active agents running on an account (**Agents on this account…**), jump straight to any agent, or bulk-migrate agents to another signed-in account (`Switch after turn`, `Skip running`, or `Switch immediately`).
  - Inspect and recover files saved inside a profile account's isolated `HOME` (**Saved home files…**) to `~/Antigravity Console/<account>` at any time without removing the account.

- **Model-aware automatic fallback & cooldowns**
  - Classifies failed turns into `quota` (`429` / rate limits), `auth` (`401` / `403`), `transient` (`5xx`, timeouts, network, unexpected exit), and general errors.
  - Retries temporary failures on the current account (`0–3` configurable retries), then switches to the next eligible account and sends `"Continue."` to resume automatically.
  - Matches both **model availability** (`agy models`) and the **model's quota pool** (`Gemini` vs `Claude / GPT`) so an agent never fails over onto an account that lacks its model or has exhausted that pool.
  - Three selection strategies: **Priority order**, **Most remaining quota**, or **Soonest quota reset** (spend quota that resets earliest first).
  - Exclude individual accounts from automatic switching (**Manual only**), view active per-pool cooldown countdowns on each account card, and clear cooldowns with one click (**Resume now**). Every retry and switch is recorded inline in the agent timeline.

- **Live quota meters & Paseo Usage integration**
  - Displays each account's Google AI plan (such as `Google AI Pro` or `Google AI Ultra` via `agy acp`) and remaining `5h`, `weekly`, `daily`, or `monthly` quota meters with reset countdowns.
  - Adds a compact **Sidebar Footer** bar showing the default account's `5H` and `7D` remaining quota at a glance.
  - Registers all added profile accounts as a Paseo usage source so they appear alongside the system sign-in in Paseo's built-in **Usage** view.

- **Usage analytics & customizable API cost estimates**
  - A GitHub-style **daily token calendar** covers the last year (fewer weeks on narrow screens), shaded by quartiles of your active days, with active days, busiest day, average per active day, and current streak. Hover or tap a day for its tokens, requests, and cost.
  - Tracks total tokens (input, cached, and output), estimated USD cost, requests, output speed (`tok/s`), cache hit rate, and time to first token across **24 hours** (hourly), **7 days** (6-hour), or **30 days** (DST-safe calendar days).
  - Filter by **conversation scope** (`All`, `Main`, `Subagents`), **attributed account** (showing per-account request count and cost), or **model** (click any model row to filter the whole dashboard, calendar included).
  - Click a stat tile to chart that metric; hover a bar to read every metric for that period.
  - The per-model table sorts by any column, shows each model's share of the sorted total, and ends with a totals row.
  - Built-in official token pricing for Google AI Studio, Anthropic, and OpenAI models (including scheduled rate changes and `>200K` long-context tiers). Open **API pricing** (or click any model's cost) to customize input/cached/output and `>200K` rates, add custom model keys, or reset to official defaults.

- **Subagents timeline cards, workspace badges, & inspector panel**
  - Replaces raw `invoke_subagent` tool calls in the timeline with live status cards showing role, type, task preview, current tool or thinking status, step count, elapsed time, output tokens, and estimated cost; condenses `manage_subagents` (`list`, `kill`, `kill_all`) into one-line summaries.
  - Displays a live running-subagent count badge on workspace rows in the sidebar while subagents are active.
  - Dedicated **Subagents** agent panel (split master-detail on desktop, stacked navigation on mobile) with nested hierarchy indentation, search, state filters (`All`, `Running`, `Failed`), token split bar (`Cache`, `New input`, `Output`), expandable task and Markdown report, **Insert into composer** to drop a subagent's report into the parent prompt, **Artifacts** browser with inline Markdown/text preview (up to 256 KiB), filterable step-by-step activity log (`All`, `Tools`, `Errors`, search, `Follow` auto-scroll), and one-click full Markdown transcript copy.

- **Interactive `ask_question` choice cards**
  - Renders Antigravity's `ask_question` tool calls as interactive choice cards supporting single-select radios, multi-select checkboxes, multi-question tabs, `Recommended` badges, custom `Other` free-text input, **Skip**, and **Edit in composer**.
  - Hides the duplicate plain-text `- [1] ...` list printed by `agy acp`, delivers replies via `steer` so deferred turns resume immediately without interrupting running tools or subagents, and collapses answered or historical cards into compact read-only summaries.

- **Orchestrator planner & executor control**
  - Choose Antigravity Orchestrator's **Planner** and **Executor** models and reasoning effort globally (saved to `~/.gemini/antigravity-cli/settings.json`), apply one-click **Quick presets** (`agy default`, `Max quality`, `Balanced`), see warnings when signed-in accounts lack a selected model family, or set **Per-account Orchestrator overrides** on individual profile accounts.
  - Adjust on the fly from the composer pill on `gemini-pro-orchestrator*` agents or with `/orchestrator`.

- **Context window meter**
  - Shows a composer pill (`used / window · %`) and detailed popover (`Cache reads`, `New input`, `Output`, window size source, and last update time) read from `agy`'s conversation logs whenever Paseo does not already display a native context meter for that agent.

## Where to Find Everything in Paseo

| Surface | Entry / Action | Purpose |
| --- | --- | --- |
| **Screen & Settings** | **Command Center** → `Antigravity Console`, **Settings → Antigravity Console**, or click the **Sidebar Footer** meters | Full console: Usage & API pricing, Accounts grid, Fallback & Orchestrator settings |
| **Command Center** | `Refresh Antigravity quotas` (`⌘K` / `Ctrl+K`) | Re-check sign-in, plan, and quota across all accounts |
| **Draft Composer** | **Account** selector | Pick which Google account a new Antigravity agent launches on |
| **Agent Composer Pills** | **Account**, **Context**, **Subagents**, **Orchestrator** | Switch account, inspect context tokens, open the Subagents panel, or change Orchestrator models |
| **Slash Command** | `/account [name or number]` | List accounts with current selection, or switch the current agent to another account |
| **Slash Command** | `/orchestrator [default\|quality\|balanced\|planner <model>\|executor <model>]` | Inspect or change Orchestrator planner/executor models or apply a preset |
| **Workspace Sidebar** | Running subagents badge | Shows active subagent count per workspace |
| **Agent Timeline** | Subagent cards, Question cards, Fallback notes | Live subagent status, interactive `ask_question` forms, and retry/switch audit rows |

## Install

Requires **Paseo `>=0.17.1`** and the **Antigravity CLI** (`agy` `1.5.13` or later; Orchestrator planner/executor settings require `1.5.14`) on the daemon host. Tested on macOS daemon hosts; client UI runs on macOS, web, iOS, and Android.

From the Paseo plugin registry (or **Settings → Plugins** inside Paseo):

```bash
paseo plugin add kel077/antigravity-console
```

Or directly from GitHub:

```bash
paseo plugin add git:Kel077/paseo-antigravity-console
```

Then open **Antigravity Console** from the Command Center (or click the quota meters in the sidebar footer) and choose **Add account**.

## How It Works & Data Access

Paseo launches `agy` for every Antigravity agent. This plugin hooks those launches on the daemon host:

- **Profile isolation**: Each added account gets its own `HOME` under `~/.paseo/plugin-data/antigravity-accounts/profiles/<id>/`. Top-level entries symlink back to your real home folder so agents still see your files and tools, while `agy` stores only that account's file-based sign-in inside the profile instead of the system keychain. Conversation directories link back to `~/.gemini/antigravity-cli`, so all accounts share conversations and agents can switch accounts mid-thread. If credentials ever land outside a profile, the plugin disables that profile to protect the system sign-in.
- **Settings sync & overrides**: Before launching on an added account, the plugin atomically copies `~/.gemini/antigravity-cli/settings.json` into the profile and merges any per-account Orchestrator override. Global Orchestrator choices write the `orchestrator` field of `~/.gemini/antigravity-cli/settings.json`.
- **Safe file recovery**: Files an agent creates directly inside a profile `HOME` can be recovered anytime (or automatically during account removal) to `~/Antigravity Console/<account name>`. When the profile and recovery folders are on different filesystem volumes, recovery copies files while preserving the originals in place, and account removal cleans up verified unchanged entries without following symlinks.
- **Local reads & zero external network traffic**: Quota (`agy -p /usage`), plans (`agy acp`), model lists (`agy models`), and sign-in run the local `agy` binary on the daemon host. Usage statistics, context window meters, and subagent transcripts/artifacts (symlink-checked with `lstat`, preview capped at 256 KiB) read `~/.gemini/antigravity-cli`. Submitting or skipping an interactive question card sends that reply message to the agent through Paseo. The plugin makes **no network requests of its own**, never reads the macOS keychain, and stores its account list, quota cache, custom pricing (`pricing.json`), and conversation-to-account attribution (`conversation-turn-accounts.json`) inside `~/.paseo/plugin-data/antigravity-accounts/`.

See [OVERVIEW.md](OVERVIEW.md) ([简体中文](OVERVIEW.zh-CN.md)) for the full listing summary and known limits.

## Development

```bash
npm install
npm run typecheck
paseo plugin install "$PWD" --id antigravity-accounts   # install from local checkout
paseo plugin reload antigravity-accounts                # reload after edits
paseo plugin logs antigravity-accounts                  # inspect daemon-side logs
```

The plugin uses only runtime modules supplied by Paseo (`react`, `react-native`, `@tanstack/react-query`, `zod`, `@getpaseo/plugin`), so it has zero runtime `dependencies` and no build step.

## License

[MIT](LICENSE)

Antigravity and the Antigravity logo are trademarks of Google LLC. This project is not affiliated with or endorsed by Google or Paseo.
