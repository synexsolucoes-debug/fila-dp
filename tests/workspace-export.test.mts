import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { REDACTED_COLUMN, redactionReason } from "../lib/workspace-export.ts";

/**
 * §50: exportação dos dados do grupo.
 *
 * A página de privacidade dizia, na seção de retenção: "após o encerramento, há
 * período de recuperação de 30 dias para exportação". O prazo existia — a
 * exclusão é reversível, e `tests/workspace-lifecycle.test.mts` garante isso.
 * A exportação não existia. Quem encerrasse o contrato tinha trinta dias para
 * *restaurar* o grupo e nenhum caminho para levar os dados embora: juntar o CSV
 * de demandas com a exportação do Caju e a do ponto ainda deixaria de fora
 * empresas, colaboradores, competências e obrigações.
 *
 * Conferido contra o produto de pé: 91 tabelas no arquivo, 1200 linhas de uma
 * tabela sem coluna inicial única saindo em três páginas sem pular nem repetir,
 * membro comum recusado com 403, e o evento na auditoria.
 */

const rota = await readFile(new URL("../app/api/workspace/export/route.ts", import.meta.url), "utf8");
const modulo = await readFile(new URL("../lib/workspace-export.ts", import.meta.url), "utf8");

test("segredo cifrado e chave de correlação não saem no arquivo", () => {
  // Exportar texto cifrado junto da versão da chave transforma um vazamento
  // futuro da chave em vazamento dos segredos de todos que já exportaram.
  for (const coluna of ["encrypted_value", "secret_encrypted", "secret_iv", "secret_tag",
    "payout_encrypted", "token_hash", "lease_token", "cpf_hash", "payload_hash", "password_hash"]) {
    assert.ok(REDACTED_COLUMN.test(coluna), `${coluna} sairia no arquivo`);
  }
  // E o que é dado do cliente continua saindo.
  for (const coluna of ["id", "full_name", "cpf_last4", "legal_name", "competence", "protocol", "evidence_url"]) {
    assert.equal(REDACTED_COLUMN.test(coluna), false, `${coluna} foi omitido sem motivo`);
  }
});

test("cada omissão tem um motivo legível, não um silêncio", () => {
  assert.match(redactionReason("secret_encrypted"), /vazamento futuro da chave/u);
  assert.match(redactionReason("lease_token"), /credencial de acesso ou trava/u);
  assert.match(redactionReason("cpf_hash"), /correlação interna/u);
  // O arquivo carrega a lista, então quem o abre sabe o que pedir a mais.
  assert.match(rota, /"omissoes": \$\{JSON\.stringify\(redactions\)\}/u);
  assert.match(rota, /anexos: "os arquivos anexados não vão no JSON/u);
});

test("a lista de tabelas vem do schema, não de um inventário à mão", () => {
  // Inventário manual envelhece em silêncio: alguém acrescenta uma tabela,
  // ninguém lembra da exportação, e o arquivo fica incompleto sem avisar.
  assert.match(modulo, /FROM pg_class c/u);
  assert.match(modulo, /w\.column_name = 'workspace_id'/u);
  // Identificador vindo do catálogo, e ainda assim conferido: é o único lugar
  // do produto onde nome de tabela entra na consulta por interpolação.
  assert.match(modulo, /\/\^fdp_\[a-z0-9_\]\+\$\/u\.test\(table\)/u);
  assert.match(modulo, /\/\^\[a-z0-9_\]\+\$\/u\.test\(column\)/u);
});

test("a paginação tem ordem total, senão pula linha em silêncio", () => {
  // Doze das 91 tabelas não começam por coluna única. Com empate na ordenação,
  // o PostgreSQL pode devolver ordens diferentes a cada página e o OFFSET passa
  // a pular e repetir. Verificado com 1200 feriados: 1200 no arquivo, 0
  // duplicados.
  assert.match(rota, /const ordem = table\.columns\.map\(\(_, index\) => index \+ 1\)\.join\(", "\)/u);
  assert.match(rota, /ORDER BY \$\{ordem\} LIMIT \$\{EXPORT_PAGE_SIZE\} OFFSET \$\{offset\}/u);
  assert.doesNotMatch(rota, /ORDER BY 1 LIMIT/u);
});

test("exportar o grupo inteiro exige quem administra o grupo, e fica na auditoria", () => {
  assert.match(rota, /requireCapability\(workspace, "workspace\.manage"\)/u);
  assert.match(rota, /action: "workspace\.exported"/u);
  // O filtro por workspace é explícito além da RLS: a consulta percorre tabelas
  // variáveis, e duas delas são globais por desenho, sem RLS a proteger.
  assert.match(rota, /WHERE workspace_id = \?/u);
});

test("o arquivo sai em fluxo e diz quando quebrou no meio", () => {
  // Uma exportação que estoura a memória quando o cliente é grande é uma
  // exportação que falta justamente para quem mais precisa dela.
  assert.match(rota, /new ReadableStream\(/u);
  // Depois do primeiro byte não dá para trocar o status por 500. O mínimo
  // honesto é o erro dentro do arquivo, para ninguém guardar um JSON truncado
  // achando que está completo.
  assert.match(rota, /"erro": \$\{JSON\.stringify\(String\(error\)\.slice\(0, 200\)\)\}/u);
});

test("a página de privacidade descreve o que o produto faz", async () => {
  const pagina = await readFile(new URL("../app/privacidade/page.tsx", import.meta.url), "utf8");
  // Antes ela prometia "período de recuperação de 30 dias para exportação" — e
  // o prazo só permitia restaurar. O texto agora separa as duas coisas.
  assert.match(pagina, /o grupo pode ser restaurado e seus dados exportados em arquivo único/u);
  // E declara os limites do arquivo, em vez de deixar a impressão de completude.
  assert.match(pagina, /O arquivo declara o que não contém/u);
  assert.match(pagina, /conteúdo binário dos anexos/u);
});

test("a exportação tem porta alcançável, não só rota", async () => {
  // A página de privacidade passou a dizer que o administrador exporta "a
  // qualquer momento". Sem botão, seria mais uma promessa sem porta.
  //
  // A primeira tentativa colocou o botão em `SaasView` — e essa tela **não é
  // renderizada por lugar nenhum**: nada importa `SaasView`, e
  // `/api/saas/overview` só é chamada por ela. Um botão numa tela inalcançável
  // é o mesmo defeito que a exportação veio resolver, com outra roupa. Ficou
  // em Relatórios, que está no menu e já é a tela de tirar dado do produto.
  const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(painel, /href="\/api\/workspace\/export" download/u);
  assert.match(painel, /\{canExportWorkspace && <a className="export-button"/u);
  assert.match(painel, /<IndicatorsView canExportWorkspace=\{isAdmin\}/u);
  // O título do botão repete o limite do arquivo: quem clica sabe o que leva.
  assert.match(painel, /Segredos cifrados, chaves internas e o conteúdo dos anexos ficam de fora/u);

  // E a verificação de navegador baixa o arquivo de verdade a cada execução.
  const check = await readFile(new URL("../scripts/browser-check.mjs", import.meta.url), "utf8");
  assert.match(check, /a exportação completa do grupo tem porta na interface/u);
  assert.match(check, /nenhum segredo cifrado no arquivo/u);
});

test("a permissão da tela vem da mesma fonte que decide no servidor", async () => {
  // `manage: true` fixo dizia que qualquer um que abre a tela pode administrar
  // a assinatura. A rota exige `saas.read`, que observador tem; administrar
  // exige `saas.manage`, que ele não tem — a tela oferecia e o servidor
  // recusava.
  const rota = await readFile(new URL("../app/api/saas/overview/route.ts", import.meta.url), "utf8");
  assert.match(rota, /manage: hasCapability\(workspace, "saas\.manage"\)/u);
  assert.match(rota, /exportData: hasCapability\(workspace, "workspace\.manage"\)/u);
  const codigo = rota.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.doesNotMatch(codigo, /manage: true/u, "permissão fixa volta a mentir para a tela");
});
