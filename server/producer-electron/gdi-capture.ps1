# Persistent GDI (BitBlt-based) screen capture loop, run as a child of the
# producer Electron process (which runs in the real interactive session).
# Exists because the server's virtual display driver doesn't implement DXGI
# Desktop Duplication -- Chromium's built-in capturer always tries that path
# first with no working fallback we can reach via flags, so we bypass it
# entirely and feed frames to producer.html over stdout instead.
#
# Framing: each frame is a 4-byte little-endian length prefix followed by
# that many bytes of JPEG data, written straight to stdout.

param(
    [int]$MonitorIndex = 0,
    [int]$Fps = 20,
    [int]$Quality = 70
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screens = [System.Windows.Forms.Screen]::AllScreens
$screen = if ($MonitorIndex -ge 0 -and $MonitorIndex -lt $screens.Length) { $screens[$MonitorIndex] } else { [System.Windows.Forms.Screen]::PrimaryScreen }
$bounds = $screen.Bounds

$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

$stdout = [System.Console]::OpenStandardOutput()
$frameIntervalMs = [int](1000 / $Fps)

while ($true) {
    $frameStart = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, $jpegCodec, $encoderParams)
        $bytes = $ms.ToArray()
        $ms.Dispose()

        $lenBytes = [System.BitConverter]::GetBytes([int32]$bytes.Length)
        $stdout.Write($lenBytes, 0, 4)
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
    } catch {
        [Console]::Error.WriteLine("gdi-capture error: $_")
    }
    $elapsed = $frameStart.ElapsedMilliseconds
    $sleep = $frameIntervalMs - $elapsed
    if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}
