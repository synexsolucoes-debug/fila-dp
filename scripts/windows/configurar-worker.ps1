<#
.SYNOPSIS
  Monta o .env.tangerino-worker.local perguntando os valores, em vez de pedir
  que alguém edite um arquivo de configuração à mão.

.DESCRIPTION
  Editar o arquivo no Bloco de Notas falha de três jeitos que ninguém vê na
  hora, e todos os três só aparecem depois, longe da causa:

    * o Bloco de Notas salva como `.env.tangerino-worker.local.txt`, e o worker
      não encontra nada;
    * `Out-File -Encoding UTF8` do PowerShell 5.1 grava BOM, e a primeira chave
      do arquivo vira `<BOM>DATABASE_URL` — o leitor não a reconhece, e o erro
      diz "DATABASE_URL vazio" sobre uma linha que está visivelmente preenchida;
    * a chave do cofre colada pela metade passa na instalação e só quebra na
      primeira consulta, quando o worker tenta abrir a credencial da Sólides.

  Este script cuida dos três: grava UTF-8 sem BOM, com o nome exato, e confere
  cada valor antes de escrever.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\configurar-worker.ps1
#>
[CmdletBinding()]
param([switch]$Forcar)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$destino = Join-Path $repoRoot ".env.tangerino-worker.local"

function Titulo([string]$texto) { Write-Host "`n$texto" -ForegroundColor Cyan }
function Ok([string]$texto) { Write-Host "  OK  $texto" -ForegroundColor Green }
function Aviso([string]$texto) { Write-Host "  !   $texto" -ForegroundColor Yellow }

if ((Test-Path $destino) -and -not $Forcar) {
  Aviso "Ja existe um $destino."
  $resposta = Read-Host "Sobrescrever? (s/N)"
  if ($resposta -notmatch '^[sS]') { Write-Host "Nada foi alterado."; exit 0 }
}

Write-Host @"
Configuracao do worker do Agente Tangerino

Voce vai precisar de tres valores, todos na Vercel:
  Projeto -> Settings -> Environment Variables -> ambiente Production

Nada do que voce digitar aqui sai deste computador.
"@ -ForegroundColor White

# ---------------------------------------------------------------------------
# 1. Banco
# ---------------------------------------------------------------------------
Titulo "1/3 - Conexao com o banco"
Write-Host "  Copie DATABASE_URL (pode estar como POSTGRES_URL ou NEON_DATABASE_URL)."
do {
  $databaseUrl = (Read-Host "  DATABASE_URL").Trim()
  $valido = $databaseUrl.StartsWith("postgres")
  if (-not $valido) { Aviso "Precisa comecar com postgres:// ou postgresql://." }
} while (-not $valido)
Ok "Conexao registrada."

# ---------------------------------------------------------------------------
# 2. Endereco do painel
# ---------------------------------------------------------------------------
Titulo "2/3 - Endereco do painel em producao"
Write-Host "  O mesmo endereco que voce usa no navegador, comecando com https://"
do {
  $appUrl = (Read-Host "  FDP_APP_URL").Trim().TrimEnd("/")
  $valido = $appUrl -match '^https://[^/\s?#]+$'
  if (-not $valido) { Aviso "Informe so o endereco, sem caminho: https://exemplo.vercel.app" }
} while (-not $valido)
Ok "Endereco registrado."

# ---------------------------------------------------------------------------
# 3. Cofre
# ---------------------------------------------------------------------------
Titulo "3/3 - Chave do cofre do Agente Tangerino"
Write-Host "  Na Vercel, em Settings > Environment Variables, procure primeiro"
Write-Host "  FDP_TANGERINO_VAULT_KEYS (no PLURAL) e copie o valor INTEIRO,"
Write-Host "  com as chaves { } e todas as versoes."
Write-Host ""
Write-Host "  So use FDP_TANGERINO_VAULT_KEY (no singular) se o plural nao existir la:"
Write-Host "  o singular registra SOMENTE a versao 1, e nao abre credencial selada"
Write-Host "  depois de uma rotacao de chave." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Sem o valor agora? Deixe em branco: o script segue, grava o arquivo"
Write-Host "  e avisa o que falta. Ctrl+C sai a qualquer momento."

<#
  A chave precisa decodificar para 32 bytes — e conferir isso aqui vale muito:
  uma chave truncada passa pela instalacao inteira e so falha na primeira
  consulta, quando o worker tenta abrir a credencial cifrada pelo aplicativo.
  Naquele momento a causa ja esta a uma hora de distancia do sintoma.
#>
function Chave32Bytes([string]$valor) {
  if ([string]::IsNullOrWhiteSpace($valor)) { return $false }
  $texto = $valor.Trim()
  if ($texto -match '^[0-9a-fA-F]{64}$') { return $true }
  try { return ([System.Convert]::FromBase64String($texto)).Length -eq 32 } catch { return $false }
}

<#
  Sem laco sem saida.

  A primeira versao deste bloco insistia ate receber um valor valido, e quem
  nao tivesse a chave em maos ficava preso: "Enter para pular" levava ao mapa
  JSON, onde Enter tambem era invalido. Nao havia terceira porta.

  Agora existe: seguir sem a chave, com o arquivo gravado e o aviso do que
  falta. O worker recusa subir sem ela de qualquer forma — melhor descobrir
  isso com o arquivo pronto e uma frase dizendo o que fazer do que num laco
  que so termina em Ctrl+C.
#>
$vaultKey = ""
$vaultKeys = ""
$configurado = $false

<#
  O mapa vem primeiro, e nao a chave unica.

  A ordem anterior perguntava pelo singular antes, e era uma armadilha: quem
  copiava a chave certa do deployment para a variavel errada ficava com um
  arquivo que parece completo e nao abre nada. FDP_TANGERINO_VAULT_KEY registra
  somente a versao 1 — num deployment ja rotacionado, a credencial esta selada
  na versao 2 e o worker falha sem nunca dizer por que.
#>
for ($tentativa = 1; $tentativa -le 3 -and -not $configurado; $tentativa++) {
  $vaultKeys = (Read-Host "  FDP_TANGERINO_VAULT_KEYS (o mapa, comecando com {)").Trim()

  if (-not [string]::IsNullOrWhiteSpace($vaultKeys)) {
    if ($vaultKeys.StartsWith("{") -and $vaultKeys.EndsWith("}")) { $configurado = $true; break }
    Aviso "O mapa precisa ser um JSON inteiro, como {`"1`":`"...`",`"2`":`"...`"}."
    $vaultKeys = ""
    continue
  }

  # Campo vazio: so oferecer a chave unica a quem disser que e esse o caso la.
  Write-Host "  O deployment nao tem o plural, so FDP_TANGERINO_VAULT_KEY (no singular)?"
  $usaSingular = Read-Host "  (s = sim / n = nao tenho o valor agora)"
  if ($usaSingular -match '^[sS]') {
    $vaultKey = (Read-Host "  FDP_TANGERINO_VAULT_KEY").Trim()
    if (Chave32Bytes $vaultKey) { $configurado = $true; break }
    Aviso "Essa chave nao decodifica para 32 bytes. Copiou inteira, sem espacos?"
    $vaultKey = ""
    continue
  }

  break
}

if (-not $configurado) {
  Aviso "Seguindo SEM a chave do cofre."
  Write-Host @"

  O arquivo sera gravado assim mesmo, com o campo em branco, e o worker vai
  recusar subir ate ele ser preenchido. Isso e proposital: sem a chave ele nao
  consegue abrir a credencial da Solides.

  Onde encontrar, quando puder:
    Vercel -> seu projeto -> Settings -> Environment Variables -> Production
    Procure FDP_TANGERINO_VAULT_KEYS (no plural) primeiro; o singular so serve
    a deployment que nunca rotacionou a chave.

  Se nenhuma das duas existir la, a chave ainda nao foi criada no deployment —
  e ai o worker nao tem como funcionar em nenhuma maquina. Fale com quem
  administra a plataforma antes de seguir.

  Para preencher depois, rode este script de novo:
    powershell -ExecutionPolicy Bypass -File scripts\windows\configurar-worker.ps1

"@ -ForegroundColor Yellow
}

$versao = (Read-Host "  FDP_TANGERINO_VAULT_KEY_VERSION (Enter para 1)").Trim()
if ([string]::IsNullOrWhiteSpace($versao)) { $versao = "1" }

# ---------------------------------------------------------------------------
# Escrita
# ---------------------------------------------------------------------------
$conteudo = @"
# Gerado por scripts\windows\configurar-worker.ps1. Nunca versione este arquivo.

DATABASE_URL=$databaseUrl
FDP_APP_URL=$appUrl

FDP_TANGERINO_VAULT_KEY=$vaultKey
FDP_TANGERINO_VAULT_KEY_VERSION=$versao
FDP_TANGERINO_VAULT_KEYS=$vaultKeys

FDP_TANGERINO_WORKER_MODE=persistent
TANGERINO_BROWSER_AGENT_ENABLED=true
TANGERINO_BROWSER_CONCURRENCY=1
TANGERINO_BROWSER_TIMEOUT_MS=300000
FDP_TANGERINO_WORKER_POLL_MS=5000

FDP_TANGERINO_PROFILE_ROOT=C:\ProgramData\Vinculato\TangerinoProfiles
FDP_TANGERINO_INTERACTIVE_AUTH=true
FDP_TANGERINO_INTERACTIVE_AUTH_TIMEOUT_MS=600000

FDP_TANGERINO_BROWSER_ALLOWED_HOSTS=
FDP_TANGERINO_CHROMIUM_SANDBOX=false
"@

# UTF-8 SEM BOM. Com BOM, a primeira chave do arquivo vira `<BOM>DATABASE_URL`,
# o leitor nao a reconhece, e o erro acusa uma linha que esta preenchida.
[System.IO.File]::WriteAllText($destino, $conteudo, (New-Object System.Text.UTF8Encoding($false)))

# O arquivo carrega a conexao do banco e a chave do cofre. Herdar as permissoes
# da pasta deixaria qualquer conta da maquina le-lo.
try {
  $acl = Get-Acl $destino
  $acl.SetAccessRuleProtection($true, $false)
  $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
  foreach ($identidade in @($env:USERNAME, "SYSTEM", "Administrators")) {
    try {
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identidade, "FullControl", "None", "None", "Allow")))
    } catch { }
  }
  Set-Acl -Path $destino -AclObject $acl
  Ok "Acesso restrito a $env:USERNAME."
} catch {
  Aviso "Nao foi possivel restringir o acesso ao arquivo. Confira as permissoes a mao."
}

Write-Host @"

Arquivo criado: $destino

Proximo passo:
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-tangerino-worker.ps1
"@ -ForegroundColor White
