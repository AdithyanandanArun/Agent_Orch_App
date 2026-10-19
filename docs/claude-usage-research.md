# Claude native usage research

Research checked 2026-10-20 against Anthropic's Agent SDK documentation and the installed `@anthropic-ai/claude-agent-sdk@0.3.302` declarations.

## Native usage API

The SDK exposes `/usage` through `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`. The method is explicitly experimental. `skipBehaviors` avoids scanning local transcripts, which is not needed to display account plan limits. Relay invokes the SDK query with the existing held-open prompt iterator; it yields no user messages and closes after the metadata control request or the shared 15 second deadline.

The response includes `subscription_type`, `rate_limits_available`, and optional `rate_limits`. Relay maps the SDK's five-hour, seven-day, OAuth-app, Opus, Sonnet, and per-model weekly utilization rows directly to usage windows. It preserves finite utilization values, including values above 100, and computes remaining percentage as `max(0, 100 - used)`; it never reports negative remaining capacity. Reset fields accept the SDK's documented ISO string and normalize numeric epoch values if a runtime version returns them.

The SDK says rate limits are unavailable when they do not apply to the session, including API-key and third-party provider sessions, or when required profile scope is missing. Relay returns `partial` when plan metadata is still available, otherwise `unavailable`, with no plan-limit rows and a notice. It does not turn unavailable limits into zero usage. Optional null windows are omitted rather than presented as additional applicable limits.

## Credits and resets

The SDK can report `extra_usage.monthly_limit`, `used_credits`, `utilization`, `is_enabled`, and `currency`, but the installed declaration does not define a usable balance denomination or a replenishment date. Relay shows the native utilization percentage as an extra-usage window, with no invented duration or reset time. It leaves `credits` null and adds a notice that the SDK does not expose a spendable credit balance or credit reset date. It does not infer a balance from cost, token usage, monthly limits, or used credits.

The usage response contains reset timestamps for individual plan windows, but it does not expose reset-grant records or a separate replenishment schedule. Relay leaves `resets` null rather than inventing reset availability. The current SDK response also does not expose a displayable unlimited-credit flag, so Relay leaves that field null.

## Privacy and failure handling

Relay consumes only documented response fields and bounds labels/window count. It does not read credential files, extract tokens, call OAuth endpoints, expose the raw usage response, or include raw SDK errors in notices. If the SDK command, authentication, or usage request fails, Relay returns an unavailable usage result with a generic notice. Session cost and token totals are not treated as account usage limits; Relay's local conversation cost remains a separate value.

## Sources

- [Claude Agent SDK: Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Claude Agent SDK: TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Installed package declarations: `@anthropic-ai/claude-agent-sdk@0.3.302`, especially `sdk.d.ts` (`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` and `SDKControlGetUsageResponse`).
