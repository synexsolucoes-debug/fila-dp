import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildRegistrationSheet } from "../lib/employee-registration-form.ts";
import {
  ambiguousLabels, extractRegistrationFields, foldKeepingLength, readRegistrationFormPdf,
  registrationFormLabels,
} from "../lib/registration-form-pdf.ts";

/**
 * A leitura do Registro de Empregado em PDF.
 *
 * NENHUM número aqui pertence a uma pessoa: todos são fabricados com dígito
 * verificador recalculado. O PDF dos testes é gerado na hora, e é isso que
 * permite provar a independência de ordem — o texto é escrito embaralhado de
 * propósito, coisa que um arquivo de exemplo fixo não deixaria fazer.
 *
 * O que estes testes PROVAM — que o fatiamento se ancora nos rótulos e não na
 * ordem, que rótulo curto não casa dentro de rótulo longo, e que um fatiamento
 * errado em campo com dígito verificador morre na conferência em vez de virar
 * valor copiável.
 *
 * O que eles NÃO provam — que os rótulos escritos em `registrationFormLabels`
 * são exatamente os que a Sólides emite. Isso só uma ficha real responde, e é
 * por isso que rótulo não encontrado vira aviso nomeando o rótulo, em vez de
 * falhar calado.
 */

async function pdfWithLines(lines: readonly string[]) {
  const document = await PDFDocument.create();
  const page = document.addPage([620, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  let y = 760;
  for (const line of lines) {
    page.drawText(line, { x: 20, y, size: 9, font });
    y -= 18;
  }
  return document.save();
}

/** Blocos fora da ordem do documento, para que a ordem não possa ser a âncora. */
const SCRAMBLED = [
  "Data de Admissão 13/10/2025 Salário R$ 2.617,52 Cargo ANALISTA I E C.B.O. 252405",
  "CTPS 7040520 Série 7107 Data de expedição da CTPS 10/10/2025 UF CTPS GO",
  "Sob nº 123.45678.90-0 Cadastrado em 13/10/2025 Domicílio bancário",
  "Empregador EMPRESA EXEMPLO LTDA CNPJ 11.222.333/0001-81",
  "CPF 111.222.333-96 Cart. Nac. Habilitação 12345678900 Título Eleitoral 123456780191",
  "Empregado FULANA DE TAL Data de nascimento 22/03/1996 Estado civil Casado",
];

test("os campos saem do PDF sem depender da ordem interna do arquivo", async () => {
  const { fields, warnings } = await readRegistrationFormPdf(await pdfWithLines(SCRAMBLED));

  assert.equal(fields.fullName, "FULANA DE TAL");
  assert.equal(fields.taxId, "111.222.333-96");
  assert.equal(fields.pisNumber, "123.45678.90-0");
  assert.equal(fields.cbo, "252405", "o rótulo seguinte delimita a fatia, mesmo em outra linha");
  assert.equal(fields.employerName, "EMPRESA EXEMPLO LTDA");
  assert.equal(fields.admissionDate, "13/10/2025");
  assert.equal(fields.ctpsState, "GO");
  // Rótulo ausente vira aviso nomeado, nunca silêncio.
  assert.ok(warnings.some((warning) => warning.includes("Telefone Celular")));
});

test("rótulo curto não casa dentro de rótulo longo", async () => {
  const { fields } = await readRegistrationFormPdf(await pdfWithLines(SCRAMBLED));
  // `CTPS` existe sozinho e dentro de `Data de expedição da CTPS` e `UF CTPS`.
  assert.equal(fields.ctpsNumber, "7040520");
  assert.equal(fields.ctpsIssueDate, "10/10/2025");
  // `Empregado` é prefixo de `Empregador`; a fronteira de palavra separa os dois.
  assert.equal(fields.fullName, "FULANA DE TAL");
  assert.notEqual(fields.employerName, "FULANA DE TAL");
});

test("o indicador ordinal do rótulo do PIS é normalizado", () => {
  assert.equal(foldKeepingLength("Sob nº"), foldKeepingLength("SOB N°"));
  assert.equal(foldKeepingLength("Sob nº").length, "Sob nº".length, "o índice tem de continuar valendo");
  const semOrdinal = extractRegistrationFields("Sob n° 123.45678.90-0 Cadastrado em 13/10/2025");
  assert.equal(semOrdinal.fields.pisNumber, "123.45678.90-0");
});

test("rótulo colado no seguinte não inventa valor", () => {
  // A fatia entre os dois rótulos é vazia: o campo fica ausente, e ausente é
  // um estado honesto — nada é adivinhado para preencher o buraco.
  const { fields } = extractRegistrationFields("Cargo Cadastrado em 13/10/2025");
  assert.equal(fields.position, undefined);
  assert.equal(fields.pisRegisteredAt, "13/10/2025");
});

test("fatia que engole um rótulo repetido vira ausência, não conteúdo", () => {
  // `Cargo` aparece duas vezes. A primeira vira âncora; a segunda cai dentro da
  // fatia de `Sexo`, e é esse o sinal de que o fatiamento atravessou um campo.
  const { fields, warnings } = extractRegistrationFields("Cargo ANALISTA Sexo Feminino Cargo ANALISTA");
  assert.equal(fields.position, "ANALISTA");
  assert.equal(fields.sex, undefined, "valor contendo outro rótulo é fatiamento errado");
  assert.ok(warnings.some((warning) => warning.includes("Sexo")));
});

test("fatiamento errado em campo com dígito morre na conferência", () => {
  // O documento não traz o rótulo do PIS, então a fatia do C.B.O. engole o resto.
  const { fields } = extractRegistrationFields("C.B.O. 252405 123.45678.90-0");
  assert.equal(fields.cbo, "252405 123.45678.90-0");

  const sheet = buildRegistrationSheet(fields);
  const cbo = sheet.blocks.flatMap((block) => block.fields).find((field) => field.key === "cbo");
  assert.equal(cbo?.status, "invalid");
  assert.equal(cbo?.value, "", "um C.B.O. mal fatiado nunca chega ao ERP");
});

test("documento sem texto é dito, não adivinhado", () => {
  const empty = extractRegistrationFields("   ");
  assert.equal(empty.found, 0);
  assert.match(empty.warnings[0] ?? "", /não tem texto legível/u);
});

test("campo de rótulo ambíguo não é lido, e o motivo está declarado", () => {
  for (const key of Object.keys(ambiguousLabels)) {
    assert.equal(registrationFormLabels[key], undefined,
      `${key} tem rótulo que não o identifica sozinho e não pode ser extraído`);
  }
  assert.equal(ambiguousLabels.driverLicenseCategory, ambiguousLabels.militaryCategory,
    "as duas Categoria são o mesmo rótulo — é essa colisão que impede a leitura");
});
