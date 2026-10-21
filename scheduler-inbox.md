# Scheduler handoff

## Stall evidence persistence fails during settlement

- **Reproduction:** `pnpm --filter @mingle/server exec vitest run src/autonomy.integration.test.ts -t 'deduplicates repeated failed command'`. A fake provider emits three identical failed `tool.activity` command events in one completed run; settlement calls `GroupRepo.recordStallEvidence`.
- **Expected:** repeated evidence from the same `sourceRunId` is deduplicated and one evidence record is persisted with count 1; the group delivery settles normally.
- **Actual:** SQLite throws `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint` from `apps/server/src/groups/repo.ts:481`, through `GroupService.recordStallSignal` and `settle`. The evidence is not recorded and the integration test cannot reach its assertion.

## Runtime idle leaves the group delivery running

- **Reproduction:** send one group message with a fake provider that returns successfully, then wait until `runtime.activeCount()` is 0. The group snapshot still has the delivery in `running` and the request remains active; the event history has `group.delivery.started` but no completion event. The new test helper manually invokes the group's normal `onRunFinished` callback to continue testing settlement behavior.
- **Expected:** runtime-idle reconciliation settles the finished delivery and advances or completes the request without a test-only callback.
- **Actual:** the delivery remains `running` after provider cleanup, preventing a queued same-request message from starting.

## Task status is counted as verified progress

- **Reproduction:** the sixth case in `apps/server/src/autonomy.integration.test.ts` records a changed `group.status` event during each run, emits the same failed command, and expects the member to be held after three distinct runs.
- **Expected:** status-only changes do not erase repeated-action evidence without a successful host-recorded check, a verified artifact, or an independently verified task transition.
- **Actual:** `GroupService.verifiedProgress` currently treats any changed `group.status` event since run start as verified progress. The test is presently blocked earlier by the stall-evidence persistence failure; it should be rerun after that is fixed.
