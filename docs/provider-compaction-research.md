# Provider auto-compaction controls — research and mapping

Researched 2026-10-20 against Codex CLI 0.160.1 (app-server schema generated with `codex app-server generate-json-schema`) and `@anthropic-ai/claude-agent-sdk` 0.3.302. Implementation: `apps/server/src/providers/compaction.ts`, wired from the Codex and Claude adapters.

## Setting semantics

`AppSettings.autoCompactPercent?: number | null` — integer 1–95. `null`/`undefined` means the provider's native default: Relay sets nothing and never disables native compaction. Non-integer or out-of-range stored values are ignored (treated as native), not clamped. No model context window is invented anywhere; capacity is always reported by the provider or read from the provider's own catalog.

## Claude Code

Sources: https://code.claude.com/docs/en/env-vars, https://code.claude.com/docs/en/model-config.

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100): percentage of the auto-compact window at which compaction triggers. It can only lower the threshold; values above the default are ignored; it applies to the main conversation and subagents.
- Relay sets it on the SDK child's `env` only when a percentage is configured. With the native default it adds nothing and does not remove an inherited value, so a user's own shell configuration still behaves natively.
- Alternatives rejected: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `autoCompactWindow` take absolute tokens (100K–1M), which would need a model window Relay does not know, and cannot express a 1–95% threshold on 1M models.
- Visibility: the adapter surfaces SDK `system/compact_boundary` (trigger, `pre_tokens`, `post_tokens`) and `system/status` with `compact_result: 'failed'` as info notices. The existing message mapper ignores these.
- **Limitation (verified 2026-10-20):** `Query.getContextUsage().autoCompactThreshold` (metadata only, no inference) is unchanged by `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (967,000 for `claude-sonnet-5-5`, 167,000 for `claude-haiku-4-5` at 50 and 100), while `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` does change it (to 167,000). The CLI binary references the override in its autocompact decision, so the variable is presumed effective, but this report does not reflect it and actual triggering was not verified because that needs a paid run. The docs also say it applies only to sessions that compact before the model's hard limit.

## Codex

Sources: https://developers.openai.com/codex/config-reference/ (now served from learn.chatgpt.com), generated app-server schema.

- `model_auto_compact_token_limit`: absolute token threshold (unset uses model defaults). `model_auto_compact_token_limit_scope` (`total` default). `model_context_window`: window available to the active model.
- `thread/start` and `thread/resume` accept `config` (per-thread overrides). Verified without inference: a valid override is accepted, and `"abc"` for `model_auto_compact_token_limit` fails with `invalid type: string "abc", expected i64`, so the override is parsed against the typed config. Whether the limit then triggers compaction at that size needs a paid run and was not observed. `turn/start` has no config field, but Relay starts a new app-server per run and always sends the override on start/resume. The user's `config.toml` is never edited.
- Percentage → tokens: `limit = floor(effectiveWindow × percent / 100)`. The effective window is the one Codex reports in `thread/tokenUsage/updated.modelContextWindow`; local session logs show it equals `context_window × effective_context_window_percent / 100` (272,000 × 95% = 258,400; 500,000 × 95% = 475,000).
- Capacity discovery before the first turn (no notification exists yet):
  1. an effective window Codex reported earlier in the same server process (bounded cache, keyed by model);
  2. `config/read` `model_context_window` (null unless the user configured one) or the catalog `context_window`, scaled by the catalog's `effective_context_window_percent`.
  `model/list` carries no context window. The catalog values come from `$CODEX_HOME/models_cache.json` (default `~/.codex`), the CLI's own model cache; only that file is read, only the numeric `context_window` / `effective_context_window_percent` of the session's model are used, and credentials in the same directory are never opened. The file format is not a documented API and may change; a failed read is treated as unknown capacity.
- Unknown capacity: nothing is overridden (native compaction stays on) and a one-time-per-model info notice explains that the threshold could not be applied.
- Verification: on the first token-usage notification Relay compares the assumed window with the reported one, learns the reported value for later runs, and adds an info notice if they differ.
- Visibility: completed `contextCompaction` items produce an info notice that includes the Relay percentage and token limit when one was applied. The deprecated `thread/compacted` notification is not used.
- Not verified: whether Codex clamps a limit above its own native default (the 90–95% range may be a no-op, analogous to Claude's "cannot raise" rule).

## Context usage event (proposal for root)

Not wired because `AdapterEvent` has no such member. Suggested contract: `{ type: 'context'; usedTokens: number; contextWindow: number | null }`. `codexContextUsage(tokenUsage)` returns that shape from `thread/tokenUsage/updated` (used = `last.totalTokens`, an estimate; window = reported effective window). For Claude the result message's `modelUsage[model].contextWindow` and `Query.getContextUsage()` (`total_tokens`, `raw_max_tokens`) can feed it. Wiring is one `emit` in `CodexRun.checkReportedWindow` and in the Claude result handling.
