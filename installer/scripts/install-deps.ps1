# Downloads and installs the three dependencies LumaArcade's new
# Sunshine/ES-DE/moonlight-web-stream architecture needs. Invoked once by
# LumaArcade.nsi's Install section via nsExec::ExecToLog. Every step is
# best-effort and non-fatal — same philosophy the old installer used for
# GStreamer/ViGEmBus via winget: log a clear message and let the user finish
# that one piece manually per the README rather than aborting the whole
# LumaArcade install over a flaky download or an installer that doesn't
# support silent mode after all.
#
# param(1): $InstDir — LumaArcade's own install directory, so
# moonlight-web-stream can be staged as $InstDir\moonlight-web-stream.
param(
    [Parameter(Mandatory = $true)]
    [string]$InstDir
)

$ErrorActionPreference = "Continue"

function Write-Step($msg) {
    Write-Host "=== $msg ==="
}

# Every download here is over HTTPS from the project's own GitHub/GitLab
# releases API, which already rules out a network-path tamper. What it
# doesn't rule out is the file being corrupted in transit or — the case
# that actually matters for anything about to run elevated — altered after
# it was signed. Get-AuthenticodeSignature reads the file's embedded
# certificate chain, so this is a real integrity check, not just a hash of
# whatever we just downloaded (which would only prove the download wasn't
# truncated, not that it's the real binary). "NotSigned" is treated as a
# warning rather than a hard stop: plenty of legitimate open-source builds
# (this whole app included) ship unsigned. An actual "HashMismatch" —
# meaning a signature is present but no longer matches the file — is the
# one status that means "this file was tampered with after signing," and
# is the only one worth refusing to run.
function Confirm-SignatureOrWarn($path, $label) {
    $sig = Get-AuthenticodeSignature -FilePath $path
    switch ($sig.Status) {
        "Valid" { Write-Host "$label signature: valid (signed by $($sig.SignerCertificate.Subject))." ; return $true }
        "NotSigned" { Write-Host "$label is not signed — proceeding, but you're trusting the download source." ; return $true }
        "HashMismatch" { Write-Host "$label signature is INVALID (file was modified after signing) — refusing to run it. Delete $path and install manually from the project's real site, see README." ; return $false }
        default { Write-Host "$label signature check returned $($sig.Status) — proceeding, but you're trusting the download source." ; return $true }
    }
}

# ---- 1. Sunshine (MSI, confirmed silent flags) ----
Write-Step "Sunshine"
try {
    if (Get-Service -Name "SunshineService" -ErrorAction SilentlyContinue) {
        Write-Host "Sunshine already installed, skipping."
    } else {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/LizardByte/Sunshine/releases/latest"
        $asset = $rel.assets | Where-Object { $_.name -like "*Windows-AMD64-installer.msi" } | Select-Object -First 1
        if (-not $asset) {
            Write-Host "Couldn't find a Windows MSI asset in the latest Sunshine release — install manually, see README."
        } else {
            $msi = "$env:TEMP\Sunshine-installer.msi"
            Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $msi
            if (-not (Confirm-SignatureOrWarn $msi "Sunshine installer")) {
                Remove-Item $msi -Force -ErrorAction SilentlyContinue
            } else {
            # Needs admin — msiexec itself will prompt via UAC since this
            # installer otherwise runs unelevated (RequestExecutionLevel
            # user), same as the old virtual-display-driver step handled it.
            $log = "$env:TEMP\sunshine-install.log"
            $p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$msi`" /quiet /norestart /l*v `"$log`"" -Wait -PassThru -Verb RunAs
            if ($p.ExitCode -eq 0) {
                Write-Host "Sunshine installed."
            } else {
                Write-Host "Sunshine MSI exited with code $($p.ExitCode) — see $log. Install manually if needed, see README."
            }
            }
        }
    }
} catch {
    Write-Host "Sunshine install failed: $($_.Exception.Message) — install manually, see README."
}

# ---- 2. ES-DE (installer .exe from GitLab releases) ----
Write-Step "ES-DE"
$esdeCandidates = @(
    "C:\Program Files\ES-DE\ES-DE.exe",
    "C:\Program Files (x86)\ES-DE\ES-DE.exe",
    "$env:LOCALAPPDATA\Programs\ES-DE\ES-DE.exe"
)
try {
    if ($esdeCandidates | Where-Object { Test-Path $_ }) {
        Write-Host "ES-DE already installed, skipping."
    } else {
        $rel = Invoke-RestMethod -Uri "https://gitlab.com/api/v4/projects/es-de%2Femulationstation-de/releases"
        $latest = $rel | Select-Object -First 1
        $asset = $latest.assets.links | Where-Object { $_.name -like "*-x64.exe" } | Select-Object -First 1
        if (-not $asset) {
            Write-Host "Couldn't find a Windows .exe asset in the latest ES-DE release — install manually, see README."
        } else {
            $exe = "$env:TEMP\ES-DE-installer.exe"
            Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $exe
            if (-not (Confirm-SignatureOrWarn $exe "ES-DE installer")) {
                Remove-Item $exe -Force -ErrorAction SilentlyContinue
            } else {
            # ES-DE's installer's exact silent-mode support wasn't confirmed
            # against its own docs — /S is the standard NSIS/CPack-NSIS
            # convention and is tried first, but this is genuinely a
            # best-effort guess, not a verified fact like the Sunshine MSI
            # flags above. If it silently does nothing or pops a wizard
            # instead, the exe is still on disk for the user to run by hand.
            $p = Start-Process -FilePath $exe -ArgumentList "/S" -Wait -PassThru -Verb RunAs
            Write-Host "ES-DE installer exited with code $($p.ExitCode). If ES-DE isn't at C:\Program Files\ES-DE afterward, run $exe manually."
            }
        }
    }
} catch {
    Write-Host "ES-DE install failed: $($_.Exception.Message) — install manually, see README."
}

# ---- 3. moonlight-web-stream (no installer — extract a release zip) ----
Write-Step "moonlight-web-stream"
try {
    $dest = "$InstDir\moonlight-web-stream"
    if (Test-Path "$dest\web-server.exe") {
        Write-Host "moonlight-web-stream already staged, skipping."
    } else {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/MrCreativ3001/moonlight-web-stream/releases/latest"
        $asset = $rel.assets | Where-Object { $_.name -like "*-x86_64-pc-windows-gnu.zip" } | Select-Object -First 1
        if (-not $asset) {
            Write-Host "Couldn't find a Windows zip asset in the latest moonlight-web-stream release — install manually, see README."
        } else {
            $zip = "$env:TEMP\moonlight-web-stream.zip"
            Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zip
            New-Item -ItemType Directory -Path $dest -Force | Out-Null
            Expand-Archive -Path $zip -DestinationPath $dest -Force
            Remove-Item $zip -Force
            # The release zip wraps everything in a "package" subfolder —
            # flatten it so $dest\web-server.exe is a stable, predictable
            # path for LumaArcade's own dependency detection to find.
            $inner = Join-Path $dest "package"
            if (Test-Path $inner) {
                Get-ChildItem $inner | Move-Item -Destination $dest -Force
                Remove-Item $inner -Recurse -Force
            }
            Write-Host "moonlight-web-stream staged at $dest."
        }
    }
} catch {
    Write-Host "moonlight-web-stream setup failed: $($_.Exception.Message) — install manually, see README."
}

Write-Host "=== Dependency setup finished. Open LumaArcade -> Settings -> Streaming -> 'Detect & wire up dependencies' next. ==="
