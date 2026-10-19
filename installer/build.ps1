#Requires -Version 5.1
<#
.SYNOPSIS
    Stage the release payload and build the per-user DSH Desktop Cowork installer.

.DESCRIPTION
    Reads the payload from ..\release (never modifies it), copies it to
    .\stage with all *.map files stripped, adds a private copy of the system
    Node.js as stage\runtime\node.exe, then compiles dsh-desktop-cowork.iss
    with Inno Setup 6 (ISCC). The only file written to ..\release is the
    resulting DSH-Desktop-Cowork-Setup-<version>.exe.

    This script does not run the installer.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\installer\build.ps1
#>
[CmdletBinding()]
param(
    [string]$IsccPath = '',
    [switch]$RemoveStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installerDir = $PSScriptRoot
$rootDir = Split-Path -Parent $installerDir
$releaseDir = Join-Path $rootDir 'release'
$stageDir = Join-Path $installerDir 'stage'
$issPath = Join-Path $installerDir 'dsh-desktop-cowork.iss'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Assert-File([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$What not found: $Path"
    }
}

function Copy-Tree([string]$Source, [string]$Destination) {
    # robocopy is used for node_modules' deep tree; /XF *.map strips source maps.
    & robocopy $Source $Destination /E /XF *.map /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed with exit code $code copying '$Source' to '$Destination'"
    }
}

# ---------------------------------------------------------------- versions ---
Write-Step 'Reading versions'
$rootPackage = Get-Content -LiteralPath (Join-Path $rootDir 'package.json') -Raw | ConvertFrom-Json
$releasePackage = Get-Content -LiteralPath (Join-Path $releaseDir 'package.json') -Raw | ConvertFrom-Json
$connectorPackage = Get-Content -LiteralPath (Join-Path $rootDir 'packages\desktop-connector\package.json') -Raw | ConvertFrom-Json

$appVersion = [string]$rootPackage.version
$connectorVersion = [string]$connectorPackage.version
$connectorTgzName = "dsh-desktop-cowork-connector-$connectorVersion.tgz"
$setupName = "DSH-Desktop-Cowork-Setup-$appVersion.exe"

if ($appVersion -ne [string]$releasePackage.version) {
    throw "release\package.json version ($($releasePackage.version)) does not match package.json ($appVersion)"
}
if ($appVersion -notmatch '^[0-9A-Za-z.\-]+$') {
    throw "package.json version '$appVersion' contains characters ISCC cannot use in a file name"
}

Write-Host "app version:       $appVersion"
Write-Host "connector version: $connectorVersion"
Write-Host "setup output:      $setupName"

# --------------------------------------------------------------- preflight ---
Write-Step 'Checking payload sources'
$required = @(
    (Join-Path $releaseDir 'dist'),
    (Join-Path $releaseDir 'skill'),
    (Join-Path $releaseDir 'node_modules'),
    (Join-Path $releaseDir 'package.json'),
    (Join-Path $releaseDir 'LICENSE'),
    (Join-Path $releaseDir 'NOTICE'),
    (Join-Path $releaseDir 'README.md'),
    (Join-Path $releaseDir $connectorTgzName)
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "release payload is missing: $path"
    }
}

$nodeSource = Join-Path ${env:ProgramFiles} 'nodejs\node.exe'
Assert-File $nodeSource 'Bundled Node.js source'
$nodeVersion = (& $nodeSource -v).Trim()
if ($nodeVersion -ne 'v24.21.0') {
    throw "Expected Node.js v24.21.0 at $nodeSource, found $nodeVersion. Refusing to bundle a different runtime."
}
Write-Host "bundled node:      $nodeSource ($nodeVersion)"

# ----------------------------------------------------------------- staging ---
Write-Step 'Staging payload (release is only read)'
$installerPrefix = [System.IO.Path]::GetFullPath($installerDir).TrimEnd('\') + '\'
$stageFull = [System.IO.Path]::GetFullPath($stageDir)
if (-not $stageFull.StartsWith($installerPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a stage directory outside installer\: $stageFull"
}
if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stageDir 'runtime') -Force | Out-Null

Copy-Tree (Join-Path $releaseDir 'dist') (Join-Path $stageDir 'dist')
Copy-Tree (Join-Path $releaseDir 'skill') (Join-Path $stageDir 'skill')
Copy-Tree (Join-Path $releaseDir 'node_modules') (Join-Path $stageDir 'node_modules')

foreach ($name in @('package.json', 'LICENSE', 'NOTICE', 'README.md', $connectorTgzName)) {
    Copy-Item -LiteralPath (Join-Path $releaseDir $name) -Destination (Join-Path $stageDir $name)
}
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $stageDir 'runtime\node.exe')

# package-lock.json is intentionally not part of the installed payload.

# --------------------------------------------------------------- validate ---
Write-Step 'Validating stage'
$stageRequired = @(
    (Join-Path $stageDir 'runtime\node.exe'),
    (Join-Path $stageDir 'dist\setup-desktop.js'),
    (Join-Path $stageDir 'dist\index.js'),
    (Join-Path $stageDir 'skill\codex-dsh-desktop\SKILL.md'),
    (Join-Path $stageDir 'skill\claude-dsh-desktop\SKILL.md'),
    (Join-Path $stageDir 'node_modules\@modelcontextprotocol\sdk\package.json'),
    (Join-Path $stageDir 'package.json'),
    (Join-Path $stageDir 'LICENSE'),
    (Join-Path $stageDir 'NOTICE'),
    (Join-Path $stageDir 'README.md'),
    (Join-Path $stageDir $connectorTgzName)
)
foreach ($path in $stageRequired) {
    Assert-File $path 'Staged file'
}

$maps = @(Get-ChildItem -LiteralPath $stageDir -Recurse -Filter '*.map' -File -ErrorAction SilentlyContinue)
if ($maps.Count -gt 0) {
    throw "Stage still contains $($maps.Count) .map file(s), e.g. $($maps[0].FullName)"
}

$stagedNodeVersion = (& (Join-Path $stageDir 'runtime\node.exe') -v).Trim()
if ($stagedNodeVersion -ne $nodeVersion) {
    throw "Staged node.exe reports $stagedNodeVersion, expected $nodeVersion"
}

$stageFiles = @(Get-ChildItem -LiteralPath $stageDir -Recurse -File)
$stageBytes = ($stageFiles | Measure-Object -Property Length -Sum).Sum
Write-Host ("staged files:      {0:N0} ({1:N1} MB)" -f $stageFiles.Count, ($stageBytes / 1MB))
Write-Host "staged node:       $stagedNodeVersion"
Write-Host 'no .map files:     yes'

# ----------------------------------------------------------------- compile ---
Write-Step 'Compiling with Inno Setup 6'
if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles} 'Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
    )
    $IsccPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    throw 'ISCC.exe (Inno Setup 6) was not found. Install it with: winget install --id JRSoftware.InnoSetup -e --scope user --accept-package-agreements --accept-source-agreements'
}
Assert-File $IsccPath 'ISCC.exe'
Assert-File $issPath 'Installer script'
Write-Host "ISCC:              $IsccPath"
Write-Host "script:            $issPath"

$setupPath = Join-Path $releaseDir $setupName
$compileStarted = Get-Date
$isccLog = Join-Path $env:TEMP ("dsh-desktop-cowork-iscc-{0}.log" -f $PID)
& $IsccPath "/DMyAppVersion=$appVersion" "/DMyConnectorVersion=$connectorVersion" $issPath *> $isccLog
$isccExit = $LASTEXITCODE
$isccWarnings = @(Select-String -LiteralPath $isccLog -Pattern '^Warning:|^Error:' -ErrorAction SilentlyContinue)
if ($isccWarnings.Count -gt 0) {
    Write-Host ''
    Write-Host 'ISCC messages:' -ForegroundColor Yellow
    $isccWarnings | ForEach-Object { Write-Host $_.Line -ForegroundColor Yellow }
}
Get-Content -LiteralPath $isccLog -Tail 10 | ForEach-Object { Write-Host "  $_" }
if ($isccExit -ne 0) {
    Write-Host ''
    Write-Host "Full ISCC log: $isccLog" -ForegroundColor Red
    throw "ISCC failed with exit code $isccExit"
}
Write-Host "ISCC log:          $isccLog"

# ------------------------------------------------------------------ result ---
Write-Step 'Build result'
Assert-File $setupPath 'Compiled installer'
$setupItem = Get-Item -LiteralPath $setupPath
if ($setupItem.LastWriteTime -lt $compileStarted.AddMinutes(-1)) {
    throw "Compiled installer looks stale: $setupPath"
}

$hash = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash
Write-Host "installer: $setupPath"
Write-Host ("size:      {0:N0} bytes ({1:N2} MB)" -f $setupItem.Length, ($setupItem.Length / 1MB))
Write-Host "sha256:    $hash"

if ($RemoveStage) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
    Write-Host ''
    Write-Host 'Stage removed.'
} else {
    Write-Host ''
    Write-Host 'Stage kept at installer\stage for verification (installer\stage\ is gitignored).'
}

Write-Host ''
Write-Host 'Build OK. The installer was NOT run.' -ForegroundColor Green
