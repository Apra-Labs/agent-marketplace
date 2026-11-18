---
name: install-cli
description: Install the stop-agents command into ~/.local/bin so it can be run from any terminal, outside Claude.
disable-model-invocation: true
---

# Install the stop-agents command for any terminal

While the plugin is enabled, `stop-agents` already works inside Claude's Bash tool. This skill copies it
to a stable folder so it also works from a normal terminal (cmd, PowerShell, Git Bash, bash, zsh).

The plugin folder path changes with every plugin version, so do not put it on PATH. Copy the files instead,
and re-run this skill after a plugin update to refresh the copies.

## Steps

1. Source: `"${CLAUDE_SKILL_DIR}/../../bin/"` holds `stop-agents` (bash), `stop-agents.cmd` and `stop-agents.ps1`.
   Target: `~/.local/bin` (on Windows `%USERPROFILE%\.local\bin`). Create it if missing.

2. For each of the three files:
   - Missing in the target: copy it.
   - Identical: skip it.
   - Different: if the target is an earlier copy of this tool (it contains `Stop Claude Code background agents`),
     overwrite it. Otherwise show the difference and ask before overwriting. Never overwrite another tool.
   Use whichever shell fits (PowerShell `Copy-Item`, or `cp`).

3. Make the bash one executable: `chmod +x ~/.local/bin/stop-agents` (harmless on Windows).

4. Check whether the target folder is on PATH. If it is, you are done. If not, SHOW the line for the user's shell and
   ask before editing any profile or setting. Never edit a profile without a yes.
   - PowerShell, user PATH (new terminals): `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + "$env:USERPROFILE\.local\bin", 'User')`
   - cmd (this window only): `set PATH=%PATH%;%USERPROFILE%\.local\bin` (use the PowerShell line to make it permanent)
   - bash, in `~/.bashrc` (Git Bash too): `export PATH="$HOME/.local/bin:$PATH"`
   - zsh, in `~/.zshrc`: `export PATH="$HOME/.local/bin:$PATH"`

5. Tell the user what was copied, what was skipped, and that they should open a new terminal and run
   `stop-agents --dry-run` to check. Remind them to re-run `/stop-agents:install-cli` after plugin updates.
