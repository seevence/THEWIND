# THEWIND 一键安装（Windows PowerShell）
# 用法：在 project 目录执行  powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "未检测到 Docker。请先安装 Docker Desktop 并启动（需启用 WSL2 后端）。"
}
docker compose version | Out-Null
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "已生成 .env"
}
function New-Secret { (([guid]::NewGuid().ToString("N")) + ([guid]::NewGuid().ToString("N"))) }
function Set-Secret([string]$key, [string]$value) {
  $lines = @(Get-Content ".env")
  $pattern = "^$key="
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pattern) { $lines[$i] = "$key=$value"; $found = $true; break }
  }
  if (-not $found) { $lines += "$key=$value" }
  Set-Content ".env" $lines -Encoding UTF8
}
Set-Secret "SESSION_SECRET" (New-Secret)
Set-Secret "IMG_PROXY_SIGN_SECRET" (New-Secret)
$admin = (Get-Content ".env" | Where-Object { $_ -match '^ADMIN_PASSWORD=' } | Select-Object -First 1)
if (-not $admin -or $admin -eq "ADMIN_PASSWORD=") { Set-Secret "ADMIN_PASSWORD" ("admin-" + (New-Secret).Substring(0, 12)) }
Write-Host "开始构建并启动（首次约 3-8 分钟）..."
docker compose up -d --build
Write-Host "等待服务就绪..."
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}
if (-not $ok) { Write-Warning "健康检查未通过，请执行 docker compose logs web api 查看日志" }
if (Test-Path "database\demo\demo-data.sql") {
  Write-Host "导入演示数据（无需 API Key 即可浏览完整页面）..."
  docker cp "database\demo\demo-data.sql" aihot-db-1:/tmp/demo-data.sql
  docker compose exec -T db psql -U aihot -d aihot -f /tmp/demo-data.sql | Out-Null
}
$pwLine = (Get-Content ".env" | Where-Object { $_ -match '^ADMIN_PASSWORD=' } | Select-Object -First 1)
Write-Host ""
Write-Host "完成：打开 http://localhost:3000 ，后台 http://localhost:3000/admin"
Write-Host "后台密码：$pwLine（可在 .env 修改）"
