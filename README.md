# Agent Cockpit

Watch and drive Claude Code, Codex, Grok and agy CLI sessions running on your Mac from your phone.
Each session is a real terminal in a private tmux server; the phone gets a live terminal, quick
keys, a message box with photo/file attach and on-Mac voice dictation, and a "needs you" status when an agent is
waiting on an approval.

It is a remote shell into your Mac, so it listens only on loopback (or a private Unix socket) and
is reached through [Tailscale](https://tailscale.com) `serve`, which proves who you are on every
request. Read **Security** below before you run it.

## What you can do

| Screen | Actions |
| --- | --- |
| List | See every session with status: working / needs you / idle / exited |
| + New | Pick a lane (claude, codex, grok, agy, shell), a project, optional first message |
| Session | **Read** view (default on phones): the whole scrollback, swipeable, refreshed live, with a "↓ Latest" button. **Live** view: the real terminal, reconnects by itself. Quick keys (Esc, Enter, arrows, Tab, Shift-Tab, Ctrl-C, 1/2/3, y/n). Message box (multi-line is sent as one message). 📎 attach photos, camera shots or files; 🎤 dictate (transcribed on the Mac, lands in the box for review). End (two taps) |

## Requirements

- macOS (Linux likely works; untested), Node 22+, tmux 3.2+.
- Tailscale on the Mac and the phone, same tailnet, with HTTPS certificates enabled for the tailnet.
- Whichever agent CLIs you want (`claude`, `codex`, `grok`, `agy`) on your login shell's `PATH`.

## Setup

1. Install:

   ```bash
   git clone <this repo> agent-cockpit && cd agent-cockpit && npm install
   ```

2. Copy the example config and edit it:

   ```bash
   cp cockpit.config.example.json cockpit.config.json
   ```

   | Key | Meaning |
   | --- | --- |
   | `user` | Your Tailscale login (the only identity allowed in). Required. |
   | `publicHost` | `host:port` your phone will use, e.g. `my-mac.tail1234.ts.net:8444`. Required. |
   | `socketPath` | Optional. Absolute path of an owner-only Unix socket to listen on instead of TCP. Only works with the open-source `tailscaled`, not the Mac app; see **Security**. |
   | `projectsRoot` | Folder whose subfolders are offered as projects. Default `~/projects`. |
   | `forbiddenPaths` | Folders the cockpit must never open or list (e.g. work or client data). |
   | `notifyCommand` | Optional alert command; the message is appended as the last argument, e.g. `["/usr/local/bin/my-notify"]`. Enabled with `COCKPIT_NOTIFY=1`. |
   | `sessionClosedCommand` | Optional shell command tmux runs when a session ends (`#{hook_session_name}` is the session). |
   | `uploadsDir` | Where files sent from the phone are saved, one folder per session. Default `state/uploads` in this folder. Claude and Codex sessions get their own folder via `--add-dir`, so they can read uploads without a permission prompt. |
   | `uploadMaxMB` | Largest upload accepted. Default 200. |
   | `stateDir` | Owner-only folder for paired devices and pending pair codes. Default `~/.agent-cockpit`. |
   | `frameAncestors` | Sites allowed to show the cockpit inside a frame (e.g. your own dashboard), as `https://host` origins. Default none. Inside a frame the browser blocks the cookie, so the page keeps its device token and sends it as a header instead; pair once inside the frame. |
   | `pairing` | Default `true`: every phone pairs once before it can do anything. Set `false` (or `COCKPIT_PAIRING=0`) only for local testing. |
   | `transcribeCommand` | Optional speech-to-text command for the 🎤 button; the audio file path is appended and the text is read from stdout. `lib/whisper_transcribe.py` works with any Python that has `mlx_whisper` (Apple silicon) and `ffmpeg` on `PATH`; model via `COCKPIT_WHISPER_MODEL`. Without it the mic button is hidden. |

   `cockpit.config.json` is gitignored. `COCKPIT_SOCKET`, `COCKPIT_PORT` (TCP mode, default 8826),
   `COCKPIT_USER` and `COCKPIT_PUBLIC_HOST` environment variables override the file.

3. Start the server and publish it to your tailnet only (8444 must match `publicHost`):

   ```bash
   node server.js
   tailscale serve --bg --https=8444 http://127.0.0.1:8826
   ```

   With `socketPath` set, use `unix:<socketPath>` in place of `http://127.0.0.1:8826`.

4. On the phone open `https://<publicHost>` and use Share → Add to Home Screen for an app icon.

5. Pair the phone. Open the cockpit **from the Home Screen icon** (iOS keeps its cookies separate
   from Safari), then on the Mac run:

   ```bash
   npm run pair
   ```

   Type the code it prints into the phone. The code works once and expires in 10 minutes; five
   wrong tries burn it. `npm run pair -- list` shows paired phones and `npm run pair -- revoke <id>`
   (or `all`) unpairs them.

To keep it running across reboots, make a LaunchAgent that runs `node server.js` in this folder
with `KeepAlive` and `LimitLoadToSessionType` = `Aqua`. The Aqua session matters: it is what lets
agents started from the phone reach your login Keychain (for `gh`, `git push`, etc.).

## Security

Anyone who gets through the cockpit can run any command as you. Know these limits:

- **Pairing is what stops local impersonation.** The server listens on `127.0.0.1`, which every
  program and every other user account on the Mac can reach, and any of them can fake the
  Tailscale identity headers. So each phone also needs a device cookie, which it only gets by
  entering a one-time code from `npm run pair`. The codes and device list live in `stateDir`,
  readable only by you, and only hashes are stored. Keep `pairing` on.
- Programs running as *your own* user can still read `stateDir` or run `npm run pair`, but they
  can already do anything you can, so that adds nothing.
- `socketPath` (an owner-only Unix socket) is a further layer, but the Tailscale Mac apps (App
  Store and standalone) can't proxy to Unix sockets: `serve` answers 502 even for a world-readable
  socket (tested). It should work with the open-source `tailscaled` daemon running as root
  (untested).
- **Never use `tailscale funnel`** for this. Funnel puts it on the public internet. Use `serve`,
  which is tailnet-only.
- The only identity allowed in is `user`. Anyone else who can sign in as that Tailscale account
  (your other devices, or a stolen phone that's unlocked) has full control. Consider
  Tailscale's device approval and key expiry.
- Agents started from the phone run with your full permissions and Keychain access, the same as
  if you had typed the command at the Mac.
- Claude's agent view (← on an empty prompt), which lists and can attach to every Claude session
  on the Mac, is turned off in cockpit sessions. `/resume` inside Claude can still list other
  projects' sessions.
- `forbiddenPaths` only affects what the project picker offers and allows as a starting folder.
  Once a session is running, it can `cd` anywhere you can.

## Guards

- Every request except the page's own files must carry a paired-device cookie, the Tailscale
  identity in `user`, an allowed `Host`, and (for anything that changes state, including the
  WebSocket) a same-origin `Origin`. Tailscale overwrites the
  identity header, so it cannot be forged from the tailnet.
- Requests with a loopback `Host` are refused unless `COCKPIT_ALLOW_LOCAL=1` (handy for testing
  on the Mac).
- Projects must be real directories under `projectsRoot` and outside `forbiddenPaths`.
- Alerts contain the session name and a link only, never screen content.
- The cockpit uses its own tmux server (`tmux -L cockpit -f tmux.conf`) and never touches your
  default tmux or `~/.tmux.conf`.

## Run by hand for testing

```bash
COCKPIT_SOCKET= COCKPIT_ALLOW_LOCAL=1 COCKPIT_PAIRING=0 node server.js
```

Then open `http://127.0.0.1:8826` (TCP mode, for testing only).

## Checks

```bash
npm test
```

## Known limits

- "Needs you" is a heuristic over the last lines of the screen (`lib/status.js`); new CLI dialogs
  may need a pattern added.
- Only sessions started from the cockpit are visible.
- `node-pty` is a native module: after a Node upgrade run `npm rebuild node-pty && npm run postinstall`.
