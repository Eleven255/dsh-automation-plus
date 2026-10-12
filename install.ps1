<#
.SYNOPSIS
  Install the Automation Plus plugin package into a DeepSeek Harness profile as a
  bundle, without needing pnpm, the dsh CLI, or network access.

.DESCRIPTION
  This replicates what the app's own plugin manager does for a local bundle,
  using only filesystem operations:

    1. copy the package to <DshHome>\plugins\dsh-automation-plus
    2. expose it to the loader through the profile's node_modules, preferring a
       directory junction and falling back to a plain copy
    3. register the dependency and append the bundle to `dsh.profile.bundles`
       in <profile>\package.json, preserving every other field

  Restart DeepSeek Harness afterwards so the new bundle is composed.

  Prefer the app's own manager when you have it (the Plugins page, or asking the
  agent to run `plugin_manager install_bundle "<absolute path>"`): it validates
  the bundle and reloads the profile for you. This script is the offline
  fallback for a machine with no pnpm.

.PARAMETER DshHome
  The DSH home directory. Defaults to $env:DSH_HOME, else %USERPROFILE%\.dsh.

.PARAMETER Profile
  The profile name to install into. Defaults to $env:DSH_PROFILE, else desktop.

.PARAMETER Force
  Replace an existing real directory at the link path instead of refusing.

.PARAMETER WhatIf
  Report every step, but change nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome D:\dsh -Profile desktop
#>
[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$Profile,
  [switch]$Force,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$PackageName = '@deepseek-ai/dsh-automation-plus'
$FolderName  = 'dsh-automation-plus'

function Write-Step { param([string]$Text) Write-Host "  $Text" }
function Write-Ok   { param([string]$Text) Write-Host "  [ok] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  [!]  $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- resolve paths

$source = $PSScriptRoot
if (-not $source) { $source = (Get-Location).Path }

if (-not $DshHome -or $DshHome -eq '') {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not $Profile -or $Profile -eq '') {
  if ($env:DSH_PROFILE) { $Profile = $env:DSH_PROFILE } else { $Profile = 'desktop' }
}

$target       = Join-Path $DshHome "plugins\$FolderName"
$profileDir   = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
$modulesDir   = Join-Path $profileDir 'node_modules\@deepseek-ai'
$linkPath     = Join-Path $modulesDir $FolderName

Write-Host ''
Write-Host 'Automation Plus installer' -ForegroundColor Cyan
Write-Host "  package : $source"
Write-Host "  home    : $DshHome"
Write-Host "  profile : $Profile"
if ($WhatIf) { Write-Host '  mode    : WHATIF (no changes)' -ForegroundColor Yellow }
Write-Host ''

# ---------------------------------------------------------------- preflight

Write-Host 'Checking the package to install...'
foreach ($required in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js')) {
  if (-not (Test-Path (Join-Path $source $required))) {
    throw "the package is incomplete: $required is missing next to this script"
  }
}
Write-Ok 'package.json, cordis.patch.yml, lib\index.js, lib\client.js'

$packageJson = Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
if ($packageJson.name -ne $PackageName) { throw "unexpected package name '$($packageJson.name)' (expected $PackageName)" }
if (-not $packageJson.dsh.bundle.patch) { throw 'package.json declares no dsh.bundle.patch, so it is not a bundle' }
if (-not $packageJson.dsh.client.platform) { throw 'package.json declares no dsh.client.platform, so its browser half would never load' }
Write-Ok "bundle patch $($packageJson.dsh.bundle.patch), client platform $($packageJson.dsh.client.platform)"

if (-not (Test-Path $profileDir)) {
  throw "profile not found: $profileDir`nStart DeepSeek Harness at least once on this machine, or pass -Profile <name>."
}
Write-Ok 'profile directory exists'

if (-not (Test-Path $manifestPath)) { throw "profile manifest not found: $manifestPath" }
# Validate the manifest BEFORE touching anything: a manifest the app cannot
# parse stops it from booting.
try { $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json }
catch { throw "the profile manifest is not valid JSON, refusing to edit it: $($_.Exception.Message)" }
Write-Ok 'profile manifest is valid JSON'

# ---------------------------------------------------------------- 1. copy package

Write-Host ''
Write-Host "Step 1/3 - copy the package to $target"
if ($WhatIf) {
  Write-Step "would copy $source -> $target"
} else {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($item in @('package.json', 'cordis.patch.yml', 'README.md')) {
    $from = Join-Path $source $item
    if (Test-Path $from) { Copy-Item $from (Join-Path $target $item) -Force }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $target 'lib') | Out-Null
  foreach ($item in @('index.js', 'client.js')) {
    Copy-Item (Join-Path $source "lib\$item") (Join-Path $target "lib\$item") -Force
  }
  Write-Ok 'copied the package files'
}

# ---------------------------------------------------------------- 2. expose it

Write-Host ''
Write-Host 'Step 2/3 - expose the package to the loader through the profile node_modules'
if ($WhatIf) {
  Write-Step "would link $linkPath -> $target"
} else {
  New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
  if (Test-Path $linkPath) {
    $existing = Get-Item $linkPath -Force
    if ($existing.LinkType) {
      # Remove only a link/reparse point, never a real directory holding files.
      [System.IO.Directory]::Delete($linkPath, $false)
      Write-Step 'removed the previous link'
    } elseif ($Force) {
      Remove-Item $linkPath -Recurse -Force
      Write-Step 'replaced the existing directory'
    } else {
      throw "$linkPath already exists and is a real directory. Re-run with -Force to replace it, or remove it by hand."
    }
  }

  $linked = $false
  for ($attempt = 1; $attempt -le 3 -and -not $linked; $attempt++) {
    try {
      New-Item -ItemType Junction -Path $linkPath -Target $target -ErrorAction Stop | Out-Null
      $linked = $true
    } catch {
      if ($attempt -lt 3) { Start-Sleep -Milliseconds 300 }
    }
  }

  if ($linked) {
    Write-Ok "junction created: $linkPath -> $target"
  } else {
    # Some machines refuse reparse points. The loader only needs the package to
    # be resolvable from the profile, so a plain copy works just as well.
    Write-Warn 'junction creation was refused; copying the package into the profile instead'
    New-Item -ItemType Directory -Force -Path $linkPath | Out-Null
    Copy-Item (Join-Path $target '*') $linkPath -Recurse -Force
    Write-Ok "package copied to $linkPath (re-run this script to update it)"
  }
}

# ---------------------------------------------------------------- 3. register

Write-Host ''
Write-Host 'Step 3/3 - register the dependency and select the bundle'

if ($null -eq $manifest.dependencies) {
  $manifest | Add-Member -MemberType NoteProperty -Name 'dependencies' -Value (New-Object psobject) -Force
}
$dependencies = $manifest.dependencies

$linkSpec = 'link:' + ($target -replace '\\', '/')
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
  $bundles = @($manifest.dsh.profile.bundles)
}
$alreadyDependency = $null -ne $dependencies.PSObject.Properties[$PackageName]
$alreadyBundle = $bundles -contains $PackageName

if ($WhatIf) {
  Write-Step "would set dependencies['$PackageName'] = '$linkSpec' (currently $(if ($alreadyDependency) { 'set' } else { 'absent' }))"
  Write-Step "would ensure dsh.profile.bundles contains '$PackageName' (currently $(if ($alreadyBundle) { 'present' } else { 'absent' }))"
} else {
  if ($alreadyDependency) { $dependencies.PSObject.Properties.Remove($PackageName) }
  $dependencies | Add-Member -MemberType NoteProperty -Name $PackageName -Value $linkSpec -Force
  Write-Ok "dependency registered ($linkSpec)"

  if (-not $alreadyBundle) { $bundles += $PackageName }
  if (-not $manifest.dsh) { $manifest | Add-Member -MemberType NoteProperty -Name 'dsh' -Value (New-Object psobject) -Force }
  if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -MemberType NoteProperty -Name 'profile' -Value (New-Object psobject) -Force }
  $manifest.dsh.profile | Add-Member -MemberType NoteProperty -Name 'bundles' -Value $bundles -Force
  Write-Ok "bundle list: $($bundles -join ', ')"

  $backup = "$manifestPath.before-automation-plus"
  Copy-Item $manifestPath $backup -Force
  Write-Step "backup written: $backup"

  $json = $manifest | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

  # Re-read before declaring success: a manifest the app cannot parse stops it
  # from booting, so undo on any doubt.
  try {
    $check = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (@($check.dsh.profile.bundles) -notcontains $PackageName) { throw 'the bundle entry did not survive the write' }
    Write-Ok 'profile manifest rewritten and verified'
  } catch {
    Copy-Item $backup $manifestPath -Force
    throw "the profile manifest failed verification and has been restored: $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- done

Write-Host ''
if ($WhatIf) {
  Write-Host 'WHATIF complete - nothing was changed.' -ForegroundColor Yellow
} else {
  Write-Host 'Installed.' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Next: restart DeepSeek Harness. The sidebar then shows "Automation Plus"'
  Write-Host 'below the shipped automation entry.'
  Write-Host ''
  Write-Host 'To uninstall:'
  Write-Host "  1. remove '$PackageName' from dsh.profile.bundles and from dependencies"
  Write-Host "     in $manifestPath"
  Write-Host "  2. delete $linkPath"
  Write-Host "  3. delete $target"
}
Write-Host ''
