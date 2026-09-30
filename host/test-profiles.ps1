# profiles.ps1 against a throwaway folder layout: Xenia profiles (one made
# mid-session), the shared DLC folder, xemu with and without a clean disk
# image, melonDS, snapshots. Never touches the real saves.
#   powershell -ExecutionPolicy Bypass -File host\test-profiles.ps1
$ErrorActionPreference = 'Stop'
$s = Join-Path $PSScriptRoot 'profiles.ps1'
$t = Join-Path $env:TEMP "prof-$(Get-Random)"
$c = "$t\Emulators\xenia_canary\content"
$X1 = 'E030000077C944B6'; $X2 = 'E00029B25206674C'; $X3 = 'E0000000DEADBEEF'
function Put($path, $text) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; Set-Content $path $text }
Put "$c\$X1\FFFE07D1\00010000\$X1\Account" 'acct1'
Put "$c\$X1\FFFE07D1\00010000\$X1\4D5309C9.gpd" 'achievements'
Put "$c\$X1\4D5309C9\00000001\ForzaProfile\save" 'forza progress'
Put "$c\$X2\FFFE07D1\00010000\$X2\Account" 'acct2'
Put "$c\0000000000000000\4D5309C9\00000002\dlc.bin" 'dlc'
Put "$t\Emulators\melonDS\saves\MKDS.sav" 'old ds save'
Put "$t\BIOS\XBOXOG\hdd\xbox_hdd.qcow2" 'used disk'
New-Item -ItemType Directory -Force "$t\gamelists", "$t\Roaming" | Out-Null
$fails = 0
function Check($what, $ok) { if ($ok) { "  ok   $what" } else { "  FAIL $what"; $script:fails++ } }
function Run($player) { & powershell -NoProfile -ExecutionPolicy Bypass -File $s -TestRoot $t -Player $player | Out-Null }

"Alice's first time"
Run '5:Alice'
Check 'Xenia profile kept (Account)' (Test-Path "$c\$X1\FFFE07D1\00010000\$X1\Account")
Check 'no one else''s Xenia save' (-not (Test-Path "$c\$X1\4D5309C9"))
Check 'no one else''s achievements' (-not (Test-Path "$c\$X1\FFFE07D1\00010000\$X1\4D5309C9.gpd"))
Check 'old Xenia saves kept as shared' (Test-Path "$t\Emulators\xenia_canary\content-profiles\$X1\_shared\4D5309C9\00000001\ForzaProfile\save")
Check 'DLC folder untouched' (Test-Path "$c\0000000000000000\4D5309C9\00000002\dlc.bin")
Check 'nothing put away inside content' (-not (Get-ChildItem $c -Directory | Where-Object Name -like '*.profiles'))
Check 'melonDS starts empty' ((Get-ChildItem "$t\Emulators\melonDS\saves" | Measure-Object).Count -eq 0)
Check 'xemu disk untouched without a clean image' ((Get-Content "$t\BIOS\XBOXOG\hdd\xbox_hdd.qcow2") -eq 'used disk')

"Alice plays: saves Forza, makes a new Xenia profile"
Put "$c\$X1\4D5309C9\00000001\ForzaProfile\save" 'alice forza'
Put "$c\$X3\FFFE07D1\00010000\$X3\Account" 'alice new profile'
Put "$t\BIOS\XBOXOG\hdd-clean\xbox_hdd.qcow2" 'clean disk'

"Bob's first time"
Run '6:Bob'
Check 'Bob has no Forza save' (-not (Test-Path "$c\$X1\4D5309C9"))
Check 'Alice''s new profile put away as hers' (Test-Path "$t\Emulators\xenia_canary\content-profiles\$X3\user-5\FFFE07D1\00010000\$X3\Account")
Check 'Bob doesn''t see Alice''s new profile' (-not (Test-Path "$c\$X3"))
Check 'xemu: Bob gets a clean disk' ((Get-Content "$t\BIOS\XBOXOG\hdd\xbox_hdd.qcow2") -eq 'clean disk')
Check 'xemu: old disk kept as shared' ((Get-Content "$t\BIOS\XBOXOG\hdd.profiles\_shared\xbox_hdd.qcow2") -eq 'used disk')

"Back to Alice"
Run '5:Alice'
Check 'Alice''s Forza save back' ((Get-Content "$c\$X1\4D5309C9\00000001\ForzaProfile\save") -eq 'alice forza')
Check 'Alice''s new profile back' (Test-Path "$c\$X3\FFFE07D1\00010000\$X3\Account")
Check 'xemu: Alice (had no disk of her own) gets a clean one' ((Get-Content "$t\BIOS\XBOXOG\hdd\xbox_hdd.qcow2") -eq 'clean disk')

"Snapshot"
$snap = & powershell -NoProfile -ExecutionPolicy Bypass -File $s -TestRoot $t -Action snapshot -Player '5:Alice' -Label test
$name = ($snap | ConvertFrom-Json).snapshot
Check 'snapshot has Alice''s Xenia saves' (Test-Path "$t\snapshots\user-5\$name\Xenia-$X1\4D5309C9")
Check 'snapshot leaves out the xemu disk' (-not (Test-Path "$t\snapshots\user-5\$name\xemu-hdd"))

"Log:"; Get-Content "$t\profiles\profiles.log" | Select-String 'fail|couldn|both exist' | ForEach-Object { "  $_" }
Remove-Item $t -Recurse -Force
"failures: $fails"
