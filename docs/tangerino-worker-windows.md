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


## Instalação em dois comandos

Primeiro a configuração, que monta o `.env.tangerino-worker.local` perguntando
os três valores em vez de pedir edição à mão:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\configurar-worker.ps1
```

Ela existe porque editar o arquivo no Bloco de Notas falha de três jeitos
invisíveis: o nome salvo como `.local.txt`, o BOM que o PowerShell 5.1 grava e
que faz a primeira chave virar `<BOM>DATABASE_URL`, e a chave do cofre colada
pela metade — esta última passa a instalação inteira e só quebra na primeira
consulta, a uma hora de distância da causa. O script confere os três.

Depois a instalação:

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

## Quando a janela do worker abre e fecha na mesma hora

Esse era o sintoma de dois defeitos distintos, e os dois estão fechados:

1. **O comando de execução estava errado.** O script chamava
   `node --experimental-strip-types worker/tangerino/windows.ts`. O código do
   Vinculato importa diretórios (`../db`) e o atalho `@/db`, que o resolvedor de
   módulos do Node recusa com `ERR_UNSUPPORTED_DIR_IMPORT` — antes de executar a
   primeira linha, sem chance de imprimir nada. O worker sobe com
   `node --import tsx`, o mesmo comando de `npm run worker:tangerino:windows`.
2. **A parada não chegava a ninguém.** Faltando uma variável, o worker
   encerrava com um evento estruturado que guarda só o nome do erro — a
   mensagem, que é a lista das variáveis, ficava de fora de propósito, porque
   mensagem de falha de navegação carrega URL com identificador de colaborador.
   Falta de configuração passou a ser a exceção: ela sai em texto, com o nome de
   cada variável e o que fazer, e nunca com o valor de nenhuma delas.

O `start-tangerino-worker.ps1` agora também:

* confere Node, dependências e arquivo de ambiente **antes** de chamar o worker,
  porque cada um desses some sem deixar mensagem quando falha;
* segura a janela aberta em qualquer saída, com `Pressione Enter para fechar`;
* grava tudo em `%LOCALAPPDATA%\Vinculato\worker-tangerino.log`, para o caso de
  a janela fechar assim mesmo — atualização, desligamento, antivírus.

Se a janela ainda fechar sem nada na tela, o log responde por quê:

```powershell
Get-Content "$env:LOCALAPPDATA\Vinculato\worker-tangerino.log" -Tail 40
```

## O worker está de pé e não consulta nada

É o estado mais confuso que existe aqui: parece falha, mas não tem mensagem. A
fila depende de uma corrente, e **cada elo vazio produz o mesmo silêncio**:

```
módulo liberado → integração cadastrada → credencial que abre com a chave
deste computador → colaboradores → vínculo com o Tangerino → candidatos da
varredura → fila
```

Um comando percorre a corrente e diz qual é o primeiro elo vazio:

```powershell
npm run tangerino:diagnostico
```

Ele só lê. Não enfileira, não consulta o Tangerino e não escreve nada. E abre a
credencial guardada — sem mostrar o conteúdo — porque é o único jeito de provar
que `FDP_TANGERINO_VAULT_KEYS` neste computador é a mesma chave que selou o
segredo. Uma chave errada deixa o worker subir normalmente e falhar só na hora
de entrar na Sólides, ciclo após ciclo.

### O elo que não se preenche sozinho

A varredura automática só enxerga quem já tem vínculo com o Tangerino
(`fdp_employee_external_refs` com `source = 'tangerino'`), e esse vínculo é
gravado pela **primeira consulta bem-sucedida** — `saveExternalReference`, em
`lib/tangerino/agent.ts`. Numa instalação nova ele não existe para ninguém.

Consequência prática, e ela precisa estar escrita: **a automação não começa
sozinha**. Alguém abre a ficha de um colaborador no Vinculato e pede a consulta
ao Tangerino uma vez. Dali em diante ele entra nas varreduras seguintes sem
ninguém lembrar dele.

O importador do Sankhya não resolve isso: ele grava vínculo com
`source = 'sankhya'`, que é outro sistema e outro identificador.

### A armadilha da chave no singular

`FDP_TANGERINO_VAULT_KEY`, no singular, registra **somente a versão 1**
(`vaultKeys`, em `lib/integrations.ts`). Num deployment que já rotacionou a
chave, a credencial está selada na versão 2 — e aí a variável no singular não
abre nada, **mesmo com o conteúdo certo**. O worker sobe normalmente e falha só
na hora de entrar na Sólides.

O que vale no computador do worker é copiar `FDP_TANGERINO_VAULT_KEYS`, no
plural, inteiro, com todas as versões, exatamente como está no deployment. O
diagnóstico distingue os três casos e diz qual é:

| O que ele encontra | O que dizer a quem opera |
| --- | --- |
| Nenhuma chave | copie `FDP_TANGERINO_VAULT_KEYS` do deployment |
| Versão local ≠ versão da credencial | o singular só serve à versão 1; use o plural |
| Versão certa, conteúdo diferente | a chave não é a mesma que selou o segredo |

### Se a chave estiver marcada como "Sensitive" na Vercel

Uma variável de ambiente do tipo **Sensitive** é gravável, e não legível: depois
de salva, ninguém lê o valor de volta — nem pelo painel, nem pela API, nem com
`vercel env pull`. É a proteção funcionando como projetada, e ela cobra um preço
exatamente aqui, porque o worker roda fora da Vercel e precisa da chave em mãos.

Aparece como campo vazio no painel. Vazio ali não quer dizer "não configurado":
quer dizer "não te mostro".

Se ninguém guardou uma cópia quando a chave foi criada, ela não se recupera — e
o caminho é rotacionar. O alcance dessa rotação é pequeno e vale estar escrito:

| Prefixo | O que ele sela | A rotação do Tangerino afeta? |
| --- | --- | --- |
| `FDP_TANGERINO_*` | o login da Sólides guardado em `fdp_integration_credentials`, e as assinaturas efêmeras do worker | **sim** |
| `FDP_INTEGRATION_*` | as fichas de contratação (`lib/admission-sheet.ts`) e os pagamentos (`lib/payments.ts`), que chamam `currentVaultKey()` sem canal | não |
| `FDP_SANKHYA_*` | o acesso ao Sankhya | não |

Ou seja: rotacionar a chave do Tangerino invalida **só** o login da Sólides
guardado, que se resolve digitando usuário e senha de novo no painel. Ficha de
contratação e dados de pagamento não são tocados.

Ao rotacionar, três detalhes que fazem a diferença entre funcionar e falhar em
silêncio:

1. guarde a chave nova em algum lugar antes de salvar — a Vercel não devolve;
2. `FDP_TANGERINO_VAULT_KEY_VERSION` precisa apontar para uma versão que exista
   no mapa novo. Se ela ficar em `2` e o mapa passar a ter só `3`,
   `currentVaultKey` pede a versão 2, não acha e falha na hora de salvar a
   credencial;
3. mudança de variável só vale no próximo deployment. Publique antes de
   regravar o acesso da Sólides.
