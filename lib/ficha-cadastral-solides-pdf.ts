/**
 * Extração da "Ficha Cadastral" da Sólides — um formato diferente do Registro
 * de Empregado que `registration-form-pdf.ts` foi construído para ler.
 *
 * ## Como se descobriu que era um documento diferente
 *
 * `registration-form-pdf.ts` (§9 da documentação) partiu do pressuposto de que
 * o PDF anexado pela Sólides era o Registro de Empregado oficial — texto
 * corrido, rótulos sem dois-pontos ("Empregado", "CPF"). A primeira ficha real
 * lida em produção mostrou o oposto: o arquivo `ficha-cadastral-solides.pdf`
 * é um resumo interno do sistema, organizado em seções ("Dados do
 * empregador", "Dados do colaborador", "Endereço", "Dependentes", "Dados
 * bancários", "Contatos de emergência", "Informações contratuais") com pares
 * `Rótulo: valor` — nome, CPF, RG, endereço e filiação aparecem uma vez cada,
 * não espalhados como o extrator antigo (feito para outro layout) enxergava.
 *
 * O nome do arquivo já dizia isso — "ficha cadastral", não "registro de
 * empregado" — só ninguém tinha uma ficha real pra confirmar até agora.
 *
 * ## Por que seções, e não um único conjunto de rótulos
 *
 * "Endereço" é rótulo de campo (endereço do empregador, dentro de "Dados do
 * empregador") E é o nome da seção do endereço residencial mais adiante — o
 * mesmo texto aparece duas vezes com significados diferentes. "CPF" e
 * "Telefone" se repetem do mesmo jeito (CPF do colaborador vs. dos
 * dependentes; telefone do colaborador vs. do contato de emergência). Um
 * único `sliceByLabels` sobre o texto inteiro pegaria sempre a primeira
 * ocorrência, o que resolve por sorte a ordem em que as seções aparecem, mas
 * não resolve rótulo igual DENTRO da mesma seção. Cortar em seções primeiro
 * (usando os cabeçalhos, que não se repetem) e rodar `sliceByLabels` de novo
 * dentro de cada uma resolve as duas ambiguidades ao mesmo tempo.
 *
 * ## Por que tantos rótulos "de fronteira", sem campo correspondente
 *
 * Um rótulo que este documento imprime mas a ficha não usa (Nome social,
 * Gênero, Email, Quant. filhos...) ainda precisa ser uma âncora — senão o
 * valor do campo vizinho ANTERIOR engole o trecho inteiro até o próximo
 * rótulo que É reconhecido, produzindo lixo em vez de ausência. Cada rótulo
 * de fronteira aqui existe porque apareceu, nesta ordem, na ficha real —
 * nenhum foi adivinhado.
 */
import type { RegistrationFormRaw } from "./employee-registration-form.ts";
import { sliceByLabels } from "./label-anchored-text.ts";

/**
 * Cabeçalhos de seção, na ordem em que o documento os imprime.
 *
 * A seção do endereço residencial é ancorada em "CEP", não em "Endereço": o
 * próprio cabeçalho da seção é a palavra "Endereço" sozinha, e essa mesma
 * palavra já é o rótulo do endereço do EMPREGADOR, poucas linhas antes — a
 * primeira ocorrência no texto é a errada. "CEP" só aparece uma vez no
 * documento inteiro, logo no início desta seção, e não colide com nada.
 */
const sectionLabels: Readonly<Record<string, string>> = {
  employer: "Dados do empregador",
  personal: "Dados do colaborador",
  address: "CEP",
  dependents: "Dependentes",
  bank: "Dados bancários",
  emergency: "Contatos de emergência",
  contract: "Informações contratuais",
};

/** Bem acima do tamanho de qualquer seção real — aqui o teto não deve recusar nada. */
const SECTION_MAX_VALUE = 8000;
const FIELD_MAX_VALUE = 220;

const employerFieldLabels: Readonly<Record<string, string>> = {
  employerName: "Empregador",
  employerTaxId: "CNPJ",
  employerAddress: "Endereço",
};

/**
 * Todo rótulo que a seção "Dados do colaborador" imprime, na ordem em que
 * aparece na ficha real. Os que não têm campo correspondente na ficha levam
 * um prefixo `_` — servem só de fronteira (ver comentário do módulo).
 */
const personalFieldLabels: Readonly<Record<string, string>> = {
  fullName: "Nome",
  _nomeSocial: "Nome social",
  birthDate: "Data de nascimento",
  sex: "Sexo",
  _genero: "Gênero",
  _email: "Email",
  mobilePhone: "Telefone",
  race: "Cor",
  maritalStatus: "Estado Civil",
  birthPlace: "Naturalidade",
  nationality: "Nacionalidade",
  motherName: "Nome da mãe",
  fatherName: "Nome do pai",
  taxId: "CPF",
  identityCard: "RG",
  identityIssueDate: "Data de emissão RG",
  identityIssuer: "Órgão/UF emissor RG",
  voterRegistration: "Título de eleitor",
  voterZone: "Zona",
  voterSection: "Seção",
  professionalBoard: "Órgão de classe",
  ctpsNumber: "CTPS",
  ctpsSeries: "Série",
  pisNumber: "PIS",
  ctpsIssueDate: "Data de emissão CTPS",
  militaryDocument: "Certificado reservista",
  education: "Grau instrução",
  disability: "PCD",
  _quantFilhos: "Quant. filhos",
  _tamanhoCamisa: "Tamanho camisa",
};

const bankFieldLabels: Readonly<Record<string, string>> = {
  _banco: "Banco",
  _numeroConta: "Nº da conta",
  bankBranch: "Agência",
  _tipoChavePix: "Tipo da chave PIX",
  _chavePix: "Chave PIX",
};

/** Todo rótulo de "Informações contratuais", na ordem em que aparece. */
const contractFieldLabels: Readonly<Record<string, string>> = {
  _modeloContratacao: "Modelo de contratação",
  bookNumber: "Nº de registro",
  esocialRegistration: "Matrícula eSocial",
  _filial: "Filial",
  _cnpjFilial: "CNPJ da filial",
  _regimeJornada: "Regime da jornada",
  admissionDate: "Data admissão",
  position: "Cargo",
  cbo: "CBO",
  _localTrabalho: "Local de trabalho",
  _centroCusto: "Centro de custo",
  _tipoSalario: "Tipo salário",
  salary: "Salário",
  _adiantamentoSalarial: "Adiantamento salarial",
  _porcentagemAdiantamento: "Porcentagem de adiantamento",
  _escalaTrabalho: "Escala de trabalho",
  _codigoDirf: "Código DIRF",
  _categoriaTrabalho: "Categoria de trabalho",
  _indicativoAdmissao: "Indicativo da admissão",
  _naturezaAtividade: "Natureza da atividade",
  _tipoAdmissao: "Tipo de admissão",
  _tipoRegimeTrabalhista: "Tipo de regime trabalhista",
  _tipoRegimePrevidenciario: "Tipo de regime previdenciário",
  _tipoContratoTrabalho: "Tipo de contrato de trabalho",
  _tipoContratacao: "Tipo de contratação",
  _cnpjSindicato: "CNPJ do sindicato",
  _razaoSocial: "Razão social",
};

/** Só as chaves reais da ficha — descarta as de fronteira (prefixo `_`). */
function keepMappedFields(fields: Record<string, string>) {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !key.startsWith("_")));
}

/** "-" é como este documento escreve "não preenchido" — não é um valor. */
function dropPlaceholderDashes(fields: Record<string, string>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim() !== "-"));
}

function compact(value: string | undefined) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * A ficha cadastral tem este marcador de seção sempre presente — é o que
 * distingue este layout do Registro de Empregado sem precisar adivinhar.
 */
export function looksLikeFichaCadastralSolides(text: string) {
  return /dados\s+do\s+colaborador/iu.test(text);
}

export function extractFichaCadastralSolidesFields(text: string): {
  fields: RegistrationFormRaw; warnings: string[]; found: number;
} {
  const sections = sliceByLabels(text, sectionLabels, SECTION_MAX_VALUE);
  const warnings: string[] = [];
  let found = 0;
  let fields: Record<string, string> = {};

  const runSection = (sectionKey: string, labels: Readonly<Record<string, string>>) => {
    const body = sections.fields[sectionKey];
    if (!body) {
      warnings.push(`Seção não encontrada na ficha cadastral: ${sectionLabels[sectionKey]}.`);
      return;
    }
    const sliced = sliceByLabels(body, labels, FIELD_MAX_VALUE);
    found += sliced.found;
    /* Rótulo de fronteira não tem campo na ficha — um aviso sobre ele
       ("não encontrado", ou valor implausível) não é uma pendência real de
       quem confere, é ruído interno do fatiamento. O caso concreto: um banco
       cujo nome começa com a própria palavra "Banco" ("Banco do Brasil",
       "Banco Bradesco") faz o valor "conter o rótulo", e sem este filtro
       isso viraria aviso na tela por um campo que nem é mostrado. */
    const boundaryLabelTexts = Object.entries(labels)
      .filter(([key]) => key.startsWith("_")).map(([, label]) => label);
    warnings.push(...sliced.warnings.filter((warning) => !boundaryLabelTexts.some((label) => warning.includes(label))));
    fields = { ...fields, ...dropPlaceholderDashes(keepMappedFields(sliced.fields)) };
  };

  runSection("employer", employerFieldLabels);
  runSection("personal", personalFieldLabels);
  runSection("bank", bankFieldLabels);
  runSection("contract", contractFieldLabels);

  /* "Residência" é o corpo inteiro da seção do endereço, sem fatiar campo a
     campo: o rótulo "Endereço" aparece DENTRO dela também (o logradouro), e
     fatiar de novo colidiria com o mesmo rótulo já usado para o endereço do
     empregador. A pessoa que confere já vê CEP, logradouro, bairro e cidade
     juntos — não precisa de um campo por pedaço. O "CEP: " é reposto na
     frente porque a âncora da seção (ver `sectionLabels.address`) é a
     própria palavra "CEP", consumida ao cortar. */
  const residenceBody = compact(sections.fields.address);
  if (residenceBody) { fields.residence = `CEP: ${residenceBody}`.slice(0, FIELD_MAX_VALUE); found += 1; }

  return { fields, warnings, found };
}
