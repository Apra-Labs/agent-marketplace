---
name: password-gen
description: "Generate a strong random password without the agent ever seeing it: it goes straight to the user's clipboard (auto-cleared), to their terminal's clipboard over SSH (OSC 52), or - only when the user runs it themselves - to stdout for piping into a secret store. Use when the user asks for a new password, passphrase, random secret or credential to be generated, or to put a fresh password on their clipboard."
---

# Password generator

`scripts/pwgen.mjs` (Node 18+, no dependencies) makes a password from four sets - upper case,
lower case, digits and `!#%*-_=+?` - without look-alike characters (`I O l 0 1`), with at least
one character from each set, using an unbiased cryptographic random generator. Default length 20.

## The rule for agents

**You may run the generator for the user; you must never see the password.**

- Run it so the password goes somewhere only the user can read: the clipboard, or the user's
  terminal. The script prints only a status line such as `Copied (20 chars) to the clipboard`.
- **Never use `--echo`** yourself: it prints the password to stdout, and you would capture it.
  `--echo` exists for a person piping it into another program in their own terminal.
- Never try to read the password back (clipboard readers, `Get-Clipboard`, `pbpaste`,
  `xclip -o`, the auto-clear helper, temp files). If the user pastes it into the chat by mistake,
  tell them to generate a new one and treat the pasted one as burned.
- Don't put the password into a command line, a file, an environment variable or a commit.

## How to run it

```
node "${CLAUDE_SKILL_DIR}/scripts/pwgen.mjs"                       # 20 chars to the clipboard, cleared after 45 s
node "${CLAUDE_SKILL_DIR}/scripts/pwgen.mjs" --length 32
node "${CLAUDE_SKILL_DIR}/scripts/pwgen.mjs" --no-symbols          # for systems that reject symbols
node "${CLAUDE_SKILL_DIR}/scripts/pwgen.mjs" --symbols '!@#$'      # only the symbols a system accepts
node "${CLAUDE_SKILL_DIR}/scripts/pwgen.mjs" --clear-after 120     # 0 = don't clear
```
Length 12 to 256. The status line goes to stderr; stdout stays empty.

## Where the password can go

| Situation | Use | Notes |
|---|---|---|
| User at their own desktop (Windows, macOS, Linux with a desktop) | default (clipboard) | Cleared after `--clear-after` seconds if the clipboard still holds it |
| User connected over **SSH** | `--osc52` | Sends it to the user's *own* terminal clipboard. Needs a terminal that supports OSC 52 (Windows Terminal, iTerm2 with clipboard access allowed, WezTerm, kitty, Alacritty, foot; tmux with `set -g set-clipboard on`) |
| User wants to pipe it into a secret store themselves | the user runs `... --echo \| <their command>` | Only the user, in their own terminal; never an agent |
| User wants it in the apra-fleet credential store | the user runs `node .../pwgen.mjs --echo \| apra-fleet secret --set NAME -y --persist` | `-y` reads the value from stdin only. The user runs this, not you |
| Agent on a remote apra-fleet member, or any session without a terminal | none of the above | There is no clipboard or terminal of the user's there. Tell the user to run the generator on their own machine, or to use the secret-store hand-off of their tooling |

Over SSH the local clipboard is refused on purpose: a clipboard tool on the remote machine fills
the remote machine's clipboard, not the user's. `--osc52` writes to the controlling terminal
directly (never stdout), so it fails when there is no terminal, which is the case for agents.

## Errors

Exit codes: `0` ok, `1` usage, `2` refused (e.g. SSH without `--osc52`, no terminal for
`--osc52`, no graphical session for the clipboard), `4` missing tool (the message names what to
install: `wl-clipboard`, `xclip` or `xsel` on Linux). Explain the message to the user and offer the
alternative it suggests; don't work around it.
