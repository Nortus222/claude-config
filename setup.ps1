# Install the runtime prerequisites, then start the interactive configuration.
$ErrorActionPreference = 'Stop'
$setupArguments = @($args)

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Host 'This bootstrap supports Windows. On macOS, run setup.sh.'
    exit 1
}

function Confirm-Install([string] $Message) {
    $answer = Read-Host "$Message [y/N]"
    return $answer -match '^(y|yes)$'
}

function Update-SessionPath {
    # Preserve custom session paths while discovering newly installed tools.
    $paths = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        $env:Path
    )
    $env:Path = ($paths | Where-Object { $_ }) -join ';'
}

function Test-Runtime {
    if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) { return $false }
    if (-not (Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue)) { return $false }
    if (-not (Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue)) { return $false }
    try {
        & node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Test-Git {
    if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { return $false }
    try {
        $null = & git --version
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Install-Prerequisite([string] $PackageId, [string] $DownloadUrl) {
    if (-not (Get-Command winget -CommandType Application -ErrorAction SilentlyContinue)) {
        Write-Host "WinGet is unavailable. Install this tool from $DownloadUrl and rerun setup.ps1."
        Write-Host 'WinGet installation: https://learn.microsoft.com/windows/package-manager/winget/'
        return
    }
    & winget install --exact --id $PackageId --source winget
    if ($LASTEXITCODE -ne 0) {
        Write-Host "The installer did not complete successfully. Official download: $DownloadUrl"
    }
    Update-SessionPath
}

Write-Host 'Checking the tools needed to start configuration...'
if (-not (Test-Runtime)) {
    if (Confirm-Install 'Node.js 24+ with npm and npx is required. Install Node.js LTS with WinGet?') {
        Install-Prerequisite 'OpenJS.NodeJS.LTS' 'https://nodejs.org/en/download'
    }
}

if (-not (Test-Git)) {
    if (Confirm-Install 'Git is required to download the configuration. Install Git with WinGet?') {
        Install-Prerequisite 'Git.Git' 'https://git-scm.com/download/win'
    }
}

if (-not (Test-Runtime) -or -not (Test-Git)) {
    Write-Host 'Setup requires Node.js 24+, npm, npx, and Git. Install the missing tools, reopen your terminal, and rerun setup.ps1.'
    exit 1
}

& npx.cmd --yes github:Nortus222/claude-config setup @setupArguments
exit $LASTEXITCODE
