# AGENTS.md — Agent Cockpit

Rules for any coding agent working on this repo.

- Never point the cockpit at the default tmux server or source `~/.tmux.conf` (personal hooks
  there, e.g. on `client-detached`, would fire on every phone connect/disconnect).
- Never add hooks to agent settings files (`~/.claude/settings.json`, Codex `hooks.json`, Grok).
  Status comes from pane text in `lib/status.js`; extend its patterns with a test built from a real
  screen.
- Keep `lib/guard.js` checks (Host, Tailscale identity, Origin, forbidden paths) covered by
  `test/guard.test.js`. Any new route goes through `checkRequest` and the paired-device check in
  `server.js` (only `STATIC` files and `POST /api/pair` are reachable unpaired); cover pairing in
  `test/pairing.test.js`.
- Per-machine values (login, host, paths, commands) belong in `cockpit.config.json` (gitignored),
  never in code, tests or docs. Tests use example values and a temp directory.
- Alerts carry session name + link only. Never send pane content off the machine.
- `node-pty` is native: after a Node upgrade run `npm rebuild node-pty && npm run postinstall`.
- Verify with `npm test`, then a loopback run (`COCKPIT_ALLOW_LOCAL=1`, spare `COCKPIT_PORT`)
  exercising create → keys → history → ws attach → end.
