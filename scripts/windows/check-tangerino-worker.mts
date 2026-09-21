/**
 * Conferência de prontidão do worker, antes de prometer que ele funciona.
 *
 * O script de instalação chama isto depois de montar o ambiente. A pergunta que
 * ele responde é estreita e útil: **este computador consegue falar com o banco
 * do Vinculato e enxergar a fila do agente?**
 *
 * Sem esta etapa, a instalação terminava com "concluído" e o worker morria no
 * primeiro ciclo por uma senha errada ou uma porta fechada — e a pessoa
 * descobria pelo que não acontecia, que é a pior forma de descobrir.
 */
import { getD1 } from "../../db/index.ts";

const problemas: string[] = [];
const ok = (mensagem: string) => console.log(`   OK  ${mensagem}`);
const erro = (mensagem: string) => { problemas.push(mensagem); console.error(`   ERRO ${mensagem}`); };

try {
  const d1 = getD1();

  const agora = await d1.prepare("SELECT CURRENT_TIMESTAMP::text AS agora").first<{ agora: string }>();
  if (!agora?.agora) erro("O banco respondeu, mas sem horário — conexão instável.");
  else ok(`Banco alcançável (${agora.agora}).`);

  /* O módulo é liberado por grupo. Um worker sem nenhum grupo liberado sobe,
     varre o nada e parece saudável — e a admissão nunca é consultada. */
  const grupos = await d1.prepare(`SELECT COUNT(*)::int AS total FROM fdp_workspaces workspace
    JOIN fdp_workspace_module_grants grant_row
      ON grant_row.workspace_id = workspace.id AND grant_row.module_key = 'tangerino_browser'
     AND grant_row.granted = 1 AND (grant_row.expires_at IS NULL OR grant_row.expires_at > CURRENT_TIMESTAMP)
    WHERE workspace.status = 'active'`).first<{ total: number }>();
  const total = Number(grupos?.total ?? 0);
  if (total === 0) erro("Nenhum grupo tem o Agente Tangerino liberado. Peça a liberação à plataforma antes de operar.");
  else ok(`${total} ${total === 1 ? "grupo com o agente liberado" : "grupos com o agente liberado"}.`);

  /* A tabela do batimento é de uma migration recente. Se ela não existir, o
     banco está atrás do código e o worker não conseguirá se anunciar. */
  const heartbeat = await d1.prepare(`SELECT to_regclass('public.fdp_tangerino_worker_heartbeats') AS tabela`)
    .first<{ tabela: string | null }>();
  if (!heartbeat?.tabela) {
    erro("A tabela de batimento do worker não existe neste banco. Aplique as migrations pendentes no servidor.");
  } else ok("Tabela de batimento presente.");

  const perfil = String(process.env.FDP_TANGERINO_PROFILE_ROOT ?? "").trim();
  if (!perfil) erro("FDP_TANGERINO_PROFILE_ROOT não chegou ao processo.");
  else ok(`Perfil do navegador: ${perfil}`);
} catch (causa) {
  erro(causa instanceof Error ? causa.message : "Falha desconhecida ao falar com o banco.");
}

if (problemas.length > 0) process.exit(1);
