$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LauncherDir = Join-Path $Root "launcher"
if (!(Test-Path $LauncherDir)) {
  New-Item -ItemType Directory -Path $LauncherDir | Out-Null
}

$IcoPath = Join-Path $LauncherDir "app.ico"
$CsPath  = Join-Path $LauncherDir "Program.cs"
$OutExe  = Join-Path $Root "SplitAndMergeStudio.exe"

# ---------------------------------------------------------------------------
# 1. Generate Crisp Multi-Size Windows Icon (16, 32, 48 DIB + 256 PNG)
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Drawing

function New-AppIconBitmap([int]$Size) {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [float]([Math]::Max(1.0, $Size * 0.05))
  $w = [float]($Size - 2 * $pad)
  $r = [float]($Size * 0.24)
  $d = $r * 2.0

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($pad, $pad, $d, $d, 180, 90)
  $path.AddArc($pad + $w - $d, $pad, $d, $d, 270, 90)
  $path.AddArc($pad + $w - $d, $pad + $w - $d, $d, $d, 0, 90)
  $path.AddArc($pad, $pad + $w - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $rect = New-Object System.Drawing.RectangleF($pad, $pad, $w, $w)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 2, 132, 199),   # Sky Cyan (#0284c7)
    [System.Drawing.Color]::FromArgb(255, 124, 58, 237),  # Violet (#7c3aed)
    45.0
  )
  $g.FillPath($grad, $path)

  # Subtle diagonal split-and-merge seam accent
  $seamPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(95, 255, 255, 255), [Math]::Max(1.0, $Size * 0.045))
  $g.DrawLine($seamPen, $pad + $w * 0.18, $pad + $w * 0.82, $pad + $w * 0.82, $pad + $w * 0.18)

  # Subtle inner border highlight
  $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 186, 230, 253), [Math]::Max(1.0, $Size * 0.03))
  $g.DrawPath($borderPen, $path)

  # Crisp "S&M" or "S" badge glyph
  $label = if ($Size -ge 32) { "S&M" } else { "S" }
  $fontSize = if ($Size -ge 32) { [float]($Size * 0.275) } else { [float]($Size * 0.52) }
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

  $shadowRect = New-Object System.Drawing.RectangleF($pad, ($pad + $Size * 0.03), $w, $w)
  $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(140, 15, 23, 42))
  $g.DrawString($label, $font, $shadowBrush, $shadowRect, $sf)

  $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.DrawString($label, $font, $whiteBrush, $rect, $sf)

  $whiteBrush.Dispose()
  $shadowBrush.Dispose()
  $sf.Dispose()
  $font.Dispose()
  $borderPen.Dispose()
  $seamPen.Dispose()
  $grad.Dispose()
  $path.Dispose()
  $g.Dispose()
  return $bmp
}

function ConvertTo-IcoDibBytes([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $andRowBytes = [int]([Math]::Ceiling($w / 32.0) * 4)
  $xorSize = $w * $h * 4
  $andSize = $andRowBytes * $h

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)

  # BITMAPINFOHEADER (40 bytes, height = 2*h for XOR + AND masks)
  $bw.Write([uint32]40)
  $bw.Write([int32]$w)
  $bw.Write([int32]($h * 2))
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)
  $bw.Write([uint32]($xorSize + $andSize))
  $bw.Write([int32]0)
  $bw.Write([int32]0)
  $bw.Write([uint32]0)
  $bw.Write([uint32]0)

  # Bottom-up 32-bit BGRA XOR pixels
  for ($y = $h - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $bw.Write([byte]$c.B)
      $bw.Write([byte]$c.G)
      $bw.Write([byte]$c.R)
      $bw.Write([byte]$c.A)
    }
  }

  # Bottom-up 1-bpp AND transparency mask
  for ($y = $h - 1; $y -ge 0; $y--) {
    $row = New-Object byte[] $andRowBytes
    for ($x = 0; $x -lt $w; $x++) {
      if ($bmp.GetPixel($x, $y).A -lt 16) {
        $byteIdx = [int][Math]::Floor($x / 8)
        $bitIdx = 7 - ($x % 8)
        $row[$byteIdx] = $row[$byteIdx] -bor (1 -shl $bitIdx)
      }
    }
    $bw.Write($row)
  }

  $bw.Flush()
  [byte[]]$bytes = $ms.ToArray()
  $bw.Dispose()
  $ms.Dispose()
  return ,$bytes
}

$sizes = @(16, 32, 48, 256)
$frames = @()
foreach ($sz in $sizes) {
  $bmp = New-AppIconBitmap $sz
  if ($sz -eq 256) {
    $pms = New-Object System.IO.MemoryStream
    $bmp.Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)
    [byte[]]$data = $pms.ToArray()
    $pms.Dispose()
  } else {
    [byte[]]$data = ConvertTo-IcoDibBytes $bmp
  }
  $bmp.Dispose()
  $frames += [PSCustomObject]@{ Size = $sz; Data = $data }
}

$icoStream = [System.IO.File]::Create($IcoPath)
$icoWriter = New-Object System.IO.BinaryWriter($icoStream)
$icoWriter.Write([uint16]0)               # Reserved
$icoWriter.Write([uint16]1)               # Type = 1 (ICON)
$icoWriter.Write([uint16]$frames.Count)   # Image count

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  $dimByte = if ($f.Size -ge 256) { [byte]0 } else { [byte]$f.Size }
  $icoWriter.Write($dimByte)              # Width
  $icoWriter.Write($dimByte)              # Height
  $icoWriter.Write([byte]0)               # Color count
  $icoWriter.Write([byte]0)               # Reserved
  $icoWriter.Write([uint16]1)             # Planes
  $icoWriter.Write([uint16]32)            # BitCount
  $icoWriter.Write([uint32]$f.Data.Length)
  $icoWriter.Write([uint32]$offset)
  $offset += $f.Data.Length
}
foreach ($f in $frames) {
  [byte[]]$raw = $f.Data
  $icoWriter.Write($raw, 0, $raw.Length)
}
$icoWriter.Flush()
$icoWriter.Dispose()
$icoStream.Dispose()

# ---------------------------------------------------------------------------
# 2. Compile Single Self-Contained Windows Executable via Built-in csc.exe
# ---------------------------------------------------------------------------
$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$csc) {
  throw "Compilador C# nativo do Windows (csc.exe) nao encontrado em $env:WINDIR\Microsoft.NET."
}

$resArgs = @(
  "/resource:`"$(Join-Path $Root 'index.html')`",app.index.html",
  "/resource:`"$(Join-Path $Root 'css\styles.css')`",app.css.styles.css",
  "/resource:`"$(Join-Path $Root 'js\prompts.js')`",app.js.prompts.js",
  "/resource:`"$(Join-Path $Root 'prompt_original_hair.txt')`",app.prompt_original_hair.txt",
  "/resource:`"$(Join-Path $Root 'prompt_reference_hair.txt')`",app.prompt_reference_hair.txt",
  "/resource:`"$(Join-Path $Root 'js\types.js')`",app.js.types.js",
  "/resource:`"$(Join-Path $Root 'js\geometry.js')`",app.js.geometry.js",
  "/resource:`"$(Join-Path $Root 'js\imageOps.js')`",app.js.imageOps.js",
  "/resource:`"$(Join-Path $Root 'js\seamMerge.js')`",app.js.seamMerge.js",
  "/resource:`"$(Join-Path $Root 'js\skinMatch.js')`",app.js.skinMatch.js",
  "/resource:`"$(Join-Path $Root 'js\viewport.js')`",app.js.viewport.js",
  "/resource:`"$(Join-Path $Root 'js\app.js')`",app.js.app.js",
  "/resource:`"$IcoPath`",app.favicon.ico"
)

$compileArgs = @(
  "/nologo",
  "/target:winexe",
  "/optimize+",
  "/platform:anycpu",
  "/out:`"$OutExe`"",
  "/win32icon:`"$IcoPath`"",
  "/r:System.dll",
  "/r:System.Core.dll",
  "/r:System.Drawing.dll",
  "/r:System.Windows.Forms.dll"
) + $resArgs + @("`"$CsPath`"")

Write-Host "Compilando executavel unico: $OutExe ..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $csc -ArgumentList $compileArgs -NoNewWindow -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  throw "Falha na compilacao com csc.exe (codigo $($proc.ExitCode))."
}

$exeInfo = Get-Item $OutExe
Write-Host ("SUCESSO! Executavel unico gerado: {0} ({1:N1} KB)" -f $exeInfo.FullName, ($exeInfo.Length / 1KB)) -ForegroundColor Green
