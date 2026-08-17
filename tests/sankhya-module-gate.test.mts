import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ApiError } from "../lib/api-errors.ts";
import { SANKHYA_HOST_HINT, assertRunnableSankhyaConfig, parseSankhyaConfig, sanitizeSankhyaConfig } from "../lib/sankhya/config.ts";
import { SANKHYA_MODULE_DISABLED_MESSAGE, requireSankhyaWorkspaceEnabled } from "../lib/sankhya/queue.ts";

/**
 * O portão do módulo Sankhya, e as duas telas que precisam concordar com ele.
 *
 * O conector `sankhya_browser` é criado em todo workspace pela migration 0038,
 * mas o módulo não entra em plano nenhum — está escrito na própria migration:
 * "O módulo não entra em nenhum plano automaticamente. A plataforma o libera
 * por workspace." A consequência é que o estado normal de um workspace recém
 * criado é *bloqueado*, e não o contrário.
 *
 * Isso produziu dois defeitos que apareceram juntos ao tentar vincular o
 * Sankhya:
 *
 *   1. a recusa dizia só o estado — "não está habilitado para este workspace" —
 *      e parava aí. Quem a recebia não sabia se era falha, se faltava contratar
 *      ou a quem pedir; e ela chegava no fim de um formulário preenchido;
 *   2. o console listava o cartão do conector em todo workspace e oferecia
 *      "Executar", "Retry" e "Configurar" mesmo com o módulo fechado. A tela
 *      prometia o que o servidor recusava — a mesma classe de defeito que esta
 *      auditoria já corrigiu no `manage: true` da visão de assinatura.
 *
 * O que este arquivo guarda é o vínculo: uma definição do portão, lida pelo
 * servidor que recusa e pelas telas que informam. A prova de que a tela
 * *renderiza* o estado certo é do `browser-check`, que abre a área de
 * Integrações do console — texto de origem não mede pixel.
 */

const raiz = new URL("../", import.meta.url);
const ler = (caminho: string) => readFile(new URL(caminho, raiz), "utf8");

/** Banco de mentira com a forma que `queue.ts` usa: prepare → bind → first. */
function bancoQueDevolve(linha: unknown, consultas: string[] = []) {
  return {
    banco: { prepare(sql: string) { consultas.push(sql); return { bind: () => ({ first: async () => linha }) }; } },
    consultas,
  };
}

test("sem liberação o portão recusa com 403 e código próprio; com liberação, deixa passar", async () => {
  const fechado = bancoQueDevolve(null);
  await assert.rejects(
    () => requireSankhyaWorkspaceEnabled(fechado.banco as never, "ws-sem-liberacao"),
    (erro: unknown) => {
      assert.ok(erro instanceof ApiError);
      assert.equal(erro.status, 403);
      assert.equal(erro.code, "SANKHYA_FEATURE_DISABLED");
      assert.equal(erro.message, SANKHYA_MODULE_DISABLED_MESSAGE);
      return true;
    },
  );

  const aberto = bancoQueDevolve({ enabled: 1 });
  await assert.doesNotReject(() => requireSankhyaWorkspaceEnabled(aberto.banco as never, "ws-liberado"));
});

test("o portão olha a liberação certa: módulo, concessão e validade", async () => {
  const { banco, consultas } = bancoQueDevolve(null);
  await requireSankhyaWorkspaceEnabled(banco as never, "ws").catch(() => undefined);
  const sql = consultas.join(" ").replace(/\s+/gu, " ");
  assert.match(sql, /FROM fdp_workspace_module_grants/u);
  assert.match(sql, /module_key = 'sankhya_browser'/u);
  // `granted = 0` é registro válido — serve para bloquear um módulo que o plano
  // inclui. Ler a existência da linha sem olhar `granted` abriria o portão para
  // exatamente o workspace que a plataforma quis fechar.
  assert.match(sql, /granted = 1/u);
  // E uma liberação vencida não é liberação.
  assert.match(sql, /expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP/u);
});

test("a recusa diz o que destrava, e não apenas que está trancado", async () => {
  // O texto anterior era só o estado. Estas três coisas são o que faltava:
  // que não existe plano que inclua o módulo, quem libera, e onde.
  assert.match(SANKHYA_MODULE_DISABLED_MESSAGE, /não faz parte de nenhum plano/u);
  assert.match(SANKHYA_MODULE_DISABLED_MESSAGE, /plataforma/iu);
  assert.match(SANKHYA_MODULE_DISABLED_MESSAGE, /Acessos e módulos/u);
  // O caminho citado precisa existir no console, e não ser uma lembrança dele.
  const consoleConfig = await ler("app/plataforma/features/WorkspaceConfiguration.tsx");
  assert.match(consoleConfig, /"Acessos e módulos"/u);
  assert.match(consoleConfig, /title="Módulos do workspace"/u);
});

test("o console lê o portão do servidor em vez de reescrever o critério", async () => {
  for (const rota of ["app/api/platform/integrations/route.ts", "app/api/platform/integrations/[id]/detail/route.ts"]) {
    const fonte = await ler(rota);
    assert.match(fonte, /isSankhyaWorkspaceEnabled/u, `${rota} precisa consultar o portão`);
    // Uma cópia do critério aqui é o que faz a tela e o servidor discordarem
    // com o tempo: bastaria a validade mudar em um dos dois lugares.
    assert.doesNotMatch(fonte, /fdp_workspace_module_grants/u, `${rota} não pode ter cópia do critério`);
    assert.match(fonte, /moduleEnabled/u, `${rota} precisa devolver o estado para a tela`);
  }
});

test("a tela de configuração recebe a frase do servidor, não uma versão própria", async () => {
  const detalhe = await ler("app/api/platform/integrations/[id]/detail/route.ts");
  assert.match(detalhe, /moduleDisabledMessage: SANKHYA_MODULE_DISABLED_MESSAGE/u);
  const painel = await ler("app/plataforma/features/SankhyaPlatformConfiguration.tsx");
  assert.match(painel, /moduleDisabledMessage/u);
  // E o formulário só existe quando o servidor aceitaria recebê-lo.
  assert.match(painel, /if \(!moduleEnabled\)/u);
});

test("o cartão do console decide pelo estado que veio do servidor", async () => {
  const fonte = await ler("app/plataforma/features/IntegrationsFeature.tsx");
  assert.match(fonte, /moduleBlocked = isSankhya && row\.moduleEnabled === false/u);
  assert.match(fonte, /onEnableModule/u, "informar sem levar até a liberação é o beco de novo");
});

/**
 * O segundo relato, depois que o módulo foi liberado: "após a configuração
 * feita, ao executar, recebo Configure a URL e a empresa de destino".
 *
 * A configuração não estava gravada. Ou nada chegou a ser gravado, ou a
 * gravação foi recusada — o caso comum sendo um Sankhya hospedado no domínio do
 * próprio cliente, que o produto só aceita depois de o operador incluir o host
 * em FDP_SANKHYA_BROWSER_ALLOWED_HOSTS. A recusa da gravação aparece no topo do
 * painel; a recusa da execução vinha depois, com uma frase que soava como "você
 * não preencheu o formulário" para quem tinha acabado de preencher.
 */

test("a recusa da execução diz o que falta e admite que a gravação pode ter sido recusada", () => {
  const semNada = parseSankhyaConfig({});
  assert.throws(() => assertRunnableSankhyaConfig(semNada), (erro: unknown) => {
    assert.ok(erro instanceof ApiError);
    assert.equal(erro.status, 409);
    assert.equal(erro.code, "SANKHYA_CONFIG_INCOMPLETE");
    assert.match(erro.message, /URL HTTPS do ambiente Sankhya/u);
    assert.match(erro.message, /empresa Vinculato de destino/u);
    // O ponto do relato: distinguir "não preenchi" de "preenchi e foi recusado".
    assert.match(erro.message, /a gravação foi recusada/u);
    return true;
  });

  // E nomeia só o que de fato falta, não a lista inteira sempre.
  const semEmpresa = parseSankhyaConfig({ endpoint: "https://cliente.sankhya.com.br/mge/" });
  assert.throws(() => assertRunnableSankhyaConfig(semEmpresa), (erro: unknown) => {
    assert.ok(erro instanceof ApiError);
    assert.doesNotMatch(erro.message, /URL HTTPS/u);
    assert.match(erro.message, /empresa Vinculato de destino/u);
    return true;
  });

  assert.doesNotThrow(() => assertRunnableSankhyaConfig(
    parseSankhyaConfig({ endpoint: "https://cliente.sankhya.com.br/mge/", companyId: "co-1" })));
});

test("o domínio recusado diz quem destrava e como, em vez de só constatar", () => {
  const anterior = process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS;
  delete process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS;
  try {
    // Sankhya no domínio do cliente: instalação on-premise, o caso que a lista
    // padrão `*.sankhya.com.br` não cobre.
    assert.throws(() => sanitizeSankhyaConfig({ endpoint: "https://erp.grupoexemplo.com.br/mge/", companyId: "co-1" }),
      (erro: unknown) => {
        assert.ok(erro instanceof ApiError);
        assert.equal(erro.code, "SANKHYA_URL_UNSAFE");
        assert.match(erro.message, /não está autorizado/u);
        assert.match(erro.message, /FDP_SANKHYA_BROWSER_ALLOWED_HOSTS/u);
        return true;
      });

    // Com o host liberado pelo operador, a mesma URL passa: a dica descreve um
    // caminho que existe, e não um consolo.
    process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = "erp.grupoexemplo.com.br";
    assert.equal(sanitizeSankhyaConfig({ endpoint: "https://erp.grupoexemplo.com.br/mge/", companyId: "co-1" }).endpoint,
      "https://erp.grupoexemplo.com.br/mge/");
  } finally {
    if (anterior === undefined) delete process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS;
    else process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = anterior;
  }
  assert.match(SANKHYA_HOST_HINT, /\*\.sankhya\.com\.br/u);
});

test("cada recusa aponta o remédio que resolve ela, e não o remédio do vizinho", () => {
  const anterior = process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS;
  try {
    // O endereço que o cliente informou: HTTP, IP puro, porta alta. Liberar o
    // host não destrava nada aqui — o bloqueio é o protocolo. A primeira versão
    // desta correção mandava liberar o host mesmo assim, inclusive quando o host
    // já estava liberado, o que faria a pessoa repetir o que não funcionou.
    for (const hosts of ["", "143.208.246.6"]) {
      process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = hosts;
      assert.throws(() => sanitizeSankhyaConfig({ endpoint: "http://143.208.246.6:8280/mge/login.jsp", companyId: "co-1" }),
        (erro: unknown) => {
          assert.ok(erro instanceof ApiError);
          assert.match(erro.message, /precisa começar com https:\/\//u);
          assert.doesNotMatch(erro.message, /FDP_SANKHYA_BROWSER_ALLOWED_HOSTS/u,
            "com o host já liberado, mandar liberar o host manda repetir o que não funcionou");
          return true;
        });
    }

    // O mesmo endereço em HTTPS passa a depender da lista — e aí, sim, é a lista
    // que a mensagem cita, e liberar resolve.
    process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = "";
    assert.throws(() => sanitizeSankhyaConfig({ endpoint: "https://143.208.246.6:8280/mge/login.jsp", companyId: "co-1" }),
      (erro: unknown) => {
        assert.ok(erro instanceof ApiError);
        assert.match(erro.message, /FDP_SANKHYA_BROWSER_ALLOWED_HOSTS/u);
        return true;
      });
    process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = "143.208.246.6";
    assert.equal(sanitizeSankhyaConfig({ endpoint: "https://143.208.246.6:8280/mge/login.jsp", companyId: "co-1" }).endpoint,
      "https://143.208.246.6:8280/mge/login.jsp");

    // E o que nem URL é recebe a forma esperada, não a lista de hosts.
    assert.throws(() => sanitizeSankhyaConfig({ endpoint: "143.208.246.6:8280", companyId: "co-1" }), (erro: unknown) => {
      assert.ok(erro instanceof ApiError);
      assert.match(erro.message, /endereço completo/u);
      assert.doesNotMatch(erro.message, /FDP_SANKHYA_BROWSER_ALLOWED_HOSTS/u);
      return true;
    });
  } finally {
    if (anterior === undefined) delete process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS;
    else process.env.FDP_SANKHYA_BROWSER_ALLOWED_HOSTS = anterior;
  }
});

test("o cartão do console não oferece executar sobre configuração que não existe", async () => {
  const rota = await ler("app/api/platform/integrations/route.ts");
  // A condição da tela é a mesma que o servidor aplica antes de enfileirar.
  assert.match(rota, /configured: text\(row\.channel\) !== "sankhya_browser" \|\| Boolean\(truthy\(row\.has_endpoint\) && text\(row\.company_id\)\)/u);
  const fonte = await ler("app/plataforma/features/IntegrationsFeature.tsx");
  assert.match(fonte, /needsSetup = isSankhya && !moduleBlocked && row\.configured === false/u);
  assert.match(fonte, /cannotRun = moduleBlocked \|\| needsSetup/u);
  assert.match(fonte, /\{!cannotRun && <><button onClick=\{\(\) => onPerform\("run"\)\}/u,
    "executar e retry só podem existir quando o servidor os aceitaria");
});

test("nenhuma mensagem do produto sai com acento quebrado", async () => {
  // Sete mensagens desta mesma área saíam com os acentos duplamente
  // codificados — "resolução de conciliação inválida" chegava ao cliente com
  // um par de caracteres estranhos no lugar de cada acento. É a falha de
  // sempre: uma mensagem que não cumpre o papel de mensagem.
  const arquivos = [
    "app/api/platform/integrations/[id]/actions/route.ts",
    "app/api/cards/route.ts",
    "app/api/cards/[id]/route.ts",
    "lib/sankhya/queue.ts",
    "app/plataforma/features/IntegrationsFeature.tsx",
    "app/plataforma/features/SankhyaPlatformConfiguration.tsx",
  ];
  for (const arquivo of arquivos) {
    // "não" mal codificado vira "nÃ£o": um "Ã" seguido de byte de continuação
    // (U+0080–U+00BF) é a assinatura exata do UTF-8 lido duas vezes.
    assert.doesNotMatch(await ler(arquivo), /\u00C3[\u0080-\u00BF]/u, `${arquivo} tem texto duplamente codificado`);
  }
});
