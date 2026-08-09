export function splitPostgresStatements(source) {
  const statements = [];
  let current = "";
  let state = "normal";
  let dollarTag = "";
  let blockCommentDepth = 0;

  const pushStatement = () => {
    const statement = current.trim();
    if (statement && !/^--[^\n]*(?:\n--[^\n]*)*$/u.test(statement)) statements.push(statement);
    current = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? "";
    current += character;

    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      continue;
    }

    if (state === "block-comment") {
      if (character === "/" && next === "*") {
        current += next;
        index += 1;
        blockCommentDepth += 1;
      } else if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockCommentDepth -= 1;
        if (blockCommentDepth === 0) state = "normal";
      }
      continue;
    }

    if (state === "single-quote") {
      if (character === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }

    if (state === "double-quote") {
      if (character === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }

    if (state === "dollar-quote") {
      if (source.startsWith(dollarTag, index)) {
        current += dollarTag.slice(1);
        index += dollarTag.length - 1;
        state = "normal";
        dollarTag = "";
      }
      continue;
    }

    if (character === "-" && next === "-") {
      current += next;
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      current += next;
      index += 1;
      state = "block-comment";
      blockCommentDepth = 1;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      state = "double-quote";
      continue;
    }
    if (character === "$") {
      const tag = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarTag = tag;
        state = "dollar-quote";
        continue;
      }
    }
    if (character === ";") pushStatement();
  }

  if (state !== "normal" && state !== "line-comment") {
    throw new Error(`SQL incompleto: delimitador não encerrado (${state}).`);
  }
  pushStatement();
  return statements;
}
