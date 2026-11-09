# Create an "mdEditor" shortcut on the Desktop and in the Start menu, for the SOURCE version
# (runs mdeditor.pyw with the installed Python).
# For the compiled version, use install.ps1 from the release zip instead (installer/install.ps1).
# Usage: right-click > Run with PowerShell  (or: powershell -ExecutionPolicy Bypass -File install-shortcut.ps1)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonw) {
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if ($python) { $pythonw = Join-Path (Split-Path $python) 'pythonw.exe' }
}
if (-not $pythonw -or -not (Test-Path $pythonw)) { throw 'pythonw.exe not found: Python must be installed and on the PATH.' }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) '')
)
foreach ($dir in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'mdEditor.lnk'))
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = '"' + (Join-Path $here 'mdeditor.pyw') + '"'
    $lnk.WorkingDirectory = $here
    $lnk.IconLocation = (Join-Path $here 'assets\mdeditor.ico')
    $lnk.Description = 'WYSIWYG Markdown editor for MkDocs'
    $lnk.Save()
    Write-Host "Shortcut created: $($lnk.FullName)"
}
