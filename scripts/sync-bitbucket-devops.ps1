# Thin PowerShell wrapper around sync-bitbucket-devops.sh.
#
#   powershell -ExecutionPolicy Bypass -File scripts\sync-bitbucket-devops.ps1 [-Ref <tag-or-branch>]

param(
    [string]$Ref = ""
)

# Prefer Git for Windows' bash: a bare `bash` on PATH can resolve to WSL,
# which cannot see Windows node/npm.
$bash = $null
$git = Get-Command git -ErrorAction SilentlyContinue
if ($null -ne $git) {
    $gitBash = Join-Path (Split-Path -Parent (Split-Path -Parent $git.Source)) "bin\bash.exe"
    if (Test-Path $gitBash) { $bash = $gitBash }
}
if ($null -eq $bash) {
    $cmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { $bash = $cmd.Source }
}
if ($null -eq $bash) {
    Write-Host "sync: bash not found - install Git for Windows (https://git-scm.com/download/win)" -ForegroundColor Red
    exit 1
}

$script = Join-Path $PSScriptRoot "sync-bitbucket-devops.sh"
if ($Ref) {
    & $bash $script $Ref
} else {
    & $bash $script
}
exit $LASTEXITCODE
