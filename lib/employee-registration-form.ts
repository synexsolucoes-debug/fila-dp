/**
 * Ficha de contratação a partir do Registro de Empregado.
 *
 * ## Por que o módulo não se chama `solides-*`
 *
 * O documento lido aqui é o **Registro de Empregado** — a ficha cujo conteúdo
 * mínimo é fixado pela legislação trabalhista, e não pelo fornecedor que a
 * emite. Rótulos, blocos e ordem são os mesmos saindo da Sólides, do Domínio ou
 * de um registro em papel digitalizado pelo cliente.
 *
 * Isso tem consequência prática: um parser preso ao nome do fornecedor seria
 * jogado fora na primeira troca de sistema, e outro nasceria igual ao lado. O
 * acoplamento com a Sólides fica onde ele de fato existe — na obtenção do
 * arquivo (`lib/tangerino/attachments-worker.ts`) — e não na leitura dele.
 *
 * ## O que este módulo faz, e o que ele deliberadamente não faz
 *
 * Ele **normaliza e valida** campos já extraídos, e monta a ficha que a tela
 * apresenta para transcrição no ERP. Ele não abre PDF, não fala com navegador e
 * não decide o que fazer com o resultado. É função pura: o teste da regra não
 * precisa de arquivo, e o teste da extração não precisa da regra — a mesma
 * separação que `lib/tangerino/parser.ts` já mantém entre interpretar e navegar.
 *
 * A extração do texto do PDF é o passo seguinte e mora em outro lugar, porque
 * depende da ordem interna do arquivo, que não é a ordem visual da grade. O
 * precedente é `lib/payroll-pdf.ts`, onde os rótulos aparecem grudados no valor
 * do campo vizinho.
 *
 * ## A regra que sustenta a ficha inteira
 *
 * Campo que não passa na validação **não vira valor copiável**. Ele é marcado
 * como ilegível e a tela manda conferir no arquivo.
 *
 * O motivo é assimétrico e vale ser dito: um campo que ficou vazio é um erro que
 * se denuncia sozinho — quem transcreve vê o buraco. Um campo preenchido com o
 * número errado — o RG que a extração colocou na casa do CPF — é aceito pelo
 * ERP, atravessa a admissão inteira e só aparece no eSocial. Por isso o dígito
 * verificador é conferido aqui, antes de qualquer coisa ser oferecida para
 * cópia: é o que separa "não consegui ler" de "li outra coisa".
 */
import { isValidCpf } from "./registrations.ts";

/** Bloco da ficha, na ordem em que o Registro de Empregado os apresenta. */
export const registrationFormBlocks = ["employer", "personal", "documents", "contract", "fgtsPis"] as const;
export type RegistrationFormBlock = typeof registrationFormBlocks[number];

export const registrationFormBlockLabels: Record<RegistrationFormBlock, string> = {
  employer: "Empregador",
  personal: "Dados pessoais",
  documents: "Documentos",
  contract: "Contrato",
  fgtsPis: "FGTS e PIS",
};

/**
 * Como cada campo é conferido.
 *
 * `text` não é ausência de regra: é a decisão explícita de que aquele campo não
 * tem como ser validado sem inventar cadastro (nome de pai, endereço, cargo).
 * Chamá-lo de validado seria prometer uma conferência que não acontece.
 */
export type RegistrationFieldKind =
  | "text" | "date" | "cpf" | "cnpj" | "pis" | "driverLicense" | "voterRegistration" | "cbo" | "money";

export type RegistrationFormField = {
  key: string;
  label: string;
  block: RegistrationFormBlock;
  kind: RegistrationFieldKind;
};

/**
 * O mapa de campos do Registro de Empregado.
 *
 * A ordem importa: é ela que a tela usa para montar os blocos e o "copiar bloco
 * inteiro", e é a ordem em que o documento apresenta os campos — o que faz a
 * transcrição andar de cima para baixo sem pular de uma tela para outra.
 */
export const registrationFormFields: readonly RegistrationFormField[] = [
  { key: "employerName", label: "Empregador", block: "employer", kind: "text" },
  { key: "employerTaxId", label: "CNPJ", block: "employer", kind: "cnpj" },
  { key: "employerAddress", label: "Endereço", block: "employer", kind: "text" },
  { key: "esocialRegistration", label: "Matrícula eSocial", block: "employer", kind: "text" },
  { key: "bookNumber", label: "Nº de registro", block: "employer", kind: "text" },

  { key: "fullName", label: "Empregado", block: "personal", kind: "text" },
  { key: "birthDate", label: "Data de nascimento", block: "personal", kind: "date" },
  { key: "birthPlace", label: "Local do nascimento", block: "personal", kind: "text" },
  { key: "nationality", label: "País da nacionalidade", block: "personal", kind: "text" },
  { key: "maritalStatus", label: "Estado civil", block: "personal", kind: "text" },
  { key: "fatherName", label: "Filiação — pai", block: "personal", kind: "text" },
  { key: "motherName", label: "Filiação — mãe", block: "personal", kind: "text" },
  { key: "residence", label: "Residência", block: "personal", kind: "text" },
  { key: "beneficiaries", label: "Beneficiários", block: "personal", kind: "text" },
  { key: "race", label: "Cor", block: "personal", kind: "text" },
  { key: "sex", label: "Sexo", block: "personal", kind: "text" },
  { key: "education", label: "Grau de instrução", block: "personal", kind: "text" },
  { key: "disability", label: "Deficiência", block: "personal", kind: "text" },
  { key: "homePhone", label: "Telefone residencial", block: "personal", kind: "text" },
  { key: "mobilePhone", label: "Telefone celular", block: "personal", kind: "text" },

  { key: "taxId", label: "CPF", block: "documents", kind: "cpf" },
  { key: "identityCard", label: "Cédula de identidade", block: "documents", kind: "text" },
  { key: "identityIssueDate", label: "Data de emissão do RG", block: "documents", kind: "date" },
  { key: "identityIssuer", label: "Órgão/UF emissor", block: "documents", kind: "text" },
  { key: "ctpsNumber", label: "CTPS — número", block: "documents", kind: "text" },
  { key: "ctpsSeries", label: "CTPS — série", block: "documents", kind: "text" },
  { key: "ctpsIssueDate", label: "Data de expedição da CTPS", block: "documents", kind: "date" },
  { key: "ctpsState", label: "UF da CTPS", block: "documents", kind: "text" },
  { key: "voterRegistration", label: "Título eleitoral", block: "documents", kind: "voterRegistration" },
  { key: "voterZone", label: "Zona eleitoral", block: "documents", kind: "text" },
  { key: "voterSection", label: "Seção eleitoral", block: "documents", kind: "text" },
  { key: "driverLicense", label: "Carteira nacional de habilitação", block: "documents", kind: "driverLicense" },
  { key: "driverLicenseCategory", label: "Categoria da CNH", block: "documents", kind: "text" },
  { key: "militaryDocument", label: "Documento militar", block: "documents", kind: "text" },
  { key: "militaryCategory", label: "Categoria militar", block: "documents", kind: "text" },
  { key: "professionalBoard", label: "Inscrição em órgão de classe", block: "documents", kind: "text" },

  { key: "admissionDate", label: "Data de admissão", block: "contract", kind: "date" },
  { key: "position", label: "Cargo", block: "contract", kind: "text" },
  { key: "jobFunction", label: "Função", block: "contract", kind: "text" },
  { key: "cbo", label: "C.B.O.", block: "contract", kind: "cbo" },
  { key: "salary", label: "Salário", block: "contract", kind: "money" },
  { key: "salaryUnit", label: "Unidade do salário", block: "contract", kind: "text" },
  { key: "workSchedule", label: "Horário de trabalho", block: "contract", kind: "text" },
  { key: "breakSchedule", label: "Horário de intervalo", block: "contract", kind: "text" },

  { key: "pisNumber", label: "PIS/PASEP", block: "fgtsPis", kind: "pis" },
  { key: "pisRegisteredAt", label: "PIS — cadastrado em", block: "fgtsPis", kind: "date" },
  { key: "fgtsOptionDate", label: "FGTS — opção em", block: "fgtsPis", kind: "date" },
  { key: "fgtsLinkedAccountBank", label: "FGTS — conta vinculada no banco", block: "fgtsPis", kind: "text" },
  { key: "fgtsRectificationDate", label: "FGTS — data da retificação", block: "fgtsPis", kind: "date" },
  { key: "bankDomicile", label: "Domicílio bancário", block: "fgtsPis", kind: "text" },
  { key: "bankNumber", label: "Nº do banco", block: "fgtsPis", kind: "text" },
  { key: "bankBranch", label: "Agência", block: "fgtsPis", kind: "text" },
  { key: "bankBranchAddress", label: "Endereço da agência", block: "fgtsPis", kind: "text" },
] as const;

export type RegistrationFormRaw = Partial<Record<string, string>>;

/**
 * Estado de um campo lido.
 *
 * `blank` e `invalid` existem separados porque pedem coisas diferentes de quem
 * lê: `blank` é um dado que o documento não tem — buscar na origem; `invalid` é
 * um dado que o documento tem e a leitura não conseguiu recuperar — conferir no
 * arquivo. Juntá-los num "sem valor" faria a tela dar a mesma instrução para
 * dois problemas com soluções opostas.
 */
export type RegistrationFieldStatus = "ok" | "blank" | "invalid";

export type RegistrationSheetField = RegistrationFormField & {
  status: RegistrationFieldStatus;
  /** Valor formatado para leitura. Vazio quando o campo não está `ok`. */
  value: string;
  /** O que a tela mostra no lugar do valor quando ele não pode ser oferecido. */
  note: string;
};

export type RegistrationSheetBlock = {
  block: RegistrationFormBlock;
  label: string;
  fields: RegistrationSheetField[];
};

export type RegistrationSheet = {
  blocks: RegistrationSheetBlock[];
  warnings: string[];
  /** Quantos campos saíram prontos para transcrever, de quantos o documento traz. */
  readable: number;
  filled: number;
};

const digitsOnly = (value: string) => value.replace(/\D/gu, "");

function clean(value: string | undefined) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 300) : "";
}

/** `DD/MM/AAAA`, que é como o Registro de Empregado escreve toda data. */
export function isValidRegistrationDate(value: string) {
  const match = /^([0-3][0-9])\/([01][0-9])\/([12][0-9]{3})$/u.exec(value.trim());
  if (!match) return false;
  const [, day, month, year] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCDate() === Number(day)
    && date.getUTCMonth() + 1 === Number(month);
}

/**
 * PIS/PASEP/NIS por módulo 11.
 *
 * Onze dígitos, os dez primeiros ponderados por 3,2,9,8,7,6,5,4,3,2. Resto menor
 * que 2 significa dígito zero — e não `11 - resto`, que daria 10 ou 11 e não
 * cabe numa casa decimal.
 */
export function isValidPis(value: string) {
  const digits = digitsOnly(value);
  if (!/^\d{11}$/u.test(digits) || /^(\d)\1{10}$/u.test(digits)) return false;
  const weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
  const remainder = sum % 11;
  return (remainder < 2 ? 0 : 11 - remainder) === Number(digits[10]);
}

/**
 * CNH: dois dígitos verificadores em módulo 11, com pesos em sentidos opostos.
 *
 * O desconto do segundo dígito existe no algoritmo oficial: quando o primeiro
 * resto passa de nove, o primeiro dígito vira zero e o segundo é calculado dois
 * a menos. Sem esse ajuste, toda habilitação nessa faixa seria recusada como
 * inválida.
 */
export function isValidDriverLicense(value: string) {
  const digits = digitsOnly(value);
  if (!/^\d{11}$/u.test(digits) || /^(\d)\1{10}$/u.test(digits)) return false;
  let first = 0;
  let second = 0;
  for (let index = 0; index < 9; index += 1) {
    first += Number(digits[index]) * (9 - index);
    second += Number(digits[index]) * (index + 1);
  }
  let firstCheck = first % 11;
  let discount = 0;
  if (firstCheck >= 10) { firstCheck = 0; discount = 2; }
  let secondCheck = second % 11;
  if (secondCheck >= 10) secondCheck = 0;
  secondCheck -= discount;
  if (secondCheck < 0) secondCheck += 11;
  return firstCheck === Number(digits[9]) && secondCheck === Number(digits[10]);
}

/**
 * Título de eleitor: oito dígitos sequenciais, dois de unidade federativa e dois
 * verificadores. O segundo verificador é calculado sobre a UF e o primeiro
 * dígito — e não sobre o número inteiro, que é o engano comum.
 */
export function isValidVoterRegistration(value: string) {
  const digits = digitsOnly(value).padStart(12, "0");
  if (!/^\d{12}$/u.test(digits) || /^(\d)\1{11}$/u.test(digits)) return false;
  const state = Number(digits.slice(8, 10));
  if (state < 1 || state > 28) return false;
  let sequential = 0;
  for (let index = 0; index < 8; index += 1) sequential += Number(digits[index]) * (index + 2);
  const firstCheck = sequential % 11 >= 10 ? 0 : sequential % 11;
  if (firstCheck !== Number(digits[10])) return false;
  const stateSum = Number(digits[8]) * 7 + Number(digits[9]) * 8 + firstCheck * 9;
  const secondCheck = stateSum % 11 >= 10 ? 0 : stateSum % 11;
  return secondCheck === Number(digits[11]);
}

export function isValidCnpj(value: string) {
  const digits = digitsOnly(value);
  if (!/^\d{14}$/u.test(digits) || /^(\d)\1{13}$/u.test(digits)) return false;
  const check = (length: number) => {
    let weight = length - 7;
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * weight;
      weight = weight - 1 < 2 ? 9 : weight - 1;
    }
    const remainder = sum % 11;
    return (remainder < 2 ? 0 : 11 - remainder) === Number(digits[length]);
  };
  return check(12) && check(13);
}

/** `R$ 2.617,52` e `2.617,52` viram o mesmo número. */
export function parseRegistrationMoney(value: string) {
  const raw = value.replace(/R\$/iu, "").replace(/\s/gu, "");
  if (!/^-?\d{1,3}(\.\d{3})*(,\d{2})?$|^-?\d+(,\d{2})?$/u.test(raw)) return null;
  const parsed = Number(raw.replace(/\./gu, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Salário sai como número, sem `R$`.
 *
 * Duas razões, e a segunda só aparece depois de colar. O campo de salário do
 * ERP recebe o valor, não o símbolo. E `style: "currency"` insere um espaço
 * não separável (U+00A0) entre o símbolo e o número — um caractere invisível
 * que atravessa a área de transferência e faz o ERP recusar o valor sem dizer
 * qual é o problema. Formatar só o número elimina os dois.
 */
const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Aplica a regra de cada tipo e devolve o valor já no formato de cópia. */
function checkField(field: RegistrationFormField, raw: string): { status: RegistrationFieldStatus; value: string } {
  switch (field.kind) {
    case "date":
      return isValidRegistrationDate(raw) ? { status: "ok", value: raw } : { status: "invalid", value: "" };
    case "cpf": {
      const digits = digitsOnly(raw);
      return isValidCpf(digits)
        ? { status: "ok", value: `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` }
        : { status: "invalid", value: "" };
    }
    case "cnpj": {
      const digits = digitsOnly(raw);
      return isValidCnpj(digits)
        ? { status: "ok", value: `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}` }
        : { status: "invalid", value: "" };
    }
    case "pis": {
      const digits = digitsOnly(raw);
      return isValidPis(digits)
        ? { status: "ok", value: `${digits.slice(0, 3)}.${digits.slice(3, 8)}.${digits.slice(8, 10)}-${digits.slice(10)}` }
        : { status: "invalid", value: "" };
    }
    case "driverLicense":
      return isValidDriverLicense(raw) ? { status: "ok", value: digitsOnly(raw) } : { status: "invalid", value: "" };
    case "voterRegistration":
      return isValidVoterRegistration(raw) ? { status: "ok", value: digitsOnly(raw) } : { status: "invalid", value: "" };
    case "cbo": {
      const digits = digitsOnly(raw);
      return /^\d{6}$/u.test(digits) ? { status: "ok", value: digits } : { status: "invalid", value: "" };
    }
    case "money": {
      const parsed = parseRegistrationMoney(raw);
      return parsed === null ? { status: "invalid", value: "" } : { status: "ok", value: decimal.format(parsed) };
    }
    default:
      return { status: "ok", value: raw };
  }
}

const NOTES: Record<RegistrationFieldStatus, string> = {
  ok: "",
  blank: "Em branco no registro — buscar na origem.",
  invalid: "Não foi possível ler com segurança — confira no arquivo.",
};

/**
 * Monta a ficha de contratação a partir dos campos já extraídos.
 *
 * Recebe texto cru por campo e devolve o que a tela apresenta. Nada é inventado:
 * campo ausente na entrada e campo vazio no documento dão no mesmo resultado,
 * porque para quem transcreve são o mesmo problema — o registro não traz o dado.
 */
export function buildRegistrationSheet(raw: RegistrationFormRaw): RegistrationSheet {
  const warnings: string[] = [];
  let readable = 0;
  let filled = 0;

  const fields = registrationFormFields.map((field): RegistrationSheetField => {
    const value = clean(raw[field.key]);
    if (!value) return { ...field, status: "blank", value: "", note: NOTES.blank };
    filled += 1;
    const checked = checkField(field, value);
    if (checked.status === "ok") readable += 1;
    else warnings.push(`${field.label}: valor lido não passou na conferência.`);
    return { ...field, status: checked.status, value: checked.value, note: NOTES[checked.status] };
  });

  const blocks = registrationFormBlocks.map((block) => ({
    block,
    label: registrationFormBlockLabels[block],
    fields: fields.filter((field) => field.block === block),
  })).filter((entry) => entry.fields.length > 0);

  return { blocks, warnings, readable, filled };
}

/** Texto do "copiar bloco inteiro": só o que está pronto para transcrever. */
export function registrationBlockClipboard(block: RegistrationSheetBlock) {
  return block.fields
    .filter((field) => field.status === "ok")
    .map((field) => `${field.label}: ${field.value}`)
    .join("\n");
}
