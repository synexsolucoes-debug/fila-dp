---
name: dp-legislacao-brasil
description: Regras trabalhistas brasileiras (CLT, NR-7, eSocial, FGTS Digital, 13º, férias, rescisão, experiência, aviso prévio, exames ocupacionais) aplicadas ao código do Vinculato. Use antes de escrever ou revisar qualquer prazo, cálculo, alerta, vencimento, validação ou texto de tela que dependa de lei — férias, rescisão, admissão, contrato de experiência, ASO, eventos do eSocial, guias, folha, Motor de Prazos, Jornadas. Também use para responder dúvidas de regra de DP/SST e para conferir se uma regra já codificada está certa.
---

# Legislação de DP no Vinculato

Erro de prazo no Vinculato não é bug cosmético: vira multa, verba em dobro ou
passivo trabalhista para o cliente. Esta skill define **como** uma regra legal
entra no código e traz a **tabela de referência** das regras mais usadas.

## 1. Antes de codificar qualquer regra

1. **Procure se ela já existe.** As regras puras moram em `lib/`:
   - `lib/vacation-balance.ts` — férias (aquisitivo, concessivo, dobro)
   - `lib/contract-terms-rules.ts` — contrato, experiência, aviso prévio
   - `lib/occupational-exams.ts` — ASO e exames ocupacionais
   - `lib/payroll-obligations.ts` — guias, encargos, rubricas do S-1200
   - `lib/dp-calendar.ts` — dia útil e feriado (use sempre este, nunca conte dias à mão)
   - `lib/dp-cutoff.ts` — corte operacional
   - `lib/erp-payroll-rules.ts` / `lib/erp-*.ts` — regras do cálculo do ERP DP

   Duas implementações da mesma regra divergem com o tempo. Reaproveite.
2. **Cite a fonte no comentário** da função: artigo da CLT, item da NR, lei,
   ou versão do MOS (Manual de Orientação do eSocial). Sem fonte, a regra não
   entra.
3. **Confira a regra em fonte primária quando houver qualquer dúvida**:
   `planalto.gov.br` (CLT e leis), `gov.br/trabalho-e-emprego` (NRs),
   `gov.br/esocial` (MOS e notas orientativas vigentes). Blogs e fóruns erram
   com frequência — há sites que dizem "demissional até 10 dias *antes*" ou
   "dispensa se o último exame tem *mais de* 135 dias", ambos errados.
   Use WebSearch/WebFetch nesses domínios.
4. **Regra que muda com o tempo tem vigência.** Siga o padrão do ERP DP
   (regra com início/fim de vigência). Nunca sobrescreva a regra antiga: o
   cálculo de uma competência passada precisa usar a regra daquela época.

## 2. Como testar uma regra de prazo

Todo prazo novo ganha teste em `tests/` cobrindo, no mínimo:

- vencimento caindo em **sábado, domingo e feriado** (via `lib/dp-calendar.ts`);
- **fim de mês** (31 → mês com 30 dias, fevereiro, ano bissexto);
- o **dia exato** do limite (dentro) e o dia seguinte (fora);
- prazo em **dias corridos** vs **dias úteis** — escreva qual é no nome do teste.

Lembre de registrar o arquivo novo no script `test` do `package.json`
enquanto ele for uma lista manual.

## 3. Fronteiras do produto (não negociáveis)

- **O Vinculato não transmite.** Ele gera número, arquivo e alerta; quem envia
  ao eSocial, DCTFWeb ou FGTS Digital é quem tem o certificado digital.
- **Saúde: resultado, nunca diagnóstico.** ASO entra como apto / inapto / apto
  com restrição, e a restrição descreve a função ("não carregar acima de
  10 kg"), não a doença. Mesma regra de `tests/psychology-clinical-boundary.test.mts`.
- **Agente e IA propõem, o motor decide.** Nenhuma regra legal é aplicada por
  sugestão de modelo sem passar pela regra determinística.
- **Prazo vira trabalho.** Todo vencimento novo deve aparecer na Central de
  Trabalho / Motor de Prazos, com responsável — prazo que só existe numa tela
  que ninguém abre não protege ninguém.

## 4. Tabela de referência

Valores de partida. Antes de codificar, confira a redação vigente (passo 1.3).

### CLT e leis

| Tema | Regra | Fonte |
|---|---|---|
| Salário mensal | Pagar até o **5º dia útil** do mês seguinte | CLT art. 459 §1º |
| Férias — direito | 12 meses de vínculo (aquisitivo) dão 30 dias, reduzidos por faltas | CLT arts. 130 |
| Férias — concessão | Gozar nos 12 meses seguintes ao aquisitivo (concessivo) | CLT art. 134 |
| Férias — vencidas | Concedidas após o concessivo: pagamento **em dobro** | CLT art. 137 |
| Férias — fracionamento | Até 3 períodos; um ≥ 14 dias, os demais ≥ 5 dias, com concordância do empregado | CLT art. 134 §1º |
| Férias — início | Não pode começar nos 2 dias que antecedem feriado ou repouso semanal | CLT art. 134 §3º |
| Férias — aviso | Comunicar por escrito com **30 dias** de antecedência | CLT art. 135 |
| Férias — pagamento | Pagar até **2 dias antes** do início | CLT art. 145 |
| Rescisão — pagamento | Até **10 dias** contados do término do contrato | CLT art. 477 §6º |
| Rescisão — atraso | Multa de um salário a favor do empregado | CLT art. 477 §8º |
| Contrato de experiência | Máximo **90 dias**, uma única prorrogação dentro desse limite | CLT arts. 445 parágrafo único e 451 |
| Contrato por prazo determinado | Máximo 2 anos | CLT art. 445 |
| Aviso prévio proporcional | 30 dias + 3 por ano completo de serviço, até 90 dias | Lei 12.506/2011 |
| 13º salário | 1ª parcela até **30/11**; 2ª parcela até **20/12** | Lei 4.749/1965 |
| Registro de ponto | Obrigatório para estabelecimento com mais de 20 empregados | CLT art. 74 §2º |

### SST (NR-7 / PCMSO)

| Tema | Regra | Fonte |
|---|---|---|
| Exame admissional | Antes do início das atividades | NR-7 |
| Exame demissional | Até **10 dias** contados do término do contrato | NR-7 item 7.5.11 |
| Dispensa do demissional | Último exame ocupacional há **menos de 135 dias** (grau de risco 1 e 2) ou **menos de 90 dias** (grau 3 e 4) | NR-7 item 7.5.11 |

### eSocial e guias — **conferir no MOS vigente antes de codificar**

Os prazos do eSocial mudam por nota orientativa e há regras diferentes por
grupo de empregador. A tabela abaixo é ponto de partida, não fonte.

| Evento | Prazo usual | Observação |
|---|---|---|
| S-2200 Admissão | Até o dia anterior ao início da prestação de serviços | |
| S-2206 Alteração contratual | Até o dia 15 do mês seguinte, ou antes do S-1200 da competência | confira a NO mais recente |
| S-2230 Afastamento | Depende do motivo e da duração | não fixe sem ler o MOS |
| S-2299 Desligamento | Até o 10º dia seguinte ao desligamento | dia não útil: antecipar |
| S-1200 Remuneração | Até o dia 15 do mês seguinte | |
| S-2210 CAT | Até o 1º dia útil seguinte ao acidente; óbito: imediato | |
| S-2220 Monitoramento da saúde (ASO) | Até o dia 15 do mês seguinte ao exame | |
| S-2240 Condições ambientais | Até o dia 15 do mês seguinte à admissão ou à mudança | |
| FGTS Digital | Recolhimento até o dia 20 do mês seguinte | antecipa se não for dia útil — confira |
| DCTFWeb | Até o dia 20 do mês seguinte | antecipa se não for dia útil — confira |

## 5. Ao responder dúvidas (sem código)

- Diga a regra, a fonte e se é dia corrido ou útil.
- Se a regra depende de convenção coletiva (CCT), do grau de risco ou do grupo
  do eSocial, diga isso em vez de dar um número único.
- Se não tiver certeza, diga e aponte onde conferir. Prazo legal chutado é pior
  que prazo nenhum.
