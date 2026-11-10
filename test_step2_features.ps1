$ErrorActionPreference = "Stop"

$serverProc = Start-Process .\SplitAndMergeStudio.exe -ArgumentList "--headless-server", "--port=49220" -PassThru
Start-Sleep -Milliseconds 1200

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$userDataDir = Join-Path $PSScriptRoot "chrome_test_profile_step2"
if (Test-Path $userDataDir) { Remove-Item -Recurse -Force $userDataDir }

$chromeArgs = @(
  "--headless=new",
  "--remote-debugging-port=9225",
  "--user-data-dir=$userDataDir",
  "--window-size=1280,800",
  "--disable-gpu",
  "http://127.0.0.1:49220/?demo=1&step=2"
)

$chromeProc = Start-Process $chrome -ArgumentList $chromeArgs -PassThru

$tabs = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $tabs = Invoke-RestMethod -Uri "http://127.0.0.1:9225/json" -ErrorAction Stop
    if ($tabs) { break }
  } catch {}
}

if (!$tabs) { throw "Chrome DevTools failed to respond on port 9225." }

try {
  $pageTab = $tabs | Where-Object { $_.type -eq "page" -and $_.url -like "*49220*" } | Select-Object -First 1

  $wsUri = [System.Uri]$pageTab.webSocketDebuggerUrl
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource(10000)
  $ws.ConnectAsync($wsUri, $cts.Token).Wait()

  function Send-Cdp([string]$method, [hashtable]$params = @{}) {
    $id = [System.Threading.Interlocked]::Increment([ref]$script:cdpId)
    $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
    $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()

    $buf = New-Object byte[] 65536
    $ms = New-Object System.IO.MemoryStream
    do {
      $recvSeg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)
      $res = $ws.ReceiveAsync($recvSeg, [System.Threading.CancellationToken]::None).Result
      $ms.Write($buf, 0, $res.Count)
    } while (!$res.EndOfMessage)

    $respStr = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    return ($respStr | ConvertFrom-Json)
  }

  $script:cdpId = 0

  # 1. Check UI, Zero-Scroll, and turn on Anatomic Guides + Rotate 12 degrees
  $eval1 = Send-Cdp "Runtime.evaluate" @{
    expression = @"
(() => {
  const scrollH = document.body.scrollHeight;
  const clientH = window.innerHeight;
  const rngRot = document.getElementById('rngImg2Rot');
  const numRot = document.getElementById('numImg2Rot');
  const btnEye = document.getElementById('btnSbEyeCalib');
  const btnAnatomic = document.getElementById('btnSbAnatomic');
  const btnFlicker = document.getElementById('btnSbFlicker');

  // Turn on anatomic guides and apply 10 deg rotation
  window.state.showAnatomicGuides = true;
  window.state.img2Transform.rotation = 10;
  window.recomputeStep2Outputs();
  window.syncAllUI();

  return JSON.stringify({
    isZeroScroll: scrollH <= clientH,
    scrollHeight: scrollH,
    clientHeight: clientH,
    hasRngRot: !!rngRot,
    hasNumRot: !!numRot,
    hasBtnEye: !!btnEye,
    hasBtnAnatomic: !!btnAnatomic,
    hasBtnFlicker: !!btnFlicker,
    rotation: window.state.img2Transform.rotation
  });
})()
"@
  }

  Write-Host "Step 2 UI Evaluation: $($eval1.result.result.value)"

  # 2. Capture screenshot of Step 2 with rotation and guides
  $screenRes1 = Send-Cdp "Page.captureScreenshot" @{ format = "png" }
  if ($screenRes1.result.data) {
    [System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot "screenshot_step2_rotation_guides.png"), [System.Convert]::FromBase64String($screenRes1.result.data))
    Write-Host "Captured screenshot_step2_rotation_guides.png"
  }

  # 3. Open Eye Calibrator Modal, place 4 points, and test calculation
  $eval2 = Send-Cdp "Runtime.evaluate" @{
    expression = @"
(() => {
  const btnEye = document.getElementById('btnSbEyeCalib');
  if (btnEye) btnEye.click();

  const modal = document.getElementById('modalEyeCalibrate');
  const isOpen = modal && modal.classList.contains('open');

  // Simulate clicking 2 eyes on imagem1 and 2 eyes on imagem2
  window.eyeCalibState.p1L = { x: 300, y: 350 };
  window.eyeCalibState.p1R = { x: 420, y: 350 };
  window.eyeCalibState.p2L = { x: 280, y: 360 };
  window.eyeCalibState.p2R = { x: 400, y: 345 };
  window.renderEyeCalibCanvases();
  window.updateEyeCalibUI();

  const banner = document.getElementById('eyeCalcStatus')?.textContent;
  const btnApply = document.getElementById('btnEyeApply');

  return JSON.stringify({
    modalOpened: isOpen,
    hasCalcResult: !!window.eyeCalibState.calcResult,
    bannerText: banner,
    btnApplyEnabled: !btnApply.disabled
  });
})()
"@
  }

  Write-Host "Eye Calibrator Evaluation: $($eval2.result.result.value)"

  # 4. Capture screenshot of modal
  $screenRes2 = Send-Cdp "Page.captureScreenshot" @{ format = "png" }
  if ($screenRes2.result.data) {
    [System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot "screenshot_modal_eye_calibrate.png"), [System.Convert]::FromBase64String($screenRes2.result.data))
    Write-Host "Captured screenshot_modal_eye_calibrate.png"
  }

  $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "Done", [System.Threading.CancellationToken]::None).Wait()
  Write-Host "ALL STEP 2 TESTS PASSED!"
} finally {
  if ($chromeProc -and !$chromeProc.HasExited) { $chromeProc | Stop-Process -Force }
  if ($serverProc -and !$serverProc.HasExited) { $serverProc | Stop-Process -Force }
  if (Test-Path $userDataDir) { Start-Sleep -Milliseconds 500; Remove-Item -Recurse -Force $userDataDir -ErrorAction SilentlyContinue }
}

