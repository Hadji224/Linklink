import { describe, expect, it } from 'vitest';
import { translate } from '../src/sqltranslate.js';

describe('traduction SQLite → PostgreSQL', () => {
  it('numérote les placeholders', () => {
    expect(translate('SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?')).toBe('SELECT * FROM t WHERE a = $1 AND b = $2 LIMIT $3');
  });
  it("ne touche pas un « ? » entre apostrophes", () => {
    expect(translate("SELECT '?' AS q, x FROM t WHERE y = ?")).toBe("SELECT '?' AS q, x FROM t WHERE y = $1");
  });
  it('INSERT OR IGNORE devient ON CONFLICT DO NOTHING', () => {
    expect(translate('INSERT OR IGNORE INTO t (a,b) VALUES (?,?)')).toBe('INSERT INTO t (a,b) VALUES ($1,$2) ON CONFLICT DO NOTHING');
  });
  it('IS ? devient une comparaison qui accepte NULL', () => {
    expect(translate('SELECT 1 FROM f WHERE parent_id IS ?')).toBe('SELECT 1 FROM f WHERE parent_id IS NOT DISTINCT FROM $1');
  });
  it('laisse IS NULL et IS NOT NULL intacts', () => {
    const q = 'SELECT 1 FROM t WHERE a IS NULL AND b IS NOT NULL AND c = ?';
    expect(translate(q)).toBe('SELECT 1 FROM t WHERE a IS NULL AND b IS NOT NULL AND c = $1');
  });
});
