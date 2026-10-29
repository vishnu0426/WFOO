<#
  Starts the whole WFM platform for local development, each part in its own window:
    PostgreSQL / Redis / NATS (checked, started where possible)
    -> Python engine (gRPC :50051) -> Node gateway (REST + WebSocket :4000) -> admin front-end (:3000) -> employee portal (:3001)

  Run from the repository root:
    .\scripts\dev.ps1              # admin web app + employee portal
    .\scripts\dev.ps1 -Mobile      # also opens the Expo dev server for the mobile app

  Every run starts everything fresh: whatever is already listening on the engine, gateway, admin app and portal ports is stopped first, so a
  code change (the Python engine does not reload by itself) always takes effect. Infrastructure (PostgreSQL, Redis, NATS) is only started
  when it is not already running, and is never stopped.
#>
param(
  [switch]$Mobile
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$engine = Join-Path $root 'backend\engine'
$gateway = Join-Path $root 'backend\gateway'
$portal = Join-Path $root 'employee-portal'
$mobileDir = Join-Path $root 'mobile'

function Test-Port($portNum) {
  try { (New-Object Net.Sockets.TcpClient).Connect('localhost', $portNum); $true } catch { $false }
}

# True when Redis actually answers PING. A port that merely accepts connections is not enough: a hung Redis still does, and then everything that waits on it hangs.
function Test-Redis {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.ReceiveTimeout = 2000
    $c.Connect('localhost', 6379)
    $st = $c.GetStream()
    $ping = [Text.Encoding]::ASCII.GetBytes("*1`r`n`$4`r`nPING`r`n")
    $st.Write($ping, 0, $ping.Length)
    $buf = New-Object byte[] 16
    $n = $st.Read($buf, 0, 16)
    $c.Close()
    return ([Text.Encoding]::ASCII.GetString($buf, 0, $n) -like '+PONG*')
  } catch { return $false }
}

# Stops whatever is listening on a port, so the part can be started again with the current code. Only the process that owns the port is stopped.
function Stop-Port($portNum, $label) {
  $owners = Get-NetTCPConnection -LocalPort $portNum -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $owners) {
    if ($procId -le 4) { continue }
    Write-Host "  Stopping the old $label (port $portNum, process $procId)..." -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 20 -and (Test-Port $portNum); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-Port $portNum) { Write-Host "  Port $portNum ($label) is still in use. Close it yourself, then run this script again." -ForegroundColor Red; exit 1 }
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

if ((Test-Port 6379) -and (Test-Redis)) {
  Write-Host '  Redis (6379): reachable' -ForegroundColor Green
} elseif (Get-Command redis-server -ErrorAction SilentlyContinue) {
  if (Test-Port 6379) {
    Write-Host '  Redis (6379): accepts connections but does not answer PING (hung). Restarting it; its saved data (dump.rdb) is kept.' -ForegroundColor Yellow
    Stop-Port 6379 'Redis'
  }
  Write-Host '  Redis (6379): starting redis-server...' -ForegroundColor Yellow
  # started from the repository root, so its saved data (dump.rdb) is always read from and written to the same place
  Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-Command', 'redis-server'
  for ($i = 0; $i -lt 20 -and -not (Test-Redis); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Redis)) { Write-Host '  Redis (6379): started but does not answer. Check its window, then re-run this script.' -ForegroundColor Red; exit 1 }
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

# 4. app: stop anything left over from an earlier run, then start engine, gateway, admin front-end, employee portal, each in its own window
Write-Host 'Stopping anything already running...' -ForegroundColor Cyan
Stop-Port 50051 'engine'
Stop-Port 4000 'gateway'
Stop-Port 3000 'admin app'
Stop-Port 3001 'employee portal'
if ($Mobile) { Stop-Port 8081 'Expo dev server' }
Start-Process powershell -WorkingDirectory $engine -ArgumentList '-NoExit', '-Command', "& '$py' server.py"
Start-Process powershell -WorkingDirectory $gateway -ArgumentList '-NoExit', '-Command', 'npm run dev'
Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-Command', 'npm run dev'
Start-Process powershell -WorkingDirectory $portal -ArgumentList '-NoExit', '-Command', 'npm run dev'
Write-Host ''
Write-Host 'Engine, gateway, admin front-end and employee portal are starting.' -ForegroundColor Green
Write-Host '  Admin app:       http://localhost:3000' -ForegroundColor Green
Write-Host '  Employee portal: http://localhost:3001' -ForegroundColor Green
Write-Host 'First start prints the administrator password once in the gateway window (unless BOOTSTRAP_ADMIN_PASSWORD is set).'

if ($Mobile) {
  Start-Process powershell -WorkingDirectory $mobileDir -ArgumentList '-NoExit', '-Command', 'npm start'
  Write-Host 'Mobile app (Expo) is starting in its own window. Press w for browser, a for Android, i for iOS, or scan the QR code with Expo Go.' -ForegroundColor Green
}
