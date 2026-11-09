<#
.SYNOPSIS
    Uninstalls mdEditor: undoes what install.ps1 did (install.json).

.DESCRIPTION
    Run it from the installation folder (right-click > Run with PowerShell).
    Removes the shortcuts, the PATH entry, the MCP registrations and the folder.
    The user settings (%APPDATA%\mdEditor: recent folders, session, preferences,
    custom languages) are kept, unless -RemoveSettings is given.
#>
[CmdletBinding()]
param(
    [switch]$RemoveSettings,
    # Keep the program folder (only undo the shortcuts, PATH and MCP entries).
    [switch]$KeepFiles
)
$ErrorActionPreference = 'Stop'
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $folder 'install.json'
if (-not (Test-Path $manifestPath)) { throw "install.json not found in ${folder}: this folder was not installed by install.ps1." }
$m = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$destination = $m.destination
if ([IO.Path]::GetFullPath($destination).TrimEnd('\') -ine $folder.TrimEnd('\')) {
    throw "install.json describes $destination, not this folder ($folder)."
}
function Step($text) { Write-Host "  $text" }
Write-Host "Uninstalling mdEditor from $destination"

$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($destination, [StringComparison]::OrdinalIgnoreCase) })
if ($running.Count -and -not $KeepFiles) { throw "mdEditor is running ($($running.Name -join ', ')): close it first." }

foreach ($lnk in @($m.shortcuts)) {
    if ($lnk -and (Test-Path -LiteralPath $lnk)) { Remove-Item -LiteralPath $lnk -Force; Step "Shortcut removed: $lnk" }
}

if ($m.path) {
    $key = Get-Item -Path 'HKCU:\Environment'
    $current = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $kept = @($current -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $destination.TrimEnd('\')) })
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value ($kept -join ';') -Type ExpandString
    [Environment]::SetEnvironmentVariable('MDEDITOR_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('MDEDITOR_PATH_REFRESH', $null, 'User')
    Step "Removed from the user PATH"
}

if ($m.mcpClaudeCode) {
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($claude) { & $claude.Source mcp remove --scope user mdeditor *> $null; Step "MCP server removed from Claude Code" }
}
if ($m.mcpClaudeDesktop -and (Test-Path -LiteralPath $m.mcpClaudeDesktop)) {
    $data = Get-Content -Raw -LiteralPath $m.mcpClaudeDesktop | ConvertFrom-Json
    if ($data.mcpServers -and $data.mcpServers.PSObject.Properties['mdeditor']) {
        $data.mcpServers.PSObject.Properties.Remove('mdeditor')
        [IO.File]::WriteAllText($m.mcpClaudeDesktop, ($data | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
        Step "MCP server removed from Claude Desktop"
    }
}

if ($RemoveSettings) {
    $settings = Join-Path $env:APPDATA 'mdEditor'
    if (Test-Path $settings) { Remove-Item -LiteralPath $settings -Recurse -Force; Step "Settings removed: $settings" }
}

if (-not $KeepFiles) {
    # PowerShell has already read this script: its folder can be removed.
    Set-Location $env:TEMP
    Remove-Item -LiteralPath $destination -Recurse -Force
    Step "Folder removed"
}
Write-Host "mdEditor is uninstalled."
