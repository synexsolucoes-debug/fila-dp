<#
.SYNOPSIS
  Sobe o worker do Agente Tangerino. Chamado pela tarefa agendada no logon.

.DESCRIPTION
  Um unico worker por perfil de navegador. Duas instancias sobre o mesmo perfil
  brigam pelo diretorio de sessao do Chromium e corrompem os cookies — o
  sintoma seria pedir login de novo a cada ciclo, sem explicacao.

  A trava e um mutex nomeado do proprio Windows, e nao um arquivo de lock:
  arquivo sobrevive a um encerramento abrupto e deixa o worker sem subir na
  proxima vez, exigindo limpeza manual. O mutex morre com o processo.
#>
[CmdletBinding()]
param([string]$EnvFile)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot ".env.tangerino-worker.local" }

if (-not (Test-Path $EnvFile)) {
  Write-Host "Arquivo de ambiente nao encontrado: $EnvFile" -ForegroundColor Red
  Write-Host "Rode scripts\windows\install-tangerino-worker.ps1 primeiro." -ForegroundColor Yellow
  exit 1
}

foreach ($line in Get-Content $EnvFile) {
  if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
  $name, $value = $line -split "=", 2
  [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process")
}
$env:FDP_DB_DRIVER = "pg"

$profileRoot = $env:FDP_TANGERINO_PROFILE_ROOT
if ([string]::IsNullOrWhiteSpace($profileRoot)) {
  Write-Host "FDP_TANGERINO_PROFILE_ROOT vazio." -ForegroundColor Red
  exit 1
}

# O nome do mutex deriva do perfil: dois workers com perfis diferentes podem
# conviver, dois com o mesmo perfil nao.
$chave = [System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes($profileRoot.ToLowerInvariant()))).Replace("-", "").Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($false, "Global\VinculatoTangerinoWorker-$chave")

if (-not $mutex.WaitOne(0)) {
  Write-Host "Ja existe um worker rodando com este perfil. Nada a fazer." -ForegroundColor Yellow
  exit 0
}

try {
  Write-Host "Worker do Agente Tangerino iniciando. Deixe esta janela aberta." -ForegroundColor Cyan
  Write-Host "Se a Solides pedir CAPTCHA ou verificacao em duas etapas, conclua na janela do navegador." -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    & node --experimental-strip-types worker/tangerino/windows.ts
  } finally { Pop-Location }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
