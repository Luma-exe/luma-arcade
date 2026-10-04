# The inside half of building an extra seat (host/seat-manager.ps1 runs it
# in the seat's Windows through PowerShell Direct, as the seat's admin
# account). C:\SeatSetup\plan.json says what the main PC has and where;
# C:\SeatSetup\setup holds Setup's own scripts (Sunshine, drivers, Luma
# Arcade's helpers) so a seat is set up the same way the main PC was.
#   -Step games     the games share as a drive, ES-DE and the emulators
#                   copied in (ROMs, BIOS files and media stay on the share),
#                   paths in their settings pointed at the seat's copies
#   -Step software  Sunshine, the virtual controllers, OpenGL/Vulkan for the
#                   partitioned graphics card (Mesa), autologon, Luma
#                   Arcade's helpers (per-player saves, lockdown, Home)
#   -Step pair      trusts Luma Arcade's certificate, so it can stream
#                   without a PIN, and hands back Sunshine's own
# Prints what it does, then one line of JSON: { "ok": true, ... }.
param([Parameter(Mandatory)][ValidateSet('games', 'software', 'pair')][string]$Step)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$plan = Get-Content -Raw 'C:\SeatSetup\plan.json' | ConvertFrom-Json
$Setup = 'C:\SeatSetup\setup'
$EsDe = 'C:\ES-DE'
$DataDir = 'C:\ProgramData\LumaArcade'
$SunshineDir = Join-Path $env:ProgramFiles 'Sunshine'
$Account = $plan.arcadeUser

function Say([string]$Text) { Write-Output $Text }
function Answer($Object) { Write-Output ($Object | ConvertTo-Json -Compress -Depth 5) }

function Grant-Account([string]$Path) {
    if (Test-Path -LiteralPath $Path) { & icacls.exe $Path /grant "${Account}:(OI)(CI)M" /T /C /Q | Out-Null }
}

# The games share for this session (copying), without a drive letter.
function Connect-Share {
    & net.exe use $plan.share /delete /y 2>$null | Out-Null
    & net.exe use $plan.share $plan.sharePassword "/user:$($plan.shareUser)" /persistent:no | Out-Null
    if ($LASTEXITCODE) { throw "Can't open the games share $($plan.share) (net use exit code $LASTEXITCODE)" }
}

# Host paths in settings files, pointed at the seat's: one pass over each
# file, longest match first, in \, / and \\ (JSON) spellings.
function Update-Paths([string[]]$Roots) {
    # Ones that stay the same (ROMs on the share) still count: they keep a
    # shorter one (G:\ES-DE) from matching them.
    $pairs = @($plan.rewrites | Where-Object { $_.from } | Sort-Object { $_.from.Length } -Descending)
    if (-not ($pairs | Where-Object { $_.from -ne $_.to })) { return 0 }
    $alts = @()
    $map = @{}
    foreach ($p in $pairs) {
        foreach ($sep in '\', '/', '\\') {
            $from = $p.from.Replace('\', $sep)
            $alts += [regex]::Escape($from)
            $map[$from.ToLower()] = $p.to.Replace('\', $sep)
        }
    }
    # Only a whole path: G:\ES-DE must match neither XG:\ES-DE nor G:\ES-DE-old.
    $regex = New-Object Text.RegularExpressions.Regex ('(?<![A-Za-z0-9_])(' + ($alts -join '|') + ')(?=[\\/"''<\s,;]|$)'), 'IgnoreCase'
    $evaluator = [Text.RegularExpressions.MatchEvaluator] { param($m) $map[$m.Value.ToLower()] }
    $changed = 0
    foreach ($root in $Roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $files = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -match '^\.(xml|cfg|ini|toml|json|ya?ml|conf|txt|opt)$' -and $_.Length -lt 8MB }
        foreach ($f in $files) {
            try {
                $text = [IO.File]::ReadAllText($f.FullName)
                if (-not $regex.IsMatch($text)) { continue }
                $bom = [IO.File]::ReadAllBytes($f.FullName)
                $encoding = if ($bom.Length -ge 3 -and $bom[0] -eq 0xEF -and $bom[1] -eq 0xBB -and $bom[2] -eq 0xBF) { New-Object Text.UTF8Encoding $true } else { New-Object Text.UTF8Encoding $false }
                [IO.File]::WriteAllText($f.FullName, $regex.Replace($text, $evaluator), $encoding)
                $changed++
            } catch { Say "  couldn't update $($f.FullName): $($_.Exception.Message)" }
        }
    }
    $changed
}

function Set-EsDeSetting([string]$File, [string]$Name, [string]$Value) {
    if (-not (Test-Path -LiteralPath $File)) { return }
    $lines = @(Get-Content -LiteralPath $File)
    $line = "<string name=`"$Name`" value=`"$([Security.SecurityElement]::Escape($Value))`" />"
    $at = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "name=`"$Name`"") { $i } })
    if ($at) { $lines[$at[0]] = $line } else { $lines += $line }
    $lines | Set-Content -LiteralPath $File -Encoding UTF8
}

try {
    switch ($Step) {
        'games' {
            Connect-Share
            # Copied from the share (robocopy, fast); what isn't on it was
            # pushed into place by seat-manager.ps1 already.
            foreach ($c in @($plan.copies)) {
                $from = Join-Path $plan.share $c.share
                Say "Copying $($c.share) from the games share to $($c.dest)"
                $xd = @($c.exclude | ForEach-Object { Join-Path $plan.share $_ })
                $robo = @($from, $c.dest, '/E', '/R:1', '/W:2', '/MT:16', '/NFL', '/NDL', '/NP', '/NJH', '/XJ')
                if ($xd) { $robo += '/XD'; $robo += $xd }
                & robocopy.exe @robo | Out-Null
                # robocopy: 0-7 is success of some kind, 8+ means something failed.
                if ($LASTEXITCODE -ge 8) { throw "Copying $($c.share) failed (robocopy exit code $LASTEXITCODE)" }
            }
            if (-not (Test-Path (Join-Path $EsDe 'ES-DE.exe'))) { throw "ES-DE.exe isn't in $EsDe after copying" }

            $n = Update-Paths @($EsDe, $plan.esDeDataDest)
            Say "Pointed $n settings file(s) at the seat's copies"
            # ES-DE's ROMs and media stay on the share.
            $settings = Join-Path $plan.esDeDataDest 'settings\es_settings.xml'
            if ($plan.romDir) { Set-EsDeSetting $settings 'ROMDirectory' $plan.romDir }
            if ($plan.mediaDir) { Set-EsDeSetting $settings 'MediaDirectory' $plan.mediaDir }
            # No update checks inside a seat.
            Set-EsDeSetting $settings 'ApplicationUpdaterFrequency' 'never'
            Grant-Account $EsDe
            Grant-Account $plan.esDeDataDest

            # The share as a drive letter for the games account, every time
            # it signs in (elevated programs too: EnableLinkedConnections).
            New-Item -ItemType Directory -Force $DataDir | Out-Null
            $cmd = Join-Path $DataDir 'map-games.cmd'
            @(
                '@echo off'
                'rem The main PC''s games folder (read-only), from Luma Arcade''s seat setup.'
                "net use $($plan.gamesLetter): /delete /y >nul 2>&1"
                "net use $($plan.gamesLetter): $($plan.share) `"$($plan.sharePassword)`" /user:$($plan.shareUser) /persistent:no"
            ) | Set-Content -Path $cmd -Encoding ASCII
            & icacls.exe $cmd /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "${Account}:RX" /Q | Out-Null
            Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLinkedConnections -Value 1 -Type DWord
            $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`""
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
            $principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName 'Games drive' -TaskPath '\LumaArcade\' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
            Answer @{ ok = $true }
        }

        'software' {
            # Lets Sunshine's ports in on any network type, and keeps the
            # seat awake, unlocked and out of Windows Update's driver offers
            # (the partitioned graphics card needs the main PC's driver).
            Get-NetConnectionProfile | Where-Object NetworkCategory -ne 'DomainAuthenticated' | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue
            foreach ($proto in 'TCP', 'UDP') {
                Get-NetFirewallRule -DisplayName "Luma Arcade seat: Sunshine $proto" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
                New-NetFirewallRule -DisplayName "Luma Arcade seat: Sunshine $proto" -Direction Inbound -Protocol $proto -LocalPort 47984-48010 -Profile Any -Action Allow | Out-Null
            }
            $personalization = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
            New-Item -Path $personalization -Force | Out-Null
            Set-ItemProperty $personalization -Name NoLockScreen -Value 1 -Type DWord
            Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -Value 0 -Type DWord
            $wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
            New-Item -Path $wu -Force | Out-Null
            Set-ItemProperty $wu -Name ExcludeWUDriversInQualityUpdate -Value 1 -Type DWord
            & powercfg.exe /change standby-timeout-ac 0
            & powercfg.exe /change monitor-timeout-ac 0

            # Autologon through an LSA secret, as on the main PC.
            $pw = Join-Path $env:TEMP 'seat-account.txt'
            [IO.File]::WriteAllText($pw, $plan.arcadePassword)
            & (Join-Path $Setup 'setup-windows.ps1') -Account $Account -PasswordFile $pw -AutoLogon
            Remove-Item $pw -Force -ErrorAction SilentlyContinue

            & (Join-Path $Setup 'install-drivers.ps1') -ViGEm
            $ds4 = [bool]($plan.sunshineConf | Where-Object { $_ -match '^\s*gamepad\s*=\s*ds4' })
            & (Join-Path $Setup 'install-sunshine.ps1') -EsDeExe (Join-Path $EsDe 'ES-DE.exe') -Ds4:$ds4

            # The main PC's encoder settings; Sunshine picks the seat's own screen.
            $conf = Join-Path $SunshineDir 'config\sunshine.conf'
            $keys = @($plan.sunshineConf | ForEach-Object { ($_ -split '=')[0].Trim() })
            $lines = @(if (Test-Path $conf) { Get-Content $conf | Where-Object { $k = ($_ -split '=')[0].Trim(); $k -notin $keys -and $k -notmatch '^(output_name|dd_)' } })
            ($lines + @($plan.sunshineConf)) | Set-Content -Path $conf -Encoding ASCII
            # Sunshine's own web page (its log), with the seat's password.
            $p = Start-Process -FilePath (Join-Path $SunshineDir 'sunshine.exe') -ArgumentList '--creds', $plan.sunshineUser, $plan.sunshinePassword -WorkingDirectory $SunshineDir -WindowStyle Hidden -PassThru
            # It writes them straight away but doesn't always exit.
            if (-not $p.WaitForExit(30000)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

            # OpenGL and Vulkan through Direct3D 12 (Mesa): the partitioned
            # card only offers Direct3D inside a VM, and ES-DE, RetroArch and
            # others need OpenGL.
            . (Join-Path $Setup 'common.ps1')
            . (Join-Path $Setup 'catalog.ps1')
            $mesa = Join-Path $env:ProgramFiles 'Mesa'
            if (-not (Test-Path (Join-Path $mesa 'opengl32.dll'))) {
                Say 'Mesa (OpenGL and Vulkan over Direct3D 12)'
                $file = Save-CatalogDownload 'mesa' (Get-CatalogDownload 'mesa')
                $tmp = Join-Path $env:TEMP 'mesa-unpacked'
                if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
                New-Item -ItemType Directory $tmp | Out-Null
                & (Get-SevenZip) x $file "-o$tmp" -y | Out-Null
                if ($LASTEXITCODE) { throw "Couldn't unpack Mesa" }
                New-Item -ItemType Directory -Force $mesa | Out-Null
                Copy-Item (Join-Path $tmp 'x64\*') $mesa -Recurse -Force
                Remove-Item $tmp -Recurse -Force
            }
            [Environment]::SetEnvironmentVariable('GALLIUM_DRIVER', 'd3d12', 'Machine')
            # Next to the programs that load OpenGL from their own folder.
            $glUsers = @((Join-Path $EsDe 'ES-DE.exe')) + @(Get-ChildItem (Join-Path $EsDe 'Emulators') -Recurse -Filter retroarch.exe -ErrorAction SilentlyContinue | ForEach-Object FullName)
            foreach ($exe in $glUsers) {
                foreach ($dll in 'opengl32.dll', 'libgallium_wgl.dll', 'dxil.dll') {
                    if (Test-Path (Join-Path $mesa $dll)) { Copy-Item (Join-Path $mesa $dll) (Split-Path $exe) -Force }
                }
            }
            $icd = Join-Path $mesa 'dzn_icd.x86_64.json'
            if (Test-Path $icd) {
                New-Item -Path 'HKLM:\SOFTWARE\Khronos\Vulkan\Drivers' -Force | Out-Null
                New-ItemProperty -Path 'HKLM:\SOFTWARE\Khronos\Vulkan\Drivers' -Name $icd -Value 0 -PropertyType DWord -Force | Out-Null
            }

            # Luma Arcade's helpers, as on the main PC; this seat asks the
            # main PC's Luma Arcade who's playing it.
            & (Join-Path $Setup 'install-host.ps1') -LumaDir 'C:\SeatSetup\luma' -Account $Account -Port $plan.port -EsDeExe (Join-Path $EsDe 'ES-DE.exe')
            $hostFile = Join-Path $DataDir 'host.json'
            $config = Get-Content -Raw $hostFile | ConvertFrom-Json
            $config | Add-Member -NotePropertyName luma -NotePropertyValue "http://$($plan.hostAddress):$($plan.port)" -Force
            $config | Add-Member -NotePropertyName seat -NotePropertyValue $plan.name -Force
            if ($plan.bios) { $config | Add-Member -NotePropertyName bios -NotePropertyValue $plan.bios -Force }
            $config | ConvertTo-Json | Set-Content -Path $hostFile -Encoding UTF8
            # This seat has no launchers' games of its own to scan.
            Unregister-ScheduledTask -TaskName 'PC Games' -TaskPath '\LumaArcade\' -Confirm:$false -ErrorAction SilentlyContinue
            # Locked down for everyone, always (no one administers a seat
            # from its own desktop): admin tools close as they open.
            New-Item -ItemType Directory -Force (Join-Path $DataDir 'home') | Out-Null
            @{ on = $true; until = 4102444800000; who = 'everyone (extra seat)' } | ConvertTo-Json | Set-Content -Path (Join-Path $DataDir 'home\lockdown.json') -Encoding UTF8
            $task = Get-ScheduledTask -TaskName 'Lockdown' -TaskPath '\LumaArcade\' -ErrorAction SilentlyContinue
            if ($task) { Set-ScheduledTask -TaskName 'Lockdown' -TaskPath '\LumaArcade\' -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $Account) | Out-Null }
            Answer @{ ok = $true }
        }

        'pair' {
            # Luma Arcade's client certificate, trusted like a paired device.
            $state = Join-Path $SunshineDir 'config\sunshine_state.json'
            $deadline = (Get-Date).AddMinutes(2)
            while (-not (Test-Path $state) -and (Get-Date) -lt $deadline) { Start-Sleep 3 }
            Stop-Service SunshineService -Force
            $json = if (Test-Path $state) { Get-Content -Raw $state | ConvertFrom-Json } else { [pscustomobject]@{} }
            if (-not $json.root) { $json | Add-Member -NotePropertyName root -NotePropertyValue ([pscustomobject]@{}) -Force }
            $devices = @($json.root.named_devices | Where-Object { $_ -and $_.cert.Trim() -ne $plan.clientCert.Trim() })
            $devices += [pscustomobject]@{ name = 'Luma Arcade'; cert = $plan.clientCert; uuid = [guid]::NewGuid().ToString().ToUpper(); enabled = $true }
            $json.root | Add-Member -NotePropertyName named_devices -NotePropertyValue $devices -Force
            if (-not $json.root.uniqueid) { $json.root | Add-Member -NotePropertyName uniqueid -NotePropertyValue ([guid]::NewGuid().ToString().ToUpper()) -Force }
            $json | ConvertTo-Json -Depth 6 | Set-Content -Path $state -Encoding UTF8
            Start-Service SunshineService
            $cert = Join-Path $SunshineDir 'config\credentials\cacert.pem'
            $deadline = (Get-Date).AddMinutes(1)
            while (-not (Test-Path $cert) -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
            if (-not (Test-Path $cert)) { throw "Sunshine has no certificate ($cert)" }
            # What it found to encode with (NVENC, AMF or Quick Sync).
            Start-Sleep 5
            $log = Join-Path $SunshineDir 'config\sunshine.log'
            $encoder = if (Test-Path $log) { (Select-String -Path $log -Pattern 'Found (H\.264|HEVC|AV1) encoder' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line } else { '' }
            if ($encoder) { Say "Sunshine: $encoder" }
            Answer @{ ok = $true; serverCert = (Get-Content -Raw $cert) }
        }
    }
} catch {
    Answer @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
