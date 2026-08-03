import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const dirty = git("status", "--porcelain");
if (dirty) throw new Error("A árvore de trabalho contém alterações não versionadas.");

const commit = git("rev-parse", "HEAD");
const branch = git("branch", "--show-current");
if (!branch) throw new Error("O deploy não pode partir de um HEAD destacado.");
console.log(JSON.stringify({ commit, branch, gitDirty: false }));
