import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { EXPORT_PAGE_SIZE, listExportTables, listRedactions } from "@/lib/workspace-export";

export const dynamic = "force-dynamic";

/**
 * Exportação dos dados do grupo (§50).
 *
 * A página de privacidade promete, na retenção, "período de recuperação de 30
 * dias para exportação". O prazo existia; a exportação não. Quem encerrasse o
 * contrato tinha trinta dias para restaurar o grupo e nenhum caminho para
 * levar os dados embora — juntar o CSV de demandas com a exportação do Caju e
 * a do ponto ainda deixaria de fora empresas, colaboradores, competências e
 * obrigações.
 *
 * O arquivo sai em fluxo, tabela por tabela e em páginas. Um grupo grande não
 * cabe confortavelmente na memória do processo, e uma exportação que derruba a
 * rota quando o cliente é grande é uma exportação que não existe justamente
 * para quem mais precisa dela.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    // Sai o grupo inteiro: quem pode isso é quem administra o grupo.
    requireCapability(workspace, "workspace.manage");

    const [tables, redactions] = await Promise.all([listExportTables(d1), listRedactions(d1)]);

    await d1.batch([prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "workspace.exported", entityType: "workspace", entityId: workspace.id,
      after: { tabelas: tables.length, colunasOmitidas: redactions.length },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })]);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        try {
          write(`{\n  "geradoEm": ${JSON.stringify(new Date().toISOString())},\n`);
          write(`  "grupo": ${JSON.stringify({ id: workspace.id, nome: workspace.name })},\n`);
          // O arquivo diz o que não traz. Um export silenciosamente incompleto
          // é pior que um incompleto declarado: o segundo se resolve pedindo o
          // que falta.
          write(`  "aviso": ${JSON.stringify({
            anexos: "os arquivos anexados não vão no JSON; a tabela fdp_card_attachments traz nome, tamanho e a referência de cada um",
            colunasOmitidas: "segredos cifrados e hashes de correlação interna foram omitidos — a lista completa está em omissoes",
          })},\n`);
          write(`  "omissoes": ${JSON.stringify(redactions)},\n`);
          write(`  "tabelas": {`);

          let first = true;
          for (const table of tables) {
            write(`${first ? "" : ","}\n    ${JSON.stringify(table.name)}: [`);
            first = false;
            const colunas = table.columns.map((column) => `"${column}"`).join(", ");
            // Ordem total sobre a tupla projetada, não `ORDER BY 1`.
            //
            // Doze das noventa e uma tabelas não começam por uma coluna única —
            // `fdp_card_assignees` começa por `card_id`, `fdp_workspace_settings`
            // por `workspace_id`. Com empate na chave de ordenação o PostgreSQL
            // pode devolver as linhas em ordens diferentes a cada página, e a
            // paginação por OFFSET passa a pular e repetir linhas. Numa
            // exportação isso é o pior tipo de defeito: silencioso, e o cliente
            // só descobre quando precisa do dado que não veio.
            const ordem = table.columns.map((_, index) => index + 1).join(", ");
            let offset = 0;
            let firstRow = true;
            for (;;) {
              const page = await d1.prepare(
                `SELECT ${colunas} FROM ${table.name} WHERE workspace_id = ? ORDER BY ${ordem} LIMIT ${EXPORT_PAGE_SIZE} OFFSET ${offset}`,
              ).bind(workspace.id).all<Record<string, unknown>>();
              for (const row of page.results) {
                write(`${firstRow ? "" : ","}\n      ${JSON.stringify(row)}`);
                firstRow = false;
              }
              if (page.results.length < EXPORT_PAGE_SIZE) break;
              offset += EXPORT_PAGE_SIZE;
            }
            write(firstRow ? "]" : "\n    ]");
          }
          write("\n  }\n}\n");
          controller.close();
        } catch (error) {
          // O fluxo já começou: não dá para trocar o status por 500. O que dá,
          // e é o mínimo honesto, é fechar o arquivo com o erro dentro dele,
          // para que ninguém guarde um JSON truncado achando que está completo.
          write(`\n  }},\n  "erro": ${JSON.stringify(String(error).slice(0, 200))}\n}\n`);
          controller.close();
        }
      },
    });

    const nome = `vinculato-${workspace.id}-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nome}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) { return apiError(error); }
}
