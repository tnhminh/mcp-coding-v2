[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Alias = if ($env:MCP_TUNNEL_ALIAS) { $env:MCP_TUNNEL_ALIAS } else { 'mcp-coding-v2' }
$versionDirs = Get-ChildItem (Join-Path $ProjectRoot '.runtime\tools\tunnel-client') -Directory -ErrorAction SilentlyContinue |
  Sort-Object { try { [version]($_.Name -replace '^v','') } catch { [version]'0.0.0' } } -Descending
$exe = $versionDirs | ForEach-Object { Join-Path $_.FullName 'tunnel-client.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw 'tunnel-client is not installed. Run npm run tunnel:install first.' }

& $exe runtimes stop $Alias --json
if ($LASTEXITCODE -ne 0) { throw "Unable to stop managed tunnel runtime '$Alias'." }
