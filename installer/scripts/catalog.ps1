# Everything the installer downloads, and how to find each one's newest
# release (dot-sourced after common.ps1). Installs use the tested version
# pinned in versions.json; update-versions.ps1 uses these to find newer ones.
#
# Emulators: with ES-DE they go in ES-DE\Emulators\<Folder>: the folder
# names ES-DE's portable find rules look for, so every system works without
# setting paths. Portable = marker files/folders that keep an emulator's
# settings and saves in its own folder (shared by every account) instead of
# the user profile.

$Catalog = [ordered]@{
    retroarch   = @{ Name = 'RetroArch (NES, SNES, Mega Drive, Game Boy, N64, PC Engine, arcade...)'; Folder = 'RetroArch-Win64'; Exe = 'retroarch.exe'
                     Source = { $tag = (Get-LatestRelease 'libretro/RetroArch').tag_name.TrimStart('v')
                                @{ Url = "https://buildbot.libretro.com/stable/$tag/windows/x86_64/RetroArch.7z"; Name = 'RetroArch.7z'; Version = $tag } } }
    dolphin     = @{ Name = 'Dolphin (GameCube, Wii)'; Folder = 'Dolphin-x64'; Exe = 'Dolphin.exe'; Portable = @('portable.txt')
                     Source = { $tags = Invoke-RestMethod 'https://api.github.com/repos/dolphin-emu/dolphin/tags?per_page=30' -Headers (Get-GitHubApiHeaders)
                                $tag = ($tags | Where-Object { $_.name -match '^\d{4}$' } | Sort-Object { [int]$_.name } -Descending | Select-Object -First 1).name
                                @{ Url = "https://dl.dolphin-emu.org/releases/$tag/dolphin-$tag-x64.7z"; Name = "dolphin-$tag-x64.7z"; Version = $tag } } }
    pcsx2       = @{ Name = 'PCSX2 (PlayStation 2)'; Folder = 'PCSX2-Qt'; Exe = 'pcsx2-qt.exe'; Portable = @('portable.ini'); Repo = 'PCSX2/pcsx2'; Pattern = '-windows-x64-Qt\.7z$' }
    duckstation = @{ Name = 'DuckStation (PlayStation)'; Folder = 'duckstation'; Exe = 'duckstation-qt-x64-ReleaseLTCG.exe'; Portable = @('portable.txt'); Repo = 'stenzek/duckstation'; Pattern = '^duckstation-windows-x64-release\.zip$' }
    ppsspp      = @{ Name = 'PPSSPP (PSP)'; Folder = 'PPSSPP'; Exe = 'PPSSPPWindows64.exe'; Repo = 'hrydgard/ppsspp'; Pattern = 'Windows-x64\.zip$' }
    rpcs3       = @{ Name = 'RPCS3 (PlayStation 3)'; Folder = 'RPCS3'; Exe = 'rpcs3.exe'; Repo = 'RPCS3/rpcs3-binaries-win'; Pattern = '_win64.*\.7z$' }
    xenia       = @{ Name = 'Xenia Canary (Xbox 360)'; Folder = 'xenia_canary'; Exe = 'xenia_canary.exe'; Portable = @('portable.txt'); Repo = 'xenia-canary/xenia-canary-releases'; Pattern = 'windows.*\.zip$' }
    xemu        = @{ Name = 'xemu (original Xbox)'; Folder = 'xemu'; Exe = 'xemu.exe'; Repo = 'xemu-project/xemu'; Pattern = '^xemu-[\d.]+-windows-x86_64\.zip$' }
    cemu        = @{ Name = 'Cemu (Wii U)'; Folder = 'cemu'; Exe = 'Cemu.exe'; PortableDirs = @('portable'); Repo = 'cemu-project/Cemu'; Pattern = 'windows-x64\.zip$' }
    azahar      = @{ Name = 'Azahar (Nintendo 3DS)'; Folder = 'azahar'; Exe = 'azahar.exe'; PortableDirs = @('user'); Repo = 'azahar-emu/azahar'; Pattern = '^azahar-windows-msvc-[\d.]+\.zip$' }
    melonds     = @{ Name = 'melonDS (Nintendo DS)'; Folder = 'melonDS'; Exe = 'melonDS.exe'; Repo = 'melonDS-emu/melonDS'; Pattern = 'windows-x86_64\.zip$' }
    vita3k      = @{ Name = 'Vita3K (PS Vita)'; Folder = 'Vita3K'; Exe = 'Vita3K.exe'; Repo = 'Vita3K/Vita3K'; Pattern = '^windows-latest\.zip$' }
    shadps4     = @{ Name = 'shadPS4 (PlayStation 4, experimental)'; Folder = 'shadPS4'; Exe = 'shadPS4.exe'; Repo = 'shadps4-emu/shadPS4'; Pattern = 'win64.*\.zip$' }
    flycast     = @{ Name = 'Flycast (Dreamcast, Naomi)'; Folder = 'flycast'; Exe = 'flycast.exe'; Repo = 'flyinghead/flycast'; Pattern = 'win64.*\.zip$' }
}

# RetroArch cores for ES-DE's default emulator on each classic system,
# taken from the stable cores bundle of the same RetroArch version (the
# nightly per-core downloads change every day).
$RetroArchCores = @('mesen', 'snes9x', 'genesis_plus_gx', 'picodrive', 'mgba', 'gambatte', 'mupen64plus_next', 'mednafen_pce', 'fbneo', 'stella')

# Everything else. Check = what update-versions.ps1 looks for to call a
# download good: a file inside the archive, or 'msi' / 'exe' / 'cab'.
$OtherDownloads = [ordered]@{
    'retroarch-cores' = @{ Name = 'RetroArch cores'; Check = 'cores\mesen_libretro.dll'
                           Source = { $tag = (Get-LatestRelease 'libretro/RetroArch').tag_name.TrimStart('v')
                                      @{ Url = "https://buildbot.libretro.com/stable/$tag/windows/x86_64/RetroArch_cores.7z"; Name = 'RetroArch_cores.7z'; Version = $tag } } }
    esde              = @{ Name = 'ES-DE'; Check = 'ES-DE.exe'
                           Source = { $release = (Invoke-RestMethod 'https://gitlab.com/api/v4/projects/es-de%2Femulationstation-de/releases?per_page=1' -Headers $script:UserAgent)[0]
                                      $link = $release.assets.links | Where-Object { $_.name -match 'x64_Portable\.zip$' } | Select-Object -First 1
                                      if (-not $link) { throw "No Windows portable download in ES-DE $($release.tag_name)" }
                                      @{ Url = $link.url; Name = 'ES-DE-portable.zip'; Version = $release.tag_name } } }
    # ES-DE's Iconic theme (the one the arcade uses): GitHub's archive of
    # its newest commit, about 190 MB.
    iconic            = @{ Name = 'Iconic theme for ES-DE'; Check = 'theme.xml'
                           Source = { $sha = (Invoke-RestMethod 'https://api.github.com/repos/Siddy212/iconic-es-de/commits?per_page=1' -Headers (Get-GitHubApiHeaders))[0].sha
                                      @{ Url = "https://codeload.github.com/Siddy212/iconic-es-de/zip/$sha"; Name = "iconic-es-de-$($sha.Substring(0, 7)).zip"; Version = $sha.Substring(0, 7) } } }
    sunshine          = @{ Name = 'Sunshine'; Check = 'msi'; Repo = 'LizardByte/Sunshine'; Pattern = 'Windows-AMD64-installer\.msi$' }
    cloudflared       = @{ Name = 'cloudflared (Cloudflare Tunnel)'; Check = 'exe'; Repo = 'cloudflare/cloudflared'; Pattern = '^cloudflared-windows-amd64\.exe$' }
    # "x86" in the name, but it holds the 64-bit (NTamd64) driver.
    vdd               = @{ Name = 'Virtual Display Driver'; Check = 'MttVDD.inf'; Repo = 'VirtualDrivers/Virtual-Display-Driver'; Pattern = '^VirtualDisplayDriver-x86\.Driver\.Only\.zip$' }
    # The virtual controller bus Sunshine plugs players' controllers into,
    # as Xbox 360 or PlayStation 4 pads. (Its last release; the project is
    # finished, not abandoned-and-broken.)
    vigembus          = @{ Name = 'ViGEmBus (virtual controllers)'; Check = 'exe'; Repo = 'nefarius/ViGEmBus'; Pattern = '^ViGEmBus_.*_x64_x86_arm64\.exe$' }
    # Microsoft's Xbox 360 controller driver (Windows Server doesn't ship it),
    # from the Microsoft Update Catalog. It hasn't changed since 2009.
    xusb              = @{ Name = 'Xbox 360 controller driver'; Check = 'cab'
                           Source = { @{ Url = 'https://catalog.s.download.windowsupdate.com/msdownload/update/driver/drvs/2013/01/20289581_7385d6be1b053a35955a910f11436729a1d4cb56.cab'; Name = 'xusb21.cab'; Version = '2.1.0.1349' } } }
    # OpenGL and Vulkan over Direct3D 12 for the extra seats (host/seat-guest.ps1):
    # a partitioned graphics card only offers Direct3D inside a virtual machine.
    mesa              = @{ Name = 'Mesa (OpenGL/Vulkan over Direct3D 12, for extra seats)'; Check = 'x64\opengl32.dll'; Repo = 'pal1000/mesa-dist-win'; Pattern = '^mesa3d-[\d.]+-release-msvc\.7z$' }
    '7zr'             = @{ Name = '7-Zip extractor'; Check = 'exe'
                           Source = { $page = Invoke-WebRequest 'https://www.7-zip.org/download.html' -UseBasicParsing -Headers $script:UserAgent
                                      $ver = [regex]::Match($page.Content, 'Download 7-Zip ([\d.]+)').Groups[1].Value
                                      @{ Url = 'https://www.7-zip.org/a/7zr.exe'; Name = '7zr.exe'; Version = $ver } } }
}

function Get-CatalogEntry([string]$Key) {
    if ($Catalog.Contains($Key)) { return $Catalog[$Key] }
    if ($OtherDownloads.Contains($Key)) { return $OtherDownloads[$Key] }
    throw "Unknown download '$Key'"
}

# Get-Download for a catalog key: its tested version unless -Latest.
function Get-CatalogDownload([string]$Key, [switch]$Latest) {
    Get-Download $Key (Get-CatalogEntry $Key) -Latest:$Latest
}

# Save-Download for a catalog key, falling back to the newest release when
# the tested one was taken down.
function Save-CatalogDownload([string]$Key, $Source) {
    Save-Download $Source (Get-CatalogEntry $Key)
}
