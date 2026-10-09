/**
 * Split a Prisma-generated SQLite migration into single statements.
 *
 * Needed because Prisma's raw SQL on SQLite executes ONLY the first statement of
 * a multi-statement string and still reports success. The splitter understands
 * '…' and "…" literals (with doubled-quote escapes), `…` and […] identifiers,
 * -- and /* *\/ comments. A CREATE TRIGGER … BEGIN … END statement is kept whole: its body
 * holds `;`, so the statement only ends at the `;` after the END that closes the BEGIN
 * (CASE … END inside the body is counted). Anything it cannot split safely (a trigger that
 * never closes) is refused instead of guessed.
 */
export class UnsafeMigrationSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMigrationSqlError";
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  const push = () => {
    const s = current.trim();
    if (s) statements.push(s);
    current = "";
    words.length = 0;
    depth = 0;
    sawBegin = false;
  };

  // Words seen outside literals and comments in the current statement, to recognise CREATE TRIGGER and its BEGIN … END.
  const words: string[] = [];
  let word = "";
  let depth = 0;
  let sawBegin = false;
  const isTrigger = () => words[0] === "CREATE" && (words[1] === "TRIGGER" || ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER"));
  const endWord = () => {
    if (!word) return;
    const w = word.toUpperCase();
    word = "";
    if (words.length < 4) words.push(w);
    if (!isTrigger()) return;
    if (w === "BEGIN") { depth++; sawBegin = true; }
    else if (w === "CASE") depth++;
    else if (w === "END") depth--;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (!/[A-Za-z_]/.test(c)) endWord();
    else word += c;
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      current += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new UnsafeMigrationSqlError("Unterminated /* comment */ in migration SQL");
      i = end + 2;
      current += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new UnsafeMigrationSqlError(`Unterminated ${c} literal in migration SQL`);
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2; // doubled quote = escaped quote
            continue;
          }
          break;
        }
        j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ";") {
      endWord();
      // Inside a trigger body the `;` belongs to the statement; it ends after the END that closes the BEGIN.
      if (isTrigger() && (!sawBegin || depth > 0)) {
        current += c;
        i++;
        continue;
      }
      push();
      i++;
      continue;
    }
    current += c;
    i++;
  }
  endWord();
  if (isTrigger() && (!sawBegin || depth !== 0)) throw new UnsafeMigrationSqlError("A CREATE TRIGGER statement in the migration SQL never closes its BEGIN … END");
  push();
  return statements;
}
