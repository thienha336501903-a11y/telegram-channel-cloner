#define MyAppName "Yêu Nấu Ăn Reader"
#define MyAppVersion "1.1.0"
#define MyAppExeName "YeuNauAnReader.exe"

[Setup]
AppId={{F00C58EE-24F2-47D2-9860-7B4C8FCB4781}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\YeuNauAnReader
PrivilegesRequired=lowest
OutputBaseFilename=YeuNauAnReaderSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\YeuNauAnReaderImport.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\YeuNauAnReaderReconcile.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "YeuNauAnReader"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Mở Yêu Nấu Ăn Reader"; Flags: nowait postinstall skipifsilent
