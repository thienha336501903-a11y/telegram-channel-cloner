$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
  python -m pip install --disable-pip-version-check -r reader-cli/requirements.txt pyinstaller==6.15.0
  python -m PyInstaller --clean --noconfirm --onefile --name YeuNauAnReaderImport reader-cli/export_history.py
  python -m PyInstaller --clean --noconfirm --onefile --name YeuNauAnReaderReconcile reader-cli/reconcile_history.py
  python -m PyInstaller --clean --noconfirm --onefile --name YeuNauAnReaderMirror reader-cli/mirror_v5_r2.py
  python -m PyInstaller --clean --noconfirm reader-manager/YeuNauAnReader.spec
  New-Item -ItemType Directory -Force reader-manager/dist | Out-Null
  Copy-Item -Force dist/YeuNauAnReader.exe reader-manager/dist/YeuNauAnReader.exe
  Copy-Item -Force dist/YeuNauAnReaderImport.exe reader-manager/dist/YeuNauAnReaderImport.exe
  Copy-Item -Force dist/YeuNauAnReaderReconcile.exe reader-manager/dist/YeuNauAnReaderReconcile.exe
  Copy-Item -Force dist/YeuNauAnReaderMirror.exe reader-manager/dist/YeuNauAnReaderMirror.exe
  & "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" reader-manager/installer.iss
}
finally { Pop-Location }
