# Worker Tangerino no Windows, com autenticação assistida

Este modo substitui o runner efêmero do GitHub Actions por um navegador visível
em uma máquina controlada pela empresa. Ele **não resolve nem contorna CAPTCHA**:
quando o Tangerino pedir uma confirmação, uma pessoa conclui o login na janela e
o perfil guarda a sessão para as próximas consultas.

## Interface validada

O caminho de leitura foi confirmado em uma sessão real e autorizada em
24/08/2026: **Admissão → Visão geral**, com a aplicação de admissões carregada
do host oficial `admissao-demissao.tangerino.com.br` dentro de um iframe.

O worker usa somente a busca **Digite o nome** e lê, no cartão retornado,
**Status da admissão** e **Status da etapa**. Ele não abre ficha, documentos,
calendário, lembrete nem menu de ações. A tela não expõe protocolo nem data
efetiva de admissão no cartão; esses campos ficam vazios em vez de usar a
posição visual ou a "Data limite para a admissão" como substituto.

## Segurança antes de começar

- Use uma conta Windows dedicada e uma máquina com disco criptografado.
- Restrinja `C:\ProgramData\Vinculato\TangerinoProfiles` a essa conta: o diretório
  contém cookies autenticados.
- O arquivo `.env.tangerino-worker.local` contém acesso ao banco e ao cofre. Não
  envie esse arquivo, não o coloque em pasta sincronizada e não o versione.
- Cada workspace recebe um diretório derivado por hash. Cookies nunca são
  compartilhados entre clientes.

## Instalação

1. Instale Node.js 24 e baixe este repositório na máquina dedicada.
2. No diretório do projeto, execute:

   ```powershell
   npm ci
   npx playwright install chromium
   Copy-Item .env.tangerino-worker.example .env.tangerino-worker.local
   ```

3. Preencha `.env.tangerino-worker.local` com `DATABASE_URL` e a chave ou mapa de
   chaves `FDP_TANGERINO_VAULT_*` usados pelo Agente Tangerino no deployment.
   Usuário e senha do Tangerino não ficam nesse arquivo; continuam cifrados no
   cofre do Vinculato.
4. Na Vercel, defina `FDP_TANGERINO_WORKER_MODE=persistent` em produção. Assim o
   backend mantém a consulta na fila para este worker e não dispara GitHub
   Actions. Não remova o token compartilhado do Sankhya.
5. Inicie o processo em uma sessão Windows visível:

   ```powershell
   npm run worker:tangerino:windows
   ```

## Primeiro teste

1. Deixe o worker aberto.
2. No Vinculato, acione **Agente Tangerino → Testar login**.
3. O worker encontra o teste em até cinco segundos e abre o Chromium.
4. Se aparecer CAPTCHA ou MFA, conclua **todo o login** manualmente nessa janela.
5. O worker continua sozinho, fecha o navegador e preserva a sessão no perfil.
6. Confira se o card muda de **Teste pendente** para **Pronto**.

Se o prazo de dez minutos terminar, o teste falha sem repetir a senha. Inicie um
novo teste quando puder acompanhar a janela. Se o Tangerino invalidar a sessão
depois, o próximo trabalho abrirá novamente a janela para renovação manual.

## Operação contínua

Depois do primeiro teste, mantenha `npm run worker:tangerino:windows` rodando na
conta Windows dedicada. Para produção, registre esse comando em uma tarefa do
Agendador do Windows disparada **ao entrar na conta**, pois o navegador precisa
de uma sessão gráfica quando houver desafio humano. Não configure a tarefa para
“Executar independentemente de o usuário estar conectado”.


## Instalação em um comando, e o que ela garante

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tangerino-worker.ps1
```

O script para no primeiro problema em vez de terminar com "concluído" e deixar o
worker morrer no primeiro ciclo. Ele confere, nesta ordem: Node 24+, Git, espaço
em disco, os campos obrigatórios do `.env.tangerino-worker.local`, cria o
diretório de perfil com permissão restrita à conta que vai operar, instala as
dependências e o Chromium, **testa a conexão com o banco** e só então registra a
tarefa agendada.

A conferência de banco (`scripts/windows/check-tangerino-worker.mts`) responde
uma pergunta estreita e útil: este computador fala com o Vinculato e enxerga a
fila? Sem ela, uma senha errada ou uma porta fechada só apareceria pelo que
*não* acontecia — a pior forma de descobrir.

### Depois disso, a rotina diária não tem comando

O worker sobe sozinho no logon da conta Windows. Para subir agora:

```powershell
Start-ScheduledTask -TaskName "Vinculato - Agente Tangerino"
```

A tarefa roda **interativa**, e não como serviço: quando a Sólides pedir CAPTCHA
ou verificação em duas etapas, alguém precisa ver a janela do navegador e
concluir o acesso. Um worker invisível travaria sem que ninguém soubesse por quê.

### Uma instância por perfil

`start-tangerino-worker.ps1` usa um mutex nomeado do Windows derivado do caminho
do perfil. Duas instâncias sobre o mesmo perfil brigam pelo diretório de sessão
do Chromium e corrompem os cookies — o sintoma seria pedir login de novo a cada
ciclo, sem explicação.

O mutex, e não um arquivo de lock: arquivo sobrevive a um encerramento abrupto e
deixa o worker sem subir na vez seguinte, exigindo limpeza manual. O mutex morre
com o processo.

## O que o worker NÃO faz

Isto precisa estar claro para quem opera, porque nenhuma tela pode compensar:

- **computador desligado ou suspenso** — nenhuma admissão é consultada. Não há
  execução remota; o worker é este processo, nesta máquina;
- **sem rede** — o worker fica de pé e a fila acumula até a conexão voltar;
- **sessão do Windows encerrada** — a tarefa é de logon; deslogar derruba o
  worker;
- **CAPTCHA ou verificação em duas etapas** — o navegador espera uma pessoa, e o
  painel do Vinculato passa a mostrar *aguardando autenticação*.

## Saúde do worker ≠ saúde do agendamento

O painel mostra as duas separadamente, porque as causas são opostas e o remédio
também:

| Sintoma | Causa provável | Quem resolve |
| --- | --- | --- |
| Worker mudo, fila cheia | Computador desligado, suspenso ou sem rede | Quem está perto da máquina |
| Worker ativo, fila vazia, agendamento atrasado | O cron do servidor parou de enfileirar | Quem cuida do servidor |
| Worker ativo pedindo autenticação | A Sólides pediu CAPTCHA/MFA | Quem opera o DP |
| Worker ativo, fila vazia, agendamento em dia | Não há admissão pendente | Ninguém — está tudo certo |

O batimento é **gravado pelo worker**, não inferido do último trabalho
concluído. Inferir vida a partir de trabalho confundiria "está parado" com "não
tinha o que fazer": um worker saudável num dia sem admissões ficaria
indistinguível de um worker morto, e o alarme apareceria justamente quando não há
problema nenhum.

O identificador do worker deriva do nome da máquina por HMAC e nunca aparece em
claro: hostname de estação costuma carregar o nome de quem a usa, e isso ficaria
visível para todo o grupo. `FDP_TANGERINO_WORKER_ID` permite escolher um nome
próprio quando o operador quiser reconhecê-lo.
