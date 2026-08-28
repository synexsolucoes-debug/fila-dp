/**
 * Conferência da política de backup do provedor (§85).
 *
 * ## O que este script existe para impedir
 *
 * O ensaio de restauração (`npm run db:rehearse-restore`) prova que o produto
 * *sabe* voltar: dump, restore, contagens, RLS, triggers, constraints e
 * isolamento, tudo verificado contra PostgreSQL real, a cada PR. O que ele não
 * prova é que **existe de onde voltar** em produção — isso é retenção
 * configurada no provedor, fora do repositório.
 *
 * Essa lacuna é a pior classe de risco de continuidade: a equipe olha a CI
 * verde, vê "backup ensaiado" e conclui que está coberta. Um script que
 * passasse sem olhar nada seria exatamente o "mascarar erro" que este projeto
 * recusa (§122).
 *
 * Então: quando há credencial, ele **confere** a janela de recuperação e
 * reprova se ela for menor que o mínimo acordado. Quando não há, ele **diz que
 * não conferiu** e sai com código diferente de zero em modo estrito. Ele nunca
 * diz "ok" sobre o que não olhou.
 *
 * ## Uso
 *
 *   NEON_API_KEY=... NEON_PROJECT_ID=... node scripts/verify-backup-policy.mjs
 *
 * Sem credencial, use `--permitir-sem-credencial` para transformar a recusa em
 * aviso — é o modo que a CI de fork usa, e ele imprime alto que não verificou.
 *
 * Mínimo padrão: 7 dias. Ajuste com `FDP_BACKUP_MINIMO_DIAS` quando o contrato
 * do cliente exigir mais.
 */

const MINIMO_DIAS = Number(process.env.FDP_BACKUP_MINIMO_DIAS ?? 7);
const permissivo = process.argv.includes("--permitir-sem-credencial");

const apiKey = process.env.NEON_API_KEY;
const projectId = process.env.NEON_PROJECT_ID;

/** Sai dizendo o que não foi verificado — nunca fingindo que foi. */
function naoVerificado(motivo) {
  console.error(`NÃO VERIFICADO: ${motivo}`);
  console.error(
    "A restauração é ensaiada a cada PR, mas a janela de recuperação em produção\n"
    + "não foi conferida por este processo. Confira em Neon → Project → Settings →\n"
    + "History retention, ou rode com NEON_API_KEY e NEON_PROJECT_ID.",
  );
  process.exit(permissivo ? 0 : 1);
}

if (!apiKey || !projectId) {
  naoVerificado("NEON_API_KEY e NEON_PROJECT_ID não foram informados.");
}

const response = await fetch(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`, {
  headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
});

if (!response.ok) {
  naoVerificado(`a API do Neon respondeu ${response.status}.`);
}

const payload = await response.json();
const project = payload?.project ?? payload;
const segundos = project?.history_retention_seconds;

/* Campo ausente não é retenção zero: pode ser mudança de contrato da API. A
   diferença importa — tratar ausência como zero geraria alarme falso, e
   tratá-la como suficiente esconderia o caso real. */
if (typeof segundos !== "number") {
  naoVerificado("a resposta do Neon não trouxe `history_retention_seconds`.");
}

const dias = segundos / 86_400;
console.log(`Projeto ${project?.name ?? projectId}: janela de recuperação de ${dias.toFixed(1)} dia(s).`);

if (dias < MINIMO_DIAS) {
  console.error(
    `\nREPROVADO: a janela de ${dias.toFixed(1)} dia(s) é menor que o mínimo de ${MINIMO_DIAS}.\n`
    + "Um incidente descoberto depois dessa janela não tem de onde voltar.",
  );
  process.exit(1);
}

console.log(`OK: a janela atende o mínimo de ${MINIMO_DIAS} dia(s).`);
