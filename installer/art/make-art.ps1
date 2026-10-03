# Draws the installer's artwork: the Setup icon, the welcome/finish side
# panel and the page header. Run it again after changing the colours
# (they match the website's: server/src/web/pages/howitworks.html).
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\art\make-art.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"
$out = $PSScriptRoot

$navy = [System.Drawing.Color]::FromArgb(11, 23, 48)      # #0b1730, the header colour in LumaArcade.nsi
$navy2 = [System.Drawing.Color]::FromArgb(16, 35, 59)     # #10233b
$blue = [System.Drawing.Color]::FromArgb(31, 111, 209)    # #1f6fd1
$teal = [System.Drawing.Color]::FromArgb(26, 154, 166)    # #1a9aa6
$purple = [System.Drawing.Color]::FromArgb(122, 79, 214)  # #7a4fd6

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.InterpolationMode = "HighQualityBicubic"
  $g.PixelOffsetMode = "HighQuality"
  return $bmp, $g
}

function Rounded($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# A soft round glow of one colour, fading out to nothing.
function Glow($g, $cx, $cy, $r, $color, $alpha) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddEllipse($cx - $r, $cy - $r, $r * 2, $r * 2)
  $b = New-Object System.Drawing.Drawing2D.PathGradientBrush $p
  $b.CenterColor = [System.Drawing.Color]::FromArgb($alpha, $color)
  $b.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color))
  $g.FillPath($b, $p)
  $b.Dispose(); $p.Dispose()
}

# The mark: a rounded tile, blue to purple, with a play button.
function Mark($g, $x, $y, $s) {
  $tile = Rounded $x $y $s $s ($s * 0.26)
  $rect = New-Object System.Drawing.RectangleF $x, $y, $s, $s
  $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $teal, $purple, 45
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend 3
  $blend.Colors = @($teal, $blue, $purple)
  $blend.Positions = @([single]0, [single]0.5, [single]1)
  $fill.InterpolationColors = $blend
  $g.FillPath($fill, $tile)
  # A light sheen on the top half.
  $sheenRect = New-Object System.Drawing.RectangleF $x, $y, $s, ($s * 0.6)
  $sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush $sheenRect, ([System.Drawing.Color]::FromArgb(70, 255, 255, 255)), ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)), 90
  $clip = $g.Clip
  $g.SetClip($tile)
  $g.FillRectangle($sheen, $sheenRect)
  $g.Clip = $clip
  # Play triangle, slightly right of centre so it looks centred.
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $cx = $x + $s * 0.53; $cy = $y + $s * 0.5; $t = $s * 0.22
  $tri.AddPolygon(@(
    (New-Object System.Drawing.PointF ($cx - $t * 0.8), ($cy - $t)),
    (New-Object System.Drawing.PointF ($cx + $t), $cy),
    (New-Object System.Drawing.PointF ($cx - $t * 0.8), ($cy + $t))
  ))
  $g.FillPath([System.Drawing.Brushes]::White, $tri)
  $fill.Dispose(); $sheen.Dispose(); $tile.Dispose(); $tri.Dispose()
}

function Save-Bmp($bmp, $path) {
  # NSIS wants a plain 24-bit bitmap.
  $flat = New-Object System.Drawing.Bitmap $bmp.Width, $bmp.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($flat)
  $g.DrawImage($bmp, 0, 0, $bmp.Width, $bmp.Height)
  $g.Dispose()
  $flat.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $flat.Dispose()
}

# ---------------------------------------------------------------- side panel (welcome / finish)
$w = 164; $h = 314
$bmp, $g = New-Canvas $w $h
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0, 0, $w, $h), $navy2, $navy, 90
$g.FillRectangle($bg, 0, 0, $w, $h)
Glow $g 20 40 140 $purple 150
Glow $g 150 170 130 $blue 140
Glow $g 30 300 120 $teal 120
# A faint dot grid.
$dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 255, 255, 255))
for ($yy = 8; $yy -lt $h; $yy += 14) { for ($xx = 8; $xx -lt $w; $xx += 14) { $g.FillEllipse($dot, $xx, $yy, 1.6, 1.6) } }
Mark $g 46 115 72
Save-Bmp $bmp (Join-Path $out "side.bmp")
$g.Dispose(); $bmp.Dispose()

# ---------------------------------------------------------------- header (right-hand side of the page header)
$w = 150; $h = 57
$bmp, $g = New-Canvas $w $h
$g.Clear($navy)
Glow $g 150 0 90 $purple 120
Glow $g 110 60 70 $blue 120
Glow $g 150 57 50 $teal 90
for ($yy = 5; $yy -lt $h; $yy += 10) { for ($xx = 5; $xx -lt $w; $xx += 10) {
  # Dots fade in from the left, so the image melts into the header.
  $a = [int](22 * [Math]::Min(1, $xx / 90.0))
  $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a, 255, 255, 255))
  $g.FillEllipse($b, $xx, $yy, 1.4, 1.4); $b.Dispose()
} }
Mark $g 104 11 35
Save-Bmp $bmp (Join-Path $out "header.bmp")
$g.Dispose(); $bmp.Dispose()

# ---------------------------------------------------------------- icon
$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($s in $sizes) {
  $bmp, $g = New-Canvas $s $s
  $g.Clear([System.Drawing.Color]::Transparent)
  $pad = [Math]::Max(0, [Math]::Round($s * 0.04))
  Mark $g $pad $pad ($s - 2 * $pad)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  , $ms.ToArray()
}
$fs = [System.IO.File]::Create((Join-Path $out "setup.ico"))
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256))
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$images[$i].Length); $bw.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Close()
Write-Host "Wrote side.bmp, header.bmp and setup.ico to $out"
