import { describe, expect, it } from 'vitest';
import { analyzeSqlPerformance } from '../src/index.js';

describe('analyzeSqlPerformance', () => {
  it('does not warn for bounded aggregate queries', () => {
    expect(
      analyzeSqlPerformance(`
        select count(*) as users
        from users
        where created_at >= now() - interval '7 days'
      `),
    ).toEqual([]);
  });

  it('flags common slow-query patterns in complex analytical SQL', () => {
    const warnings = analyzeSqlPerformance(`
      select *
      from users u, orders o
      where lower(u.email) like '%@example.com'
      order by o.created_at desc
      offset 25000
    `);

    expect(warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'SELECT_STAR',
        'MISSING_LIMIT',
        'LEADING_WILDCARD_LIKE',
        'LARGE_OFFSET',
        'CARTESIAN_JOIN',
        'FUNCTION_ON_FILTER_COLUMN',
      ]),
    );
  });

  it('ignores write statements because execution safety handles them separately', () => {
    expect(analyzeSqlPerformance("update users set city = 'Shanghai' where id = 1")).toEqual([]);
  });
});
