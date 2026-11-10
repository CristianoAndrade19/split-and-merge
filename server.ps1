param(
  [int]$Port = 8765,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Pick an available port starting from $Port
$Listener = $null
for ($p = $Port; $p -lt ($Port + 30); $p++) {
  try {
    $Listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $Listener.Start()
    $Port = $p
    break
  } catch {
    $Listener = $null
  }
}

if (-not $Listener) {
  Write-Error "Nao foi possivel iniciar o servidor local."
  exit 1
}

$Url = "http://127.0.0.1:$Port/"
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Split & Merge Studio rodando em: $Url" -ForegroundColor Green
Write-Host "  (Mantenha esta janela aberta enquanto usar o app)" -ForegroundColor Gray
Write-Host "  Pressione Ctrl+C para encerrar." -ForegroundColor Gray
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $NoBrowser) {
  Start-Process $Url
}

$MimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

try {
  while ($true) {
    $Client = $Listener.AcceptTcpClient()
    try {
      $Stream = $Client.GetStream()
      $Stream.ReadTimeout = 5000
      $Reader = New-Object System.IO.StreamReader($Stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $RequestLine = $Reader.ReadLine()

      if ($RequestLine) {
        $Headers = @{}
        while ($true) {
          $HeaderLine = $Reader.ReadLine()
          if ([string]::IsNullOrEmpty($HeaderLine)) { break }
          $ColonIdx = $HeaderLine.IndexOf(':')
          if ($ColonIdx -gt 0) {
            $HName = $HeaderLine.Substring(0, $ColonIdx).Trim()
            $HVal = $HeaderLine.Substring($ColonIdx + 1).Trim()
            $Headers[$HName] = $HVal
          }
        }

        $Parts = $RequestLine.Split(' ')
        $Method = if ($Parts.Length -ge 1) { $Parts[0].ToUpperInvariant() } else { 'GET' }
        $RawPath = if ($Parts.Length -ge 2) { $Parts[1] } else { '/' }
        $CleanPath = ($RawPath -split '\?')[0]
        $CleanPath = [System.Uri]::UnescapeDataString($CleanPath)

        # API: Data folders list
        if ($CleanPath -eq '/api/data-folders') {
          $dataDir = Join-Path $Root 'data'
          if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
          $subDirs = Get-ChildItem -Path $dataDir -Directory | Sort-Object {
            $num = 0
            if ([int]::TryParse($_.Name, [ref]$num)) { $num } else { -1 }
          } -Descending
          $names = @($subDirs | ForEach-Object { $_.Name })
          $defaultF = if ($names.Count -gt 0) { $names[0] } else { '' }
          $json = @{ folders = $names; defaultFolder = $defaultF } | ConvertTo-Json -Compress
          $Body = [System.Text.Encoding]::UTF8.GetBytes($json)
          $Header = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($Body.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
          $Stream.Write([System.Text.Encoding]::ASCII.GetBytes($Header), 0, $Header.Length)
          $Stream.Write($Body, 0, $Body.Length)
          continue
        }

        # API: Save image to /data/<folder>/<filename>
        if ($CleanPath -eq '/api/save-image' -and $Method -eq 'POST') {
          $contentLen = 0
          if ($Headers.ContainsKey('Content-Length')) {
            [int]::TryParse($Headers['Content-Length'], [ref]$contentLen) | Out-Null
          }
          $bodyChars = New-Object char[] $contentLen
          $readTotal = 0
          while ($readTotal -lt $contentLen) {
            $r = $Reader.Read($bodyChars, $readTotal, $contentLen - $readTotal)
            if ($r -le 0) { break }
            $readTotal += $r
          }
          $bodyStr = New-Object string($bodyChars, 0, $readTotal)
          $reqObj = $bodyStr | ConvertFrom-Json

          $filename = [System.IO.Path]::GetFileName($reqObj.filename)
          if ([string]::IsNullOrEmpty($filename)) { $filename = "imagem_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".png" }
          if (-not $filename.EndsWith('.png', [System.StringComparison]::OrdinalIgnoreCase)) { $filename += '.png' }

          $folder = if ($reqObj.folder) { $reqObj.folder.ToString().Trim('\', '/') } else { '' }
          $targetDir = if ($folder) { Join-Path $Root (Join-Path 'data' $folder) } else { Join-Path $Root 'data' }
          if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
          $targetPath = Join-Path $targetDir $filename

          # Strip base64 header if present (e.g. data:image/png;base64,...)
          $b64 = $reqObj.dataUrl
          if ($b64.Contains(',')) {
            $b64 = $b64.Substring($b64.IndexOf(',') + 1)
          }
          $bytes = [System.Convert]::FromBase64String($b64)
          [System.IO.File]::WriteAllBytes($targetPath, $bytes)

          $relSaved = if ($folder) { "data/$folder/$filename" } else { "data/$filename" }
          $resJson = @{ ok = $true; path = $relSaved; fullPath = $targetPath; bytes = $bytes.Length } | ConvertTo-Json -Compress
          $Body = [System.Text.Encoding]::UTF8.GetBytes($resJson)
          $Header = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($Body.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
          $Stream.Write([System.Text.Encoding]::ASCII.GetBytes($Header), 0, $Header.Length)
          $Stream.Write($Body, 0, $Body.Length)
          continue
        }

        # API: Open data folder in Windows Explorer
        if ($CleanPath -eq '/api/open-data-folder') {
          $folder = if ($RawPath.Contains('folder=')) { ($RawPath -split 'folder=')[1].Split('&')[0] } else { '' }
          $folder = [System.Uri]::UnescapeDataString($folder).Trim('\', '/')
          $targetDir = if ($folder) { Join-Path $Root (Join-Path 'data' $folder) } else { Join-Path $Root 'data' }
          if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
          Start-Process 'explorer.exe' $targetDir
          $resJson = '{"ok":true}'
          $Body = [System.Text.Encoding]::UTF8.GetBytes($resJson)
          $Header = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($Body.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
          $Stream.Write([System.Text.Encoding]::ASCII.GetBytes($Header), 0, $Header.Length)
          $Stream.Write($Body, 0, $Body.Length)
          continue
        }

        if ($CleanPath -eq '/') { $CleanPath = '/index.html' }

        $RelPath = $CleanPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $FullPath = [System.IO.Path]::GetFullPath((Join-Path $Root $RelPath))

        # Prevent path traversal outside workspace root
        if ($FullPath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $FullPath -PathType Leaf)) {
          $Bytes = [System.IO.File]::ReadAllBytes($FullPath)
          $Ext = [System.IO.Path]::GetExtension($FullPath).ToLowerInvariant()
          $ContentType = if ($MimeTypes.ContainsKey($Ext)) { $MimeTypes[$Ext] } else { 'application/octet-stream' }

          $Header = "HTTP/1.1 200 OK`r`nContent-Type: $ContentType`r`nContent-Length: $($Bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
          $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
          $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
          $Stream.Write($Bytes, 0, $Bytes.Length)
        } else {
          $Body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
          $Header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
          $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
          $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
          $Stream.Write($Body, 0, $Body.Length)
        }
      }
    } catch {
      # Ignore aborted client connections
    } finally {
      $Client.Close()
    }
  }
} finally {
  $Listener.Stop()
}

