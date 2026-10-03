# Shared by the installer's PowerShell steps (dot-sourced). Output goes to
# the installer's details list, so every step says what it's doing.

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower while it draws a progress bar.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:UserAgent = @{ 'User-Agent' = 'LumaArcade-Setup' }
$script:DownloadDir = Join-Path $env:TEMP 'LumaArcadeSetup'
# Versions known to work, with checksums (versions.json, refreshed by
# update-versions.ps1 / the "Tested versions" GitHub workflow).
$script:VersionsFile = Join-Path $PSScriptRoot 'versions.json'

function Write-Step([string]$Text) { Write-Output "==> $Text" }
function Write-Note([string]$Text) { Write-Output "    $Text" }

# Headers for GitHub API lookups: with GITHUB_TOKEN set (the "Tested
# versions" workflow), a higher rate limit. Only ever sent to api.github.com
# lookups, not downloads (those redirect to other hosts).
function Get-GitHubApiHeaders {
    $headers = $script:UserAgent.Clone()
    if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }
    $headers
}

function Get-LatestRelease([string]$Repo) {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers (Get-GitHubApiHeaders)
}

# The newest release's download whose name matches $Pattern.
function Get-GitHubAsset([string]$Repo, [string]$Pattern) {
    $release = Get-LatestRelease $Repo
    $asset = $release.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
    if (-not $asset) { throw "No download matching '$Pattern' in $Repo $($release.tag_name)" }
    # Rolling releases ("latest", "continuous") replace their files under the
    # same tag and name: say when this one was built.
    $version = $release.tag_name
    $rolling = $version -notmatch '\d'
    if ($rolling) { $version = "$version $(([datetime]$asset.updated_at).ToString('yyyy-MM-dd'))" }
    # AssetUrl names this exact file (a replaced one gets a new id), which
    # is how update-versions.ps1 tells a rolling release's new build apart.
    [pscustomobject]@{ Url = $asset.browser_download_url; AssetUrl = $asset.url; Name = $asset.name; Version = $version; Rolling = $rolling }
}

function Get-PinnedVersions {
    if (-not $script:Pinned) {
        $script:Pinned = if (Test-Path $script:VersionsFile) {
            (Get-Content -Raw $script:VersionsFile | ConvertFrom-Json).downloads
        } else { [pscustomobject]@{} }
    }
    $script:Pinned
}

# The newest release of a download: $Entry has a Source script block, or
# a GitHub Repo and a Pattern for the asset's name.
function Resolve-Latest($Entry) {
    if ($Entry.Source) { return [pscustomobject](& $Entry.Source) }
    Get-GitHubAsset $Entry.Repo $Entry.Pattern
}

# What to download for $Key: the tested version from versions.json, or with
# -Latest (or when nothing is pinned) the newest release. The pinned one
# carries a checksum that Save-Download checks.
function Get-Download([string]$Key, $Entry, [switch]$Latest) {
    $pin = (Get-PinnedVersions).$Key
    if ($pin -and -not $Latest) {
        return [pscustomobject]@{ Url = $pin.url; Name = $pin.name; Version = $pin.version; Sha256 = $pin.sha256; Rolling = ($pin.rolling -eq 'true'); Pinned = $true }
    }
    $src = Resolve-Latest $Entry
    $src | Add-Member -NotePropertyName Pinned -NotePropertyValue $false -Force
    $src
}

# Downloads $Source (from Get-Download, or anything with Url and Name). A
# pinned download must match its checksum; if its release was taken down,
# the newest one ($Entry's) is used instead, with a note. Plain download
# addresses only: GitHub's API allows 60 requests an hour, which a couple of
# installs would use up.
function Save-Download($Source, $Entry) {
    New-Item -ItemType Directory -Force $script:DownloadDir | Out-Null
    $file = Join-Path $script:DownloadDir $Source.Name
    try {
        Invoke-WebRequest -Uri $Source.Url -OutFile $file -UseBasicParsing -Headers $script:UserAgent
    } catch {
        if (-not ($Source.Pinned -and $Entry)) { throw }
        Write-Note "The tested version ($($Source.Version)) can't be downloaded any more ($($_.Exception.Message)); using the newest one"
        return Save-Download (Resolve-Latest $Entry)
    }
    if ($Source.Sha256) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
        if ($hash -ne $Source.Sha256 -and $Source.Rolling) {
            # A rolling release replaced the tested build with a newer one
            # under the same address: that's the only one there is now.
            Write-Note "The tested build ($($Source.Version)) was replaced by a newer one; using that"
        } elseif ($hash -ne $Source.Sha256) {
            Remove-Item -Force -LiteralPath $file
            throw "$($Source.Name) doesn't match the checksum of the tested version (got $hash) - not installing it"
        }
    }
    $file
}

# 7-Zip's standalone .7z extractor (many emulators ship as .7z).
function Get-SevenZip {
    $exe = Join-Path $script:DownloadDir '7zr.exe'
    if (-not (Test-Path $exe)) {
        $entry = @{ Source = { @{ Url = 'https://www.7-zip.org/a/7zr.exe'; Name = '7zr.exe'; Version = 'latest' } } }
        Save-Download (Get-Download '7zr' $entry) $entry | Out-Null
    }
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
        # .NET's unzip: Expand-Archive (PowerShell 5) takes minutes on an
        # archive of thousands of files, like the Iconic theme.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($File, $tmp)
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

# Reads a secret the installer handed over in a file (never on a command
# line other programs can see), then deletes the file unless -Keep (a file
# someone passed to a silent install is theirs).
function Read-SecretFile([string]$Path, [switch]$Keep) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $value = (Get-Content -Raw -LiteralPath $Path).TrimEnd("`r", "`n")
    if (-not $Keep) { Remove-Item -Force -LiteralPath $Path }
    $value
}

# One argument for a program's command line, quoted the way Windows programs
# split them (a password can hold quotes and backslashes).
function ConvertTo-Argument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', { param($m) ($m.Groups[1].Value * 2) + '\"' })
    $escaped = [regex]::Replace($escaped, '(\\+)$', { param($m) $m.Groups[1].Value * 2 })
    '"' + $escaped + '"'
}
