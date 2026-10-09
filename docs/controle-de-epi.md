# Controle de EPI

Módulo operacional que acompanha a jornada completa do equipamento de proteção
individual: cadastro, entrega ao colaborador, troca por danificação, devolução,
higienização, descarte e análise de possível desconto.

O módulo combina estoque operacional compartilhado e **rastreabilidade**: quem
recebeu o quê, quando, com qual CA, de qual local saiu, em que condição
devolveu, quem concluiu a higienização, quem autorizou o descarte e quem decidiu
sobre o desconto — com evidência anexada em cada etapa.

O SKU e o saldo pertencem ao workspace. A empresa do cadastro é apenas a origem
da compra; a empresa consumidora fica em cada entrega, devolução, dano,
descarte e movimentação. Assim, empresas do mesmo grupo usam o mesmo estoque
sem duplicar o produto por CNPJ.

## A regra que governa o módulo

**Desconto de EPI nunca é lançado automaticamente.**

Extravio, não devolução, dano por uso inadequado e solicitação manual abrem uma
*análise* — nunca um débito. A análise vira uma demanda no quadro do
Departamento Pessoal, com o título fixado pela especificação:

```
Analisar possível desconto de EPI — [Nome do colaborador]
```

O valor fica registrado como "em análise" até que alguém com
`epi.discount.analyze` decida. "Descontar integral" e "descontar parcialmente"
criam uma movimentação `epi_discount` em estado `draft` na Central de
Movimentações, com a competência e o valor aprovado. Essa movimentação é um
encaminhamento explícito: `automaticDeduction` permanece falso e nenhuma folha
ou salário é alterado automaticamente.

A separação está no banco, não só no código: `fdp_epi_discount_requests` aponta
para `fdp_cards` em vez de guardar um valor a descontar como fato consumado, e
dois `CHECK` recusam a decisão contraditória — aprovado para desconto com valor
zero, ou valor decidido acima do valor do próprio equipamento.

## O destino do EPI é consequência, não escolha

Na devolução, quem classifica a condição não marca "volta ao estoque". A
condição **determina** o destino, e a tela mostra a consequência antes de
gravar:

| Condição informada | Estoque | Higienização | Descarte | Demanda no DP |
| --- | --- | --- | --- | --- |
| Devolvido higienizado | volta | — | — | — |
| Devolvido pendente de higienização | — | sim | — | — |
| Devolvido danificado | — | — | sim | — |
| Devolvido inutilizado | — | — | sim | — |
| Devolvido para descarte | — | — | sim | — |
| Não devolvido | — | — | — | **sim** |
| Extraviado | — | — | — | **sim** |

A tabela vive em `returnRouting()` (`lib/epi.ts`), função pura usada pelo
servidor **e** pela tela. Uma segunda cópia divergiria, e a pessoa confirmaria
uma coisa enquanto outra aconteceria.

O mesmo vale para a troca por danificação, em `damageRouting()`:

| Decisão | Baixa do antigo | Descarte | Novo EPI | Demanda no DP |
| --- | --- | --- | --- | --- |
| Troca sem desconto | sim | sim | sim | — |
| Enviar para análise de desconto | sim | — | sim | **sim** |
| Recusar troca | — | — | — | — |
| Encaminhar para descarte | sim | sim | — | — |
| Encaminhar para higienização | sim | — | — | — |

"Recusar troca" não abre demanda: recusar a troca decide sobre o equipamento,
não sobre o salário. Quem quiser levar o caso ao DP abre a análise
explicitamente, e o registro da recusa fica como evidência.

## Estrutura de dados

A base do módulo está em `0044_epi_control.sql`; áreas, locais e o saldo
compartilhado são introduzidos por `0045_workspace_areas_shared_stock.sql`.

| Tabela | Papel |
| --- | --- |
| `fdp_epi_products` | Catálogo compartilhado de SKUs; `stock_quantity` é projeção compatível |
| `fdp_stock_locations` | Locais físicos do estoque do workspace |
| `fdp_stock_balances` | Fonte de verdade do saldo por SKU e local |
| `fdp_epi_deliveries` | Entrega ao colaborador, termo e baixa |
| `fdp_epi_returns` | Devolução, condição e destino |
| `fdp_epi_damages` | Ocorrência de dano, análise e decisão |
| `fdp_epi_disposals` | Janela de descarte |
| `fdp_epi_discount_requests` | Análise de desconto, ligada à demanda |
| `fdp_epi_movements` | Razão append-only de todas as movimentações |
| `fdp_epi_attachments` | Termos, fotos e evidências |
| `fdp_areas` | Áreas operacionais transversais às empresas |
| `fdp_area_members` | Vínculo N:N entre usuários e áreas, com área principal opcional |
| `fdp_area_module_assignments` | Roteamento de módulos para áreas responsáveis |

### O que o banco garante sozinho

Três invariantes ficam no schema porque não podem depender de disciplina de
quem escrever a próxima rota:

- **estoque nunca fica negativo** — `fdp_apply_stock_change` bloqueia o SKU com
  `FOR UPDATE` e aplica o delta em `fdp_stock_balances` somente quando o saldo do
  local continua não negativo. O evento operacional, o razão, o saldo e a
  auditoria são enviados no mesmo lote transacional;
- **`stock_quantity` não aceita escrita direta** — um gatilho restringe a
  coluna à projeção atualizada pela função de saldo;
- **devolução nunca soma mais do que foi entregue** — `CHECK` de
  `settled_quantity <= quantity`;
- **o razão é append-only** e **o descarte confirmado é imutável** — dois
  gatilhos. Depois de confirmado, o equipamento não volta ao estoque e o
  registro não aceita alteração.

Toda tabela tem RLS habilitada e forçada, com política por
`current_setting('app.workspace_id')`. As referências carregam
`workspace_id`; relações de uso preservam também a empresa consumidora. O
catálogo compartilhado não expõe entregas e movimentações de empresas fora do
escopo do usuário.

## Áreas operacionais

Áreas são independentes de CNPJ e não substituem departamentos ou lotações de
colaboradores. Um usuário pode participar de várias áreas e ter, no máximo, uma
área principal. As demandas guardam `requester_area_id` e
`responsible_area_id`, portanto origem e destino continuam consultáveis mesmo
quando pessoas mudam de equipe.

O roteamento do Controle de EPI usa duas atribuições configuráveis:
`epi.owner`, para a área solicitante (por exemplo SESMT), e
`epi.discount_analysis`, para a área responsável pela análise (por exemplo
Departamento Pessoal). Ausência de configuração gera erro explícito; o sistema
não escolhe uma área silenciosamente.

## Permissões

Doze capacidades, na área "Controle de EPI" da tela de usuários:

| Capacidade | Admin | Membro | Observador | Convidado |
| --- | --- | --- | --- | --- |
| `epi.view` | ✓ | ✓ | ✓ | — |
| `epi.create` | ✓ | ✓ | — | — |
| `epi.edit` | ✓ | ✓ | — | — |
| `epi.deliver` | ✓ | ✓ | — | — |
| `epi.return` | ✓ | ✓ | — | — |
| `epi.damage` | ✓ | ✓ | — | — |
| `epi.dispose` | ✓ | ✓ | — | — |
| `epi.discount.analyze` | ✓ | ✓ | — | — |
| `epi.export` | ✓ | ✓ | — | — |
| `epi.delete` | ✓ | — | — | — |
| `epi.audit.view` | ✓ | — | — | — |
| `epi.stock.adjust` | ✓ | ✓ | — | — |

O analista de DP opera o módulo inteiro. O que fica só com o administrador é dar
baixa em cadastro e ler a trilha de auditoria — as duas ações que serviriam para
encobrir as outras.

Negar o módulo `epi` a uma pessoa fecha as onze, não só a tela: `epi.audit.view`
entra em `moduleWriteCapabilities` justamente para que quem perdesse a tela não
continuasse lendo a trilha do EPI pela auditoria.

`epi.delete` é baixa, não exclusão: o cadastro passa a `inactive` e o histórico
fica. Um EPI com unidades em poder de colaboradores não é inativado — primeiro a
devolução, depois a baixa.

## Fluxo operacional

1. **Cadastro** — EPI, tipo, CA, tamanho, marca, modelo e valor. Uma quantidade
   inicial gera entrada no local escolhido e a primeira movimentação no razão.
2. **Entrada e transferência** — entradas somam ao local de destino;
   transferências debitam a origem e creditam o destino no mesmo lote.
3. **Entrega** — saldo, entrega, razão e auditoria são atômicos. Se o local não
   tiver quantidade suficiente, nada do evento é persistido.
4. **Devolução** — a condição decide o destino (tabela acima). A baixa é
   registrada na entrega, e é ela que faz o colaborador deixar de constar com o
   equipamento.
5. **Higienização** — itens pendentes passam por início e conclusão ou rejeição;
   somente a conclusão repõe o saldo no local registrado.
6. **Troca por dano** — a decisão da análise governa o antigo e o novo.
7. **Descarte** — a janela recolhe o que a devolução e a troca encaminharam,
   mais o que for aberto à mão a partir do estoque. Confirmar exige responsável
   e data, e é definitivo. Descarte aberto do estoque debita o saldo na
   confirmação; o que veio de devolução ou troca já saiu na entrega, e debitar
   de novo tiraria duas unidades por uma.
8. **Análise de desconto** — abre demanda roteada entre áreas; a decisão fica
   na análise, no razão e na linha do tempo. Aprovação cria um rascunho na
   Central de Movimentações, nunca um desconto automático.

## Telas

- **Painel do módulo** (`Controle de EPI`, seção "Pessoas e cadastros"): sete
  cartões — estoque, entregues, pendentes de assinatura, pendentes de
  higienização, aguardando descarte, descontos em análise, CA vencido ou
  vencendo. Cada cartão é atalho para a aba com o filtro já aplicado.
- **Abas**: Estoque, Entregas, Trocas e danos, Devoluções, Descarte, Descontos,
  Relatórios.
- **Aba "EPIs" no cadastro do colaborador**: EPIs ativos, entregas, devoluções,
  trocas, descartes, análises de desconto, anexos e a linha do tempo completa.
  A aba é de consulta — registrar acontece no módulo, onde estão as validações
  de estoque e a evidência.
- **Aplicativo de campo** (`/campo`): entrega com assinatura, devolução, dano com
  foto e consulta, pelo celular. Detalhado adiante.

## Aplicativo de campo (`/campo`)

O painel é feito para a mesa: tabela larga, filtro, relatório. A entrega de EPI
não acontece na mesa — acontece no pátio, no galpão, na porta do almoxarifado,
com o colaborador de pé esperando. `/campo` é a tela desse momento.

Não é um produto separado, e não é o painel responsivo. É uma rota do mesmo
aplicativo, com a mesma sessão, as mesmas permissões e as mesmas rotas de API.
Instala-se na tela inicial do celular como aplicativo (PWA): `app/manifest.ts`
declara `start_url: "/campo"`, modo `standalone` e três atalhos — entrega,
devolução e dano — que abrem direto no fluxo.

### O que se faz por ela

| Ação | Permissão | O que a tela acrescenta |
| --- | --- | --- |
| Entregar EPI | `epi.deliver` | Assinatura no dedo, anexada como termo de entrega |
| Receber devolução | `epi.return` | Condição do EPI, que decide o destino |
| Registrar dano | `epi.damage` | Foto da evidência pela câmera do aparelho |
| Consultar colaborador | `epi.view` | O que está em poder de quem, com saldo pendente |

Sem a permissão, a ação aparece desabilitada e diz por quê — não desaparece.
Esconder a ação faria a pessoa procurar o que não existe para ela.

### Quatro decisões que moldam a tela

**O saldo exibido é o do local escolhido.** A entrega debita um local de
estoque, não o grupo. Mostrar o total disponível ofereceria doze unidades onde
há zero, e a recusa chegaria depois — na frente do colaborador que já assinou.
O local escolhido também vai explícito no dano: sem ele o servidor usa o local
padrão do grupo, e as consequências da decisão — descarte, higienização,
reposição — lançariam no estoque de outro almoxarifado.

**A assinatura é imagem, colhida em `canvas` com eventos de ponteiro**, escalada
por `devicePixelRatio` para não sair serrilhada, e enviada como PNG com o tipo
`delivery_term`. É ela que torna o termo assinado: sem assinatura a entrega
nasce `pending_signature`, e o relatório de entregas sem termo é justamente o
que cobra isso depois.

**A leitura de código usa `BarcodeDetector`, que é API do navegador** — nenhuma
biblioteca embarcada. A consequência é honesta e está na tela: existe no Chrome
do Android, **não** existe no Safari do iPhone. Onde não existe, o campo de
digitação é o caminho principal, não uma mensagem de erro. A busca aceita nome,
código interno ou CA, o que faz a etiqueta impressa valer tanto quanto a câmera.

**O que foi feito sem rede não se perde.** A operação inteira — inclusive a
assinatura e a foto, que são Blobs — fica no IndexedDB e é reenviada quando a
conexão volta. O reenvio é seguro porque cada operação nasce com uma chave de
idempotência estável, gravada na própria linha do registro: repetir devolve a
entrega existente em vez de criar uma segunda, e entrega duplicada no estoque
significa unidade a menos sem motivo.

A tela diz qual dos três resultados aconteceu, porque eles são diferentes:
registrado; guardado para enviar; **ou registrado com a evidência pendente** —
quando o servidor aceitou a entrega e só o anexo falhou. Nesse último caso a
fila mostra "registro já gravado no servidor · falta só a evidência", e a
pessoa não precisa colher a assinatura de novo. Se o armazenamento de anexos
não estiver conectado ao projeto, a resposta é `503
ATTACHMENT_STORAGE_UNAVAILABLE` com o motivo legível — a falha vai para a tela,
não só para o log.

### Aparelho compartilhado

O celular do almoxarifado troca de mão a cada turno, e duas coisas acontecem na
saída por causa disso. A casca guardada pelo service worker é apagada — ela é o
HTML já renderizado, com o nome de quem estava logado, e sem isso o próximo a
abrir no modo avião veria o nome de quem saiu. E se houver pendência na fila, a
saída avisa: operação enviada depois da troca de login subiria no nome de quem
entrou, não de quem registrou.

A **fila não é apagada** na saída, de propósito: ela guarda entrega assinada e
foto de dano que ainda não subiram, e perder isso é perder a evidência de algo
que aconteceu.

### Service worker

`public/sw.js` guarda a casca do aplicativo (a rota `/campo`, os ícones, o
manifesto) e **nunca** guarda `/api/`. É deliberado: saldo velho em cache é
pior do que saldo nenhum, porque a pessoa entrega contra um número que não
existe mais. Navegação é rede primeiro, com a casca em cache como reserva; o
estático é servido do cache e revalidado em seguida.

O registro usa **escopo `/campo`**, não a raiz. No escopo raiz o service worker
controlaria o painel e o site público, e a reserva sem rede devolveria a casca
do aplicativo de campo a quem pediu o painel. As páginas de `/campo` continuam
levando consigo os arquivos estáticos do Next: o escopo decide quais páginas o
service worker controla, não quais endereços ele pode guardar. O escopo do
*manifesto* segue `/`, porque sair e entrar de novo atravessa `/login` — com
escopo estreito ali, isso abriria uma aba do navegador no meio do turno.

### Paleta

A mesma da central de comando: `/campo` consome os tokens `--ui-*` do produto,
sem tema paralelo. Há um detalhe que custou duas violações de contraste e vale
registrar: superfície e texto chegam à rota porque moram em `:root`, mas o
quarteto de acento mora em `.dashboard-shell` — e `/campo` não é o painel. Com
reserva de tema claro, a tela montava fundo escuro com acento claro, e o
"Trocar" media 2.28:1. As reservas do acento agora são as de
`.dashboard-shell.theme-dark`, repetidas de propósito e com a origem nomeada,
até que o acento suba para `:root` como o resto já subiu.

O campo de assinatura é a exceção: papel branco e traço grafite escritos à mão.
Eles pertencem ao documento, não à interface — se seguissem o tema, o termo
guardado deixaria de ser o que a pessoa viu ao assinar.

### Duas formas de assinar, e quando usar cada uma

O módulo tem dois caminhos para a ciência do colaborador, e eles não competem:

- **Assinatura em campo** (`/campo`): o colaborador assina no aparelho de quem
  entrega, na hora. Serve quando as duas pessoas estão frente a frente — o caso
  comum do almoxarifado e do pátio.
- **Link de ciência** (`/portal/epi/<token>`): a entrega é registrada sem
  assinatura e o colaborador confirma depois, no próprio celular, por um link
  assinado com prazo. Serve para quem está em obra, em viagem ou em turno que
  não cruza com o do almoxarifado.

A entrega sem nenhum dos dois nasce `pending_signature`, e o relatório de
entregas sem termo assinado é o que cobra a pendência.

### Como isso é verificado

`scripts/browser-check.mjs` percorre o turno inteiro em 390px, pelas rotas reais
do produto e conferindo **no banco**, não na tela:

1. **Entrega**: acha o EPI pelo código interno, assina no canvas, confirma — e o
   banco mostra `signed`, a assinatura com o nome certo e o estoque de 10 para 9.
2. **Consulta**: o EPI entregue aparece em poder do colaborador.
3. **Devolução**: condição "devolvido higienizado" devolve a unidade ao local, o
   saldo volta a 10 e a condição gravada é a que foi escolhida na tela.
4. **Dano**: a foto entra pelo mesmo `<input type="file">` da câmera, a tela
   cobra a descrição antes de mandar, e a decisão "enviar para análise de
   desconto" abre a demanda com o título exato da regra do módulo.

`scripts/a11y-check.mjs` audita a tela inicial, os quatro fluxos e o passo da
assinatura em todas as larguras da varredura — um passo inalcançável conta como
falha de cobertura, não como ausência de problema.

## Relatórios

Treze relatórios, com filtro por empresa e período, visualização em tela e
exportação em CSV: estoque, entregas, EPIs por colaborador, por empresa/CNPJ,
devoluções, danificações, descartes, pendentes de higienização, descontos em
análise, entregas sem termo assinado, por CA, movimentações por competência e
histórico por colaborador.

A exportação exige `epi.export` e fica registrada na auditoria com o relatório e
o recorte pedidos — quem levou dado de colaborador para fora do produto é
informação que precisa sobreviver ao download. O CSV sai com BOM (para o Excel
em português abrir em UTF-8) e neutraliza campo que comece com `=`, que numa
planilha viraria fórmula executável.

## API

| Rota | Método | Permissão |
| --- | --- | --- |
| `/api/epi/overview` | GET | `epi.view` |
| `/api/epi/products` | GET, POST | `epi.view`, `epi.create` |
| `/api/epi/products?search=` | GET | busca por nome, código interno ou CA |
| `/api/epi/products/[id]` | GET, PATCH, DELETE | `epi.view`, `epi.edit`, `epi.delete` |
| `/api/epi/stock/locations` | GET, POST, PATCH | `epi.view`, `epi.stock.adjust` |
| `/api/epi/stock/entries` | POST | `epi.stock.adjust` |
| `/api/epi/stock/transfers` | POST | `epi.stock.adjust` |
| `/api/epi/deliveries` | GET, POST | `epi.view`, `epi.deliver` |
| `/api/epi/deliveries/[id]` | GET, PATCH | `epi.view`, `epi.deliver` |
| `/api/epi/returns` | GET, POST | `epi.view`, `epi.return` |
| `/api/epi/returns/[id]/sanitization` | POST | `epi.return` |
| `/api/epi/damages` | GET, POST | `epi.view`, `epi.damage` |
| `/api/epi/disposals` | GET, POST | `epi.view`, `epi.dispose` |
| `/api/epi/disposals/[id]` | POST | `epi.dispose` |
| `/api/epi/discounts` | GET, POST | `epi.view`, `epi.discount.analyze` |
| `/api/epi/discounts/[id]` | GET, POST | `epi.view`, `epi.discount.analyze` |
| `/api/epi/employees/[id]` | GET | `epi.view` |
| `/api/epi/reports` | GET | `epi.view`, `epi.export` para CSV |
| `/api/epi/attachments` | GET, POST | `epi.view`, `epi.edit` |
| `/api/epi/attachments/[id]` | GET, DELETE | `epi.view`, `epi.edit` |
| `/api/areas` | GET, POST | `departments.view`, `departments.create` |
| `/api/areas/[id]` | GET, PATCH, DELETE | permissões de área correspondentes |
| `/api/areas/[id]/members` | PUT | `departments.manage_members` |

Eventos com empresa consumidora aplicam o recorte de empresas do usuário: sem
escopo, a resposta é vazia — nunca "tudo". Catálogo, locais e saldos são do
workspace; no detalhe do SKU, as movimentações continuam filtradas por empresa.

## Anexos

Termo de entrega, foto do dano, comprovante de descarte. Mesmos limites dos
anexos de demanda: 20 MB por arquivo, PDF/imagem/TXT/CSV/DOCX/XLSX, e a **mesma
cota de armazenamento do plano** — a conferência soma `fdp_card_attachments` e
`fdp_epi_attachments` na instrução que grava, dentro de um lock, para que dois
envios simultâneos não passem juntos pela última fatia.

O anexo de um descarte já confirmado não pode ser removido: ele é a evidência do
ato que o banco tornou imutável.

## Aplicar em produção

```bash
npm run db:migrate
```

As migrations preservam o histórico. A `0045` cria um local padrão por workspace,
migra o saldo legado para esse local, troca as referências operacionais de
produto para a identidade `(workspace_id, product_id)` e mantém
`stock_quantity` como projeção. Faça backup e ensaie a migração conforme o
procedimento de produção antes da aplicação definitiva.

Ver `docs/aplicar-migracoes-em-producao.md` para o procedimento completo.
