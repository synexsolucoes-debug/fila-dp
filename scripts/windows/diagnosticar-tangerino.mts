/**
 * Por que a fila do Agente Tangerino está vazia.
 *
 * O worker pode estar perfeitamente de pé e mesmo assim não consultar nada — e
 * é o pior estado possível para quem opera, porque parece falha e não tem
 * mensagem. A fila depende de uma corrente de elos, e cada elo vazio produz
 * exatamente o mesmo sintoma: silêncio.
 *
 *   módulo liberado → integração cadastrada → credencial que abre com a chave
 *   deste computador → colaboradores → vínculo com o Tangerino → candidatos da
 *   varredura → fila
 *
 * Este script percorre a corrente e diz **qual elo é o primeiro vazio**, com o
 * que fazer a respeito. Ele só lê: não enfileira, não consulta o Tangerino e
 * não escreve nada.
 *
 * Uso:
 *   npm run tangerino:diagnostico
 */
import { getD1, getScopedD1 } from "../../db/index.ts";
import { openCredentials } from "../../lib/integrations.ts";
import { prepareSweepCandidates } from "../../lib/tangerino/sweep.ts";

/* O mesmo driver que o worker usa nesta máquina. Sem isso o padrão é o Neon
   por HTTP, e o diagnóstico poderia responder por um caminho diferente do que
   o worker percorre — que é justamente o que ele está aqui para conferir. */
process.env.FDP_DB_DRIVER ||= "pg";

const ok = (mensagem: string) => console.log(`   OK    ${mensagem}`);
const vazio = (mensagem: string) => console.log(`   VAZIO ${mensagem}`);
const falha = (mensagem: string) => console.log(`   ERRO  ${mensagem}`);
const titulo = (mensagem: string) => console.log(`\n== ${mensagem}`);

/**
 * O servidor de banco, sem a credencial.
 *
 * Endereço e porta são o que a pessoa precisa conferir contra o deployment;
 * usuário e senha estão na mesma string e não têm por que aparecer na tela.
 */
function descreverServidor() {
  const bruto = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || "").trim();
  if (!bruto) return "nada — a variável está vazia.";
  try {
    const url = new URL(bruto);
    return `${url.hostname}:${url.port || "5432"}, banco "${url.pathname.replace(/^\//u, "") || "(sem nome)"}".`;
  } catch {
    return "um valor que não é uma string de conexão válida.";
  }
}

/**
 * Quais versões do cofre existem NESTE computador — só os números, nunca as chaves.
 *
 * O número é o que resolve o caso mais confuso: `FDP_TANGERINO_VAULT_KEY`, no
 * singular, registra somente a versão 1. Quem copiou a chave certa do
 * deployment para a variável errada fica com uma configuração que parece
 * completa e não abre nada selado depois da primeira rotação.
 */
function versoesLocais(): { numeros: number[]; peloSingular: boolean } {
  const mapa = String(process.env.FDP_TANGERINO_VAULT_KEYS ?? "").trim();
  if (mapa) {
    try {
      const numeros = Object.keys(JSON.parse(mapa) as Record<string, unknown>)
        .map(Number).filter((numero) => Number.isInteger(numero) && numero > 0).sort((a, b) => a - b);
      if (numeros.length) return { numeros, peloSingular: false };
    } catch { return { numeros: [], peloSingular: false }; }
  }
  /* A variável no singular registra a versão 1 e nenhuma outra. Quem copiou a
     chave certa para ela fica com uma configuração que parece completa. */
  if (String(process.env.FDP_TANGERINO_VAULT_KEY ?? "").trim()) return { numeros: [1], peloSingular: true };
  return { numeros: [], peloSingular: false };
}

function descreverVersoesLocais() {
  const { numeros, peloSingular } = versoesLocais();
  if (peloSingular) return "somente a versão 1 (FDP_TANGERINO_VAULT_KEY, no singular)";
  if (!numeros.length) return "nenhuma chave";
  return numeros.length === 1 ? `a versão ${numeros[0]}` : `as versões ${numeros.join(", ")}`;
}

/** O primeiro elo vazio é o único que importa: os seguintes são consequência. */
let primeiroElo = "";
const registrarElo = (elo: string, comoResolver: string) => {
  if (!primeiroElo) primeiroElo = `${elo}\n\n   ${comoResolver}`;
};

const d1 = getD1();

titulo("Banco");
/* Falha de conexão é o caso mais comum e era o pior atendido: o processo
   morria com um stack trace do pg-pool, que fala de `getaddrinfo` e de
   `processTicksAndRejections` — nada que diga o que corrigir. O endereço do
   servidor aparece; usuário e senha, não. */
let agora: { agora: string } | null = null;
try {
  agora = await d1.prepare("SELECT CURRENT_TIMESTAMP::text AS agora").first<{ agora: string }>();
} catch (causa) {
  const codigo = causa && typeof causa === "object" && "code" in causa ? String((causa as { code: unknown }).code) : "";
  falha(`Não consegui falar com o banco${codigo ? ` (${codigo})` : ""}.`);
  console.log(`   ---   DATABASE_URL aponta para ${descreverServidor()}`);
  titulo("Conclusão");
  console.log(codigo === "ENOTFOUND"
    ? "   O endereço do servidor não existe — esse host não responde por DNS.\n\n"
      + "   Confira a linha DATABASE_URL no .env.tangerino-worker.local. Um host chamado\n"
      + "   'host' ou 'localhost' costuma ser o modelo de exemplo, colado sem substituir.\n"
      + "   O valor tem que ser a MESMA string de conexão do deployment.\n"
    : "   Confira a linha DATABASE_URL no .env.tangerino-worker.local e a conexão de rede.\n");
  process.exit(1);
}
if (!agora?.agora) {
  falha("O banco respondeu sem horário — conexão instável.");
  process.exit(1);
}
ok(`Alcançável (${agora.agora}).`);

titulo("Grupos com o Agente Tangerino liberado");
const grupos = await d1.prepare(`SELECT workspace.id, workspace.name FROM fdp_workspaces workspace
  JOIN fdp_workspace_module_grants grant_row
    ON grant_row.workspace_id = workspace.id AND grant_row.module_key = 'tangerino_browser'
   AND grant_row.granted = 1 AND (grant_row.expires_at IS NULL OR grant_row.expires_at > CURRENT_TIMESTAMP)
  WHERE workspace.status = 'active' ORDER BY workspace.created_at`).all<{ id: string; name: string }>();

const lista = grupos.results ?? [];
if (lista.length === 0) {
  vazio("Nenhum grupo tem o módulo liberado.");
  registrarElo("Nenhum grupo tem o Agente Tangerino liberado.",
    "O worker varre só os grupos liberados. Libere em Configuração operacional › Acessos e módulos.");
} else {
  ok(`${lista.length} ${lista.length === 1 ? "grupo liberado" : "grupos liberados"}.`);
}

for (const grupo of lista) {
  const workspaceId = String(grupo.id);
  const scoped = getScopedD1({ workspaceId, userId: null });
  titulo(`Grupo ${grupo.name}`);

  const integracao = await scoped.prepare(`SELECT id, last_sync_at::text AS last_sync_at, next_sync_at::text AS next_sync_at
    FROM fdp_integrations WHERE workspace_id = ? AND channel = 'tangerino_browser'`)
    .bind(workspaceId).first<{ id: string; last_sync_at: string | null; next_sync_at: string | null }>();
  if (!integracao) {
    vazio("Integração do Tangerino não cadastrada neste grupo.");
    registrarElo(`O grupo ${grupo.name} não tem a integração do Tangerino cadastrada.`,
      "Cadastre em Integrações › Agente Tangerino, com o usuário e a senha do acesso pelo navegador.");
    continue;
  }
  ok(`Integração cadastrada (agendamento: ${integracao.next_sync_at ?? "sem próximo"}, última: ${integracao.last_sync_at ?? "nunca"}).`);

  /* Abrir a credencial é o único jeito de saber se a chave do cofre deste
     computador é a mesma que selou o segredo. Um worker com a chave errada sobe
     igual, tenta, falha na hora de logar e volta para a fila — para sempre. */
  const credencial = await scoped.prepare(`SELECT encrypted_value, initialization_vector, auth_tag, key_version
    FROM fdp_integration_credentials
    WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 1`)
    .bind(workspaceId, String(integracao.id))
    .first<{ encrypted_value: string; initialization_vector: string; auth_tag: string; key_version: number }>();

  if (!credencial) {
    vazio("Sem credencial ativa da Sólides/Tangerino.");
    registrarElo(`O grupo ${grupo.name} não tem credencial ativa da Sólides.`,
      "Salve o acesso em Integrações › Agente Tangerino. Sem ele o worker não tem como entrar.");
    continue;
  }
  try {
    const segredos = openCredentials("tangerino_browser", {
      encryptedValue: credencial.encrypted_value,
      initializationVector: credencial.initialization_vector,
      authTag: credencial.auth_tag,
      keyVersion: Number(credencial.key_version),
    });
    // Nunca o conteúdo: só se abriu e se os campos que o login exige estão lá.
    if (!segredos.username || !segredos.password) {
      vazio("A credencial abriu, mas está sem usuário ou sem senha.");
      registrarElo(`A credencial do grupo ${grupo.name} está incompleta.`,
        "Salve de novo o acesso em Integrações › Agente Tangerino.");
      continue;
    }
    ok(`Credencial abre com a chave deste computador (versão ${credencial.key_version}).`);
  } catch (causa) {
    /* Três causas diferentes, três remédios diferentes. Dizer só "não abre"
       mandaria trocar a chave em duas delas — e numa a chave está certa. */
    const codigo = causa && typeof causa === "object" && "code" in causa ? String((causa as { code: unknown }).code) : "";
    const versaoNecessaria = Number(credencial.key_version);
    falha(`A credencial NÃO abre com a chave deste computador (selada na versão ${versaoNecessaria}).`);

    if (codigo === "VAULT_NOT_CONFIGURED") {
      registrarElo("Este computador não tem chave do cofre nenhuma.",
        "Copie do deployment FDP_TANGERINO_VAULT_KEYS (Vercel › Settings › Environment Variables)\n"
        + "   para o .env.tangerino-worker.local.");
    } else if (codigo === "VAULT_KEY_VERSION_MISSING") {
      const { numeros, peloSingular } = versoesLocais();
      const titulo = `Este computador tem ${descreverVersoesLocais()}, e a credencial foi selada na versão ${versaoNecessaria}.`;

      if (peloSingular) {
        registrarElo(titulo,
          "FDP_TANGERINO_VAULT_KEY (no singular) registra SOMENTE a versão 1 — por isso ela nunca abre\n"
          + `   uma credencial da versão ${versaoNecessaria}, mesmo que o conteúdo da chave esteja certo.\n`
          + "   Use FDP_TANGERINO_VAULT_KEYS (no plural), com o mapa de versões exatamente como está\n"
          + "   no deployment. Apague a linha do singular para não confundir as duas.");
      } else if (numeros.every((numero) => numero > versaoNecessaria)) {
        /* A chave desta máquina é mais NOVA que o selo da credencial. Não é
           configuração errada: é uma rotação cuja segunda metade ficou pela
           metade. A credencial guardada continua na chave antiga até alguém
           regravá-la, e mandar mexer no arquivo aqui não resolveria nada. */
        registrarElo(titulo,
          "A chave deste computador é mais NOVA que o selo da credencial: falta terminar a rotação.\n"
          + "   O arquivo daqui está certo — o que falta é do lado do deployment, nesta ordem:\n"
          + `     1. publicar um deployment novo, para a chave da versão ${numeros[numeros.length - 1]} valer;\n`
          + "     2. regravar usuário e senha da Sólides no painel, em Integrações › Agente Tangerino.\n"
          + `   Só o passo 2 sela a credencial de novo, na versão ${numeros[numeros.length - 1]}. Até lá ela fica na ${versaoNecessaria}.`);
      } else {
        registrarElo(titulo,
          `Falta a versão ${versaoNecessaria} no mapa FDP_TANGERINO_VAULT_KEYS deste computador.\n`
          + "   Copie o mapa do deployment inteiro, com todas as versões — uma credencial antiga\n"
          + "   continua selada na versão em que foi guardada.");
      }
    } else {
      registrarElo(`A chave da versão ${versaoNecessaria} deste computador não é a mesma que selou a credencial.`,
        "O conteúdo precisa ser idêntico ao do deployment. Uma chave nova não abre o que foi selado com a antiga.");
    }
    continue;
  }

  const contagem = await scoped.prepare(`SELECT
      (SELECT COUNT(*)::int FROM fdp_employees
        WHERE workspace_id = ? AND termination_date IS NULL) AS ativos,
      (SELECT COUNT(*)::int FROM fdp_employee_external_refs
        WHERE workspace_id = ? AND source = 'tangerino' AND external_id <> '') AS vinculados,
      (SELECT COUNT(*)::int FROM fdp_tangerino_admission_consultations
        WHERE workspace_id = ? AND state IN ('QUEUED', 'RUNNING')) AS na_fila,
      (SELECT COUNT(*)::int FROM fdp_tangerino_admission_consultations
        WHERE workspace_id = ? AND state = 'SUCCESS') AS concluidas,
      (SELECT MAX(consulted_at)::text FROM fdp_tangerino_admission_consultations
        WHERE workspace_id = ? AND state = 'SUCCESS') AS ultima`)
    .bind(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId)
    .first<{ ativos: number; vinculados: number; na_fila: number; concluidas: number; ultima: string | null }>();

  const ativos = Number(contagem?.ativos ?? 0);
  const vinculados = Number(contagem?.vinculados ?? 0);
  const naFila = Number(contagem?.na_fila ?? 0);

  if (ativos === 0) {
    vazio("Nenhum colaborador ativo neste grupo.");
    registrarElo(`O grupo ${grupo.name} não tem colaborador ativo.`,
      "A varredura parte dos colaboradores do Vinculato. Importe ou cadastre antes de esperar consulta.");
  } else ok(`${ativos} ${ativos === 1 ? "colaborador ativo" : "colaboradores ativos"}.`);

  /* O vínculo é gravado pela PRIMEIRA consulta bem-sucedida, e a varredura só
     enxerga quem já o tem. Numa instalação nova isso é zero, e a automação não
     tem como começar sozinha: alguém precisa consultar uma vez pela ficha. */
  if (ativos > 0 && vinculados === 0) {
    vazio("Nenhum colaborador tem vínculo com o Tangerino ainda.");
    registrarElo(`Nenhum colaborador do grupo ${grupo.name} foi consultado no Tangerino ainda.`,
      "A varredura automática só alcança quem já tem vínculo, e o vínculo nasce da primeira consulta.\n"
      + "   Abra a ficha de um colaborador no Vinculato e peça a consulta ao Tangerino uma vez.\n"
      + "   A partir daí ele entra sozinho nas varreduras seguintes.");
  } else if (vinculados > 0) ok(`${vinculados} com vínculo no Tangerino.`);

  if (vinculados > 0) {
    const candidatos = await prepareSweepCandidates(scoped, workspaceId).all<{ employee_id: string }>();
    const quantos = (candidatos.results ?? []).length;
    if (quantos === 0) {
      vazio("A varredura não encontrou ninguém a consultar agora.");
      registrarElo(`No grupo ${grupo.name} não há ninguém pendente de conferência.`,
        "Isso costuma ser normal: quem terminou em COMPLETED ou CANCELLED não se reconsulta, e leitura recente espera a validade vencer.");
    } else ok(`${quantos} ${quantos === 1 ? "pendente" : "pendentes"} de conferência na próxima varredura.`);
  }

  console.log(`   ---   Fila agora: ${naFila} | consultas concluídas: ${Number(contagem?.concluidas ?? 0)} | última: ${contagem?.ultima ?? "nunca"}`);

  const batimento = await scoped.prepare(`SELECT worker_id, last_seen_at::text AS last_seen_at, needs_authentication
    FROM fdp_tangerino_worker_heartbeats WHERE workspace_id = ? ORDER BY last_seen_at DESC LIMIT 1`)
    .bind(workspaceId).first<{ worker_id: string; last_seen_at: string; needs_authentication: number }>();
  if (!batimento) {
    vazio("Nenhum worker se anunciou para este grupo.");
    registrarElo(`Nenhum worker se anunciou para o grupo ${grupo.name}.`,
      "Se o worker está rodando, ele está falando com OUTRO banco: compare a DATABASE_URL do computador com a do deployment.");
  } else if (Number(batimento.needs_authentication) === 1) {
    falha(`Worker ${batimento.worker_id} parado esperando autenticação (${batimento.last_seen_at}).`);
    registrarElo(`O worker do grupo ${grupo.name} está esperando uma pessoa.`,
      "A Sólides pediu CAPTCHA, verificação em duas etapas ou recusou a senha. Conclua na janela do navegador.");
  } else ok(`Worker ${batimento.worker_id} visto em ${batimento.last_seen_at}.`);
}

titulo("Conclusão");
if (primeiroElo) {
  console.log(`   ${primeiroElo}\n`);
} else {
  console.log("   A corrente está inteira. Se ainda assim nada acontece, é na janela do worker que a\n"
    + "   causa aparece — deixe-a aberta e acompanhe o próximo ciclo.\n");
}
