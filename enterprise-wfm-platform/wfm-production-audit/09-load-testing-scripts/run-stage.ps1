# Runs one audit stage against the TEST org on the server. Run this yourself in a PowerShell window.
# It asks for the test org admin password (hidden) and keeps it only in this process.
#   .\run-stage.ps1 -Run TR0042S50 -Steps setup,employees,history,forecast,schedule
param(
  [string]$Run = 'TR0042S50',
  [string]$Steps = 'all',
  [string]$User = 'admin',
  [string]$Horizons = '1,4,13,26,52',
  [int]$TimeLimit = 60
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runDir = Join-Path $here "..\05-synthetic-data-generator\out\$Run"
if (-not (Test-Path "$runDir\setup.json")) { throw "No generated data at $runDir" }
$sec = Read-Host -AsSecureString "Password for $User in org AUDITTR0042"
$env:QA_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$env:QA_API = 'http://192.168.9.186:3000'
$env:QA_TENANT = 'AUDITTR0042'
$env:QA_USER = $User
$env:EXPECT_TENANT = 'a27e73cf-8151-4447-a402-795a177a6537'
$env:HORIZONS = $Horizons
$env:TIME_LIMIT = "$TimeLimit"
try { node "$here\stage.mjs" $runDir $Steps } finally { Remove-Item Env:QA_PASSWORD }
