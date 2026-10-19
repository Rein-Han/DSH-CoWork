; ============================================================================
;  DSH Desktop Cowork - per-user Windows installer (Inno Setup 6)
;
;  This script automates release\README.md exactly:
;    1. quit DeepSeek Harness Desktop (never killed by setup)
;    2. dsh.cmd plugin --profile desktop add <installed tgz>
;    3. start DeepSeek Harness Desktop, wait for a published connection.json
;    4. runtime\node.exe dist\setup-desktop.js --caller both --scope user
;       --apply --replace   (so Codex/Claude point at the installed copy)
;
;  Uninstall:
;    1. runtime\node.exe dist\setup-desktop.js --uninstall --apply
;    2. dsh.cmd plugin --profile desktop remove dsh-desktop-cowork-connector
;    3. Inno removes {app}; %LOCALAPPDATA%\DSHDesktopCowork and the
;       .bak-dsh-desktop-cowork-* config backups are left in place.
;
;  Build with installer\build.ps1. The stage\ tree must exist relative to this
;  script (runtime\node.exe, dist\, skill\, node_modules\, package.json,
;  LICENSE, NOTICE, README.md and the connector tgz, with *.map stripped).
;
;  Note on failure handling: Inno's Abort() does not terminate Setup from
;  CurStepChanged(ssPostInstall) (only ssInstall/InitializeSetup do), and
;  rolling back after the plugin was registered would leave the DSH profile
;  pointing at a deleted tgz. So a failed registration stops all remaining
;  steps and turns the final page into a red "Setup did not complete" page
;  with the exact command needed to finish. Nothing is silently ignored.
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0-alpha.5"
#endif
#ifndef MyConnectorVersion
  #define MyConnectorVersion "1.0.1"
#endif

#define MyAppName "DSH Desktop Cowork"
#define MyConnectorTgz "dsh-desktop-cowork-connector-" + MyConnectorVersion + ".tgz"

[Setup]
; Keep this AppId stable: it is how Windows Add/Remove Programs identifies the
; installation across upgrades.
AppId={{6E1C9D42-3B7A-4F58-9E21-5C8D0A7B4F36}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppName}
VersionInfoVersion=0.1.0.5
VersionInfoDescription={#MyAppName} Setup
DefaultDirName={localappdata}\Programs\DSH Desktop Cowork
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\release
OutputBaseFilename=DSH-Desktop-Cowork-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName} {#MyAppVersion}
UninstallDisplayIcon={app}\runtime\node.exe
CloseApplications=no
RestartApplications=no
AllowCancelDuringInstall=no
UsePreviousAppDir=yes
ChangesEnvironment=no

[Languages]
; Inno Setup 6.7.3 does not ship ChineseSimplified.isl in its Languages folder
; (checked before building), so the wizard uses the English default messages.
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; runtime\node.exe is the bundled Node.js copied from C:\Program Files\nodejs.
; dist\ and skill\ must stay siblings: dist\setup-desktop.js resolves the
; caller skills as ../skill/<name> relative to dist\.
Source: "stage\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "stage\dist\*"; DestDir: "{app}\dist"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.map"
Source: "stage\skill\*"; DestDir: "{app}\skill"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.map"
Source: "stage\node_modules\*"; DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.map"
Source: "stage\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\NOTICE"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "stage\{#MyConnectorTgz}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Do NOT add a shortcut that runs the MCP server: Codex/Claude start it.
Name: "{userprograms}\{#MyAppName}\README"; Filename: "{sys}\notepad.exe"; Parameters: """{app}\README.md"""; WorkingDir: "{app}"; Comment: "Open the DSH Desktop Cowork README"
Name: "{userprograms}\{#MyAppName}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[UninstallDelete]
; Setup/registration logs are created at run time and are not in the [Files]
; list, so remove them explicitly. The connector state in %LOCALAPPDATA% and
; the .bak-dsh-desktop-cowork-* config backups are deliberately left alone.
Type: filesandordirs; Name: "{app}\logs"

[Code]
const
  DshExeName = 'DeepSeek Harness.exe';
  ConnectionWaitSeconds = 60;

var
  InstallFailed: Boolean;
  FailureDetail: String;
  FailureNeedsPlugin: Boolean;
  LogsDir: String;

function DshCmdPath: String;
begin
  Result := ExpandConstant('{localappdata}\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd');
end;

function ConnectionsRoot: String;
begin
  Result := ExpandConstant('{localappdata}\DSHDesktopCowork\connections');
end;

function EnsureLogsDir: String;
begin
  { Keep setup/registration logs with the app, not in the connector's
    %LOCALAPPDATA%\DSHDesktopCowork state folder. }
  Result := ExpandConstant('{app}\logs');
  if not ForceDirectories(Result) then
    Result := ExpandConstant('{tmp}');
end;

{ Run an executable through cmd.exe with stdout+stderr captured to LogPath.
  This is the only reliable way to get both the exit code and the console
  output (Inno's Exec cannot capture output). }
function RunViaCmdLogged(const ExePath, Params, LogPath: String; var ExitCode: Integer): Boolean;
var
  CmdLine: String;
begin
  ExitCode := -1;
  CmdLine := '/d /c ""' + ExePath + '" ' + Params + ' > "' + LogPath + '" 2>&1"';
  Result := Exec(ExpandConstant('{cmd}'), CmdLine, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
end;

function ReadTextFile(const FileName: String): String;
var
  Raw: AnsiString;
begin
  Result := '';
  if FileExists(FileName) then
    if LoadStringFromFile(FileName, Raw) then
      Result := String(Raw);
end;

{ Last MaxChars characters of a command log, for display in a message box. }
function LogTail(const LogPath: String; MaxChars: Integer): String;
var
  S: String;
begin
  S := Trim(ReadTextFile(LogPath));
  if Length(S) > MaxChars then
    S := '...' + Copy(S, Length(S) - MaxChars + 1, MaxChars);
  Result := S;
end;

function DshRunning: Boolean;
var
  Code: Integer;
  S: String;
begin
  Result := False;
  if not RunViaCmdLogged(ExpandConstant('{sys}\tasklist.exe'),
    '/FI "IMAGENAME eq ' + DshExeName + '" /NH /FO CSV',
    ExpandConstant('{tmp}\dsh-cowork-tasklist.log'), Code) then
    Exit;
  S := ReadTextFile(ExpandConstant('{tmp}\dsh-cowork-tasklist.log'));
  Result := Pos(DshExeName, S) > 0;
end;

{ Ask the user to quit the Desktop app. Setup never terminates it itself.
  Returns False only when the user chooses Cancel. }
function EnsureDshClosed(const ActionText: String): Boolean;
var
  Answer: Integer;
begin
  Result := True;
  while DshRunning do
  begin
    Answer := MsgBox(
      'DeepSeek Harness Desktop is running.' + #13#10#13#10 +
      'Quit it completely before ' + ActionText + ':' + #13#10 +
      'right-click the DeepSeek Harness tray icon and choose Exit.' + #13#10 +
      'Closing the main window is not enough; the profile stays locked.' + #13#10#13#10 +
      'Click Retry when it has fully exited, or Cancel to stop setup. ' +
      'Setup will never terminate the app for you.',
      mbError, MB_RETRYCANCEL);
    if Answer <> IDRETRY then
    begin
      Result := False;
      Exit;
    end;
    Sleep(1000);
  end;
end;

{ Any profile directory under connections\ containing connection.json counts. }
function ConnectionPublished: Boolean;
var
  FindRec: TFindRec;
  Dir, Sub: String;
begin
  Result := False;
  Dir := ConnectionsRoot;
  if not DirExists(Dir) then
    Exit;
  if FindFirst(Dir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Sub := Dir + '\' + FindRec.Name;
          if DirExists(Sub) and FileExists(Sub + '\connection.json') then
          begin
            Result := True;
            Exit;
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function WaitForConnection(Seconds: Integer): Boolean;
var
  I: Integer;
begin
  for I := 1 to Seconds do
  begin
    if ConnectionPublished then
    begin
      Result := True;
      Exit;
    end;
    WizardForm.StatusLabel.Caption :=
      'Waiting for DeepSeek Harness Desktop to publish its connection file... ' +
      IntToStr(I) + ' / ' + IntToStr(Seconds) + ' s';
    WizardForm.Refresh;
    Sleep(1000);
  end;
  Result := ConnectionPublished;
end;

function SetupDesktopCommand: String;
begin
  Result := '"' + ExpandConstant('{app}\runtime\node.exe') + '" "' +
    ExpandConstant('{app}\dist\setup-desktop.js') + '" --caller both --scope user --apply --replace';
end;

procedure MarkFailure(const Detail: String);
begin
  InstallFailed := True;
  FailureDetail := Detail;
end;

{ Pre-flight. Returning a non-empty string stops Setup before any file is
  copied and exits with a dedicated non-zero exit code. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  Result := '';
  if not EnsureDshClosed('installing the connector plugin') then
  begin
    Result := 'DeepSeek Harness Desktop is still running.' + #13#10#13#10 +
      'Quit it from the tray icon, then run this setup again.';
    Exit;
  end;
  if not FileExists(DshCmdPath()) then
  begin
    Result := 'DeepSeek Harness Desktop was not found at:' + #13#10 +
      ExpandConstant('{localappdata}\Programs\DeepSeek Harness') + #13#10#13#10 +
      'Install DeepSeek Harness Desktop for this Windows user first, then run this setup again.';
    Exit;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  PluginLog, SetupLog, Tail: String;
  Answer: Integer;
begin
  if CurStep <> ssPostInstall then
    Exit;

  InstallFailed := False;
  FailureDetail := '';
  FailureNeedsPlugin := False;

  { The user may have restarted the app while the payload was copied. }
  if not EnsureDshClosed('installing the connector plugin') then
  begin
    FailureNeedsPlugin := True;
    MarkFailure('DeepSeek Harness Desktop was still running, so the connector was not registered.');
    Exit;
  end;

  LogsDir := EnsureLogsDir;
  PluginLog := LogsDir + '\plugin-add.log';

  WizardForm.FilenameLabel.Caption := '';
  WizardForm.StatusLabel.Caption := 'Installing the dsh-desktop-cowork-connector plugin into DeepSeek Harness Desktop...';
  WizardForm.Refresh;

  if not RunViaCmdLogged(DshCmdPath(),
    'plugin --profile desktop add "' + ExpandConstant('{app}\{#MyConnectorTgz}') + '"',
    PluginLog, Code) then
  begin
    FailureNeedsPlugin := True;
    MarkFailure('The connector plugin could not be installed because cmd.exe could not be started.');
    Exit;
  end;
  if Code <> 0 then
  begin
    Tail := LogTail(PluginLog, 1200);
    MsgBox('Installing the connector plugin failed (exit code ' + IntToStr(Code) + ').' + #13#10#13#10 +
      'Output from DeepSeek Harness:' + #13#10 + Tail + #13#10#13#10 +
      'Command log: ' + PluginLog + #13#10#13#10 +
      'Make sure DeepSeek Harness Desktop is fully quit (tray icon > Exit), then run this setup again.',
      mbError, MB_OK);
    FailureNeedsPlugin := True;
    MarkFailure('The connector plugin install failed (exit code ' + IntToStr(Code) + ').');
    Exit;
  end;

  Answer := MsgBox('The connector plugin is installed.' + #13#10#13#10 +
    'Start DeepSeek Harness Desktop now; it must be running for the next step.' + #13#10#13#10 +
    'Click OK when it is running. Setup will then wait up to 60 seconds for the ' +
    'connector to publish its connection file.',
    mbInformation, MB_OK);

  WizardForm.StatusLabel.Caption := 'Waiting for DeepSeek Harness Desktop...';
  WizardForm.Refresh;

  while not WaitForConnection(ConnectionWaitSeconds) do
  begin
    Answer := MsgBox('No connection file was published within 60 seconds.' + #13#10#13#10 +
      'Make sure DeepSeek Harness Desktop is running and not waiting on a dialog, then click Retry.' + #13#10 +
      'Click Cancel to stop here; the program files stay installed and the final page shows how to finish.',
      mbError, MB_RETRYCANCEL);
    if Answer <> IDRETRY then
    begin
      MarkFailure('DeepSeek Harness Desktop did not publish a connection file within 60 seconds.');
      Exit;
    end;
  end;

  SetupLog := LogsDir + '\setup-desktop.log';
  WizardForm.StatusLabel.Caption := 'Registering dsh_desktop with Codex and Claude Code...';
  WizardForm.Refresh;

  if not RunViaCmdLogged(ExpandConstant('{app}\runtime\node.exe'),
    '"' + ExpandConstant('{app}\dist\setup-desktop.js') + '" --caller both --scope user --apply --replace',
    SetupLog, Code) then
  begin
    MarkFailure('The bundled Node.js runtime could not be started.');
    Exit;
  end;

  if Code <> 0 then
  begin
    Tail := LogTail(SetupLog, 1500);
    if Code = 2 then
      MsgBox('setup-desktop refused to update the Codex / Claude Code configuration (exit code 2).' + #13#10#13#10 +
        Tail + #13#10#13#10 +
        'Command log: ' + SetupLog + #13#10#13#10 +
        'A refusal usually means no connection.json could be found. Start DeepSeek Harness Desktop, ' +
        'wait about 10 seconds, then run the command on the final page.',
        mbError, MB_OK)
    else
      MsgBox('Registering dsh_desktop failed (exit code ' + IntToStr(Code) + ').' + #13#10#13#10 +
        Tail + #13#10#13#10 +
        'Command log: ' + SetupLog + #13#10#13#10 +
        'The command on the final page can be run again after fixing the cause.',
        mbError, MB_OK);
    MarkFailure('setup-desktop failed (exit code ' + IntToStr(Code) + ').');
    Exit;
  end;

  WizardForm.StatusLabel.Caption := '';
  InstallFailed := False;
end;

{ The final page is the one place that must never lie about the outcome. }
procedure CurPageChanged(CurPageID: Integer);
var
  Text: String;
begin
  if CurPageID <> wpFinished then
    Exit;

  WizardForm.RunList.Visible := False;

  if InstallFailed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'Setup did not complete';
    Text :=
      'The program files were copied to:' + #13#10 +
      ExpandConstant('{app}') + #13#10#13#10 +
      'But the setup did not finish:' + #13#10 +
      FailureDetail + #13#10#13#10;
    if FailureNeedsPlugin then
      Text := Text +
        'Quit DeepSeek Harness Desktop from the tray, then run this setup again so the connector can be installed.'
    else
      Text := Text +
        'Make sure DeepSeek Harness Desktop is running, then run this command to finish:' + #13#10 +
        SetupDesktopCommand;
    Text := Text + #13#10#13#10 +
      'See the error message shown earlier and README.md in the install folder.';
    WizardForm.FinishedLabel.Caption := Text;
    WizardForm.FinishedLabel.Font.Color := clRed;
  end
  else
  begin
    Text :=
      'Installed to:' + #13#10 +
      ExpandConstant('{app}') + #13#10#13#10 +
      'dsh_desktop is registered for Codex and Claude Code (user scope) with the bundled Node.js and this folder.' + #13#10#13#10 +
      'Next:' + #13#10 +
      '1. Start DeepSeek Harness Desktop.' + #13#10 +
      '2. Restart Codex / Claude Code and open a new session.' + #13#10#13#10 +
      'Uninstall from Settings > Apps. The uninstaller leaves ' + ExpandConstant('{localappdata}') +
      '\DSHDesktopCowork and the .bak-dsh-desktop-cowork-* backups in place.';
    WizardForm.FinishedLabel.Caption := Text;
  end;
  WizardForm.FinishedLabel.AdjustHeight;
end;

{ Uninstall: configuration first, then the DSH plugin, then Inno deletes the
  install folder. Abort() *does* terminate the uninstaller when called from
  usUninstall, so Cancel here leaves the installation untouched. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  NodeExe, SetupJs, SetupLog, RemoveLog, Tail: String;
  Answer: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    if not EnsureDshClosed('removing the connector plugin') then
    begin
      Abort;
      Exit;
    end;

    NodeExe := ExpandConstant('{app}\runtime\node.exe');
    SetupJs := ExpandConstant('{app}\dist\setup-desktop.js');
    LogsDir := EnsureLogsDir;
    SetupLog := LogsDir + '\setup-desktop-uninstall.log';

    if FileExists(NodeExe) and FileExists(SetupJs) then
    begin
      UninstallProgressForm.StatusLabel.Caption := 'Removing the dsh_desktop entries from Codex and Claude Code...';
      repeat
        if RunViaCmdLogged(NodeExe,
          '"' + SetupJs + '" --caller both --scope user --uninstall --apply',
          SetupLog, Code) and (Code = 0) then
          Break;
        Tail := LogTail(SetupLog, 1200);
        Answer := MsgBox('Removing the Codex / Claude Code entries failed (exit code ' + IntToStr(Code) + ').' + #13#10#13#10 +
          Tail + #13#10#13#10 +
          'Retry: try again.' + #13#10 +
          'Ignore: continue removing the program (the entries may stay behind).' + #13#10 +
          'Abort: stop the uninstall and keep everything as it is.',
          mbError, MB_ABORTRETRYIGNORE);
        if Answer = IDABORT then
        begin
          Abort;
          Exit;
        end;
        if Answer = IDIGNORE then
          Break;
      until False;
    end
    else
      MsgBox('The files needed to remove the Codex / Claude Code entries are missing from:' + #13#10 +
        ExpandConstant('{app}') + #13#10#13#10 +
        'Those entries may stay behind. Remove the dsh_desktop entry from your Codex / Claude ' +
        'configuration manually if needed.',
        mbInformation, MB_OK);

    RemoveLog := LogsDir + '\plugin-remove.log';
    if FileExists(DshCmdPath()) then
    begin
      UninstallProgressForm.StatusLabel.Caption := 'Removing the dsh-desktop-cowork-connector plugin from DeepSeek Harness Desktop...';
      repeat
        if RunViaCmdLogged(DshCmdPath(),
          'plugin --profile desktop remove dsh-desktop-cowork-connector',
          RemoveLog, Code) and (Code = 0) then
          Break;
        Tail := LogTail(RemoveLog, 1200);
        Answer := MsgBox('Removing the connector plugin failed (exit code ' + IntToStr(Code) + ').' + #13#10#13#10 +
          Tail + #13#10#13#10 +
          'Retry: try again.' + #13#10 +
          'Ignore: continue removing the program (the plugin may stay registered).' + #13#10 +
          'Abort: stop the uninstall and keep everything as it is.',
          mbError, MB_ABORTRETRYIGNORE);
        if Answer = IDABORT then
        begin
          Abort;
          Exit;
        end;
        if Answer = IDIGNORE then
          Break;
      until False;
    end
    else
      MsgBox('DeepSeek Harness Desktop was not found at:' + #13#10 +
        ExpandConstant('{localappdata}\Programs\DeepSeek Harness') + #13#10#13#10 +
        'The connector plugin cannot be removed, but the rest of the uninstall will continue.',
        mbInformation, MB_OK);
  end
  else if CurUninstallStep = usDone then
  begin
    MsgBox('DSH Desktop Cowork was removed.' + #13#10#13#10 +
      'Left in place on purpose:' + #13#10 +
      '  - ' + ExpandConstant('{localappdata}') + '\DSHDesktopCowork (connection file and bridge state)' + #13#10 +
      '  - .bak-dsh-desktop-cowork-* backups next to your Codex / Claude configuration files',
      mbInformation, MB_OK);
  end;
end;
