# Refreshes versions.json: the version of each download the installer uses,
# with its checksum. For every entry in catalog.ps1 it finds the newest
# release; if that's newer than the pinned one, it downloads it, checks it
# really is what the installer expects (the emulator's .exe is in the
# archive, the .msi is an installer...) and pins it. A download that fails
# a check keeps its old pin, so one bad release never reaches installs.
#
#   powershell -ExecutionPolicy Bypass -File update-versions.ps1 [-Only sunshine,dolphin] [-Force]
#
# -Force re-downloads and re-checks entries whose version didn't change.
# Run by the "Tested versions" GitHub workflow, which opens a pull request
# with the changes. Prints a summary (also to -SummaryFile).
param(
    [string]$Only = '',
    [switch]$Force,
    [string]$SummaryFile = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'catalog.ps1')

$keys = @($Catalog.Keys) + @($OtherDownloads.Keys)
if ($Only) { $keys = @($Only -split '[,\s]+' | Where-Object { $_ }) }

$current = [ordered]@{}
if (Test-Path $script:VersionsFile) {
    $json = Get-Content -Raw $script:VersionsFile | ConvertFrom-Json
    foreach ($p in $json.downloads.PSObject.Properties) { $current[$p.Name] = $p.Value }
}

# The names of the files in an archive (without unpacking it).
function Get-ArchiveNames([string]$File) {
    if ($File -match '\.7z$') {
        $out = & (Get-SevenZip) l -ba -slt $File
        if ($LASTEXITCODE) { throw "7-Zip couldn't read $File" }
        return @($out | Where-Object { $_ -like 'Path = *' } | ForEach-Object { $_.Substring(7) })
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($File)
    try { return @($zip.Entries | ForEach-Object { $_.FullName -replace '/', '\' }) } finally { $zip.Dispose() }
}

function Test-FileStart([string]$File, [byte[]]$Magic) {
    $bytes = [byte[]]::new($Magic.Length)
    $stream = [IO.File]::OpenRead($File)
    try { [void]$stream.Read($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    -not (Compare-Object $bytes $Magic -SyncWindow 0)
}

# Throws unless $File is what the installer expects for $Entry.
function Test-Download($Entry, [string]$File) {
    $check = if ($Entry.Exe) { $Entry.Exe } else { $Entry.Check }
    switch ($check) {
        'msi' { if (-not (Test-FileStart $File ([byte[]](0xD0, 0xCF, 0x11, 0xE0)))) { throw 'not an .msi installer' } }
        'exe' { if (-not (Test-FileStart $File ([byte[]](0x4D, 0x5A)))) { throw 'not a program (.exe)' } }
        'cab' { if (-not (Test-FileStart $File ([byte[]](0x4D, 0x53, 0x43, 0x46)))) { throw 'not a .cab' } }
        default {
            $names = Get-ArchiveNames $File
            $want = $check.ToLowerInvariant()
            $hit = $names | Where-Object { $n = $_.ToLowerInvariant(); $n -eq $want -or $n.EndsWith('\' + $want) } | Select-Object -First 1
            if (-not $hit) { throw "$check isn't in the download" }
        }
    }
}

$changes = @()
$problems = @()
foreach ($key in $keys) {
    $entry = Get-CatalogEntry $key
    $old = $current[$key]
    try {
        $src = Resolve-Latest $entry
    } catch {
        $problems += "${key}: couldn't find the newest release ($($_.Exception.Message))"
        continue
    }
    # Same file as the pinned one: same address (for GitHub, the same asset
    # id - rolling releases keep their tag and name but not their id).
    $same = $old -and $old.url -eq $src.Url -and $(if ($src.AssetUrl) { $old.assetUrl -eq $src.AssetUrl } else { $old.version -eq $src.Version })
    if ($same -and -not $Force) {
        Write-Note "$key $($src.Version): unchanged"
        continue
    }
    Write-Step "$key $($src.Version)$(if ($old) { " (pinned: $($old.version))" })"
    try {
        $file = Save-Download $src
        Test-Download $entry $file
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
        Remove-Item -Force $file
        $pin = [ordered]@{ version = [string]$src.Version; name = $src.Name; url = $src.Url }
        if ($src.AssetUrl) { $pin.assetUrl = $src.AssetUrl }
        if ($src.Rolling) { $pin.rolling = 'true' }
        $pin.sha256 = $hash
        if ($old -and $old.sha256 -eq $hash -and $old.assetUrl -eq $src.AssetUrl) { Write-Note 'same file'; continue }
        $current[$key] = [pscustomobject]$pin
        $changes += "${key}: " + $(if (-not $old) { $src.Version } elseif ($old.version -eq $src.Version) { "$($src.Version) (same version, new file)" } else { "$($old.version) -> $($src.Version)" })
        Write-Note "OK $hash"
    } catch {
        $problems += "$key $($src.Version): $($_.Exception.Message) - keeping $(if ($old) { $old.version } else { 'nothing pinned' })"
        Write-Note "FAILED: $($_.Exception.Message)"
    }
}

# The same text from Windows PowerShell and PowerShell 7 (their
# ConvertTo-Json layouts differ), UTF-8 without a BOM, LF: stable diffs.
function ConvertTo-JsonString([string]$Value) {
    '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}
if ($changes) {
    $lines = @('{')
    $lines += '  "comment": ' + (ConvertTo-JsonString 'Download versions the installer uses, checked by installer/scripts/update-versions.ps1. Change them with that script, not by hand.') + ','
    $lines += '  "updated": ' + (ConvertTo-JsonString (Get-Date -Format 'yyyy-MM-dd')) + ','
    $lines += '  "downloads": {'
    $names = @($current.Keys | Sort-Object)
    for ($i = 0; $i -lt $names.Count; $i++) {
        $pin = $current[$names[$i]]
        $fields = @($pin.PSObject.Properties | ForEach-Object { '      ' + (ConvertTo-JsonString $_.Name) + ': ' + (ConvertTo-JsonString ([string]$_.Value)) })
        $lines += '    ' + (ConvertTo-JsonString $names[$i]) + ': {'
        $lines += $fields -join ",`n"
        $lines += '    }' + $(if ($i -lt $names.Count - 1) { ',' })
    }
    $lines += '  }'
    $lines += '}'
    [IO.File]::WriteAllText($script:VersionsFile, ($lines -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))
}

$summary = @('## Download versions', '')
$summary += if ($changes) { @('Updated:', '') + ($changes | ForEach-Object { "- $_" }) } else { 'Nothing new.' }
if ($problems) { $summary += @('', 'Not updated (these keep their tested version):', '') + ($problems | ForEach-Object { "- $_" }) }
$summary | ForEach-Object { Write-Output $_ }
if ($SummaryFile) { $summary -join "`n" | Set-Content -Path $SummaryFile -Encoding UTF8 }
