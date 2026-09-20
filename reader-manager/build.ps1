$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
  python -m pip install --disable-pip-version-check -r reader-cli/requirements.txt pyinstaller==6.15.0
  python -m PyInstaller --clean --noconfirm --onefile --hidden-import cryptg --name YeuNauAnReaderImport reader-cli/export_history.py
  python -m PyInstaller --clean --noconfirm --onefile --hidden-import cryptg --name YeuNauAnReaderReconcile reader-cli/reconcile_history.py
  python -m PyInstaller --clean --noconfirm --onefile --hidden-import cryptg --name YeuNauAnReaderMirror reader-cli/mirror_v5_r2.py
  python -m PyInstaller --clean --noconfirm reader-manager/YeuNauAnReader.spec
  New-Item -ItemType Directory -Force reader-manager/dist | Out-Null
  Copy-Item -Force dist/YeuNauAnReader.exe reader-manager/dist/YeuNauAnReader.exe
  Copy-Item -Force dist/YeuNauAnReaderImport.exe reader-manager/dist/YeuNauAnReaderImport.exe
  Copy-Item -Force dist/YeuNauAnReaderReconcile.exe reader-manager/dist/YeuNauAnReaderReconcile.exe
  Copy-Item -Force dist/YeuNauAnReaderMirror.exe reader-manager/dist/YeuNauAnReaderMirror.exe

  # Bundle ffmpeg and ffprobe into reader-manager/bin for Inno Setup
  $BinDir = Join-Path $PSScriptRoot "bin"
  New-Item -ItemType Directory -Force $BinDir | Out-Null

  function Resolve-MediaBinary($name) {
    $known = @(
      "C:\ffmpeg\bin\$name.exe",
      "C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\$name.exe",
      "C:\Program Files\ffmpeg\bin\$name.exe"
    )
    foreach ($p in $known) {
      if (Test-Path $p) { return (Resolve-Path $p).Path }
    }
    $cmd = Get-Command "$name.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
      $shimDir = Split-Path $cmd.Source
      $parent = Split-Path $shimDir
      $toolPath = Join-Path $parent "lib\ffmpeg\tools\ffmpeg\bin\$name.exe"
      if (Test-Path $toolPath) { return (Resolve-Path $toolPath).Path }
      return $cmd.Source
    }
    return $null
  }

  $ffmpegPath = Resolve-MediaBinary "ffmpeg"
  $ffprobePath = Resolve-MediaBinary "ffprobe"

  if (-not $ffmpegPath -or -not $ffprobePath) {
    if (Get-Command choco -ErrorAction SilentlyContinue) {
      choco install ffmpeg -y --no-progress
      $ffmpegPath = Resolve-MediaBinary "ffmpeg"
      $ffprobePath = Resolve-MediaBinary "ffprobe"
    }
  }

  if (-not $ffmpegPath -or -not (Test-Path $ffmpegPath)) {
    throw "ffmpeg.exe not found for packaging into {app}\bin"
  }
  if (-not $ffprobePath -or -not (Test-Path $ffprobePath)) {
    throw "ffprobe.exe not found for packaging into {app}\bin"
  }

  Copy-Item -Force $ffmpegPath (Join-Path $BinDir "ffmpeg.exe")
  Copy-Item -Force $ffprobePath (Join-Path $BinDir "ffprobe.exe")

  $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  if (-not (Test-Path $iscc)) {
    $isccCmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($isccCmd) { $iscc = $isccCmd.Source }
  }
  & $iscc reader-manager/installer.iss
}
finally { Pop-Location }
