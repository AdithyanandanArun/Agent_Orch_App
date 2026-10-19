# Workspace simplification — 2026-10-19

The first workspace exposed too many panels, badges and setup controls at once. This revision prioritizes the conversation and makes optional tools available on demand.

## T3 Code references

- [Official T3 Code site](https://t3.codes/): inspected its product screenshot in the collaborative browser. The useful reference is the compact project/thread sidebar, central conversation and optional diff panel, rather than the site's marketing treatment.
- [Settings and project overrides](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md): documents model/workspace defaults for new threads. Relay implements local application defaults; it does not implement T3's environment/project inheritance system.
- [Keyboard shortcuts](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md): documents composer model and effort pickers. Relay places those controls in its composer; it does not claim all those keyboard shortcuts.

These are interaction and visual references. Relay's implementation remains original.

## Implemented behavior

- Neutral surfaces, smaller radii, quieter branding and shorter empty states.
- Conversation first; the context pane and terminal start closed. File browsing, diffs, preview and terminal remain accessible.
- Tasks, activity and the agent map are under the sidebar's More menu.
- New Session creates and selects a session directly using saved defaults. There is no session-creation dialog and no automatic model call. Errors appear as notifications.
- Settings exposes the default provider, a separate remembered model for each provider, and default effort. Changing a default affects future sessions only.
- Workspace isolation and approval defaults remain available under an expandable settings section. Provider diagnostics and executable overrides have their own disclosure.
- The composer can change a session's model and effort between runs. The next run receives the updated values, and the existing provider conversation identifier is preserved.
- A new session can select either provider through the model picker. Once a provider conversation exists, changing providers requires a new session; model changes within that provider remain available.
- Run configuration is locked during an active turn or provider cleanup. Renaming remains available. Server validation enforces the same rules as the UI.
- Settings and session changes are stored in SQLite. Existing application data needs no destructive migration. Previous project/session selection is retained when the simpler UI preferences are initialized.

## Checks for this revision

Workspace type checking and the production build passed. The running server returned the new defaults through bootstrap, and browser DOM inspection showed the model and effort selectors. The collaborative browser's snapshot tool repeatedly failed on the local page; no screenshot review is claimed. Automated tests and live model turns were not run for this revision.
