# Stop Claude Code background agents that still have a running process (an "id"
# and a "pid" in "claude agents --json"). Windows version; run via stop-agents.cmd.
#
# Usage: stop-agents [-y|--yes] [-n|--dry-run] [-s|--state blocked,working]
#   -y, --yes       stop without asking
#   -n, --dry-run   only list what would be stopped
#   -s, --state     additionally restrict to these states (comma-separated)
# Never stops the session it runs in: when CLAUDE_CODE_SESSION_ID is set, the
# agent with that sessionId is skipped. Interactive sessions (no id) are skipped too.
# With no terminal to ask on and no -y, nothing is stopped: it says so and exits 0.
# Conversations are kept: "claude attach <id>" or "claude --resume" reopens them.
# Same flags as the bash version (stop-agents) for macOS/Linux.

$ErrorActionPreference = 'Stop'

$Yes = $false; $DryRun = $false; $State = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    switch -Regex ($arg) {
        '^(-y|--yes)$'      { $Yes = $true; break }
        '^(-n|--dry-run)$'  { $DryRun = $true; break }
        '^(-s|--state)$'    { $i++; if ($i -lt $args.Count) { $State += [string]$args[$i] }; break }
        '^--state=(.*)$'    { $State += $Matches[1]; break }
        '^(-h|--help)$'     { Get-Content $PSCommandPath -TotalCount 12 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
        default             { Write-Host "unknown option: $arg (see --help)"; exit 2 }
    }
}
$State = @($State -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$raw = & claude agents --json
if ($LASTEXITCODE -ne 0) { Write-Host "claude agents --json failed (exit $LASTEXITCODE)"; exit 1 }

# Assign first: in Windows PowerShell 5.1, ConvertFrom-Json emits the array as a single object.
$parsed = ($raw | Out-String) | ConvertFrom-Json
$agents = @($parsed)

# Only background agents (an "id" field) that still have a live process (a "pid"
# field) are stopped. Interactive sessions are listed with a pid but no id, and
# "claude stop" cannot stop them.
$candidates = @($agents | Where-Object {
    $_.id -and $_.pid -and ($State.Count -eq 0 -or $State -contains $_.state)
})

# Never stop the session this script runs in.
$me = $env:CLAUDE_CODE_SESSION_ID
$targets = @()
foreach ($a in $candidates) {
    if ($me -and $a.sessionId -eq $me) {
        Write-Host "Skipping $($a.id) ($($a.name)): this is the current session."
    } else { $targets += $a }
}

if ($targets.Count -eq 0) { Write-Host 'No background agents with a running process (pid) found.'; exit 0 }

Write-Host "Found $($targets.Count) background agent(s) with a running process:"
$targets | Format-Table -AutoSize id, pid, state, status, name | Out-String -Width 200 | Write-Host

if ($DryRun) { Write-Host 'Dry run: nothing stopped.'; exit 0 }

if (-not $Yes) {
    $answer = $null
    if (-not [Console]::IsInputRedirected) {
        try { $answer = Read-Host 'Stop all of them? [y/N]' } catch { $answer = $null }
    }
    if ($null -eq $answer) {
        Write-Host 'No terminal to confirm; rerun with -y to stop them.'
        exit 0
    }
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Aborted.'; exit 0 }
}

$failed = 0
foreach ($a in $targets) {
    Write-Host -NoNewline "Stopping $($a.id) ($($a.name))... "
    # A failing native command must not abort the loop (stderr + 'Stop' throws in PS 5.1).
    $ErrorActionPreference = 'Continue'
    & claude stop $a.id *> $null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -eq 0) { Write-Host 'ok' -ForegroundColor Green }
    else { Write-Host "failed (exit $LASTEXITCODE)" -ForegroundColor Red; $failed++ }
}

Write-Host "Done: $($targets.Count - $failed) stopped, $failed failed."
exit [int]($failed -gt 0)
