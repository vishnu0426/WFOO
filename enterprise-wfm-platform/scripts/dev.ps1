<#
  Starts the whole WFM platform for local development, each part in its own window:
    PostgreSQL / Redis / NATS (checked, started where possible)
    -> Python engine (gRPC :50051) -> Node gateway (REST + WebSocket :4000) -> admin front-end (:3000) -> employee portal (:3001)

  Run from the repository root:
    .\scripts\dev.ps1              # admin web app + employee portal
    .\scripts\dev.ps1 -Mobile      # also opens the Expo dev server for the mobile app

  Idempotent: safe to re-run. Windows it already opened are left alone; it only starts what is missing.
#>
param(
  [switch]$Mobile
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$engine = Join-Path $root 'backend\engine'
$gateway = Join-Path $root 'backend\gateway'
$portal = Join-Path $root 'employee-portal'
$superadmin = Join-Path $root 'superadmin-portal'
$mobileDir = Join-Path $root 'mobile'

function Test-Port($portNum) {
  try { (New-Object Net.Sockets.TcpClient).Connect('localhost', $portNum); $true } catch { $false }
}

# 0. configuration: one .env for the whole backend (gateway and engine both read it); the database URL is yours to supply, nothing is guessed
$envFile = Join-Path $root 'backend\.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root 'backend\.env.example') $envFile
  Write-Host "Created $envFile. Set DATABASE_URL (and JWT_SECRET) in it, then run this script again." -ForegroundColor Yellow
  exit 1
}

# 1. infrastructure: PostgreSQL, Redis, NATS with JetStream
Write-Host 'Checking PostgreSQL, Redis, NATS...' -ForegroundColor Cyan

if (Test-Port 5432) {
  Write-Host '  PostgreSQL (5432): reachable' -ForegroundColor Green
} else {
  $pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pg -and $pg.Status -ne 'Running') {
    Write-Host "  PostgreSQL: starting Windows service '$($pg.Name)'..." -ForegroundColor Yellow
    Start-Service $pg.Name
    Start-Sleep -Seconds 2
  }
  if (-not (Test-Port 5432)) {
    Write-Host '  PostgreSQL (5432): NOT reachable. Start it yourself, then re-run this script.' -ForegroundColor Red
    exit 1
  }
}

if (Test-Port 6379) {
  Write-Host '  Redis (6379): reachable' -ForegroundColor Green
} elseif (Get-Command redis-server -ErrorAction SilentlyContinue) {
  Write-Host '  Redis (6379): starting redis-server...' -ForegroundColor Yellow
  Start-Process powershell -ArgumentList '-NoExit', '-Command', 'redis-server'
  Start-Sleep -Seconds 2
} else {
  Write-Host '  Redis (6379): NOT reachable and redis-server is not on PATH. Start it yourself, then re-run this script.' -ForegroundColor Red
  exit 1
}

if (Test-Port 4222) {
  Write-Host '  NATS (4222): reachable' -ForegroundColor Green
} elseif (Get-Command nats-server -ErrorAction SilentlyContinue) {
  Write-Host '  NATS (4222): starting nats-server -js (JetStream)...' -ForegroundColor Yellow
  Start-Process powershell -ArgumentList '-NoExit', '-Command', 'nats-server -js'
  Start-Sleep -Seconds 2
} else {
  Write-Host '  NATS (4222): NOT reachable and nats-server is not on PATH. Start it yourself with "nats-server -js", then re-run this script.' -ForegroundColor Red
  exit 1
}

# 2. engine: virtual environment + generated gRPC stubs
$py = Join-Path $engine '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
  Write-Host 'Setting up the Python engine (first run only)...'
  python -m venv (Join-Path $engine '.venv')
  & $py -m pip install --quiet -r (Join-Path $engine 'requirements.txt')
}
if (-not (Test-Path (Join-Path $engine 'wfm_pb2.py'))) {
  Push-Location $engine
  & $py -m grpc_tools.protoc -I ..\proto --python_out=. --grpc_python_out=. wfm.proto
  Pop-Location
}

# 3. Node dependencies
foreach ($dir in @($gateway, $root, $portal)) {
  if (-not (Test-Path (Join-Path $dir 'node_modules'))) { Push-Location $dir; npm install; Pop-Location }
}
if ($Mobile -and -not (Test-Path (Join-Path $mobileDir 'node_modules'))) { Push-Location $mobileDir; npm install; Pop-Location }

# 4. app: engine, gateway, admin front-end, super admin portal, employee portal
Start-Process powershell -WorkingDirectory $engine -ArgumentList '-NoExit', '-Command', "& '$py' server.py"
Start-Process powershell -WorkingDirectory $gateway -ArgumentList '-NoExit', '-Command', 'npm run dev'
Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-Command', 'npm run dev'
Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-Command', 'npm run dev:superadmin'
Start-Process powershell -WorkingDirectory $portal -ArgumentList '-NoExit', '-Command', 'npm run dev'
Write-Host ''
Write-Host 'Engine, gateway, admin front-end, super admin portal and employee portal are starting.' -ForegroundColor Green
Write-Host '  Tenant Admin app:   http://localhost:3000' -ForegroundColor Green
Write-Host '  Super Admin portal: http://localhost:3001' -ForegroundColor Green
Write-Host '  Employee portal:    http://localhost:3002' -ForegroundColor Green
Write-Host 'First start prints the administrator password once in the gateway window (unless BOOTSTRAP_ADMIN_PASSWORD is set).'

if ($Mobile) {
  Start-Process powershell -WorkingDirectory $mobileDir -ArgumentList '-NoExit', '-Command', 'npm start'
  Write-Host 'Mobile app (Expo) is starting in its own window. Press w for browser, a for Android, i for iOS, or scan the QR code with Expo Go.' -ForegroundColor Green
}
