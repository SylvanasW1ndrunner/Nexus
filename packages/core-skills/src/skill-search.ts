import type { SkillCatalogEntry, SkillSearchResult } from './types.js';
import { compareUnicodeCodePoints } from './canonical-text-order.js';

/**
 * Lightweight catalog search for `/skills` and internal host callers.
 *
 * This is not an automatic workflow planner. Agent-side activation should use
 * the model-visible name/description catalog; no proprietary keyword or signal
 * fields are required.
 */
export function searchSkillCatalog(
  catalog: readonly SkillCatalogEntry[],
  query: string,
  limit = 20,
): SkillSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Skill search limit must be a positive integer.');
  }
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return catalog.slice(0, limit).map((skill) => ({ skill: { ...skill }, score: 0 }));
  }
  const terms = searchTerms(normalizedQuery);

  return catalog
    .map((skill) => ({ skill, score: scoreSkill(skill, normalizedQuery, terms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || compareUnicodeCodePoints(left.skill.name, right.skill.name),
    )
    .slice(0, limit)
    .map(({ skill, score }) => ({ skill: { ...skill }, score }));
}

function scoreSkill(skill: SkillCatalogEntry, query: string, terms: readonly string[]): number {
  const name = normalize(skill.name);
  const description = normalize(skill.description);
  let score = 0;
  if (name === query) score += 100;
  else if (name.startsWith(query)) score += 60;
  else if (name.includes(query)) score += 40;
  if (description.includes(query)) score += 30;
  for (const term of terms) {
    if (name === term) score += 20;
    else if (name.includes(term)) score += 10;
    if (description.includes(term)) score += 5;
  }
  return score;
}

function searchTerms(value: string): string[] {
  const terms = new Set(
    value
      .split(/[\s,，。！？、/:;；：]+/)
      .map((term) => term.trim())
      .filter(Boolean),
  );
  for (const sequence of value.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.add(sequence.slice(index, index + 2));
    }
  }
  return [...terms];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
