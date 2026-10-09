; Farm Edge — классический Windows-установщик (Inno Setup 6+)
; Собирается pack-setup.ps1 → dist\FarmEdge-Setup.exe
;
; SourceDir задаётся через ISCC /DStageDir=...

#ifndef StageDir
  #define StageDir ".."
#endif

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{A8F3E2B1-9C4D-4E7A-B2F1-5D6C8A9E0123}
AppName=Farm Edge
AppVersion={#AppVersion}
AppVerName=Farm Edge {#AppVersion}
AppPublisher=3D ZIPPER / 3dvortex.ru
AppPublisherURL=https://farm.5dsap.ru/
AppSupportURL=https://farm.5dsap.ru/
DefaultDirName={localappdata}\Programs\FarmEdge
DefaultGroupName=Farm Edge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x86 x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#StageDir}\..\
OutputBaseFilename=FarmEdge-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Farm Edge
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany=3dvortex.ru
VersionInfoProductName=Farm Edge
VersionInfoDescription=Домашний агент фермы для farm.5dsap.ru
VersionInfoCopyright=© 3D ZIPPER / 3dvortex.ru
SetupLogging=yes
CloseApplications=no
; Authenticode: pack-setup.ps1 passes /Ssigntool=... and /DSignBuild=1 when a
; code-signing certificate is available. Without it Setup.exe stays unsigned and
; Windows SmartScreen shows "Неопознанное приложение / Неизвестный издатель".
#ifdef SignBuild
SignTool=signtool
SignedUninstaller=yes
#endif

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; GroupDescription: "Дополнительно:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "FarmEdge.iss"

[Icons]
Name: "{group}\Farm Edge (Панель и Трей)"; Filename: "{app}\FarmEdge.cmd"; WorkingDir: "{app}"
Name: "{group}\Подключить Farm Edge"; Filename: "{app}\Connect-FarmEdge.bat"; WorkingDir: "{app}"
Name: "{group}\Инструкция"; Filename: "{app}\INSTRUCTIONS-RU.html"
Name: "{group}\Удалить Farm Edge"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Farm Edge"; Filename: "{app}\FarmEdge.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Connect-FarmEdge.bat"; Description: "Запустить Farm Edge (подключение / панель в трее)"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Stop-FarmEdge.ps1"" -RemoveData"; RunOnceId: "StopFarmEdge"; Flags: runhidden waituntilterminated

[Code]
function InitializeUninstall(): Boolean;
begin
  Result := True;
end;
