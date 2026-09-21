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

  Este script nunca termina em silencio. Toda parada — requisito ausente,
  ambiente incompleto, erro do proprio worker — escreve a causa na tela, grava
  em %LOCALAPPDATA%\Vinculato\worker-tangerino.log e segura a janela aberta.
  A janela que fecha sozinha e o pior defeito possivel aqui: quem opera fica
  sem nada para ler e sem nada para tentar.

.PARAMETER EnvFile
  Caminho do .env.tangerino-worker.local. Padrao: na raiz do repositorio.

.PARAMETER NoPause
  Nao segura a janela no fim. Para execucao automatizada, onde ninguem le.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\start-tangerino-worker.ps1
#>
[CmdletBinding()]
param(
  [string]$EnvFile,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"
# No PowerShell 7.4 um comando nativo que sai com codigo diferente de zero vira
# excecao por causa do ErrorActionPreference acima. Aqui isso atrapalha: o codigo
# de saida do worker e justamente o que queremos ler e explicar.
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot ".env.tangerino-worker.local" }

$logDir = Join-Path $env:LOCALAPPDATA "Vinculato"
$logFile = Join-Path $logDir "worker-tangerino.log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Registrar([string]$Texto) {
  # O arquivo existe para o caso de a janela ter fechado assim mesmo: uma
  # atualizacao futura, um encerramento do Windows, um antivirus.
  "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Texto | Add-Content -Path $logFile -Encoding UTF8
}

function Parar([string]$Titulo, [string[]]$Passos) {
  Write-Host ""
  Write-Host "  $Titulo" -ForegroundColor Red
  Registrar "FALHA: $Titulo"
  if ($Passos) {
    Write-Host ""
    Write-Host "  O que fazer:" -ForegroundColor Yellow
    foreach ($passo in $Passos) { Write-Host "    $passo" -ForegroundColor Yellow; Registrar "  -> $passo" }
  }
  Write-Host ""
  Write-Host "  Registro completo em: $logFile" -ForegroundColor DarkGray
  Segurar
  exit 1
}

function Segurar {
  if ($NoPause) { return }
  Write-Host ""
  Write-Host "  Pressione Enter para fechar esta janela." -ForegroundColor DarkGray
  try { [void](Read-Host) } catch {
    # Sem console interativo (tarefa agendada com entrada redirecionada) o
    # Read-Host falha na hora. Ai o que segura a janela e a espera limitada:
    # tempo de alguem ver a mensagem, sem prender a tarefa para sempre.
    Start-Sleep -Seconds 900
  }
}

Write-Host ""
Write-Host "  Worker do Agente Tangerino" -ForegroundColor Cyan
Write-Host "  Repositorio: $repoRoot" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# Requisitos que fazem o processo morrer antes da primeira linha de log
# ---------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Parar "Node.js nao encontrado neste PowerShell." @(
    "1. Instale o Node.js 24 ou superior: https://nodejs.org/en/download",
    "2. FECHE este PowerShell e abra outro (o PATH so muda em janela nova).",
    "3. Rode este script de novo."
  )
}

$versaoNode = (& node --version) -replace "^v", ""
$maiorNode = 0
[void][int]::TryParse(($versaoNode -split "\.")[0], [ref]$maiorNode)
if ($maiorNode -lt 24) {
  # O worker e TypeScript executado direto pelo Node. Em versao antiga o
  # processo morre no ato, com "bad option", e a janela fecha antes de qualquer
  # mensagem nossa — exatamente o sintoma que este bloco existe para evitar.
  Parar "Node.js $versaoNode encontrado; o worker exige a versao 24 ou superior." @(
    "1. Instale o Node.js 24 LTS: https://nodejs.org/en/download",
    "2. Confirme em uma janela nova:  node --version",
    "3. Rode este script de novo."
  )
}
Write-Host "  Node.js $versaoNode" -ForegroundColor DarkGray

if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
  Parar "As dependencias nao estao instaladas neste repositorio." @(
    "1. cd `"$repoRoot`"",
    "2. npm ci",
    "3. npx playwright install chromium"
  )
}

# ---------------------------------------------------------------------------
# Ambiente
# ---------------------------------------------------------------------------
if (-not (Test-Path $EnvFile)) {
  Parar "Arquivo de ambiente nao encontrado: $EnvFile" @(
    "Monte o arquivo respondendo as perguntas:",
    "  powershell -ExecutionPolicy Bypass -File `"$repoRoot\scripts\windows\configurar-worker.ps1`""
  )
}

$config = @{}
# -Encoding UTF8 e obrigatorio: o Windows PowerShell 5.1 le como ANSI por padrao
# e transformaria "C:\Users\Usuario" com acento num caminho que nao existe.
foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
  if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
  $name, $value = $line -split "=", 2
  $nome = $name.Trim()
  # Aspas ao redor do valor sao habito de quem edita .env a mao. Passa-las
  # adiante faria a string de conexao comecar com aspas e o Postgres recusar.
  $valor = $value.Trim() -replace '^\s*"(.*)"\s*$', '$1' -replace "^\s*'(.*)'\s*$", '$1'
  if ($nome) {
    $config[$nome] = $valor
    [System.Environment]::SetEnvironmentVariable($nome, $valor, "Process")
  }
}
$env:FDP_DB_DRIVER = "pg"

$faltando = @()
foreach ($chave in @("DATABASE_URL", "FDP_TANGERINO_PROFILE_ROOT")) {
  if ([string]::IsNullOrWhiteSpace($config[$chave])) { $faltando += $chave }
}
if ([string]::IsNullOrWhiteSpace($config["FDP_TANGERINO_VAULT_KEY"]) -and
    [string]::IsNullOrWhiteSpace($config["FDP_TANGERINO_VAULT_KEYS"])) {
  $faltando += "FDP_TANGERINO_VAULT_KEYS"
}
if ($config["FDP_TANGERINO_INTERACTIVE_AUTH"] -ne "true") { $faltando += "FDP_TANGERINO_INTERACTIVE_AUTH" }
if ($config["TANGERINO_BROWSER_AGENT_ENABLED"] -ne "true") { $faltando += "TANGERINO_BROWSER_AGENT_ENABLED" }

if ($faltando.Count -gt 0) {
  # A lista sai por nome de variavel. Nenhum valor vai para a tela nem para o
  # log: e aqui que moram a chave do cofre e a string de conexao.
  Parar ("Faltam campos no arquivo de ambiente: " + ($faltando -join ", ")) @(
    "1. Rode de novo o montador, que preenche o que falta:",
    "     powershell -ExecutionPolicy Bypass -File `"$repoRoot\scripts\windows\configurar-worker.ps1`"",
    "2. Se faltar a chave do cofre, ela precisa ser a MESMA do deployment",
    "   (Vercel > Settings > Environment Variables > FDP_TANGERINO_VAULT_KEYS).",
    "   Uma chave nova nao abre o que ja foi guardado com a antiga.",
    "3. Arquivo conferido: $EnvFile"
  )
}

$profileRoot = $config["FDP_TANGERINO_PROFILE_ROOT"]
if (-not (Test-Path $profileRoot)) { New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null }

# ---------------------------------------------------------------------------
# Instancia unica
# ---------------------------------------------------------------------------
# O nome do mutex deriva do perfil: dois workers com perfis diferentes podem
# conviver, dois com o mesmo perfil nao.
$chave = [System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes($profileRoot.ToLowerInvariant()))).Replace("-", "").Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($false, "Global\VinculatoTangerinoWorker-$chave")

if (-not $mutex.WaitOne(0)) {
  Write-Host ""
  Write-Host "  Ja existe um worker rodando com este perfil. Nada a fazer." -ForegroundColor Yellow
  Write-Host "  Procure a outra janela do PowerShell, ou pare a tarefa:" -ForegroundColor DarkGray
  Write-Host "    Stop-ScheduledTask -TaskName `"Vinculato - Agente Tangerino`"" -ForegroundColor DarkGray
  Registrar "Ja havia worker ativo para este perfil."
  Segurar
  exit 0
}

try {
  Write-Host ""
  Write-Host "  Worker iniciando. Deixe esta janela aberta." -ForegroundColor Cyan
  Write-Host "  Se a Solides pedir CAPTCHA ou verificacao em duas etapas," -ForegroundColor Cyan
  Write-Host "  conclua na janela do navegador que abrir." -ForegroundColor Cyan
  Write-Host ""
  Registrar "Worker iniciado (Node $versaoNode)."

  Push-Location $repoRoot
  try {
    # O worker precisa do tsx, e nao do --experimental-strip-types do Node: o
    # codigo do Vinculato importa diretorios ("../db") e o atalho "@/db", que o
    # resolvedor do Node recusa com ERR_UNSUPPORTED_DIR_IMPORT antes de executar
    # a primeira linha. Era essa a janela que abria e fechava na mesma hora.
    # E o mesmo comando de "npm run worker:tangerino:windows".
    & node --import tsx worker/tangerino/windows.ts
    $codigo = $LASTEXITCODE
  } finally { Pop-Location }

  if ($codigo -ne 0) {
    # A causa ja foi impressa pelo proprio worker (falta de configuracao sai em
    # texto; o resto, como evento estruturado). O que este bloco acrescenta e
    # nao deixar a janela fechar por cima dela.
    Parar "O worker parou com erro (codigo $codigo). A causa esta nas linhas acima." @(
      "1. Leia a ultima mensagem impressa antes desta.",
      "2. Falta de configuracao: rode configurar-worker.ps1 e suba de novo.",
      "3. Falha de banco ou rede: confira DATABASE_URL e a conexao.",
      "4. Persistindo, guarde o conteudo desta janela para analise."
    )
  }

  Write-Host ""
  Write-Host "  Worker encerrado normalmente." -ForegroundColor Green
  Registrar "Worker encerrado normalmente."
  Segurar
} catch {
  Parar "Falha ao executar o worker: $($_.Exception.Message)" @(
    "1. Confirme que voce esta no repositorio: $repoRoot",
    "2. Confirme as dependencias:  npm ci",
    "3. Rode este script de novo."
  )
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
