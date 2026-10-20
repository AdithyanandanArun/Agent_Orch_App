# Milestones and evidence

The product has a multi-month horizon. Milestones are accepted by observed behavior rather than dates or the number of visible features. The original vision in vision.md remains the product scope.

| Milestone | Required evidence |
| --- | --- |
| Research and experience | Supported provider interfaces identified; original workspace workflow specified; provider access and commercial assumptions recorded. |
| Local foundation | Open a real project, run a provider session, inspect/edit code, use a terminal, interrupt safely, and restore state after restart. Usable with one agent. |
| Two-agent collaboration | Independent provider sessions in distinct worktrees. One produces a committed contract; the receiver consumes the exact revision and implements against it. Integrated feature passes its acceptance checks with measured human interventions. |
| Reliable orchestration | Dependency scheduling, context retrieval, conflict detection and controlled integration handle repeated real tasks. Compare accepted task time, token use, rework and cost against manual sessions. |
| Two-computer collaboration | Authenticated membership and owner-scoped actions work across machines. Disconnect, reconnect, replay, duplicate delivery and revoked permissions are exercised. Credentials remain under their owner's control. |
| Product release | Keyboard and voice flows, browser ownership, actionable graph, desktop packaging and updates, team controls and support documentation survive external-user feedback. |

## Foundation acceptance scenarios

- Provider errors remain visible and do not lose the user's prompt.
- A second prompt cannot start an overlapping turn in one session.
- Interrupting a run ends its outstanding approvals and preserves its transcript.
- Restarting the server never restores a stale approval as actionable.
- Opening a different project cannot expose another project's sessions or task dependencies through a mutation.
- File traversal, symlink escapes and unsafe Git revision inputs are rejected.
- A failed dependency cannot be bypassed by assigning a downstream task a different owner.
- An artifact handoff identifies immutable source content and does not silently change the destination checkout.
- A terminal belongs to the browser connection that created it and stops on disconnect.
- The example workspace stays clearly identified and starts no paid inference.

## Product validation

Use the same feature request, repository, acceptance criteria and quality bar to compare manual multi-session work with Relay. Measure total time until integrated acceptance, human coordination actions, total provider tokens and cost, conflicts, rework and blocked time. Adding agents is useful when the accepted result improves enough to justify their overhead. Record failures as well as successes.

## Repository workflow progress — 2026-10-20

These items record implemented work and previously requested capabilities still outside the current pass. They are also explicit sources for Relay's repository task tracking.

- [x] Show the real checkout and branch, and commit selected eligible files while preserving other staged work.
- [x] Add explicit push and pull request controls without automatic publishing.
- [x] Show read-only GitHub checks and workflow history with each run's commit.
- [x] Populate project components, languages and Git context from an existing repository or local folder.
- [x] Track repository checklists, session work requests and native provider plans automatically, preserving manual edits.
- [x] Populate Activity and Agent Map from actual repository, session, task and provider records.
- [ ] Add composer attachments and file mentions.
- [ ] Add native interactive questions and full planning controls.
- [ ] Add personal Claude skill discovery and general MCP/plugin management.
- [ ] Complete AUR publication and desktop update distribution after owner-approved release preparation.
