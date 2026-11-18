---
name: stop
description: Stop Claude Code background agents that still have a running process, after showing the list and getting confirmation. Optional argument is a state filter such as "-s blocked".
disable-model-invocation: true
---

# Stop background agents

Stops the Claude Code background agents that still have a running process, with one
confirmation. It never stops the session it is running in, and conversations are kept
(`claude attach <id>` reopens one).

Arguments the user gave: `$ARGUMENTS`. If they contain a state filter (for example `-s blocked` or
`--state blocked,working`), keep it and pass the same filter to both commands below. Ignore anything else.

## Steps

1. Run the list, which stops nothing:

   `stop-agents --dry-run [filter]`

   `stop-agents` is on the Bash tool's PATH while this plugin is enabled. If the shell says it is not
   found, use the plugin's own copy instead (quote the path):

   `"${CLAUDE_SKILL_DIR}/../../bin/stop-agents" --dry-run [filter]`

2. Show the user the list exactly as printed, including any `Skipping ...: this is the current session.` line.
   If it says no background agents were found, say so and stop here.

3. Ask for confirmation in chat with AskUserQuestion: "Stop these N agents?" with the options "Stop them" and "Cancel".
   Do not continue without a "Stop them" answer.

4. Only after a yes, run the same command with `-y` instead of `--dry-run`:

   `stop-agents -y [filter]`

5. Report each result line (`ok` or `failed`) and the final `Done: N stopped, M failed.` line.
   For a failure, say which agent and suggest `claude attach <id>` or `claude agents` to look at it. Do not retry in a loop.

## Notes

- Only entries with both an id and a pid are targeted. Interactive sessions are skipped: `claude stop` takes only background-session ids.
- The current session is skipped automatically (via `CLAUDE_CODE_SESSION_ID`).
- This relies on `claude agents --json`, which is undocumented and may change.
