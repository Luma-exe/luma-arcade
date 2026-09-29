# Shared by the installer's PowerShell steps (dot-sourced). Output goes to
# the installer's details list, so every step says what it's doing.

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower while it draws a progress bar.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:UserAgent = @{ 'User-Agent' = 'LumaArcade-Setup' }
$script:DownloadDir = Join-Path $env:TEMP 'LumaArcadeSetup'

function Write-Step([string]$Text) { Write-Output "==> $Text" }
function Write-Note([string]$Text) { Write-Output "    $Text" }

function Get-LatestRelease([string]$Repo) {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $script:UserAgent
}

# The newest release's download whose name matches $Pattern.
function Get-GitHubAsset([string]$Repo, [string]$Pattern) {
    $release = Get-LatestRelease $Repo
    $asset = $release.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
    if (-not $asset) { throw "No download matching '$Pattern' in $Repo $($release.tag_name)" }
    [pscustomobject]@{ Url = $asset.browser_download_url; Name = $asset.name; Version = $release.tag_name }
}

function Save-Download([string]$Url, [string]$Name) {
    New-Item -ItemType Directory -Force $script:DownloadDir | Out-Null
    $file = Join-Path $script:DownloadDir $Name
    Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing -Headers $script:UserAgent
    $file
}

# 7-Zip's standalone .7z extractor (many emulators ship as .7z).
function Get-SevenZip {
    $exe = Join-Path $script:DownloadDir '7zr.exe'
    if (-not (Test-Path $exe)) { Save-Download 'https://www.7-zip.org/a/7zr.exe' '7zr.exe' | Out-Null }
    $exe
}

# Unpacks a .zip or .7z into $Destination. Most archives hold one top
# folder; its contents go straight into $Destination.
function Expand-Download([string]$File, [string]$Destination) {
    $tmp = Join-Path $script:DownloadDir ([IO.Path]::GetFileNameWithoutExtension($File) + '-unpacked')
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    if ($File -match '\.7z$') {
        & (Get-SevenZip) x $File "-o$tmp" -y | Out-Null
        if ($LASTEXITCODE) { throw "7-Zip couldn't unpack $File" }
    } else {
        Expand-Archive -LiteralPath $File -DestinationPath $tmp -Force
    }
    $root = $tmp
    $items = @(Get-ChildItem -LiteralPath $tmp -Force)
    if ($items.Count -eq 1 -and $items[0].PSIsContainer) { $root = $items[0].FullName }
    New-Item -ItemType Directory -Force $Destination | Out-Null
    Copy-Item -Path (Join-Path $root '*') -Destination $Destination -Recurse -Force
    Remove-Item -Recurse -Force $tmp
    Remove-Item -Force $File
}

# Lets every account on the PC change $Path (saves, settings), so a
# separate games account can use what an admin installed.
function Grant-UsersModify([string]$Path) {
    # S-1-5-32-545 = the built-in Users group, whatever the Windows language.
    & icacls.exe $Path /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q | Out-Null
}
