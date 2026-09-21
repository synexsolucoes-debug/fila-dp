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

/** O primeiro elo vazio é o único que importa: os seguintes são consequência. */
let primeiroElo = "";
const registrarElo = (elo: string, comoResolver: string) => {
  if (!primeiroElo) primeiroElo = `${elo}\n\n   ${comoResolver}`;
};

const d1 = getD1();

titulo("Banco");
const agora = await d1.prepare("SELECT CURRENT_TIMESTAMP::text AS agora").first<{ agora: string }>();
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
  } catch {
    falha(`A credencial NÃO abre com a chave deste computador (versão ${credencial.key_version}).`);
    registrarElo(`A chave do cofre deste computador não abre a credencial do grupo ${grupo.name}.`,
      "FDP_TANGERINO_VAULT_KEYS precisa ser a MESMA do deployment. Uma chave nova não abre o que foi selado com a antiga.");
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
