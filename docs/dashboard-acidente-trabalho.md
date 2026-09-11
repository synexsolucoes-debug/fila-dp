# Dashboard de Acidente de Trabalho (SESMT)

Módulo de leitura e lançamento para a equipe de segurança do trabalho: quantos
acidentes houve no período, quanto custaram em dias de afastamento e em
dinheiro, quem se acidentou, em que parte do corpo, em que setor, em que turno
e em que mês.

Quem alimenta é o próprio SESMT. **Não existe origem automática de acidente** —
nenhum conector traz esse dado, e nenhuma rotina interna o infere. A tela de
lançamentos é a única porta de entrada, e é por isso que ela é curta.

## A regra que governa o módulo

**Um registro por acidente, e nove recortes derivados dele.**

A alternativa óbvia seria guardar totais digitados — "21 acidentes", "451 dias
afastados", "24% mulheres". Ela quebra na primeira competência: os totais passam
a se contradizer entre si, ninguém sabe qual está desatualizado, e o filtro de
período não tem o que filtrar.

Aqui, tipo, parte do corpo, setor, gênero, turno, mês, dias afastados, despesa e
total são a **mesma soma vista de nove ângulos**, calculada por
`summarizeAccidents` em `lib/work-accidents.ts`. Trocar o mês move todos ao mesmo
tempo, porque todos saem da mesma passada sobre a mesma base.

A segunda regra é o período: **a data que conta é a do fato**, nunca a do
lançamento. Um acidente de março registrado em setembro pertence a março, que é
onde a CAT o colocou.

## O que o módulo não faz

- **Não calcula taxa de frequência nem de gravidade da NBR 14280.** As duas
  exigem horas-homem trabalhadas, que o Vinculato não coleta. Publicar uma taxa
  a partir de um denominador que ninguém informou seria inventar indicador legal
  — e indicador legal errado é pior que indicador nenhum. Não há coluna para
  elas de propósito.
- **Não emite CAT nem se comunica com o INSS.** O módulo registra se a CAT foi
  emitida e o protocolo; emitir continua sendo feito onde sempre foi.
- **Não guarda dado clínico.** Diagnóstico, CID, laudo, exame e prontuário estão
  fora do modelo, pela mesma fronteira que o módulo de Psicologia respeita.
  O que existe é a parte do corpo atingida, que é o que a CAT registra e o que o
  mapa do dashboard mostra.

## A tela

O filtro de período fica no topo e vale para tudo abaixo dele:

- **Empresa** — todas as que a pessoa enxerga, ou uma;
- **Ano** — os anos que têm lançamento, vindos da base inteira. Abrir já traz o
  mais recente selecionado: abrir em "todos" faria a série de doze meses somar
  exercícios diferentes, que é o número que mais engana neste dashboard;
- **Mês** — nenhum selecionado significa ano inteiro. Vários selecionados somam.

Os cinco cartões do topo respondem "quanto": total de acidentes (com quantos
tiveram afastamento e quantos geraram CAT), total de dias afastados, total de
despesas, divisão por gênero e contagem por turno.

Os quatro painéis abaixo respondem "onde": rosca por tipo (incidente, típico,
trajeto, doença ocupacional), mapa do corpo com as regiões atingidas, série dos
doze meses e barras por setor.

A aba **Lançamentos** mostra a base que sustenta os gráficos, com correção e
exclusão para quem tem permissão.

### O mapa do corpo gira

A figura é tridimensional, e isso resolve um problema real: **região lombar e
costas só existem por trás**. Num mapa plano de frente elas precisavam ser
desenhadas por cima do abdômen — duas regiões diferentes no mesmo lugar, que é
exatamente o que o mapa existe para separar. Aqui a lombar fica atrás do tronco
e aparece ao virar o boneco, pelo arrasto ou pelos botões Frente, Lado e Costas.

Não entrou biblioteca 3D. Cada região é um punhado de planos cruzados dentro de
um palco com `perspective` e `preserve-3d`; de qualquer ângulo pelo menos um
plano está virado para a câmera, então o volume nunca some. A seção de cada
parte é declarada (`depth`), e é ela que dá ao tronco frente larga e perfil
estreito — sem isso o boneco sairia cilíndrico, com a mesma largura em toda a
volta. O custo é zero em dependência, em `npm audit` e em tamanho de pacote, e
a cor continua saindo dos tokens do painel, de modo que o tema escuro vem junto.

Para quem usa leitor de tela a figura é decorativa: girar um desenho não
acrescenta nada a quem não o vê, e os números estão escritos na legenda ao lado.
Os botões de vista existem porque arrastar com o mouse não pode ser o único
caminho até as costas.

### Detalhes que não são estéticos

- **Mês sem acidente é zero, não buraco na linha.** O buraco sugere "não
  medimos"; o zero afirma "não houve", que é o que o SESMT quer poder mostrar.
- **Gênero não informado continua contando.** Ele aparece na divisão em vez de
  sumir dela: somar só quem declarou e apresentar o resultado como o todo seria
  um gráfico que mente sem errar nenhuma conta.
- **Os percentuais fecham em 100.** A repartição usa a regra da maior sobra;
  arredondar cada fatia isolada produziria 99 num dia e 101 no outro, com os
  números escritos ao lado da rosca.
- **Setor é campo aberto; o resto é vocabulário fechado.** A estrutura de
  setores é de cada empresa. A anatomia, o tipo e o turno não são — e um campo
  livre viraria "mão", "MAO" e "mao dir." como três fatias do mesmo lugar.

## Permissões

| Capacidade | O que libera | Papel base |
| --- | --- | --- |
| `safety.view` | Abrir o dashboard e a lista de lançamentos | Membro e observador |
| `safety.manage` | Registrar e corrigir acidentes | Membro |
| `safety.export` | Baixar a planilha do período | Membro |
| `safety.delete` | Excluir um lançamento | Administrador |

Excluir é permissão própria, e não a de registrar: apagar um acidente apaga o
número que sustenta a análise do período inteiro, e a CAT que ele acompanha já
saiu da empresa. O caminho normal para um lançamento errado é corrigi-lo;
excluir serve para o duplicado e para o que nunca aconteceu. O que foi apagado
fica na trilha de auditoria com o estado anterior inteiro.

A exportação é permissão separada porque o arquivo sai da tela e entra em anexo
de e-mail: ele leva o nome do colaborador e a descrição do acidente na mesma
linha, que é o par que o dashboard nunca mostra junto. Toda exportação fica
registrada na trilha, com o recorte pedido e a contagem de linhas.

## Banco

Tabela única, `fdp_work_accidents`, criada em
`drizzle/postgres/0083_work_accident_dashboard.sql` com RLS por workspace
(`ENABLE` + `FORCE`), índice por empresa e data, e quatro `CHECK` que o código
não pode contornar:

- tipo, parte do corpo, turno e gênero só aceitam o vocabulário do módulo;
- dias afastados e despesa nunca são negativos — os dois são somados direto nos
  cartões do topo;
- número de CAT só existe quando a CAT foi emitida: guardar protocolo de uma
  comunicação que ninguém emitiu é registrar prova de um ato que não aconteceu.

A migration também registra o módulo em `fdp_modules`, inclui-o em todos os
planos — registrar acidente é obrigação de qualquer empresa com colaborador, não
recurso de porte — e o atribui à área que já responde pelo EPI, que é a mesma
equipe de segurança.

## Rotas

| Rota | Método | Permissão |
| --- | --- | --- |
| `/api/safety/overview` | GET | `safety.view` |
| `/api/safety/accidents` | GET, POST | `safety.view`, `safety.manage` |
| `/api/safety/accidents/[id]` | PATCH, DELETE | `safety.manage`, `safety.delete` |
| `/api/safety/export` | GET | `safety.export` |

Todas aplicam o recorte de empresa do membro. A correção confere a permissão nas
**duas** empresas quando o lançamento muda de filial: sem a conferência na
origem, quem só enxerga a filial B moveria para si um acidente da filial A que
nem deveria estar vendo.

A listagem devolve os registros crus e a tela agrega com a mesma função pura do
servidor — é o que permite trocar de mês sem nova ida ao banco. O teto é de
5.000 registros por consulta; acima dele a tela avisa que o recorte precisa ser
menor, em vez de mostrar um total silenciosamente incompleto.

## Testes

`tests/work-accidents.test.mts` prende as três promessas do módulo: os nove
recortes somam o mesmo total, o período filtra pela data do fato e os
percentuais fecham em 100. O mesmo arquivo confere a RLS da migration, o
vocabulário igual no banco e no código, a matriz de permissões e a porta da tela
no menu.
