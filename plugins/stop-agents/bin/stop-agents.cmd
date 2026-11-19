@echo off
rem Stop Claude Code background agents that have a running process (pid).
rem Usage: stop-agents [-y|--yes] [-n|--dry-run] [-s|--state blocked,working]
rem Same flags as the bash version (stop-agents) for macOS/Linux.
rem Never stops the current session (CLAUDE_CODE_SESSION_ID); no terminal and no -y: nothing stopped.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-agents.ps1" %*
exit /b %ERRORLEVEL%
