# Sends a real CTRL_C_EVENT to scrcpy.exe so its libavformat muxer
# finalizes the MP4 (writes the moov atom). Called by the Electron main
# process at recording-stop time.
#
# Node's child_process.kill() on Windows is always TerminateProcess —
# scrcpy's signal handler never runs, and the resulting MP4 is a 48-byte
# unplayable shell. The only way to deliver a proper Ctrl+C from one
# process to another on Windows is via GenerateConsoleCtrlEvent, which
# requires attaching to the target's console first.

param([Parameter(Mandatory=$true)][int]$TargetPid)

Add-Type -Name K -Namespace W -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr HandlerRoutine, bool Add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@

# Detach from PowerShell's own console (if any) so AttachConsole can succeed.
[void][W.K]::FreeConsole()

$attached = [W.K]::AttachConsole([uint32]$TargetPid)
if (-not $attached) {
    Write-Error "AttachConsole($TargetPid) failed"
    exit 1
}

# Disable Ctrl+C handling in OUR process so the event we're about to
# raise doesn't terminate this helper before it can run to completion.
[void][W.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true)

# 0 = CTRL_C_EVENT, group 0 = all processes attached to current console.
# scrcpy's handler catches this and pushes SDL_QUIT, which makes its
# main thread run cleanup (flush muxer, write moov atom).
$sent = [W.K]::GenerateConsoleCtrlEvent(0, 0)
if (-not $sent) {
    Write-Error "GenerateConsoleCtrlEvent failed"
    [void][W.K]::FreeConsole()
    exit 2
}

# Detach immediately. scrcpy stays attached to its own console and can
# finish flushing on its own time; we don't need to keep PS alive.
[void][W.K]::FreeConsole()
exit 0
