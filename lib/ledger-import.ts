/**
 * Leitura assistida da planilha de vales e descontos.
 *
 * Este arquivo **interpreta**; ele não grava nada e não decide nada sozinho.
 * Tudo o que sai daqui é uma proposta com o texto original ao lado, e toda
 * dúvida vira uma ambiguidade nomeada que impede a gravação até alguém
 * resolvê-la.
 *
 * ## O que a planilha real é
 *
 * Medido no arquivo do cliente: 87 abas mensais, ~7.500 linhas de pessoa, 721
 * grafias distintas de nome e 1.979 células de texto livre. Cada aba tem vários
 * blocos, cada bloco com título `EMPRESA - CNPJ: ...` e cabeçalho próprio — e os
 * cabeçalhos **divergem entre blocos da mesma aba** (`ADTO` vs
 * `VALE (financeiro)`, `UNIDADE` vs `CIDADE`). Em alguns blocos as colunas estão
 * deslocadas, e a coluna do adiantamento contém CPF.
 *
 * Por isso o mapeamento é por bloco, deduzido do cabeçalho e **sempre**
 * revisável, em vez de uma posição fixa de coluna.
 *
 * ## As armadilhas, e o que o produto faz com cada uma
 *
 * | Texto na planilha | O que **não** se conclui |
 * |---|---|
 * | `5/10 R$ 200,00` | que 5 parcelas foram descontadas |
 * | `lançado na Domínio` | que o desconto aconteceu |
 * | o mesmo empréstimo em 40 abas | que são 40 empréstimos |
 * | `VALE FIXO` | que existe um saldo devedor total |
 * | um nome | que é aquela pessoa |
 *
 * Nenhuma dessas conclusões é tirada aqui. A primeira vira parcela corrente com
 * as anteriores marcadas como anteriores ao Vinculato; a segunda vira anotação;
 * a terceira é resolvida por agrupamento na prévia; a quarta nasce recorrente
 * sem total; e a quinta exige confirmação humana de pessoa, sempre.
 */
import ExcelJS from "exceljs";
import { isCompetence, toCents, type LedgerCategory, type LedgerModality } from "./payroll-ledger.ts";

export const MAX_IMPORT_FILE_BYTES = 12 * 1024 * 1024;

/** Colunas que o importador sabe reconhecer, e os rótulos que já apareceram. */
const HEADER_ALIASES: Record<string, string[]> = {
  employeeName: ["funcionario", "funcionário", "colaborador", "nome"],
  bankBranch: ["agencia", "agência"],
  bankAccount: ["conta"],
  taxId: ["cpf"],
  advanceAmount: ["adto", "vale", "vale (financeiro)", "adiantamento"],
  unit: ["unidade", "cidade"],
  department: ["departamento", "setor"],
  operation: ["empresa", "operacao", "operação", "marca"],
  freeText: [
    "controle de emprestimos", "controle de empréstimos",
    "outros descontos (financeiro e rh)", "outros descontos", "observacao", "observação",
  ],
};

const normalize = (value: string) => value
  .normalize("NFD").replace(/[̀-ͯ]/gu, "")
  .replace(/\s+/gu, " ").trim().toLowerCase();

const textOf = (value: ExcelJS.CellValue): string => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    if ("text" in value) return String(value.text ?? "").trim();
    if ("result" in value) return String(value.result ?? "").trim();
    if ("richText" in value) {
      const rich = (value as { richText?: { text?: string }[] }).richText ?? [];
      return rich.map((part) => part.text ?? "").join("").trim();
    }
  }
  return String(value).trim();
};

export type BlockMapping = {
  /** Linha do cabeçalho na aba. */
  headerRow: number;
  /** Título do bloco, normalmente `EMPRESA - CNPJ: ...`. */
  blockLabel: string;
  /** CNPJ lido do título, se houver. Nunca inventado. */
  taxId: string;
  /** Coluna de cada campo reconhecido, 1-based. */
  columns: Record<string, number>;
  /** Colunas de texto livre, na ordem. Uma célula pode ter mais de uma. */
  freeTextColumns: number[];
};

const CNPJ_PATTERN = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/u;

/**
 * Descobre os blocos de uma aba.
 *
 * Um bloco começa numa linha de cabeçalho — a que tem "FUNCIONARIO" na primeira
 * coluna — e o título é a última linha não vazia antes dela. Achar o cabeçalho
 * pelo conteúdo, e não pela posição, é o que faz o leitor funcionar nas abas em
 * que alguém inseriu uma linha a mais.
 */
export function detectBlocks(sheet: ExcelJS.Worksheet): BlockMapping[] {
  const blocks: BlockMapping[] = [];
  const titles = new Map<number, string>();

  sheet.eachRow((row, rowNumber) => {
    const first = textOf(row.getCell(1).value);
    if (first) titles.set(rowNumber, first);

    const columns: Record<string, number> = {};
    const freeTextColumns: number[] = [];
    let reconhecidas = 0;
    row.eachCell((cell, colNumber) => {
      const header = normalize(textOf(cell.value));
      if (!header) return;
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (!aliases.includes(header)) continue;
        reconhecidas += 1;
        if (field === "freeText") freeTextColumns.push(colNumber);
        else if (!(field in columns)) columns[field] = colNumber;
      }
    });

    /* Um cabeçalho de verdade tem a coluna do nome e ao menos mais duas
       reconhecidas. O limite existe para não confundir uma linha de dados que
       por acaso contenha a palavra "conta" com o começo de um bloco. */
    if (!columns.employeeName || reconhecidas < 3) return;

    /* A coluna sem cabeçalho logo depois da última de texto livre também é
       texto livre: na planilha real ela existe e carrega metade das
       observações. */
    const ultimaTexto = freeTextColumns.at(-1);
    if (ultimaTexto) {
      const seguinte = ultimaTexto + 1;
      if (!Object.values(columns).includes(seguinte)) freeTextColumns.push(seguinte);
    }

    let titulo = "";
    for (let acima = rowNumber - 1; acima >= 1 && acima >= rowNumber - 6; acima -= 1) {
      const candidato = titles.get(acima);
      if (candidato && normalize(candidato) !== "funcionario") { titulo = candidato; break; }
    }

    blocks.push({
      headerRow: rowNumber,
      blockLabel: titulo,
      taxId: CNPJ_PATTERN.exec(titulo)?.[1] ?? "",
      columns,
      freeTextColumns,
    });
  });

  return blocks;
}

export type ImportAmbiguity = {
  code: string;
  message: string;
};

export type ImportCandidate = {
  category: LedgerCategory;
  modality: LedgerModality;
  /** Nulo no recorrente: a planilha não diz um total, e o produto não inventa. */
  totalAmount: number | null;
  installmentCount: number | null;
  /** Parcela já corrente na planilha, quando o texto traz `n/N`. */
  currentInstallment: number | null;
  installmentAmount: number | null;
  firstCompetence: string;
  title: string;
  /** O texto exato de onde a proposta saiu. Sempre preservado. */
  sourceText: string;
  ambiguities: ImportAmbiguity[];
};

const COMPETENCE = /(\d{2})\s*[/\-.]\s*(\d{4})|(\d{4})\s*-\s*(\d{2})/u;

/**
 * Extrai os valores de dinheiro de um texto, na ordem em que aparecem.
 *
 * O cuidado central: `5/10` e `6X` **não** são dinheiro, e `06/2026` também
 * não. A primeira versão disto usava um `\d+` solto e lia o "5" de "5/10 R$
 * 200,00" como o valor da parcela — um empréstimo de duzentos reais virava um
 * de cinco. Por isso os fragmentos de parcela, de multiplicador e de
 * competência saem do texto antes da varredura, e um número sem vírgula, sem
 * ponto de milhar e sem `R$` na frente não é considerado valor.
 */
function extractAmounts(text: string): number[] {
  const limpo = text
    .replace(/\b\d{1,2}\s*\/\s*\d{1,2}\b/gu, " ")
    .replace(/\b\d{1,2}\s*[Xx]\b/gu, " ")
    .replace(/\b\d{2}\s*[/\-.]\s*\d{4}\b/gu, " ")
    .replace(/\b\d{4}\s*-\s*\d{2}\b/gu, " ");

  const achados: { posicao: number; valor: number }[] = [];
  const registrar = (pattern: RegExp, extrair: (achado: RegExpMatchArray) => string) => {
    for (const achado of limpo.matchAll(pattern)) {
      const valor = parseMoney(extrair(achado));
      if (valor !== null && achado.index !== undefined) {
        if (achados.some((item) => Math.abs(item.posicao - achado.index!) < 2)) continue;
        achados.push({ posicao: achado.index, valor });
      }
    }
  };

  // Com centavos: a forma mais confiável, e a mais comum na planilha.
  registrar(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/gu, (achado) => achado[0]);
  // Milhar com ponto e sem centavos: "R$ 2.000" é dois mil.
  registrar(/\d{1,3}(?:\.\d{3})+(?!,)/gu, (achado) => achado[0]);
  // Inteiro cru só quando `R$` diz que é dinheiro.
  registrar(/R\$\s*(\d+)(?![,.\d])/giu, (achado) => achado[1]);

  return achados.sort((esquerda, direita) => esquerda.posicao - direita.posicao).map((item) => item.valor);
}

function parseMoney(raw: string): number | null {
  const limpo = raw.replace(/R\$/giu, "").replace(/\s/gu, "");
  if (!limpo) return null;
  /* "2.000" na planilha é dois mil, não dois. Só há centavos quando há vírgula:
     o ponto sozinho é separador de milhar no português que a planilha usa. */
  const normalizado = limpo.includes(",")
    ? limpo.replace(/\./gu, "").replace(",", ".")
    : limpo.replace(/\./gu, "");
  const numero = Number(normalizado);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

function findCompetence(text: string): string | null {
  const achado = COMPETENCE.exec(text);
  if (!achado) return null;
  const competencia = achado[1] ? `${achado[2]}-${achado[1]}` : `${achado[3]}-${achado[4]}`;
  return isCompetence(competencia) ? competencia : null;
}

const CATEGORY_HINTS: { category: LedgerCategory; pattern: RegExp }[] = [
  { category: "traffic_fine", pattern: /\bMULTA\b/iu },
  { category: "vehicle_deductible", pattern: /FRANQUIA|DANOS?\s+VEICULO|DANOS?\s+VE[ÍI]CULO/iu },
  { category: "sesmt_discount", pattern: /\bSESMT\b/iu },
  { category: "equipment_damage", pattern: /CELULAR|NOTEBOOK|EQUIPAMENT|PURIFICADOR|APARELHO/iu },
  { category: "loan", pattern: /EMPR[ÉE]STIMO|EMPRESTIMO/iu },
  { category: "salary_advance", pattern: /\bVALE\b|\bADTO\b|ADIANTAMENTO/iu },
];

/**
 * Interpreta uma célula de texto livre.
 *
 * Devolve zero, uma ou mais propostas. Duas categorias reconhecidas na mesma
 * célula produzem duas propostas — a planilha real tem 59 células assim, e
 * juntar as duas num lançamento só seria perder uma das cobranças.
 */
export function interpretCell(raw: string): ImportCandidate[] {
  const texto = raw.trim();
  if (!texto) return [];

  const ambiguidadesComuns: ImportAmbiguity[] = [];
  if (/LAN[ÇC]AD|DOM[ÍI]NIO/iu.test(texto)) {
    ambiguidadesComuns.push({
      code: "mentions_launched",
      message: "O texto diz que algo foi lançado em outro sistema. Isso é anotação, não comprovação de desconto — confirme se já foi descontado antes de marcar qualquer parcela.",
    });
  }

  const categorias = CATEGORY_HINTS.filter((hint) => hint.pattern.test(texto));
  if (!categorias.length) {
    return [{
      category: "other", modality: "single", totalAmount: null, installmentCount: null,
      currentInstallment: null, installmentAmount: null, firstCompetence: "",
      title: texto.slice(0, 180), sourceText: texto,
      ambiguities: [...ambiguidadesComuns, {
        code: "unknown_category",
        message: "Não reconheci a categoria neste texto. Escolha a categoria e o valor antes de gravar.",
      }],
    }];
  }

  const competencia = findCompetence(texto);
  const parcelaCorrente = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/u.exec(texto);
  const vezes = /\b(\d{1,2})\s*[Xx]\b/u.exec(texto);
  const valores = extractAmounts(texto);
  const vale = /\bVALE\s+FIXO\b/iu.test(texto);
  const somenteEsta = /(SOMENTE|APENAS)\s+(ESTE\s+M[ÊE]S|COMPET|M[ÊE]S|PARA\s+COMPET)/iu.test(texto);

  return categorias.map((hint) => {
    const ambiguities = [...ambiguidadesComuns];
    let modality: LedgerModality = "single";
    let totalAmount: number | null = null;
    let installmentCount: number | null = null;
    let currentInstallment: number | null = null;
    let installmentAmount: number | null = null;

    if (hint.category === "salary_advance" && vale && !somenteEsta) {
      /* "VALE FIXO" é regra vigente, não dívida. Sem total, por definição. */
      modality = "recurring";
    } else if (parcelaCorrente) {
      modality = "installments";
      currentInstallment = Number(parcelaCorrente[1]);
      installmentCount = Number(parcelaCorrente[2]);
      installmentAmount = valores[0] ?? null;
      if (installmentAmount) totalAmount = Number((installmentAmount * installmentCount).toFixed(2));
      ambiguities.push({
        code: "installment_in_progress",
        message: `O texto diz "${currentInstallment}/${installmentCount}". O Vinculato **não** assume que ${currentInstallment - 1} parcela(s) já foram descontadas: as anteriores entram como histórico anterior ao sistema. Confirme o saldo antes de gravar.`,
      });
    } else if (vezes) {
      modality = "installments";
      installmentCount = Number(vezes[1]);
      /* "R$ 2.000 EM 6X DE 333,33" traz total e parcela; "6X DE 149,23" traz só
         a parcela. O maior dos dois é o total quando há dois valores. */
      if (valores.length >= 2) {
        totalAmount = Math.max(...valores);
        installmentAmount = Math.min(...valores);
      } else if (valores.length === 1) {
        installmentAmount = valores[0];
        totalAmount = Number((valores[0] * installmentCount).toFixed(2));
        ambiguities.push({
          code: "total_inferred",
          message: `O total foi deduzido multiplicando ${valores[0].toFixed(2)} por ${installmentCount}. Confira se é isso.`,
        });
      }
    } else {
      totalAmount = valores[0] ?? null;
      installmentCount = 1;
    }

    if (modality === "recurring" && installmentAmount === null) {
      installmentAmount = valores[0] ?? null;
      if (installmentAmount === null) {
        ambiguities.push({
          code: "missing_recurring_amount",
          message: "O texto diz que o desconto é fixo, mas não diz de quanto. Informe o valor mensal antes de gravar.",
        });
      }
    }
    if (modality !== "recurring" && totalAmount === null) {
      ambiguities.push({
        code: "missing_amount",
        message: "Não encontrei um valor neste texto. Informe o valor antes de gravar — nada é deduzido.",
      });
    }
    if (modality !== "recurring" && !competencia) {
      ambiguities.push({
        code: "missing_competence",
        message: "Não encontrei a competência de início. Escolha em qual competência o desconto começa.",
      });
    }
    if (categorias.length > 1) {
      ambiguities.push({
        code: "multiple_in_cell",
        message: "A mesma célula descreve mais de um desconto. Cada um virou uma proposta separada — confira os valores de cada.",
      });
    }
    /* Arredondamento que não fecha: 3 × 333,33 = 999,99, não 1.000,00. Apontar
       agora evita a diferença aparecer só na última parcela. */
    if (totalAmount && installmentCount && installmentAmount) {
      const somaParcelas = toCents(installmentAmount) * installmentCount;
      if (Math.abs(somaParcelas - toCents(totalAmount)) > installmentCount) {
        ambiguities.push({
          code: "amount_mismatch",
          message: `As parcelas de ${installmentAmount.toFixed(2)} × ${installmentCount} não fecham com o total de ${totalAmount.toFixed(2)}. Confirme qual dos dois vale.`,
        });
      }
    }

    return {
      category: hint.category,
      modality,
      totalAmount: modality === "recurring" ? null : totalAmount,
      installmentCount: modality === "recurring" ? null : installmentCount,
      currentInstallment,
      installmentAmount,
      firstCompetence: competencia ?? "",
      title: texto.slice(0, 180),
      sourceText: texto,
      ambiguities,
    };
  });
}

export type ImportRow = {
  sheetName: string;
  rowNumber: number;
  blockLabel: string;
  blockTaxId: string;
  employeeName: string;
  /** Presente só quando a planilha traz; nunca deduzido do nome. */
  taxId: string;
  unit: string;
  department: string;
  operation: string;
  advanceAmount: number | null;
  raw: Record<string, string>;
  candidates: ImportCandidate[];
  ambiguities: ImportAmbiguity[];
  /** Hash estável da linha, para reimportação não duplicar o que já foi gravado. */
  rowHash: string;
};

const CPF_PATTERN = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/u;

/**
 * Lê uma aba inteira.
 *
 * Só linhas com nome viram propostas. A célula do adiantamento é aceita como
 * valor **apenas** quando é numérica: em vários blocos da planilha real ela
 * contém CPF, e tratar isso como dinheiro criaria um vale de R$ 704.052.071,07.
 */
export function readSheet(sheet: ExcelJS.Worksheet, hashOf: (parts: string) => string): ImportRow[] {
  const blocks = detectBlocks(sheet);
  if (!blocks.length) return [];

  const rows: ImportRow[] = [];
  const blockAt = (rowNumber: number) => {
    let atual: BlockMapping | null = null;
    for (const block of blocks) {
      if (block.headerRow < rowNumber) atual = block; else break;
    }
    return atual;
  };

  sheet.eachRow((row, rowNumber) => {
    const block = blockAt(rowNumber);
    if (!block) return;
    if (blocks.some((candidate) => candidate.headerRow === rowNumber)) return;

    const nome = textOf(row.getCell(block.columns.employeeName).value).trim();
    if (!nome || CNPJ_PATTERN.test(nome)) return;
    if (normalize(nome) === "funcionario") return;

    const celula = (field: string) => block.columns[field]
      ? textOf(row.getCell(block.columns[field]).value).trim()
      : "";

    const ambiguities: ImportAmbiguity[] = [];
    const adiantamentoBruto = celula("advanceAmount");
    let advanceAmount: number | null = null;
    if (adiantamentoBruto) {
      if (CPF_PATTERN.test(adiantamentoBruto)) {
        /* Coluna deslocada: a planilha real tem blocos em que o CPF caiu na
           coluna do adiantamento. Apontar é melhor do que ler dinheiro ali. */
        ambiguities.push({
          code: "shifted_column",
          message: "A coluna do adiantamento contém um CPF — as colunas deste bloco parecem deslocadas. Reveja o mapeamento antes de gravar.",
        });
      } else if (/^-+$/u.test(adiantamentoBruto)) {
        // Um traço é "nada", e não zero.
      } else {
        const valor = parseMoney(adiantamentoBruto);
        if (valor === null) {
          ambiguities.push({
            code: "unreadable_advance",
            message: `Não consegui ler "${adiantamentoBruto}" como valor de adiantamento.`,
          });
        } else {
          advanceAmount = valor;
        }
      }
    }

    const textosLivres = block.freeTextColumns
      .map((coluna) => textOf(row.getCell(coluna).value).trim())
      .filter(Boolean);

    const candidates = textosLivres.flatMap((texto) => interpretCell(texto));

    /* Um "VALE FIXO" escrito no texto livre diz que é recorrente e não diz de
       quanto; o número da coluna diz de quanto. Os dois se completam — e o
       resultado fica marcado como vindo da coluna, para alguém confirmar. */
    const recorrenteSemValor = candidates.find((candidate) =>
      candidate.category === "salary_advance" && candidate.modality === "recurring" && candidate.installmentAmount === null);
    if (advanceAmount !== null && recorrenteSemValor) {
      recorrenteSemValor.installmentAmount = advanceAmount;
      recorrenteSemValor.ambiguities = recorrenteSemValor.ambiguities
        .filter((item) => item.code !== "missing_recurring_amount")
        .concat({
          code: "recurring_amount_from_column",
          message: `O valor mensal de ${advanceAmount.toFixed(2)} veio da coluna de adiantamento da planilha, não do texto. Confirme se é o valor vigente.`,
        });
    }

    /* O adiantamento numérico da coluna própria é uma proposta por si: é o
       "vale" daquele mês, e existe mesmo sem nada escrito no texto livre. */
    if (advanceAmount !== null && !candidates.some((candidate) => candidate.category === "salary_advance")) {
      candidates.push({
        category: "salary_advance",
        modality: "single",
        totalAmount: advanceAmount,
        installmentCount: 1,
        currentInstallment: null,
        installmentAmount: advanceAmount,
        firstCompetence: "",
        title: "Adiantamento da coluna da planilha",
        sourceText: adiantamentoBruto,
        ambiguities: [{
          code: "missing_competence",
          message: "A coluna do adiantamento não diz a competência. Escolha em qual competência ele entra.",
        }],
      });
    }

    const taxId = celula("taxId");
    if (!taxId) {
      ambiguities.push({
        code: "no_tax_id",
        message: "Esta linha não traz CPF. A pessoa precisa ser confirmada à mão — nome sozinho não identifica alguém numa base com homônimos.",
      });
    }

    const raw: Record<string, string> = {};
    row.eachCell((cell, colNumber) => {
      const valor = textOf(cell.value).trim();
      if (valor) raw[`c${colNumber}`] = valor;
    });

    rows.push({
      sheetName: sheet.name,
      rowNumber,
      blockLabel: block.blockLabel,
      blockTaxId: block.taxId,
      employeeName: nome,
      taxId,
      unit: celula("unit"),
      department: celula("department"),
      operation: celula("operation"),
      advanceAmount,
      raw,
      candidates,
      ambiguities,
      /* O hash é do conteúdo, não da posição: a mesma linha reimportada de um
         arquivo renomeado continua sendo a mesma linha. */
      rowHash: hashOf([sheet.name, String(rowNumber), nome, taxId, adiantamentoBruto, ...textosLivres].join("")),
    });
  });

  return rows;
}

export type ImportPreview = {
  sheets: string[];
  rows: ImportRow[];
  totals: {
    sheets: number;
    rows: number;
    candidates: number;
    ambiguous: number;
    distinctNames: number;
  };
};

/**
 * Lê o arquivo inteiro, ou apenas as abas escolhidas.
 *
 * A planilha do cliente tem 87 abas cobrindo sete anos. Importar todas seria
 * recriar sete anos de pagamentos que já aconteceram — por isso a escolha de
 * abas é do usuário, e o padrão é nenhuma: a competência de entrada define o
 * que o Vinculato passa a controlar, e o que é anterior fica como consulta.
 */
export async function previewLedgerImport(
  buffer: ArrayBuffer,
  options: { sheetNames?: string[]; hashOf: (parts: string) => string },
): Promise<ImportPreview> {
  if (buffer.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error("A planilha deve ter no máximo 12 MB.");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const todas = workbook.worksheets.map((sheet) => sheet.name);
  const escolhidas = options.sheetNames?.length
    ? workbook.worksheets.filter((sheet) => options.sheetNames!.includes(sheet.name))
    : [];

  const rows = escolhidas.flatMap((sheet) => readSheet(sheet, options.hashOf));
  const nomes = new Set(rows.map((row) => normalize(row.employeeName)));

  return {
    sheets: todas,
    rows,
    totals: {
      sheets: escolhidas.length,
      rows: rows.length,
      candidates: rows.reduce((soma, row) => soma + row.candidates.length, 0),
      ambiguous: rows.filter((row) =>
        row.ambiguities.length > 0 || row.candidates.some((candidate) => candidate.ambiguities.length > 0)).length,
      distinctNames: nomes.size,
    },
  };
}
