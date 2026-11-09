<#
.SYNOPSIS
    Installs mdEditor (compiled version) for the current user, without administrator rights.

.DESCRIPTION
    Run it from the unzipped mdEditor folder (next to mdEditor.exe):
        right-click install.ps1 > Run with PowerShell
        or: powershell -ExecutionPolicy Bypass -File install.ps1 [options]

    1. Copies the application to %LOCALAPPDATA%\Programs\mdEditor (or -Destination).
    2. Creates the "mdEditor" shortcuts on the Desktop and in the Start menu.
    3. Adds the folder to the user PATH, so that `mdeditor-cli` works in any terminal.
    4. With -Mcp: registers the MCP server in Claude Code and Claude Desktop.
    What was done is written to install.json, which uninstall.ps1 reads.
    The user settings (%APPDATA%\mdEditor) are not touched.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Mcp -McpRoot D:\Docs\Help\Md
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\mdEditor'),
    [switch]$NoShortcuts,
    [switch]$NoPath,
    # Register mdeditor-mcp.exe in Claude Code (claude mcp add) and Claude Desktop.
    [switch]$Mcp,
    # Documentation folder given to the MCP server (--root); by default it uses the last folder opened in the editor.
    [string]$McpRoot,
    # Folders that receive the shortcut (Desktop and Start menu by default).
    [string[]]$ShortcutFolders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Destination = [IO.Path]::GetFullPath($Destination)

function Step($text) { Write-Host "  $text" }

if (-not (Test-Path (Join-Path $source 'mdEditor.exe')) -or -not (Test-Path (Join-Path $source '_internal'))) {
    throw "mdEditor.exe and _internal\ were not found next to install.ps1 ($source). Run the script from the unzipped mdEditor folder."
}
Write-Host "Installing mdEditor into $Destination"

# 1. Files -------------------------------------------------------------------
$samePlace = ([IO.Path]::GetFullPath($source).TrimEnd('\') -ieq $Destination.TrimEnd('\'))
if (-not $samePlace) {
    if (Test-Path $Destination) {
        $items = @(Get-ChildItem -LiteralPath $Destination -Force)
        if ($items.Count -and -not (Test-Path (Join-Path $Destination 'mdEditor.exe'))) {
            throw "$Destination is not empty and does not contain mdEditor: choose another -Destination."
        }
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($Destination, [StringComparison]::OrdinalIgnoreCase) })
        if ($running.Count) {
            throw "mdEditor is running from $Destination ($($running.Name -join ', ')): close it, then run the installer again."
        }
        # Previous version: replaced as a whole (no stale library left in _internal).
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -ne 'install.json' } |
        Copy-Item -Destination $Destination -Recurse -Force
    Step "Files copied"
} else {
    Step "Already in place: files not copied"
}
$exe = Join-Path $Destination 'mdEditor.exe'
$manifest = [ordered]@{ version = 1; destination = $Destination; shortcuts = @(); path = $false; mcpClaudeCode = $false; mcpClaudeDesktop = $null }

# 2. Shortcuts -----------------------------------------------------------------
if (-not $NoShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($dir in $ShortcutFolders) {
        if (-not $dir) { continue }
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $lnk = $shell.CreateShortcut((Join-Path $dir 'mdEditor.lnk'))
        $lnk.TargetPath = $exe
        $lnk.WorkingDirectory = $Destination
        $lnk.IconLocation = "$exe,0"
        $lnk.Description = 'WYSIWYG editor for MkDocs documentation'
        $lnk.Save()
        $manifest.shortcuts += $lnk.FullName
        Step "Shortcut: $($lnk.FullName)"
    }
}

# 3. User PATH (for mdeditor-cli) ------------------------------------------------
# Read and written raw (REG_EXPAND_SZ kept), so that %VARIABLES% in the PATH are not expanded.
if (-not $NoPath) {
    $key = Get-Item -Path 'HKCU:\Environment'
    $current = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $entries = @($current -split ';' | Where-Object { $_ })
    if ($entries | Where-Object { $_.TrimEnd('\') -ieq $Destination.TrimEnd('\') }) {
        Step "Already in the user PATH"
    } else {
        $new = (@($entries) + $Destination) -join ';'
        Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $new -Type ExpandString
        # Tell Windows that the environment changed (new terminals see the new PATH).
        [Environment]::SetEnvironmentVariable('MDEDITOR_PATH_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('MDEDITOR_PATH_REFRESH', $null, 'User')
        $manifest.path = $true
        Step "Added to the user PATH: mdeditor-cli works in new terminals"
    }
}

# 4. MCP server for Claude -------------------------------------------------------------
if ($Mcp) {
    $mcpExe = Join-Path $Destination 'mdeditor-mcp.exe'
    $mcpArgs = @()
    if ($McpRoot) { $mcpArgs = @('--root', [IO.Path]::GetFullPath($McpRoot)) }
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($claude) {
        & $claude.Source mcp remove --scope user mdeditor *> $null
        & $claude.Source mcp add --scope user mdeditor -- $mcpExe @mcpArgs
        if ($LASTEXITCODE -eq 0) { $manifest.mcpClaudeCode = $true; Step "MCP server registered in Claude Code (user scope)" }
        else { Write-Warning "claude mcp add failed (exit code $LASTEXITCODE)" }
    } else {
        Step "Claude Code not found: skipped"
    }
    $desktopDir = Join-Path $env:APPDATA 'Claude'
    if (Test-Path $desktopDir) {
        $config = Join-Path $desktopDir 'claude_desktop_config.json'
        $data = if (Test-Path $config) { Get-Content -Raw -LiteralPath $config | ConvertFrom-Json } else { [pscustomobject]@{} }
        if (Test-Path $config) { Copy-Item -LiteralPath $config "$config.bak" -Force }
        if (-not $data.PSObject.Properties['mcpServers']) { $data | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
        $entry = [pscustomobject]@{ command = $mcpExe; args = @($mcpArgs) }
        if ($data.mcpServers.PSObject.Properties['mdeditor']) { $data.mcpServers.mdeditor = $entry }
        else { $data.mcpServers | Add-Member -NotePropertyName mdeditor -NotePropertyValue $entry }
        [IO.File]::WriteAllText($config, ($data | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
        $manifest.mcpClaudeDesktop = $config
        Step "MCP server added to Claude Desktop ($config; restart Claude Desktop)"
    } else {
        Step "Claude Desktop not found: skipped"
    }
}

[IO.File]::WriteAllText((Join-Path $Destination 'install.json'), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host "mdEditor is installed. Uninstall: $(Join-Path $Destination 'uninstall.ps1')"
