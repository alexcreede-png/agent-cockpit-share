#!/bin/bash
# Finder launcher: use this checkout's existing pairing CLI, without shell startup files.

finish() {
  printf '\nPress Return to finish, then close this Terminal window.'
  IFS= read -r acknowledgement || :
  exit "$1"
}

if ! cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")"; then
  printf 'Could not open the Agent Cockpit folder. Reopen Pair-a-phone.command from that folder.\n'
  finish 1
fi

printf 'Pair a phone with Agent Cockpit\n\n'
printf 'This creates a new one-time pairing code for this Cockpit installation.\n'
printf 'It replaces any unused code and expires after 10 minutes.\n'
printf 'Only give the code to a phone you want to control your Mac.\n\n'
printf 'Press Return to create the code, or type cancel and press Return to stop: '
if ! IFS= read -r confirmation || [ -n "$confirmation" ]; then
  printf '\nCancelled. No pairing state changed. Reopen this file when ready to pair.\n'
  finish 0
fi

if [ ! -f scripts/pair.js ]; then
  printf '\nMissing scripts/pair.js. Keep this helper in the complete Agent Cockpit folder and reopen it.\n'
  finish 1
fi

# Finder has a smaller PATH than Terminal. Check common existing installations too.
# Do not source profiles, install anything, or change the caller's pairing configuration.
PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.nvm/current/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin"
export PATH
node_bin=$(command -v node)
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  printf '\nNode.js could not be found. No pairing state changed.\n'
  printf 'If Node.js 22 or newer is already installed, open Terminal in this Agent Cockpit folder\n'
  printf 'and run: npm run pair\n'
  printf 'Otherwise, ask the person who set up Cockpit to make Node.js 22 or newer available, then reopen this file.\n'
  finish 1
fi

printf '\nCreating the code…\n\n'
"$node_bin" "$PWD/scripts/pair.js"
result=$?
if [ "$result" -eq 0 ]; then
  printf '\nOn your phone, open Cockpit and enter the code above under Pairing code.\n'
  printf 'Keep Tailscale connected on both devices. The code works once.\n'
else
  printf '\nCould not create a pairing code. Read the error above.\n'
  printf 'Ask the person who set up Cockpit to check its configuration and Node.js 22 or newer.\n'
  printf 'You can also open Terminal in this folder and run: npm run pair\n'
fi
finish "$result"
