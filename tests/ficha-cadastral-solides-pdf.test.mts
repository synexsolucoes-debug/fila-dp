import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildRegistrationSheet } from "../lib/employee-registration-form.ts";
import {
  extractFichaCadastralSolidesFields, looksLikeFichaCadastralSolides,
} from "../lib/ficha-cadastral-solides-pdf.ts";
import { readRegistrationFormPdf } from "../lib/registration-form-pdf.ts";

/**
 * A "Ficha Cadastral" da Sólides — um layout diferente do Registro de
 * Empregado que `registration-form-pdf.ts` foi construído para ler.
 *
 * NENHUM número aqui pertence a uma pessoa: são os mesmos fabricados usados
 * em `tests/employee-registration-form.test.mts` (dígito verificador
 * recalculado). O texto abaixo reproduz a ESTRUTURA de uma ficha real lida em
 * produção — seções, rótulos e ordem — só com conteúdo trocado.
 *
 * O que estes testes PROVAM — que a seção residencial não rouba o endereço
 * do empregador (os dois usam o mesmo rótulo "Endereço", em lugares
 * diferentes), que "-" é tratado como campo vazio e não como valor, que um
 * rótulo impresso pelo documento mas sem campo correspondente não faz o
 * campo vizinho engolir texto, e que o despacho entre os dois formatos
 * escolhe certo pela presença do marcador de seção.
 *
 * O que eles NÃO provam — que toda conta da Sólides exporta exatamente este
 * layout. É o que a primeira ficha real, lida em produção, confirmou para
 * esta conta; outra pode variar, e é para isso que o extrator antigo continua
 * como caminho de reserva.
 */

const FICHA_CADASTRAL_TEXT = `Dados do empregador
Empregador: EMPRESA EXEMPLO LTDA CNPJ: 11.222.333/0001-81
Endereço: Rua Modelo 100 Centro Cidade Exemplo
Dados do colaborador
Nome: Fulana de Tal Data de nascimento: 22/03/1996
Nome social: Fulana Sexo: Feminino Gênero: Feminino
Email: fulana@exemplo.test Telefone: (62) 90000-0000
Cor: Parda Estado Civil: Solteiro
Naturalidade: Goiás, Goiânia, Brasil Nacionalidade: Brasil
Nome da mãe: Beltrana de Tal Nome do pai: Ciclano de Tal
CPF: 111.222.333-96 RG: 12345678 Data de emissão RG:
10/10/2020
Órgão/UF emissor RG:
SSP-GO
Título de eleitor:
123456780191 Zona: 040 Seção: 0049 Órgão de classe: -
CTPS: - Série: - PIS: 123.45678.90-0 Data de emissão CTPS:
-
Certificado reservista: - Grau instrução: Ensino médio completo
PCD: - Quant. filhos: 0 Tamanho camisa: Tamanho M
Endereço
CEP: 75000-000 Endereço: Rua Residencial Logradouro: Rua
Nº: 10 Bairro: Setor Exemplo Complemento: Apto 1
Estado: Goiás País: Brasil Cidade: Cidade Exemplo
Dependentes
Dependente: Nenhum CPF: -
Dados bancários
Banco: BANCO EXEMPLO S.A. Nº da conta: 12345-6 Agência: 1234
Tipo da chave PIX: CPF Chave PIX: 111.222.333-96
Contatos de emergência
Nome do contato: Beltrana Telefone: (62) 90000-0001 Grau de parentesco: Mãe
Informações contratuais
Modelo de contratação: CLT Nº de registro: -
Matrícula eSocial: - Filial: Matriz
CNPJ da filial: -
Regime da jornada: Submetido a horário de
trabalho Data admissão: 13/10/2025
Cargo: Analista I E CBO: 252405 - Analista de sistemas
Local de trabalho: Comercial Centro de custo: COMERCIAL
Tipo salário: 5 - Por mês Salário: R$ 2.617,52
Adiantamento salarial: Não Porcentagem de adiantamento: 0%`;

test("looksLikeFichaCadastralSolides reconhece o marcador de seção, e só ele", () => {
  assert.equal(looksLikeFichaCadastralSolides(FICHA_CADASTRAL_TEXT), true);
  assert.equal(looksLikeFichaCadastralSolides("Empregador EMPRESA EXEMPLO LTDA CNPJ 11.222.333/0001-81"), false);
});

test("nome, CPF, RG, endereço e filiação saem certos, mesmo com os dois \"Endereço\" do documento", () => {
  const { fields, warnings, found } = extractFichaCadastralSolidesFields(FICHA_CADASTRAL_TEXT);
  assert.equal(fields.employerAddress, "Rua Modelo 100 Centro Cidade Exemplo",
    "o endereço do empregador não pode sumir para a seção residencial");
  assert.match(fields.residence ?? "", /75000-000/u, "a seção residencial começa em CEP, não no rótulo repetido \"Endereço\"");
  assert.match(fields.residence ?? "", /Cidade Exemplo/u);
  assert.equal(fields.fullName, "Fulana de Tal");
  assert.equal(fields.taxId, "111.222.333-96");
  assert.equal(fields.motherName, "Beltrana de Tal");
  assert.equal(fields.fatherName, "Ciclano de Tal");
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.ok(found > 20, `esperava dezenas de campos encontrados, achou ${found}`);
});

test("rótulo sem campo correspondente (Nome social, Gênero, Email) não faz o vizinho engolir texto", () => {
  const { fields } = extractFichaCadastralSolidesFields(FICHA_CADASTRAL_TEXT);
  // Se "Nome social"/"Gênero"/"Email" não fossem âncoras de fronteira, o
  // valor de "sex" ou "mobilePhone" atravessaria esses rótulos e viraria lixo.
  assert.equal(fields.sex, "Feminino");
  assert.equal(fields.mobilePhone, "(62) 90000-0000");
});

test('"-" é como o documento escreve campo vazio, e não vira valor', () => {
  const { fields } = extractFichaCadastralSolidesFields(FICHA_CADASTRAL_TEXT);
  assert.equal(fields.ctpsNumber, undefined);
  assert.equal(fields.ctpsSeries, undefined);
  assert.equal(fields.bookNumber, undefined);
  assert.equal(fields.esocialRegistration, undefined);
});

test("os campos passam pela mesma conferência de dígito verificador da ficha", () => {
  const { fields } = extractFichaCadastralSolidesFields(FICHA_CADASTRAL_TEXT);
  const sheet = buildRegistrationSheet(fields);
  assert.equal(sheet.warnings.length, 0, JSON.stringify(sheet.warnings));
  const byKey = Object.fromEntries(sheet.blocks.flatMap((block) => block.fields).map((field) => [field.key, field]));
  assert.equal(byKey.taxId?.status, "ok");
  assert.equal(byKey.pisNumber?.status, "ok");
  assert.equal(byKey.voterRegistration?.status, "ok");
  assert.equal(byKey.cbo?.value, "252405");
  assert.equal(byKey.salary?.value, "2.617,52");
});

test("readRegistrationFormPdf despacha para o extrator certo pelo marcador de seção", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([620, 900]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  let y = 870;
  for (const line of FICHA_CADASTRAL_TEXT.split("\n")) {
    page.drawText(line, { x: 20, y, size: 8, font });
    y -= 14;
  }
  const bytes = await document.save();
  const { fields, warnings } = await readRegistrationFormPdf(bytes);
  assert.equal(fields.fullName, "Fulana de Tal");
  assert.equal(fields.taxId, "111.222.333-96");
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
});

test("o Registro de Empregado tradicional continua caindo no extrator antigo", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([620, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Empregado FULANA DE TAL Data de nascimento 22/03/1996", { x: 20, y: 760, size: 9, font });
  page.drawText("CPF 111.222.333-96 Cargo ANALISTA I E", { x: 20, y: 740, size: 9, font });
  const bytes = await document.save();
  const { fields } = await readRegistrationFormPdf(bytes);
  assert.equal(fields.fullName, "FULANA DE TAL", "sem o marcador de seção, o extrator antigo continua sendo usado");
  assert.equal(fields.taxId, "111.222.333-96");
});
