// Metro do Vinculato Campo.
//
// O app reaproveita as regras do sistema sem copiá-las: `lib/epi.ts`,
// `lib/epi-compliance.ts`, `app/campo/sesmt.logic.ts` e os normalizadores do
// painel moram na raiz do repositório e entram aqui pelo apelido `@/`
// (`tsconfig.json`). Duas cópias divergiriam no primeiro ajuste de regra — e
// a diferença apareceria só no celular de quem está no galpão.
//
// Por isso o Metro enxerga a raiz, mas **não** as pastas pesadas dela: o
// `node_modules` da raiz traria um segundo React, e `.next`/`desktop` são
// saídas de outros projetos.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");
const config = getDefaultConfig(projectRoot);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blocked = ["node_modules", ".next", "desktop", "worker", "examples", ".git"]
  .map((name) => new RegExp(`^${escape(path.join(repoRoot, name))}(/.*)?$`));

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];
config.resolver.blockList = [...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : config.resolver.blockList ? [config.resolver.blockList] : []), ...blocked];

module.exports = config;
