<#
.SYNOPSIS
  Prepara o computador do DP para rodar o worker do Agente Tangerino.

.DESCRIPTION
  Depois desta instalação, a rotina diária não exige nenhum comando: o worker
  sobe sozinho quando a pessoa entra na conta do Windows e fica drenando a fila.

  O que o script faz, nesta ordem, parando no primeiro problema:

    1. confere os requisitos (Node, Git, versao do Windows, espaco em disco);
    2. confere o arquivo de ambiente e recusa os campos vazios que impedem o
       worker de subir, em vez de deixar ele morrer no primeiro ciclo;
    3. cria o diretorio de perfil do navegador com permissao so para a conta
       que vai rodar o worker — ele contem cookies autenticados da Solides;
    4. instala as dependencias e o Chromium do Playwright;
    5. testa a conexao com o banco antes de prometer qualquer coisa;
    6. registra a tarefa agendada que sobe o worker no logon.

  O worker roda com janela visivel de proposito. Quando a Solides pedir CAPTCHA
  ou verificacao em duas etapas, alguem precisa ver a tela e concluir o acesso —
  um worker invisivel travaria sem que ninguem soubesse por que.

.PARAMETER EnvFile
  Caminho do .env.tangerino-worker.local. Padrao: na raiz do repositorio.

.PARAMETER SkipBrowserInstall
  Pula o download do Chromium. Use so quando ele ja foi instalado antes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-tangerino-worker.ps1
#>
[CmdletBinding()]
param(
  [string]$EnvFile,
  [switch]$SkipBrowserInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot ".env.tangerino-worker.local" }

function Write-Step([string]$Message) { Write-Host "`n== $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "   OK  $Message" -ForegroundColor Green }
function Fail([string]$Message)       { Write-Host "   ERRO $Message" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 1. Requisitos
# ---------------------------------------------------------------------------
Write-Step "Conferindo os requisitos"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js nao encontrado. Instale a versao 24 ou superior e abra um novo PowerShell." }
$nodeMajor = [int](((& node --version) -replace "^v", "") -split "\.")[0]
if ($nodeMajor -lt 24) { Fail "Node.js $nodeMajor encontrado; o worker exige 24 ou superior." }
Write-Ok "Node.js $(& node --version)"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "Git nao encontrado." }
Write-Ok "Git presente"

# O Chromium do Playwright e o perfil persistente ocupam alguns GB. Descobrir
# isso no meio do download deixa a instalacao pela metade.
$systemDrive = (Get-Item $repoRoot).PSDrive.Name
$freeGb = [math]::Round((Get-PSDrive $systemDrive).Free / 1GB, 1)
if ($freeGb -lt 5) { Fail "Espaco livre insuficiente em ${systemDrive}: ${freeGb} GB. Sao necessarios ao menos 5 GB." }
Write-Ok "Espaco livre: ${freeGb} GB"

# ---------------------------------------------------------------------------
# 2. Ambiente
# ---------------------------------------------------------------------------
Write-Step "Conferindo o arquivo de ambiente"

if (-not (Test-Path $EnvFile)) {
  $exemplo = Join-Path $repoRoot ".env.tangerino-worker.example"
  Fail "Arquivo nao encontrado: $EnvFile`n        Copie o modelo e preencha: copy `"$exemplo`" `"$EnvFile`""
}

$env:PATHEXT = $env:PATHEXT  # evita aviso de variavel nao usada em modo estrito
$config = @{}
# ANSI por padrao no PowerShell 5.1 estragaria um caminho de perfil acentuado.
foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
  if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
  $name, $value = $line -split "=", 2
  $config[$name.Trim()] = $value.Trim()
}

$obrigatorios = @(
  "DATABASE_URL", "FDP_APP_URL", "FDP_TANGERINO_PROFILE_ROOT",
  "FDP_TANGERINO_INTERACTIVE_AUTH", "TANGERINO_BROWSER_AGENT_ENABLED"
)
foreach ($chave in $obrigatorios) {
  if (-not $config.ContainsKey($chave) -or [string]::IsNullOrWhiteSpace($config[$chave])) {
    Fail "$chave esta vazio em $EnvFile."
  }
}
# O cofre aceita a chave unica ou o mapa de versoes; exigir as duas recusaria
# uma configuracao valida.
if ([string]::IsNullOrWhiteSpace($config["FDP_TANGERINO_VAULT_KEY"]) -and
    [string]::IsNullOrWhiteSpace($config["FDP_TANGERINO_VAULT_KEYS"])) {
  Fail "Defina FDP_TANGERINO_VAULT_KEY ou FDP_TANGERINO_VAULT_KEYS."
}
if ($config["FDP_TANGERINO_INTERACTIVE_AUTH"] -ne "true") {
  Fail "FDP_TANGERINO_INTERACTIVE_AUTH precisa ser true: sem janela visivel, um CAPTCHA trava o worker em silencio."
}
Write-Ok "Campos obrigatorios preenchidos"

# ---------------------------------------------------------------------------
# 3. Perfil do navegador
# ---------------------------------------------------------------------------
Write-Step "Preparando o perfil do navegador"

$profileRoot = $config["FDP_TANGERINO_PROFILE_ROOT"]
if (-not (Test-Path $profileRoot)) { New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null }

# O diretorio guarda cookies autenticados da Solides. Herdar as permissoes da
# pasta pai deixaria qualquer conta da maquina ler a sessao do DP.
$acl = Get-Acl $profileRoot
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
foreach ($identidade in @($env:USERNAME, "SYSTEM", "Administrators")) {
  try {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identidade, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
  } catch { Write-Host "   aviso: nao foi possivel conceder acesso a $identidade" -ForegroundColor Yellow }
}
Set-Acl -Path $profileRoot -AclObject $acl
Write-Ok "Perfil em $profileRoot, restrito a $env:USERNAME"

# ---------------------------------------------------------------------------
# 4. Dependencias
# ---------------------------------------------------------------------------
Write-Step "Instalando dependencias"
Push-Location $repoRoot
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) { Fail "npm ci falhou." }
  Write-Ok "Dependencias instaladas"

  if (-not $SkipBrowserInstall) {
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Fail "Instalacao do Chromium falhou." }
    Write-Ok "Chromium instalado"
  }
} finally { Pop-Location }

# ---------------------------------------------------------------------------
# 5. Banco
# ---------------------------------------------------------------------------
Write-Step "Testando a conexao com o banco"
Push-Location $repoRoot
try {
  $env:DATABASE_URL = $config["DATABASE_URL"]
  $env:FDP_DB_DRIVER = "pg"
  & node --experimental-strip-types scripts/windows/check-tangerino-worker.mts
  if ($LASTEXITCODE -ne 0) { Fail "O worker nao consegue falar com o banco. Confira DATABASE_URL e a rede." }
  Write-Ok "Banco alcancavel"
} finally { Pop-Location }

# ---------------------------------------------------------------------------
# 6. Tarefa agendada
# ---------------------------------------------------------------------------
Write-Step "Registrando o inicio automatico"

$taskName = "Vinculato - Agente Tangerino"
$runner = Join-Path $repoRoot "scripts\windows\start-tangerino-worker.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Normal -File `"$runner`"" `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Interativo, e nao servico: o worker precisa de uma area de trabalho para
# mostrar o navegador quando a Solides pedir CAPTCHA ou MFA.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Write-Ok "Tarefa `"$taskName`" registrada para o logon de $env:USERNAME"

Write-Host @"

Instalacao concluida.

  * O worker sobe sozinho no proximo logon desta conta Windows.
  * Para subir agora sem reiniciar:  Start-ScheduledTask -TaskName "$taskName"
  * Para acompanhar:                 Get-ScheduledTask -TaskName "$taskName"
  * Para parar:                      Stop-ScheduledTask -TaskName "$taskName"

O que ele NAO faz, e precisa ficar claro para quem opera:

  * com o computador desligado ou suspenso, nenhuma admissao e consultada;
  * sem rede, o worker fica de pe e a fila acumula ate a conexao voltar;
  * quando a Solides pedir CAPTCHA ou verificacao em duas etapas, a janela do
    navegador espera uma pessoa. O painel do Vinculato avisa nesse caso.

No painel, em Agentes, confira "Worker" para ver disponibilidade, ultima
comunicacao e fila pendente.
"@ -ForegroundColor White
