/** SQLite → PostgreSQL : placeholders `?` → `$n`, `INSERT OR IGNORE`, `IS ?`. Les chaînes entre apostrophes sont respectées. */
const cache = new Map<string, string>();
export function translate(input: string): string {
  const hit = cache.get(input);
  if (hit) return hit;
  let sql = input;
  let ignore = false;
  sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, () => {
    ignore = true;
    return 'INSERT INTO';
  });
  sql = sql.replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?');
  let out = '';
  let n = 0;
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  if (ignore) out = out.trimEnd().replace(/;$/, '') + ' ON CONFLICT DO NOTHING';
  cache.set(input, out);
  return out;
}

