import type { SkillCapabilityRequirement } from './types.js';

export function skillCapabilityRequirements(
  metadata: Readonly<Record<string, string>>,
): SkillCapabilityRequirement[] {
  const raw = metadata.capabilities?.trim();
  if (!raw) return [];
  let values: unknown;
  if (raw.startsWith('[')) {
    try {
      values = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid Skill capability metadata: ${errorMessage(error)}`);
    }
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      throw new Error('Invalid Skill capability metadata: expected a JSON string array.');
    }
  } else {
    values = raw.split(/[\s,]+/u);
  }
  const seen = new Set<string>();
  const requirements: SkillCapabilityRequirement[] = [];
  for (const value of values as string[]) {
    const capabilityId = value.trim();
    if (!capabilityId || seen.has(capabilityId)) continue;
    seen.add(capabilityId);
    requirements.push({ capabilityId });
  }
  return requirements;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
