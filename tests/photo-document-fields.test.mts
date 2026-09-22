import assert from "node:assert/strict";
import test from "node:test";
import { extractPhotoFields } from "../lib/photo-document-fields.ts";
import { sliceByLabels } from "../lib/label-anchored-text.ts";

/**
 * Sugestão de campo a partir do OCR de uma foto de documento (RG, CTPS).
 *
 * NENHUM número aqui pertence a uma pessoa: os CPF/PIS usados têm dígito
 * verificador recalculado, os mesmos de `tests/registration-form-pdf.test.mts`.
 *
 * O que estes testes PROVAM — que só vira sugestão o que passa numa
 * conferência (dígito verificador ou rótulo padronizado), que ambiguidade
 * (mais de um CPF/PIS válido no mesmo texto) não produz sugestão nenhuma, e
 * que nome nunca sai com confiança alta por ser texto livre.
 *
 * O que eles NÃO provam — que o provedor de OCR devolve texto nesse formato
 * para uma foto real de RG ou CTPS. Isso só uma foto real responde.
 */

test("foto sem texto legível não produz sugestão, e diz por quê", () => {
  const { fields, warnings } = extractPhotoFields("   ");
  assert.deepEqual(fields, {});
  assert.match(warnings[0] ?? "", /não tem texto legível/u);
});

test("um único CPF com dígito verificador correto vira sugestão de alta confiança", () => {
  const { fields, warnings } = extractPhotoFields("REPÚBLICA FEDERATIVA DO BRASIL CPF 111.222.333-96 VALIDADE 2030");
  assert.equal(fields.taxId?.value, "111.222.333-96");
  assert.equal(fields.taxId?.confidence, "ok");
  assert.equal(warnings.length, 0);
});

test("dois CPFs válidos no mesmo texto não produzem sugestão — ambiguidade vira aviso", () => {
  const { fields, warnings } = extractPhotoFields("111.222.333-96 e também 111.444.777-35 aparecem na foto");
  assert.equal(fields.taxId, undefined);
  assert.ok(warnings.some((warning) => warning.includes("Mais de um CPF válido")));
});

test("um único PIS com dígito verificador correto vira sugestão de alta confiança", () => {
  const { fields } = extractPhotoFields("PIS/PASEP Sob nº 123.45678.90-0 Cadastrado em 13/10/2025");
  assert.equal(fields.pisNumber?.value, "123.45678.90-0");
  assert.equal(fields.pisNumber?.confidence, "ok");
});

test("número de 11 dígitos sem dígito verificador batendo não vira sugestão", () => {
  const { fields } = extractPhotoFields("Documento 100.000.000-00 emitido em algum lugar");
  assert.equal(fields.taxId, undefined);
  assert.equal(fields.pisNumber, undefined);
});

test("nome pelo rótulo do RG/CTPS entra sempre com confiança baixa, por ser texto livre", () => {
  const { fields } = extractPhotoFields("CARTEIRA DE IDENTIDADE Nome FULANA DE TAL Data de Nascimento 22/03/1996");
  assert.equal(fields.fullName?.value, "FULANA DE TAL");
  assert.equal(fields.fullName?.confidence, "low", "texto livre nunca sai com confiança alta");
});

test("data de nascimento válida perto do rótulo vira sugestão de alta confiança", () => {
  const { fields, warnings } = extractPhotoFields("Data de Nascimento 22/03/1996 Nome FULANA DE TAL");
  assert.equal(fields.birthDate?.value, "22/03/1996");
  assert.equal(fields.birthDate?.confidence, "ok");
  assert.equal(warnings.length, 0);
});

test("trecho perto do rótulo de nascimento que não é data válida não vira sugestão", () => {
  const { fields, warnings } = extractPhotoFields("Data de Nascimento GOIÂNIA GO Nome FULANA DE TAL");
  assert.equal(fields.birthDate, undefined);
  assert.ok(warnings.some((warning) => warning.includes("Data de nascimento")));
});

test("CTPS, RG e outros campos curtos deliberadamente não são oferecidos", () => {
  const { fields } = extractPhotoFields("CTPS 7040520 Série 7107 RG 12.345.678-9 Nome FULANA DE TAL");
  assert.equal("ctpsNumber" in fields, false);
  assert.equal("ctpsSeries" in fields, false);
  assert.equal("identityCard" in fields, false);
});

/* -------------------------------------------------------------------------- *
 * `sliceByLabels`, extraído para servir tanto o PDF quanto o OCR de foto.
 * -------------------------------------------------------------------------- */

test("sliceByLabels ancora pelo rótulo independente da ordem, igual ao PDF", () => {
  const labels = { fullName: "Nome", birthDate: "Data de Nascimento" };
  const { fields } = sliceByLabels("Data de Nascimento 22/03/1996 Nome FULANA DE TAL", labels, 160);
  assert.equal(fields.fullName, "FULANA DE TAL");
  assert.equal(fields.birthDate, "22/03/1996");
});

test("sliceByLabels sem nenhum rótulo encontrado devolve aviso nomeado por rótulo", () => {
  const { fields, warnings, found } = sliceByLabels("texto qualquer sem rótulo nenhum", { fullName: "Nome" }, 160);
  assert.deepEqual(fields, {});
  assert.equal(found, 0);
  assert.ok(warnings.some((warning) => warning.includes("Nome")));
});
