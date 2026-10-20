# Codex usage research

> **Naming note:** Mingle was named Relay when these observations were recorded. Historical commands, paths, tool names and artifact receipts are retained. See [current naming and data compatibility](mingle-rename.md).

Checked on 2026-10-20 against Codex CLI `0.160.1` and a fresh `codex app-server generate-json-schema` bundle. The protocol reference is the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server), especially its [rate limits section](https://learn.chatgpt.com/docs/app-server#rate-limits-chatgpt) and [earned reset details](https://learn.chatgpt.com/docs/app-server#earned-rate-limit-resets-chatgpt).

## Read-only request

After JSON-RPC `initialize` / `initialized`, Relay calls only `account/rateLimits/read`. It does not call `account/read`, `account/usage/read`, reset-credit consumption, login/logout, model/turn methods, or file-based credential APIs. The request is short-lived and bounded; Relay closes the child process group on success and failure. The CLI uses its own configured sign-in, and Relay neither reads nor returns auth files, account IDs, emails, or provider-side diagnostics that could contain private account information.

The native endpoint is account-level and requires authentication supported by Codex services. The official reference documents ChatGPT-backed authentication for usage reporting; API-key-only and Bedrock authentication do not provide the account token-usage endpoint. When the rate-limit request is unavailable, Relay returns an unavailable status with a generic retry notice.

## Native fields and Relay mapping

The fresh schema's `GetAccountRateLimitsResponse` has a backward-compatible `rateLimits` snapshot and an optional `rateLimitsByLimitId` map. Relay uses the map when present and falls back to the legacy snapshot only when that map is absent or null, avoiding duplicates. Each bucket can report `primary` and `secondary` windows with `usedPercent`, `windowDurationMins`, and epoch-second `resetsAt`; missing values remain `null`. The map supports multiple meter buckets, which Relay retains as separate windows with their bucket as scope.

Relay labels a primary 300-minute window `Session`, and a 10,080-minute window `Weekly`. Other windows use their reported bucket and duration; these labels are not inferred from model names. Reset timestamps are converted from the provider's epoch seconds to ISO strings.

`planType` is read from limit snapshots. `credits` may report a string balance and an `unlimited` flag. The native credits shape supplies no unit or reset timestamp, so Relay reports those fields as `null`; it does not estimate money or replenish dates. If multiple buckets report conflicting plan or balance data, Relay leaves the singular aggregate field unknown and adds a notice.

`rateLimitResetCredits.availableCount` is authoritative when returned. `credits: null` means details are unknown; an empty array means details were fetched and no grants were returned. Detail rows may be capped by the service, so Relay preserves the count independently and only reports returned available grant rows. Grant expiry and grant time are native timestamps; `replenishesAt` stays `null` because the endpoint provides no replenishment date. This read-only feature never consumes a reset.

These quotas belong to the Codex account and are shared across conversations. Relay's session-level token and cost counters remain separate and are not inferred from account quota percentages.
