/**
 * Os relatórios dos módulos de pagamento.
 *
 * O catálogo mora aqui, e não dentro da rota, por um motivo só: o extrato
 * analítico precisa ser ensaiado contra um PostgreSQL de verdade, e um ensaio
 * que reescreve a consulta prova a cópia, não o produto. Importando daqui, o
 * ensaio roda exatamente o SQL que a rota executa.
 *
 * `paramPairs` diz quantas vezes a consulta cita o par (grupo, competência).
 * Quase todas citam uma vez; o extrato analítico é uma união — a base da
 * apuração de um lado, os lançamentos do outro — e cita nos dois.
 */
export const reports = {
  "psychology-by-psychologist": {
    capability: "psychology.payments.read",
    columns: ["psicologo", "competencia", "consultas", "colaboradores", "bruto", "ajustes", "liquido", "status", "pagamento"],
    query: `SELECT a.legal_name AS psicologo, c.competence AS competencia, c.sessions_count AS consultas, c.employees_count AS colaboradores,
        c.gross_amount AS bruto, c.adjustments_amount AS ajustes, c.net_amount AS liquido, c.status, coalesce(p.status, 'sem_registro') AS pagamento
      FROM fdp_psychology_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      LEFT JOIN fdp_psychology_payments p ON p.workspace_id = c.workspace_id AND p.closing_id = c.id
      WHERE c.workspace_id = ? AND c.competence = ?`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
  "psychology-by-employee": {
    capability: "psychology.payments.read",
    columns: ["colaborador", "matricula", "psicologo", "competencia", "consultas", "valor"],
    query: `SELECT e.full_name AS colaborador, e.registration_number AS matricula, a.legal_name AS psicologo, s.competence AS competencia,
        sum(s.session_quantity)::int AS consultas, sum(s.total_amount) AS valor
      FROM fdp_psychology_sessions s
      JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
      JOIN fdp_auxiliary_providers a ON a.workspace_id = s.workspace_id AND a.id = s.provider_id
      WHERE s.workspace_id = ? AND s.competence = ? AND s.status = 'registered'`,
    companyColumn: "s.company_id",
    order: "GROUP BY e.full_name, e.registration_number, a.legal_name, s.competence ORDER BY e.full_name",
  },
  "contractor-closing": {
    capability: "contractors.payments.read",
    columns: ["prestador", "competencia", "base", "creditos", "descontos", "liquido", "limite_nf", "nf_esperada", "complemento", "caju",
      "nf_recebida", "status_nf", "status_caju", "conciliacao", "diferenca", "status"],
    query: `SELECT a.legal_name AS prestador, c.competence AS competencia, c.base_amount AS base, c.credits_amount AS creditos,
        c.debits_amount AS descontos, c.net_amount AS liquido, c.invoice_limit_amount AS limite_nf, c.invoice_expected_amount AS nf_esperada,
        c.complement_amount AS complemento, c.caju_amount AS caju, c.invoice_received_amount AS nf_recebida, c.invoice_status AS status_nf,
        c.caju_status AS status_caju, c.reconciliation_status AS conciliacao, c.reconciliation_difference AS diferenca, c.status
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE c.workspace_id = ? AND c.competence = ? AND c.excluded_at IS NULL`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
  /* Extrato analítico da competência inteira, rubrica a rubrica.
   *
   * Os dois relatórios PJ abaixo são sintéticos: uma linha por prestador, com
   * os totais já somados. Servem para saber quanto sai, não para conferir de
   * onde o número veio — e conferência é exatamente perguntar "por que este
   * desconto de 340,00 existe".
   *
   * Havia um analítico, mas de um prestador por vez, montado no navegador a
   * partir do detalhamento aberto na tela. Conferir uma competência com trinta
   * prestadores custava trinta diálogos e trinta arquivos.
   *
   * O valor contratual entra como linha, não como coluna repetida: quem
   * confere soma a coluna de valor e o total precisa bater com o líquido. Ele
   * não é um lançamento — vem do contrato —, e é por isso que a consulta é uma
   * união: um lado é a base da apuração, o outro são os lançamentos que a
   * ajustam.
   *
   * Lançamento cancelado aparece, com a situação dita. Sumir com ele deixaria
   * quem confere sem explicação para a diferença entre o que foi lançado e o
   * que foi apurado — que é precisamente o que uma conferência procura. */
  "contractor-analytical": {
    capability: "contractors.payments.read",
    columns: ["codigo", "prestador", "cnpj", "contrato", "funcao", "competencia", "tipo", "rubrica", "quantidade",
      "valor", "origem", "documento", "situacao", "valor_contrato", "total_apurado", "nf_esperada", "limite_nf",
      "origem_limite", "complemento", "forma_complemento", "status_nf", "status_fechamento"],
    query: `SELECT t.* FROM (
        SELECT a.code AS codigo, a.legal_name AS prestador, a.tax_id AS cnpj, coalesce(p.contract_reference, '') AS contrato,
          coalesce(p.role_title, '') AS funcao, c.competence AS competencia,
          'PROVENTO' AS tipo, 'Valor contratual' AS rubrica, 1::numeric(18, 4) AS quantidade, c.base_amount AS valor,
          -- Mesmo vocabulário do lançamento, não um sinônimo: quem confere
          -- filtra a coluna inteira de uma vez, e "ativo" ao lado de "active"
          -- faria o filtro descartar metade das linhas sem avisar.
          'contrato' AS origem, coalesce(p.contract_reference, '') AS documento, 'active' AS situacao,
          c.base_amount AS valor_contrato, c.net_amount AS total_apurado, c.invoice_expected_amount AS nf_esperada,
          c.invoice_limit_amount AS limite_nf, c.invoice_limit_source AS origem_limite,
          c.complement_amount AS complemento, c.complement_method AS forma_complemento,
          c.invoice_status AS status_nf, c.status AS status_fechamento,
          c.company_id, 0 AS ordem
        FROM fdp_contractor_closings c
        JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
        -- O contrato é um só por prestador, e o prestador é do grupo: casar
        -- também por empresa faria o contrato sumir do extrato justamente quando
        -- a apuração corresse por outra empresa do grupo, deixando contrato e
        -- função em branco sem nenhum aviso.
        LEFT JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
        WHERE c.workspace_id = ? AND c.competence = ? AND c.excluded_at IS NULL
        UNION ALL
        SELECT a.code AS codigo, a.legal_name AS prestador, a.tax_id AS cnpj, coalesce(p.contract_reference, '') AS contrato,
          coalesce(p.role_title, '') AS funcao, c.competence AS competencia,
          CASE WHEN k.direction = 'credit' THEN 'PROVENTO' ELSE 'DESCONTO' END AS tipo,
          coalesce(nullif(k.description, ''), k.component_type) AS rubrica,
          k.component_quantity AS quantidade, k.amount AS valor,
          k.origin AS origem, k.document_reference AS documento, k.status AS situacao,
          c.base_amount AS valor_contrato, c.net_amount AS total_apurado, c.invoice_expected_amount AS nf_esperada,
          c.invoice_limit_amount AS limite_nf, c.invoice_limit_source AS origem_limite,
          c.complement_amount AS complemento, c.complement_method AS forma_complemento,
          c.invoice_status AS status_nf, c.status AS status_fechamento,
          c.company_id, CASE WHEN k.direction = 'credit' THEN 1 ELSE 2 END AS ordem
        FROM fdp_contractor_components k
        JOIN fdp_contractor_closings c ON c.workspace_id = k.workspace_id AND c.id = k.closing_id
        JOIN fdp_auxiliary_providers a ON a.workspace_id = k.workspace_id AND a.id = k.provider_id
        LEFT JOIN fdp_contractor_profiles p ON p.workspace_id = k.workspace_id AND p.provider_id = k.provider_id
        -- Lançamento excluído não entra no extrato.
        --
        -- Ele continua no banco e na auditoria, que é onde se responde "o que
        -- foi lançado e retirado, por quem e por quê". O extrato responde outra
        -- pergunta — "de onde veio o valor que estou pagando" —, e uma linha
        -- que não entrou na conta só atrapalha quem soma a coluna conferindo.
        -- O filtro fica aqui, e não só na montagem do PDF, para que CSV, JSON e
        -- PDF contem a mesma história: divergir entre formatos do mesmo
        -- relatório é pior do que o próprio excesso de linhas.
        WHERE k.workspace_id = ? AND k.competence = ? AND c.excluded_at IS NULL AND k.status <> 'canceled'
      ) t WHERE true`,
    /* A união menciona grupo e competência uma vez de cada lado. */
    paramPairs: 2,
    companyColumn: "t.company_id",
    order: "ORDER BY t.prestador, t.ordem, t.rubrica",
  },
  /* As mensagens de aviso de nota fiscal.
   *
   * Não é um relatório: é um arquivo de texto com uma mensagem pronta por
   * prestador, para quem avisa copiar e colar na conversa de cada um. Mora
   * aqui porque o caminho é o mesmo dos relatórios — mesma permissão, mesmo
   * recorte por empresa, mesma auditoria de exportação — e uma rota paralela
   * seria a segunda cópia dessas três coisas.
   *
   * Entram os prestadores com valor a emitir na competência, tenham já mandado
   * a nota ou não. Quem tem nota zerada fica de fora: uma mensagem dizendo
   * "segue o valor a ser emitido: R$ 0,00" não avisa nada.
   *
   * A ordem é alfabética, a mesma da tela — o arquivo sai sem cabeçalho de
   * identificação, por escolha de quem usa, e é a ordem que permite acompanhar
   * a tabela enquanto se cola. */
  /* Aviso de nota fiscal.
   *
   * Aqui a empresa escolhida não recorta a lista: ela é a emitente, quem vai
   * receber a nota, e vale para todos os prestadores do grupo. O PJ é do
   * grupo — é ele quem presta serviço para as empresas, e não uma empresa que
   * possui o PJ —, então um arquivo que trouxesse só os prestadores de uma
   * empresa deixaria de fora justamente quem atende mais de uma.
   *
   * `companyMeaning` é o que a rota lê para saber que não deve filtrar por
   * `companyColumn` neste relatório. O recorte por acesso continua valendo:
   * quem só enxerga parte das empresas continua enxergando só a parte dela. */
  "contractor-invoice-notice": {
    capability: "contractors.payments.read",
    companyMeaning: "issuer",
    columns: ["prestador", "codigo", "cnpj", "competencia", "nf_esperada", "status_nf"],
    query: `SELECT a.legal_name AS prestador, a.code AS codigo, a.tax_id AS cnpj, c.competence AS competencia,
        c.invoice_expected_amount AS nf_esperada, c.invoice_status AS status_nf
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE c.workspace_id = ? AND c.competence = ? AND c.excluded_at IS NULL
        AND c.invoice_expected_amount > 0`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
  "contractor-divergences": {
    capability: "contractors.payments.read",
    columns: ["prestador", "competencia", "liquido", "nf_esperada", "nf_recebida", "complemento", "complemento_pago", "diferenca", "conciliacao"],
    query: `SELECT a.legal_name AS prestador, c.competence AS competencia, c.net_amount AS liquido, c.invoice_expected_amount AS nf_esperada,
        c.invoice_received_amount AS nf_recebida, c.complement_amount AS complemento, c.complement_paid_amount AS complemento_pago,
        c.reconciliation_difference AS diferenca, c.reconciliation_status AS conciliacao
      FROM fdp_contractor_closings c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE c.workspace_id = ? AND c.competence = ? AND c.excluded_at IS NULL
        AND (c.reconciliation_status = 'divergent' OR c.invoice_status = 'divergent')`,
    companyColumn: "c.company_id",
    order: "ORDER BY a.legal_name",
  },
} as const;

export type PaymentReportKey = keyof typeof reports;
