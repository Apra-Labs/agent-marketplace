# password-gen

Generate a strong random password **without the agent (or anyone watching its output) seeing it**.

- Four character sets (upper, lower, digits, `!#%*-_=+?`), no look-alikes (`I O l 0 1`), at least
  one of each, unbiased cryptographic randomness. Default length 20 (12 to 256).
- The password goes to your **clipboard** and is cleared after 45 seconds if still there.
- Over **SSH** the remote machine's clipboard isn't yours, so the local clipboard is refused;
  `--osc52` sends it to *your* terminal's clipboard instead (written to the terminal device, never
  to stdout).
- `--echo` (off by default) prints it to stdout so **you** can pipe it into a secret store, e.g. the
  apra-fleet credential store. Agents are told never to use it.

## Requirements

Node.js 18+. Clipboard tools: built in on Windows (`clip`) and macOS (`pbcopy`); on Linux
`wl-clipboard` (Wayland) or `xclip`/`xsel` (X11). OSC 52 needs a terminal that supports it: Windows
Terminal, iTerm2 (allow clipboard access), WezTerm, kitty, Alacritty, foot; in tmux set
`set -g set-clipboard on`.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install password-gen@apra
```
Then ask: "generate a 24-character password". Or run it yourself:
`node <skill dir>/scripts/pwgen.mjs [--length N] [--no-symbols | --symbols SET] [--osc52] [--echo] [--clear-after SEC]`.

## Over SSH, in short

| You are | Command | Where it lands |
|---|---|---|
| at your desktop | `pwgen` | your clipboard |
| SSH'd into a server | `pwgen --osc52` | your local terminal's clipboard |
| piping into a store | `pwgen --echo \| <store command>` | the store (and nowhere else) |
| storing it in apra-fleet | `pwgen --echo \| apra-fleet secret --set NAME -y --persist` | the fleet credential store (`-y` reads the value from stdin only) |

## Test

From the repository root: `npm test`.

## License

[Apache License 2.0](LICENSE).
