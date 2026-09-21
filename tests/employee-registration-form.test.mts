import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRegistrationSheet, isValidCnpj, isValidDriverLicense, isValidPis, isValidRegistrationDate,
  isValidVoterRegistration, parseRegistrationMoney, registrationBlockClipboard, registrationFormBlocks,
  registrationFormFields,
} from "../lib/employee-registration-form.ts";

/**
 * A ficha de contratação montada a partir do Registro de Empregado.
 *
 * NENHUM número aqui pertence a uma pessoa. Todos são fabricados com dígito
 * verificador recalculado, justamente porque o que se testa é o dígito: uma
 * fixture com documento real provaria o mesmo e deixaria dado de pessoa no
 * repositório para sempre.
 *
 * O que estes testes PROVAM — que documento com dígito quebrado não chega à
 * tela como valor copiável, que campo vazio no registro é distinguido de campo
 * ilegível, e que o "copiar bloco" nunca carrega um campo reprovado.
 *
 * O que eles NÃO provam — a extração do texto do PDF, que ainda não existe e
 * depende da ordem interna do arquivo, e não da grade visual.
 */

const VALID = {
  cpf: "111.222.333-96",
  pis: "123.45678.90-0",
  cnh: "12345678900",
  voter: "123456780191",
  cnpj: "11.222.333/0001-81",
};

test("os dígitos verificadores aceitam documento coerente e recusam o alterado", () => {
  assert.equal(isValidPis(VALID.pis), true);
  assert.equal(isValidPis("123.45678.90-1"), false);
  assert.equal(isValidPis("111.11111.11-1"), false);

  assert.equal(isValidDriverLicense(VALID.cnh), true);
  assert.equal(isValidDriverLicense("12345678901"), false);

  assert.equal(isValidVoterRegistration(VALID.voter), true);
  assert.equal(isValidVoterRegistration("123456780192"), false);
  // Unidade federativa fora de 01–28 não existe, mesmo com dígito coerente.
  assert.equal(isValidVoterRegistration("123456789991"), false);

  assert.equal(isValidCnpj(VALID.cnpj), true);
  assert.equal(isValidCnpj("11.222.333/0001-82"), false);
});

test("a data do registro é DD/MM/AAAA, e dia impossível não passa", () => {
  assert.equal(isValidRegistrationDate("13/10/2025"), true);
  assert.equal(isValidRegistrationDate("31/02/2025"), false);
  assert.equal(isValidRegistrationDate("2025-10-13"), false);
});

test("o salário aceita o formato do registro e recusa texto", () => {
  assert.equal(parseRegistrationMoney("R$ 2.617,52"), 2617.52);
  assert.equal(parseRegistrationMoney("2617,52"), 2617.52);
  assert.equal(parseRegistrationMoney("dois mil"), null);
});

test("campo reprovado na conferência não vira valor copiável", () => {
  const sheet = buildRegistrationSheet({ fullName: "FULANA DE TAL", taxId: "111.222.333-00" });
  const taxId = sheet.blocks.flatMap((block) => block.fields).find((field) => field.key === "taxId");
  assert.equal(taxId?.status, "invalid");
  assert.equal(taxId?.value, "", "um CPF que não fecha nunca pode ser oferecido para cópia");
  assert.match(taxId?.note ?? "", /confira no arquivo/u);
  assert.equal(sheet.warnings.length, 1);
});

test("em branco no registro e ilegível são estados diferentes", () => {
  const sheet = buildRegistrationSheet({ taxId: "111.222.333-00" });
  const fields = sheet.blocks.flatMap((block) => block.fields);
  assert.equal(fields.find((field) => field.key === "bankNumber")?.status, "blank");
  assert.equal(fields.find((field) => field.key === "taxId")?.status, "invalid");
  assert.equal(sheet.filled, 1, "só o campo presente na entrada conta como preenchido");
  assert.equal(sheet.readable, 0);
});

test("a ficha normaliza o que passou e conta o que está pronto", () => {
  const sheet = buildRegistrationSheet({
    employerName: "EMPRESA EXEMPLO LTDA",
    employerTaxId: "11222333000181",
    fullName: "FULANA DE TAL",
    birthDate: "22/03/1996",
    taxId: "11122233396",
    pisNumber: "12345678900",
    driverLicense: "12345678900",
    voterRegistration: "123456780191",
    admissionDate: "13/10/2025",
    cbo: "252405",
    salary: "R$ 2.617,52",
  });
  const byKey = new Map(sheet.blocks.flatMap((block) => block.fields).map((field) => [field.key, field]));
  assert.equal(byKey.get("taxId")?.value, "111.222.333-96", "o CPF sai pontuado, como o ERP espera");
  assert.equal(byKey.get("pisNumber")?.value, "123.45678.90-0");
  assert.equal(byKey.get("employerTaxId")?.value, "11.222.333/0001-81");
  assert.equal(byKey.get("salary")?.value, "2.617,52", "o salário sai como número, pronto para o campo do ERP");
  assert.doesNotMatch(byKey.get("salary")?.value ?? "", /[\u00a0R$]/u,
    "símbolo e espaço não separável atravessariam a área de transferência e o ERP recusaria o valor");
  assert.equal(sheet.warnings.length, 0);
  assert.equal(sheet.readable, 11);
});

test("copiar bloco leva só o que passou na conferência", () => {
  const sheet = buildRegistrationSheet({ fullName: "FULANA DE TAL", birthDate: "32/13/2025" });
  const personal = sheet.blocks.find((block) => block.block === "personal");
  const clipboard = registrationBlockClipboard(personal!);
  assert.equal(clipboard, "Empregado: FULANA DE TAL");
  assert.doesNotMatch(clipboard, /nascimento/iu, "data reprovada não pode entrar na área de transferência");
});

test("o mapa de campos cobre os blocos do registro sem chave repetida", () => {
  const keys = registrationFormFields.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const block of registrationFormBlocks) {
    assert.ok(registrationFormFields.some((field) => field.block === block), `bloco ${block} sem campo`);
  }
});
