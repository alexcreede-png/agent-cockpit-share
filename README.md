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
| Your tasks | Search by project or assistant; see working / needs you / idle / ended status. Same-project tasks show their start time. |
| New task | Choose Grok or Gemini / Antigravity, a project, and an optional first message. Claude, Codex and Terminal remain under More assistants. Choices and draft stay available after a failed start; project loading can be retried in place. |
| Session | **Read** view (default on phones): the whole scrollback, swipeable, refreshed live, with a "↓ Latest" button. **Live** view: the real terminal, reconnects by itself. Quick keys (Esc, Enter, arrows, Tab, Shift-Tab, Ctrl-C, 1/2/3, y/n). Message box (multi-line is sent as one message). 📎 attach photos, camera shots or files; 🎤 dictate (transcribed on the Mac, lands in the box for review). End (two taps) |

Antigravity uses its selected model, which may be Gemini or another supported model. Its first message is passed through the interactive prompt option. Opening a task confirms terminal creation, not authentication or assistant readiness. If a start is unconfirmed, use **Check start** to recover the original request without opening another terminal. Its assistant, project and first message stay locked until the start is confirmed or you explicitly choose a different task. Pending starts are saved in this tab for up to 24 hours; closing the tab may lose recovery. When browser storage is unavailable, the app explains that you must keep the page open. Ordinary unsubmitted drafts and task-message drafts stay in page memory only. Older servers without safe-start support direct you to Your tasks before retrying. Leaving the task list or app does not end a running terminal; the Mac must remain available.

“Sent to terminal” confirms delivery to the CLI; its response appears in the output pane. If delivery is unconfirmed, check the output before retrying to avoid sending twice. First messages support up to 8,000 characters, and session messages up to 20,000 (including attached file paths). Longer messages are rejected rather than shortened, and the draft stays available to edit.

Read view shortens runs of four or more blank terminal rows to two for readability. Live view preserves the terminal display.

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
   from Safari). On the Mac, open the Agent Cockpit folder in Finder and double-click
   **Pair-a-phone.command**. Terminal opens and explains the action. Press **Return** to create
   a code, or type **cancel** and press Return to stop without changing pairing state.

   Enter the code shown in Terminal into **Pairing code** on the phone, then tap **Connect this
   phone**. Terminal shows the expiry time and waits for Return so you can keep the code visible.
   Keep Tailscale connected on both devices. Only pair a phone you want to control your Mac.

   The helper uses the existing Node.js installation and `scripts/pair.js` in its own folder;
   keep it with the complete checkout configured for your running Cockpit. If it cannot find
   Node.js, it explains how to continue without changing pairing state. Cockpit requires Node.js 22 or newer.
   Advanced fallback: open Terminal in the Agent Cockpit folder and run:

   ```bash
   npm run pair
   ```

   The code works once and expires in 10 minutes; creating a new code replaces the unused one.
   Five wrong tries burn it. `npm run pair -- list` shows paired phones and `npm run pair -- revoke <id>`
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

For an isolated end-to-end runtime check (synthetic project and its own tmux server):

```bash
node scripts/verify-runtime.cjs
```

For browser acceptance, use an existing Playwright installation available through Node's
module resolution, then run `node scripts/verify-ui.cjs`. It exercises synthetic API fixtures
in WebKit and Chromium, including session-scoped drafts/uploads, failed sends and session ending,
keyboard navigation, scrollback and responsive layouts. Optional `COCKPIT_WEBKIT_EXECUTABLE` and
`COCKPIT_CHROMIUM_EXECUTABLE` variables select already-installed browser binaries. Screenshots go
to a temporary directory, or `COCKPIT_ARTIFACT_DIR`. Neither check reads existing conversations.

To check the containing dashboard, set `COCKPIT_DASHBOARD_DIST` to its built `dist/public`
directory and run `node scripts/verify-host.cjs` with the same Playwright/browser setup.
All API and external requests are synthetic fixtures. The check covers a reduced visual viewport,
viewport panning, an active usage warning, desktop width, and leaving the cockpit route.

## Dictation recovery

Keep the page open after recording. Accepted jobs are checked automatically with read-only requests every two seconds while the page is visible. A network failure stops those checks and offers **Check dictation**, which only reads the original job's status;
when an upload is unknown, **Retry upload** checks again before uploading the same recording
with the same identity. A queued job can outlast the browser's 60-second request timeout.
Recovered words go into the original task's draft for review, never directly to the terminal.
**Discard dictation** and End suppress late results. A failed or expired job is never restarted
by a status check or a same-ID upload. Recording controls require a server advertising recovery;
old clients retain the synchronous `POST /api/transcribe` → `{text}` interface, without retry guarantees.

Audio stays in page memory until completion/discard, for at most 15 minutes after recording,
with four recordings per page, one per task, up to 25 MiB each. Recording stops after two minutes
or rejects over-limit audio. These page timers depend on the browser being scheduled; expired
recordings cannot be recovered by checking after the limit. Reloading, closing the page, browser
memory eviction or restarting the server has **no supported dictation recovery**. Ordinary
completed draft text remains page-local under the existing draft lifecycle.

The Mac admits at most four receiving/queued/running jobs, serializes model commands (180 seconds
each), and aborts jobs after 12 minutes including upload/queue time. It uses the existing private
`.voice` temporary audio files for processing only, removing them on completion/failure/cancel;
it adds no audio archive. Completed text is held **only in server memory**, at most 20,000
characters per result for ten minutes, and is cleared earlier on acknowledged page acceptance,
discard or task end. Up to 1,024 identities/tombstones are kept per server run; capacity refuses
new work rather than evicting an identity and risking duplicate execution. Restarting clears
that registry and changes its epoch. Abrupt process/machine termination can leave existing-style
temporary files; this protocol does not promise crash cleanup or recovery. Cancellation requests
are best effort while disconnected; page ownership checks still suppress late text locally.

API clients obtain `dictationEpoch` from paired `GET /api/state`. Upload to `POST /api/transcribe`
with `X-Dictation-Id` (32 random lowercase hex characters), `X-Dictation-Epoch`, and
`X-Dictation-Task` (original session name). The server reserves the identity before streaming,
then acknowledges the fully received upload with a receipt (HTTP 202; repeated uploads may
return 200). Receipts contain `{requestId, epoch, task, state}` and `text` only when complete.
`GET /api/transcribe/<id>?epoch=<epoch>&task=<task>` is a non-executing lookup;
`POST /api/transcribe/<id>/cancel?epoch=<epoch>&task=<task>` cancels/discards that identity,
including a cancel that arrives before its upload. All routes retain guard and pairing checks.
A mismatched task returns 409; stale epochs and unavailable original tasks fail closed with 410.
Use the original epoch/ID on retry; generating another ID has no deduplication guarantee.

## Start recovery for API clients

`GET /api/state` advertises `startRecovery: true`. Upgraded clients may include a fresh random `requestId` (16–128 ASCII letters, digits, `_` or `-`) in `POST /api/sessions`. Keep the exact ID, assistant, project and first message when retrying an unconfirmed start. A successful response includes `{name, requestId, reused}` and confirms only a live terminal.

A changed payload returns `409 START_REQUEST_MISMATCH`; an uncertain or missing terminal returns `409 START_UNCONFIRMED`; a dead terminal returns `409 START_SESSION_ENDED`. Retrying the same reserved request never launches another terminal. Choose a new ID only for an intentional new task. Older clients without an ID retain their original behavior. Keep the private `start-requests` directory with the instance state; its records contain only a planned identity and digest, not prompt text.

`node scripts/verify-delivery.cjs` also loses a real launch response, reloads the phone page, and verifies that explicit Check start returns the same single terminal before exercising message delivery.

`node scripts/verify-starts.cjs` checks actual HTTP response loss, server restart, concurrent retries, payload mismatch and ended tasks against a unique disposable tmux server. It uses synthetic shell tasks and never launches an assistant or reads an existing session.

## Known limits

- "Needs you" is a heuristic over the last lines of the screen (`lib/status.js`); new CLI dialogs
  may need a pattern added.
- Only sessions started from the cockpit are visible.
- `node-pty` is a native module: after a Node upgrade run `npm rebuild node-pty && npm run postinstall`.

For real browser-to-terminal delivery acceptance with installed Playwright browsers:

```bash
node scripts/verify-delivery.cjs
```

This uses a synthetic terminal fixture on a unique tmux server. It verifies actual single-line and multiline submissions, rendered replies, resize/focus behavior, and cleanup without accessing existing sessions. Use the same optional browser executable overrides as the UI suite.

### Startup help and output labels

New assistant tasks show a short setup tip with Dismiss. Needs you shows separate guidance:
review the assistant's question, then choose Respond to open the keys. Opening Respond sends
nothing. While a task Needs you, Read shows terminal output so its current question and choices
remain visible even if a saved conversation exists. Live opens the terminal when needed.

Conversation labels the owned structured user/assistant messages. Terminal output labels the
terminal fallback; terminal text is never turned into chat messages. Displayed conversation
messages retire generic startup help, but do not confirm a later pending message, change task
status, or clear delivery warnings. Terminal output and successful sends do not establish
assistant readiness or message acceptance. Dismissal lasts for this page and task only.

### Reading complete Grok answers

Read view uses Grok's saved user/assistant conversation when its active-session registry matches
both the cockpit pane process and project directory. This shows complete, naturally wrapping
messages instead of the TUI's clipped viewport. Answer start returns to the latest answer;
new output preserves your reading position. Phone response keys stay behind Controls (Respond when a task Needs you), and Live
remains available for exact terminal interaction.

Only the bound conversation's `updates.jsonl` is read. System prompts, thinking, tool inputs,
and tool outputs are excluded. No newest-session guess or transcript-directory scan is used.
Unavailable/unsupported Grok histories retain terminal Read view. The adapter
supports the standard encoded-project directory layout, up to 32 MiB of events and 2 MiB of
message text; it falls back instead of silently truncating. Bindings survive an agent exit while
the server remains running, but are rediscovered from active processes after a server restart.
Set `grokHome` in the local configuration only when Grok uses a nonstandard home directory.

### Reading complete Gemini answers

New Gemini tasks launched through Cockpit can show their complete saved conversation, including
after a Cockpit server restart. The `agy` bridge preserves interactive input and approvals and
retains only a new-conversation identity from its diagnostic stream; raw diagnostics are discarded.
The reader requires the same launch nonce, live wrapper/child processes, project directory,
conversation identity and creation time before opening that task's saved messages read-only.
Live identity is checked again before publishing the result. An ambiguous launch disables its
reader in live process state even if its binding file cannot be updated.
It never searches for the newest conversation. System instructions, thinking and tool details
are excluded. Existing tasks launched without this bridge keep terminal output.

This adapter covers the Antigravity 1.4.7 local format and requires Node's built-in SQLite support.
Unknown formats, unavailable SQLite, ended tasks or failed identity checks fall back to terminal
output. Explicit current error headings and approval prompts also select terminal output so
older saved messages cannot conceal a request for attention. This is a bounded presentation
check; Live remains available for other terminal messages. It accepts at most 10,000 steps, 32 MiB of stored payloads and 2 MiB of visible text;
larger histories fall back rather than being silently clipped. Set `agyHome` in the local
configuration only when the CLI stores its data outside `~/.gemini/antigravity-cli`.

To check the bridge without running an AI provider, run `node scripts/verify-agy.cjs`.
It uses a synthetic CLI on a unique tmux server and verifies that ending its terminal
reaps both the bridge and child process.
