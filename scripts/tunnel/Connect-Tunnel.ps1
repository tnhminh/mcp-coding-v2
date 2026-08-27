[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Alias = if ($env:MCP_TUNNEL_ALIAS) { $env:MCP_TUNNEL_ALIAS } else { 'mcp-coding-v2' }
$Port = if ($env:MCP_PORT) { [int]$env:MCP_PORT } else { 7317 }
$TargetUrl = if ($env:MCP_TUNNEL_TARGET_URL) { $env:MCP_TUNNEL_TARGET_URL } else { "http://127.0.0.1:$Port/mcp" }
$ReadyUrl = "http://127.0.0.1:$Port/health/ready"
$ProfileDir = if ($env:MCP_TUNNEL_PROFILE_DIR) { $env:MCP_TUNNEL_PROFILE_DIR } else { Join-Path $ProjectRoot '.runtime\tunnel-client\profiles' }

if (-not $env:CONTROL_PLANE_TUNNEL_ID) { throw 'CONTROL_PLANE_TUNNEL_ID is required.' }
if (-not $env:CONTROL_PLANE_API_KEY) { throw 'CONTROL_PLANE_API_KEY is required.' }
if ($env:CONTROL_PLANE_TUNNEL_ID -notmatch '^tunnel_[A-Za-z0-9_-]{8,}$') { throw 'CONTROL_PLANE_TUNNEL_ID has an unexpected format.' }

$versionDirs = Get-ChildItem (Join-Path $ProjectRoot '.runtime\tools\tunnel-client') -Directory -ErrorAction SilentlyContinue |
  Sort-Object { try { [version]($_.Name -replace '^v','') } catch { [version]'0.0.0' } } -Descending
$exe = $versionDirs | ForEach-Object { Join-Path $_.FullName 'tunnel-client.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw 'tunnel-client is not installed. Run npm run tunnel:install first.' }

try {
  $ready = Invoke-WebRequest -UseBasicParsing -Uri $ReadyUrl -TimeoutSec 3
  if ($ready.StatusCode -ne 200) { throw "HTTP $($ready.StatusCode)" }
} catch {
  throw "Local MCP is not ready at $ReadyUrl. Start the compiled MCP runtime before connecting the tunnel."
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
& $exe runtimes connect `
  --alias $Alias `
  --profile $Alias `
  --profile-dir $ProfileDir `
  --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID `
  --runtime-api-key 'env:CONTROL_PLANE_API_KEY' `
  --mcp-server-url $TargetUrl `
  --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client runtimes connect failed.' }

function Find-BoolValue {
  param(
    [Parameter(Mandatory=$false)]$Value,
    [Parameter(Mandatory=$true)][string[]]$Keys,
    [int]$Depth = 0
  )
  if ($null -eq $Value -or $Depth -gt 8) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    foreach ($key in $Keys) {
      if ($Value.Contains($key) -and $Value[$key] -is [bool]) { return [bool]$Value[$key] }
    }
    foreach ($child in $Value.Values) {
      $found = Find-BoolValue -Value $child -Keys $Keys -Depth ($Depth + 1)
      if ($null -ne $found) { return $found }
    }
    return $null
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    foreach ($child in $Value) {
      $found = Find-BoolValue -Value $child -Keys $Keys -Depth ($Depth + 1)
      if ($null -ne $found) { return $found }
    }
    return $null
  }
  foreach ($property in $Value.PSObject.Properties) {
    if ($Keys -contains $property.Name -and $property.Value -is [bool]) { return [bool]$property.Value }
  }
  foreach ($property in $Value.PSObject.Properties) {
    $found = Find-BoolValue -Value $property.Value -Keys $Keys -Depth ($Depth + 1)
    if ($null -ne $found) { return $found }
  }
  return $null
}

$statusText = (& $exe runtimes status $Alias --json 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Tunnel runtime started but status could not be read.' }
$status = $statusText | ConvertFrom-Json

$processRunning = Find-BoolValue -Value $status -Keys @('process_running','processRunning')
$healthy = Find-BoolValue -Value $status -Keys @('healthy')
$readyState = Find-BoolValue -Value $status -Keys @('ready')
if (-not ($processRunning -eq $true -and $healthy -eq $true -and $readyState -eq $true)) {
  throw 'Tunnel runtime is not fully running/healthy/ready. Run npm run tunnel:status for diagnostics.'
}

[pscustomobject]@{
  connected = $true
  alias = $Alias
  target = $TargetUrl
  process_running = $true
  healthy = $true
  ready = $true
} | ConvertTo-Json
