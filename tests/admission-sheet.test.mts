import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractText, getDocumentProxy } from "unpdf";

process.env.FDP_INTEGRATION_VAULT_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { openSheet, sanitizeSheetFields, sanitizeSheetWarnings, sealSheet } = await import("../lib/admission-sheet.ts");
const { chooseRegistrationFormAttachment, REGISTRATION_FORM_FILENAME } = await import("../lib/registration-form-file.ts");
const { capabilitiesForRole } = await import("../lib/authorization.ts");
const { buildRegistrationSheet } = await import("../lib/employee-registration-form.ts");
const { sealCredentials } = await import("../lib/integrations.ts");
const { buildVinculatoAdmissionSheetPdf } = await import("../lib/vinculato-admission-sheet-pdf.ts");

/**
 * O envelope da ficha de contratação e a fronteira que ele protege.
 *
 * NENHUM número aqui pertence a uma pessoa.
 *
 * O que estes testes PROVAM — que o envelope da ficha não é intercambiável com
 * o de credencial mesmo com a mesma chave, que só chave conhecida do mapa de
 * campos entra no envelope, que os avisos guardados em coluna aberta não
 * carregam conteúdo, e que ler a ficha é permissão separada de ver o anexo.
 *
 * O que eles NÃO provam — o comportamento das rotas contra banco real. Isso é
 * o ensaio de banco, e não cabe numa função pura.
 */

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("o que entra cifrado volta igual", () => {
  const fields = { fullName: "FULANA DE TAL", taxId: "111.222.333-96", pisNumber: "123.45678.90-0" };
  const sealed = sealSheet(fields);
  assert.notEqual(sealed.encryptedValue, "");
  assert.ok(!sealed.encryptedValue.includes("FULANA"), "o texto claro não pode sobreviver no envelope");
  assert.deepEqual(openSheet(sealed), fields);
});

test("o mesmo conteúdo em outra ordem produz o mesmo texto claro", () => {
  const a = openSheet(sealSheet({ taxId: "111.222.333-96", fullName: "FULANA" }));
  const b = openSheet(sealSheet({ fullName: "FULANA", taxId: "111.222.333-96" }));
  assert.deepEqual(a, b);
});

test("envelope de credencial não abre como ficha", () => {
  // Mesma chave, cofres diferentes: o dado adicional autenticado separa os dois.
  // Sem isso, trocar as linhas de lugar no banco abriria um pelo outro.
  const credential = sealCredentials("email", { token: "0".repeat(20) });
  assert.throws(() => openSheet({
    encryptedValue: credential.encryptedValue,
    initializationVector: credential.initializationVector,
    authTag: credential.authTag,
    keyVersion: credential.keyVersion,
  }), /ADMISSION_SHEET_DECRYPTION_FAILED|não foi possível abrir/iu);
});

test("envelope adulterado é recusado, não aberto pela metade", () => {
  const sealed = sealSheet({ fullName: "FULANA DE TAL" });
  const corrupted = Buffer.from(sealed.encryptedValue, "base64");
  corrupted[0] ^= 0xff;
  assert.throws(() => openSheet({ ...sealed, encryptedValue: corrupted.toString("base64") }));
});

test("só chave do mapa de campos entra no envelope", () => {
  const fields = sanitizeSheetFields({
    fullName: "FULANA DE TAL",
    __proto__: "poluição",
    campoInventado: "valor",
    taxId: 12345,
  });
  assert.deepEqual(Object.keys(fields), ["fullName"], "leitura de arquivo é entrada não confiável");
});

test("os avisos guardados em coluna aberta são metadado, com teto", () => {
  const warnings = sanitizeSheetWarnings([
    "CPF: valor lido não passou na conferência.",
    "   ", 42, null,
    ...Array.from({ length: 80 }, (_unused, index) => `aviso ${index}`),
  ]);
  assert.equal(warnings[0], "CPF: valor lido não passou na conferência.");
  assert.ok(warnings.length <= 60, "coluna aberta cresce sem ninguém olhar");
  assert.ok(warnings.every((warning) => warning.length <= 200));
  assert.equal(sanitizeSheetWarnings(["aviso repetido", "aviso repetido"]).length, 1,
    "o mesmo problema não deve aparecer duas vezes na demanda");
});

test("o Vinculato emite uma ficha PDF própria com campos e pendências visíveis", async () => {
  const sheet = buildRegistrationSheet({
    fullName: "FULANA DE TAL",
    admissionDate: "13/10/2025",
    taxId: "111.222.333-00",
  });
  const bytes = await buildVinculatoAdmissionSheetPdf({
    sheet,
    provenance: { fullName: { source: "document" }, admissionDate: { source: "registry" } },
    sourceFilename: "ficha-cadastral.pdf",
    generatedAt: new Date("2026-09-22T12:00:00.000Z"),
  });
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  const parsed = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(parsed, { mergePages: true });
  assert.match(text, /FICHA DE ADMISSÃO/u);
  assert.match(text, /FULANA DE TAL/u);
  assert.match(text, /Conferir no documento/u,
    "campo inválido precisa continuar evidente na ficha emitida");
});

test("a ficha é reconhecida entre os anexos, inclusive renumerada pelo ZIP", () => {
  const pdf = "application/pdf";
  assert.equal(chooseRegistrationFormAttachment([
    { id: "a", filename: "rg.pdf", contentType: pdf },
    { id: "b", filename: REGISTRATION_FORM_FILENAME, contentType: pdf },
  ])?.id, "b");
  assert.equal(chooseRegistrationFormAttachment([
    { id: "c", filename: "ficha-cadastral-solides (2).pdf", contentType: pdf },
  ])?.id, "c");
  // Imagem com o nome da ficha não é a ficha: o leitor exige PDF.
  assert.equal(chooseRegistrationFormAttachment([
    { id: "d", filename: REGISTRATION_FORM_FILENAME, contentType: "image/png" },
  ]), null);
  assert.equal(chooseRegistrationFormAttachment([]), null);
});

test("ler a ficha é permissão separada de ver o anexo", () => {
  for (const role of ["admin", "member"] as const) {
    assert.ok(capabilitiesForRole(role).includes("admission.sheet.read"), `${role} transcreve admissão`);
  }
  for (const role of ["observer", "guest"] as const) {
    const granted = capabilitiesForRole(role);
    assert.ok(!granted.includes("admission.sheet.read"), `${role} não lê documento transcrito`);
  }
  // O observador continua vendo que existe anexo — é essa a diferença.
  assert.ok(capabilitiesForRole("observer").includes("attachments.read"));
});

test("a rota da ficha cobra a permissão e audita o acesso, não o conteúdo", () => {
  const route = source("../app/api/cards/[id]/registration-sheet/route.ts");
  assert.match(route, /requireCapability\(workspace, "admission\.sheet\.read"\)/u);
  assert.match(route, /action: "admission\.sheet\.read"/u);

  /* A asserção mudou junto com a rota, e a versão nova é mais estreita.
     
     Antes ela recusava qualquer `fields` dentro de `after`, o que era um proxy
     grosseiro para "sem conteúdo". A edição manual precisa registrar QUAIS
     campos mudaram — e `Object.keys` são nomes de campo, não valores. O que
     não pode aparecer é o conteúdo, e é isso que se cobra agora. */
  assert.match(route, /after: \{ fields: Object\.keys\(incoming\) \}/u,
    "a auditoria da edição nomeia os campos alterados");
  for (const vazamento of ["after: { fields: incoming", "after: { ...incoming", "after: { values"]) {
    assert.ok(!route.includes(vazamento),
      `auditar o conteúdo desfaria a cifra no histórico (${vazamento})`);
  }
});

test("a emissão da ficha Vinculato reutiliza a mesma rota protegida", () => {
  const route = source("../app/api/cards/[id]/registration-sheet/pdf/route.ts");
  assert.match(route, /GET as getRegistrationSheet/u,
    "o PDF não pode criar um segundo caminho sem a permissão e auditoria da ficha");
  assert.match(route, /buildVinculatoAdmissionSheetPdf/u);
  assert.match(route, /Content-Type": "application\/pdf/u);
  assert.match(route, /Cache-Control": "no-store/u);
});

test("concluir a demanda agenda o expurgo, em vez de apagar no ato", () => {
  /* Contrato trocado de propósito.
     
     A versão anterior apagava a ficha no instante da conclusão, e este teste
     cobrava isso. Parecia cuidadoso e era cedo demais: erro de digitação no ERP
     aparece no dia seguinte, e a conferência ficava sem o material que a
     sustentaria — restava reabrir sessão de navegador e baixar tudo de novo,
     incomodando a origem por um problema nosso.
     
     O dado continua tendo prazo; o que mudou é que ele passa a ser uma data
     marcada, e não o relógio do clique. */
  const route = source("../app/api/cards/[id]/route.ts");
  assert.match(route, /retention_until = COALESCE\(retention_until/u);
  assert.match(route, /reason: "card_archived"/u);
  assert.doesNotMatch(route, /DELETE FROM fdp_admission_sheets/u,
    "apagar no ato tirava o material da conferência do dia seguinte");
});

test("a ficha não viaja no retrato do workspace", () => {
  const db = source("../lib/fila-dp-db.ts");
  assert.doesNotMatch(db, /fdp_admission_sheets/u,
    "valor de documento no retrato chegaria a quem só passou pela tela");
});
