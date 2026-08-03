/** Maps D1-style positional markers to PostgreSQL parameters without changing SQL syntax. */
export function toPostgresParameters(sql: string) {
  let parameter = 0;
  let quote: "'" | '"' | "`" | null = null;
  let result = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote) {
      result += character;
      if (character === quote) {
        if (next === quote) {
          result += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
    } else if (character === "?") {
      parameter += 1;
      result += `$${parameter}`;
    } else {
      result += character;
    }
  }
  return result.trim();
}
