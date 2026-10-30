# Changelog

## v1.2.2 — 2026-10-30

- **Resumed sessions are isolated too.** A session that is still at its workspace
  root — an empty session created before the bundle was installed, or any session
  opened for the first time afterwards — now gets its own
  `<workspace>/_sessions/<session-id>` folder when it is resumed, so the header
  folder button appears for existing sessions as well. Sessions that already
  replayed their own working directory (an isolation folder, or a directory the
  user moved to) are left untouched, so isolation still happens exactly once per
  session.
- Verified on DSH **0.2.1-rc.5**; Host/Client contracts unchanged, no new
  dependencies.

## v1.2.1 — 2026-10-30

- **Docs: animated files-panel tour** (`docs/session-folders.gif`) showing one
  folder per isolated session under `_sessions`.
- Verified against DSH **0.2.1-rc.5**: `agent/created` signature, the
  `workingDirectory` service (`get` / `ensure` / `set`), `webServer.register` +
  `connection.requestRejection`, the `conversation.session.header.utilities`
  slot (the bundle's button is registered and active), the
  `dsh-resource://file/` address grammar and the `/open-in-app` routes are
  unchanged, and the browser half still loads through `exports["./client"]`.
  **No code changes were needed.**

## v1.2.0 — 2026-10-21

- **Browser half: file-address repair.** DSH's browser code assumes the session
  working directory equals the workspace root. For isolated sessions it can build
  a missing-separator address (`.../default-workspace_sessions/<id>/a.md`) or a
  working-directory-relative path (`a.md`, resolved against the workspace root by
  the Host). The bundle now wraps `sidebarRight.openResource` and repairs both
  shapes before opening, so the document preview works for files inside
  `_sessions\<session-id>`.
- **Browser half: "open session folder" button** in the conversation header next
  to DSH's built-in "Open in…" button. It queries the Host for the real session
  directory and reuses DSH's `/open-in-app` routes to open it in the OS file
  manager.
- **Host half: `GET /session-isolation/session-directory`** — a read-only route
  behind the web server's trust fence that reports the isolated directory of a
  session (404 for non-isolated sessions and deleted directories).
- Verified against DSH 0.2.1-rc.2 and 0.2.1-rc.3; no contract changes were needed.

## v1.1.0 — 2026-10-21

- Browser half added (first UI surface for the bundle): `dsh.client` declaration,
  `exports["./client"]`, header slot registration.

## v1.0.0 — 2026-10-21

- Initial release: Host-only bundle that gives every new session in a configured
  workspace its own working directory at `<workspace>\<baseDir>\<session-id>`.
