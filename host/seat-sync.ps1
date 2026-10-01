# Moves one player's saves in or out of an extra seat (a Hyper-V VM on this
# PC), for LumaArcade (server/src/web/saveSync.ts): it runs the seat's own
# profiles.ps1 through PowerShell Direct and copies the folder across.
#   -Mode export: on the seat, export the player's saves to -SeatDir, then
#                 copy that folder here to -HostDir
#   -Mode import: copy -HostDir to -SeatDir on the seat (the seat's own
#                 switch imports it before loading their saves)
# The seat's sign-in is read from -CredFile ({ arcadeUser, arcadePassword },
# made when the seat was set up). Prints one line of JSON.
#
# Deployed copy: C:\ProgramData\LumaArcade\seat-sync.ps1.
param(
    [Parameter(Mandatory)][ValidateSet('export', 'import')][string]$Mode,
    [Parameter(Mandatory)][string]$VmName,
    [Parameter(Mandatory)][string]$CredFile,
    [Parameter(Mandatory)][string]$Player,
    [Parameter(Mandatory)][string]$SeatDir,
    [Parameter(Mandatory)][string]$HostDir
)
$ErrorActionPreference = 'Stop'
try {
    $c = Get-Content -LiteralPath $CredFile -Raw | ConvertFrom-Json
    $cred = New-Object PSCredential("$VmName\$($c.arcadeUser)", (ConvertTo-SecureString $c.arcadePassword -AsPlainText -Force))
    $session = New-PSSession -VMName $VmName -Credential $cred
    try {
        if ($Mode -eq 'export') {
            $answer = Invoke-Command -Session $session -ArgumentList $Player, $SeatDir -ScriptBlock {
                param($p, $d)
                powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\LumaArcade\profiles.ps1 -Action export -Player $p -Dir $d
            }
            $line = @($answer)[-1]
            if ($line -notmatch '"exported"') { throw "the seat couldn't export: $line" }
            if (Test-Path -LiteralPath $HostDir) { Remove-Item -LiteralPath $HostDir -Recurse -Force }
            New-Item -ItemType Directory -Force -Path $HostDir | Out-Null
            Copy-Item -FromSession $session -Path (Join-Path $SeatDir '*') -Destination $HostDir -Recurse -Force
            @{ ok = $true; mode = 'export' } | ConvertTo-Json -Compress
        }
        else {
            Invoke-Command -Session $session -ArgumentList $SeatDir -ScriptBlock {
                param($d)
                if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
                New-Item -ItemType Directory -Force -Path $d | Out-Null
            }
            Copy-Item -ToSession $session -Path (Join-Path $HostDir '*') -Destination $SeatDir -Recurse -Force
            @{ ok = $true; mode = 'import' } | ConvertTo-Json -Compress
        }
    }
    finally { Remove-PSSession $session }
}
catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
