# Workspace simplification — 2026-10-19

The first workspace exposed too many panels, badges and setup controls at once. The initial simplification prioritized the conversation. A subsequent design pass uses the user's supplied T3 Code screenshot as its visual reference, with original implementation throughout.

## T3 Code references

- [Official T3 Code site](https://t3.codes/): inspected its product screenshot in the collaborative browser. The useful reference is the compact project/thread sidebar, central conversation and optional diff panel, rather than the site's marketing treatment.
- [Settings and project overrides](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md): documents model/workspace defaults for new threads. Relay implements local application defaults; it does not implement T3's environment/project inheritance system.
- [Keyboard shortcuts](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md): documents composer model and effort pickers. Relay places those controls in its composer; it does not claim all those keyboard shortcuts.

These are interaction and visual references. Relay's implementation remains original.

## Implemented behavior

- Neutral black/charcoal surfaces, white emphasis and occasional blue for sending, links and keyboard focus. Purple is removed, including from the application favicon and task review indicator.
- User messages are soft right-aligned charcoal bubbles; assistant responses are plain prose, without provider icons or repeated model/name headers. Speaker labels remain available to assistive technology. Timestamps appear on hover/focus.
- Conversation and composer share an approximately 768px content width. Typography, spacing, outlines and rounding are consistent across both themes.
- Conversation first; the context pane and terminal start closed. File browsing, diffs, preview and terminal remain accessible.
- Tasks, activity and the agent map are under the sidebar footer's More menu. Search opens session/command search; the new-session and open-project actions are compact toolbar buttons.
- New Session creates and selects a session directly using saved defaults. There is no session-creation dialog and no automatic model call. Errors appear as notifications.
- Settings exposes the default provider, a separate remembered model for each provider, and default effort. Changing a default affects future sessions only.
- Settings is a full workspace page with General, Providers and Appearance sections and a return action. It is not a drawer or modal. General contains model, effort, workspace and permission defaults; Providers exposes real diagnostics with optional connection details and executable overrides.
- Model, effort, policy, task/session assignments and filters use the same custom choice popover, including selected-state marks, grouped models, arrow-key navigation, typeahead, Escape dismissal and viewport-aware placement. Dialogs use restrained surfaces and the same form styling.
- The composer can change a session's model and effort between runs. The next run receives the updated values, and the existing provider conversation identifier is preserved.
- A new session can select either provider through the model picker. Once a provider conversation exists, changing providers requires a new session; model changes within that provider remain available.
- Run configuration is locked during an active turn or provider cleanup. Renaming remains available. Server validation enforces the same rules as the UI.
- Settings and session changes are stored in SQLite. Existing application data needs no destructive migration. Previous project/session selection is retained when the simpler UI preferences are initialized.

## Checks for this revision

The initial simplification passed workspace type checking and the production build. The running server returned the new defaults through bootstrap. Snapshot capture initially failed, limiting that pass to DOM inspection.

During the subsequent screenshot-directed design pass, native browser capture became available after opening the preview visibly. The actual chat with existing messages, full Settings page and open model popover were inspected visually. The work starts no new model turn and fabricates no demonstration conversation. Automated tests and live model turns were not run for this design pass; compilation and production-build results are recorded in validation.md.
