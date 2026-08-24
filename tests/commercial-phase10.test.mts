import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  faqEntries, findProhibitedClaims, integrationCatalog, leadInterests, productBoundaries, sanitizeLead, siteNavigation,
} from "../lib/marketing.ts";

const sitePages = [
  "../app/page.tsx",
  "../app/solucao/page.tsx",
  "../app/funcionalidades/page.tsx",
  "../app/integracoes/page.tsx",
  "../app/planos/page.tsx",
  "../app/demonstracao/page.tsx",
  "../app/faq/page.tsx",
  "../app/contato/page.tsx",
] as const;

async function readPage(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("o site comercial existe com todas as páginas exigidas", async () => {
  const directories = await readdir(new URL("../app", import.meta.url));
  for (const route of ["solucao", "funcionalidades", "integracoes", "planos", "demonstracao", "faq", "contato", "termos", "privacidade", "subprocessadores", "login", "recuperar"]) {
    assert.ok(directories.includes(route), `rota ausente: /${route}`);
  }
  // A navegação declarada é a mesma usada pelas páginas.
  assert.deepEqual(siteNavigation.map((item) => item.href), ["/solucao", "/funcionalidades", "/integracoes", "/planos", "/faq", "/contato"]);
});

test("nenhuma página do site promete admissão digital própria, prontuário ou cálculo tributário", async () => {
  for (const page of [...sitePages, "../app/termos/page.tsx", "../app/privacidade/page.tsx", "../app/subprocessadores/page.tsx"]) {
    const source = await readPage(page);
    const claims = findProhibitedClaims(source);
    assert.deepEqual(claims, [], `${page} contém promessa proibida: ${claims.join(", ")}`);
  }
});

test("a guarda de promessas reconhece a violação e aceita a negativa", () => {
  assert.deepEqual(findProhibitedClaims("Faça a admissão digital própria dentro do Fila DP"), ["admissão digital própria"]);
  assert.deepEqual(findProhibitedClaims("Prontuário psicológico integrado"), ["prontuário psicológico"]);
  assert.deepEqual(findProhibitedClaims("Cálculo tributário automático do PJ"), ["cálculo tributário ou emissão fiscal"]);
  assert.deepEqual(findProhibitedClaims("Substitui o ERP de folha"), ["substituição de ERP/contador"]);
  // Dizer o que o produto não faz é obrigatório, não violação.
  assert.deepEqual(findProhibitedClaims("O Fila DP não executa a admissão digital: ela permanece na Sólides."), []);
  assert.deepEqual(findProhibitedClaims("Não armazena diagnóstico, evolução ou anotação terapêutica."), []);
  assert.deepEqual(findProhibitedClaims("Não guarda prontuário psicológico e não faz cálculo tributário."), []);
  assert.deepEqual(findProhibitedClaims("Prontuário e agenda clínica ficam fora do escopo do produto."), []);
  // A negação de um trecho não libera a promessa de outro no mesmo texto.
  assert.deepEqual(
    findProhibitedClaims("Não guarda prontuário. Em compensação, oferece cálculo tributário automático para o PJ."),
    ["cálculo tributário ou emissão fiscal"],
  );
});

test("o site declara as fronteiras do produto em vez de escondê-las", async () => {
  const solucao = await readPage("../app/solucao/page.tsx");
  const funcionalidades = await readPage("../app/funcionalidades/page.tsx");
  assert.match(solucao, /productBoundaries/);
  assert.match(funcionalidades, /productBoundaries/);
  const titles = productBoundaries.map((item) => item.title);
  assert.ok(titles.some((title) => /ERP de folha/u.test(title)));
  assert.ok(titles.some((title) => /admiss[ãa]o digital/iu.test(title)));
  assert.ok(titles.some((title) => /cl[íi]nico/iu.test(title)));
  assert.ok(titles.some((title) => /fiscal|tribut/iu.test(title)));
  // O rodapé do site repete o limite em toda página.
  const shell = await readPage("../app/site/SiteShell.tsx");
  assert.match(shell, /admiss[ãa]o digital é executada na Sólides/u);
  assert.match(shell, /não substitui contador nem emite nota fiscal/u);
});

test("a home lê o catálogo real e não escreve preço no código", async () => {
  const home = await readPage("../app/page.tsx");
  // Nenhum preço, nome de plano ou limite fixo no código da página.
  assert.doesNotMatch(home, /R\$\s?\d/u);
  assert.doesNotMatch(home, /plan-name">Standard/u);
  assert.doesNotMatch(home, /plan-name">Premium/u);
  assert.match(home, /FROM fdp_saas_plans WHERE status = 'active'/);
  assert.match(home, /monthly_price_cents/);
  // Sem catálogo, a seção remete à equipe em vez de inventar condição.
  assert.match(home, /Condições sob consulta/);
  assert.match(home, /href="\/planos"/);
  assert.match(home, /href="\/contato/);
  assert.match(home, /site-boundary-note/);
});

test("a home só oferece cadastro grátis quando existe plano sem custo e autocadastro habilitado", async () => {
  const home = await readPage("../app/page.tsx");
  // A oferta é condicional às duas verdades, não um texto solto no herói.
  assert.match(home, /const freePlan = plans\.find\(\(plan\) => plan\.monthly_price_cents === 0\)/);
  assert.match(home, /const freeSignup = signupOpen && Boolean\(freePlan\)/);
  assert.match(home, /freeSignup[\s\S]{0,120}Começar grátis/u);
  // "Começar grátis" nunca aparece fora da condição.
  const offers = [...home.matchAll(/Começar grátis/gu)];
  assert.equal(offers.length, 2, "a oferta grátis deve existir só nos dois CTAs condicionais");
  for (const offer of offers) {
    const before = home.slice(Math.max(0, (offer.index ?? 0) - 200), offer.index);
    assert.match(before, /freeSignup/u, "oferta grátis sem a condição do catálogo");
  }
});

test("a home entrega o posicionamento Vinculato, não o texto anterior", async () => {
  const home = await readPage("../app/page.tsx");
  assert.match(home, /<h1>Sua operação, conectada\.<\/h1>/u);
  assert.match(home, /Centralize processos, demandas, documentos e integrações/u);
  // O posicionamento antigo, centrado em fila e quadro kanban, saiu.
  assert.doesNotMatch(home, /Toda demanda do DP na fila certa/u);
  assert.doesNotMatch(home, /kanban/iu);
  // O conteúdo vem da fonte única de marketing, não duplicado na página.
  for (const symbol of ["featureHighlights", "productBoundaries", "integrationCatalog", "faqEntries", "siteNavigation"]) {
    assert.match(home, new RegExp(symbol), `a home precisa consumir ${symbol} de lib/marketing`);
  }
});

test("a página de planos lê o catálogo persistido e não inventa preço", async () => {
  const source = await readPage("../app/planos/page.tsx");
  assert.match(source, /FROM fdp_saas_plans WHERE status = 'active'/);
  // O preço vem do catálogo; o que depende do provedor de pagamento é a
  // contratação direta, não a exibição do valor publicado.
  assert.match(source, /const payable = plan\.monthly_price_cents > 0 && Boolean\(plan\.stripe_monthly_price_id\)/);
  assert.match(source, /contratação com a equipe/);
  assert.match(source, /Falar com a equipe/);
  assert.match(source, /selfSignupEnabled/);
  // Sem catálogo, a página não mostra tabela de preços fabricada.
  assert.match(source, /Condições sob consulta/);
  assert.doesNotMatch(source, /R\$\s?\d/u);
});

test("o catálogo de integrações declara estado real e não promete fornecedor não integrado", () => {
  const byName = new Map(integrationCatalog.map((item) => [item.name, item]));
  // A Sólides deixou de ser "preparado" quando o conector oficial passou a existir, mas
  // continua parcial: depende do token do cliente e não traz os arquivos dos documentos.
  assert.equal(byName.get("Sólides")?.state, "partial");
  assert.match(byName.get("Sólides")!.note, /admissão permanece na Sólides/u);
  assert.equal(byName.get("Caju")?.state, "planned");
  assert.equal(byName.get("Sankhya")?.state, "partial");
  assert.equal(byName.get("API pública Vinculato")?.state, "available");

  // Teams, e-mail e WhatsApp não podem voltar a "disponível" sem o handshake do
  // fornecedor. O endpoint de entrada é sólido, mas fala o protocolo do
  // Vinculato: a Meta exige eco de `hub.challenge` no GET de verificação e o
  // Microsoft Graph exige devolver `validationToken` e renovar a assinatura.
  // Sem isso o cliente não consegue sequer cadastrar a URL — chamar de
  // "disponível" venderia uma conexão que não conecta.
  for (const name of ["Microsoft Teams", "E-mail corporativo", "WhatsApp Business"] as const) {
    assert.equal(byName.get(name)?.state, "assisted", `${name} depende de configuração na ponta do fornecedor`);
    assert.match(byName.get(name)!.note, /implantação/iu, `${name} precisa dizer que a ponta do fornecedor é configurada junto`);
  }

  for (const item of integrationCatalog) {
    assert.ok(["available", "partial", "assisted", "planned"].includes(item.state), `${item.name} com estado inválido`);
    assert.ok(item.note.length > 10, `${item.name} precisa explicar o estado`);
  }
  // O texto do Caju deixa claro que não há integração implementada.
  assert.match(byName.get("Caju")!.note, /não há integração oficial implementada/u);
});

test("o formulário de contato valida entrada e exige consentimento", () => {
  const lead = sanitizeLead({
    name: "Maria Silva", email: "MARIA@EMPRESA.COM.BR", company: "Empresa",
    interest: "demonstracao", message: "Quero conhecer", consent: true, extra: "descartar",
  });
  assert.equal(lead.email, "maria@empresa.com.br");
  assert.equal(lead.interest, "demonstracao");
  assert.equal(Object.hasOwn(lead, "extra"), false);

  assert.throws(() => sanitizeLead({ name: "M", email: "a@b.com", interest: "demonstracao", consent: true }), /nome/iu);
  assert.throws(() => sanitizeLead({ name: "Maria", email: "invalido", interest: "demonstracao", consent: true }), /e-mail/iu);
  assert.throws(() => sanitizeLead({ name: "Maria", email: "a@b.com", interest: "inexistente", consent: true }), /assunto/iu);
  // Sem consentimento não há captação.
  assert.throws(() => sanitizeLead({ name: "Maria", email: "a@b.com", interest: "planos" }), /concordar/iu);
  assert.throws(() => sanitizeLead({ name: "Maria", email: "a@b.com", interest: "planos", consent: false }), /concordar/iu);
  // `privacidade` entrou porque a página de privacidade manda o titular pedir
  // acesso, correção, anonimização ou portabilidade por este mesmo formulário —
  // e não havia assunto para isso. O pedido chegava como "outro", numa tabela
  // chamada `fdp_marketing_leads`, listada no console sob "Leads comerciais".
  assert.deepEqual([...leadInterests], ["demonstracao", "planos", "integracoes", "suporte", "privacidade", "outro"]);
});

test("o contato é gravado de verdade, com limite por endereço e sem PII em log", async () => {
  const source = await readPage("../app/api/site/contact/route.ts");
  assert.match(source, /INSERT INTO fdp_marketing_leads/);
  assert.match(source, /sanitizeLead/);
  assert.match(source, /CONTACT_RATE_LIMITED/);
  assert.match(source, /fdp_api_rate_limits/);
  assert.match(source, /protocol/);
  // O log registra o fato, nunca o conteúdo do contato.
  assert.match(source, /interest: lead\.interest, hasCompany/);
  assert.doesNotMatch(source, /log\([^)]*lead\.email/u);
  assert.doesNotMatch(source, /log\([^)]*lead\.name/u);

  const form = await readPage("../app/contato/ContactForm.tsx");
  assert.match(form, /fetch\("\/api\/site\/contact"/);
  assert.match(form, /Protocolo/);
  assert.match(form, /role=\{status\.tone === "error" \? "alert" : "status"\}/);
  assert.match(form, /name="consent" required/);
});

test("os contatos são visíveis apenas para a administração da plataforma", async () => {
  const [route, migration] = await Promise.all([
    readPage("../app/api/platform/leads/route.ts"),
    readPage("../drizzle/postgres/0020_marketing_leads.sql"),
  ]);
  assert.match(route, /requirePlatformAdmin/);
  assert.match(route, /withPlatformContext/);
  assert.match(route, /fdp_platform_audit_events/);
  assert.match(migration, /ALTER TABLE "fdp_marketing_leads" FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /fdp_marketing_leads_platform_read/);
  assert.match(migration, /current_setting\('app.platform_admin', true\) = 'true'/);
  // A inserção pública existe, mas leitura e atualização são exclusivas da plataforma.
  assert.match(migration, /FOR INSERT WITH CHECK \(true\)/);
});

test("os documentos legais cobrem os pontos exigidos pela LGPD", async () => {
  const [termos, privacidade, dpa] = await Promise.all([
    readPage("../app/termos/page.tsx"),
    readPage("../app/privacidade/page.tsx"),
    readPage("../app/subprocessadores/page.tsx"),
  ]);

  for (const required of ["Última atualização", "cancelamento", "Limitação de responsabilidade"]) {
    assert.ok(termos.includes(required), `Termos sem seção: ${required}`);
  }
  assert.match(termos, /não calcula nem processa a folha de pagamento oficial/iu);
  assert.match(termos, /não armazena prontuário|Não armazena prontuário/u);

  for (const required of ["Bases legais", "Retenção", "Direitos do titular", "Incidentes de segurança", "Transferência internacional", "Encarregado", "minimização"]) {
    assert.ok(privacidade.toLowerCase().includes(required.toLowerCase()), `Privacidade sem seção: ${required}`);
  }
  assert.match(privacidade, /controlador/);
  assert.match(privacidade, /operador/);
  assert.match(privacidade, /HMAC/);
  assert.match(privacidade, /AES-256-GCM/);

  for (const required of ["Subprocessadores atuais", "Compromissos do operador", "Obrigações do controlador", "Medidas técnicas"]) {
    assert.ok(dpa.includes(required), `DPA sem seção: ${required}`);
  }
  // Backup não é declarado testado sem ensaio.
  assert.match(dpa, /devem ser ensaiados antes de serem\s*\n?\s*declarados válidos|não afirmamos restauração testada sem ensaio/u);
});

test("o FAQ responde às fronteiras do produto", () => {
  const questions = faqEntries.map((entry) => entry.question.toLowerCase()).join(" ");
  assert.ok(questions.includes("folha"));
  assert.ok(questions.includes("admissão") || questions.includes("sólides"));
  assert.ok(questions.includes("clínica") || questions.includes("psicólogos"));
  assert.ok(questions.includes("impostos") || questions.includes("pj"));
  const answers = faqEntries.map((entry) => entry.answer).join(" ");
  assert.deepEqual(findProhibitedClaims(answers), []);
  assert.match(answers, /Row Level Security/);
});

test("o site é navegável por teclado e tem marco de conteúdo", async () => {
  const shell = await readPage("../app/site/SiteShell.tsx");
  assert.match(shell, /Ir para o conteúdo/);
  assert.match(shell, /id="conteudo"/);
  assert.match(shell, /aria-label="Navegação do site"/);
  assert.match(shell, /aria-current=\{active === item\.href \? "page" : undefined\}/);
  const css = await readPage("../app/site/site.module.css");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 820px\)/);
});
