# Generates the PWA icon set for power-logs.html from icons/_source.png.
#
#   powershell -ExecutionPolicy Bypass -File make_icons.ps1
#
# _source.png is the full-bleed logo (a red 25 kg plate and a spiral notepad on a pastel
# sage tile, the same sage as the app's theme). Everything is drawn from it:
#   icon-192 / icon-512         purpose "any": rounded corners, transparent outside them
#   icon-512-maskable           purpose "maskable": the art pulled into the centre 80% safe zone
#   apple-touch-icon (180)      iOS applies its own mask: full bleed, no alpha
#   favicon-32                  browser tabs: the art slightly enlarged so it reads
# (Replaces make_icons.py: no Python needed. It needs Windows PowerShell and System.Drawing.)
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = [System.Drawing.Image]::FromFile((Join-Path $root "icons\_source.png"))
# The tile's own gradient, so a smaller logo on a bigger canvas (maskable) melts into it.
$top = [System.Drawing.Color]::FromArgb(0xDC, 0xEB, 0xE1)
$bot = [System.Drawing.Color]::FromArgb(0xB8, 0xD2, 0xC2)

function Build($size, $scale, $radius, $alpha) {
  $fmt = if ($alpha) { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb } else { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb }
  $ss = 4; $S = $size * $ss
  $big = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.SmoothingMode = "HighQuality"; $g.InterpolationMode = "HighQualityBicubic"; $g.PixelOffsetMode = "HighQuality"
  $t = [int]($S * $scale); $off = [int](($S - $t) / 2)
  # The gradient runs over the logo's own height and stays flat above and below it, so a smaller logo has no visible edge.
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ((New-Object System.Drawing.Point 0, $off), (New-Object System.Drawing.Point 0, ($off + $t)), $top, $bot)
  if ($radius -gt 0) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int]($S * $radius * 2)
    $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($S - $r, 0, $r, $r, 270, 90)
    $path.AddArc($S - $r, $S - $r, $r, $r, 0, 90); $path.AddArc(0, $S - $r, $r, $r, 90, 90); $path.CloseFigure()
    $g.SetClip($path)
  }
  $g.Clear($top)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $bot), 0, $off + $t, $S, $S - $off - $t)
  $g.FillRectangle($brush, 0, $off, $S, $t)
  $g.DrawImage($src, $off, $off, $t, $t)
  $g.Dispose()
  $out = New-Object System.Drawing.Bitmap $size, $size, $fmt
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = "HighQualityBicubic"; $g2.PixelOffsetMode = "HighQuality"
  if (-not $alpha) { $g2.Clear($top) }
  $g2.DrawImage($big, 0, 0, $size, $size)
  $g2.Dispose(); $big.Dispose()
  return $out
}
function Save($bmp, $name) { $bmp.Save((Join-Path $root "icons\$name"), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose() }

Save (Build 192 1.0 0.18 $true) "icon-192.png"
Save (Build 512 1.0 0.18 $true) "icon-512.png"
Save (Build 512 0.80 0 $false) "icon-512-maskable.png"
Save (Build 180 1.0 0 $false) "apple-touch-icon.png"
Save (Build 32 1.10 0 $false) "favicon-32.png"
$src.Dispose()
"icons written"
