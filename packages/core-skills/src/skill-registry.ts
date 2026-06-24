import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseSkillDefinition } from './skill-parser.js';
import { createAutoExecutionPlan, findMatchingSkills } from './skill-matcher.js';
import type {
  SkillAutoExecutionPlan,
  SkillDefinition,
  SkillExecutionPlan,
  SkillLoadResult,
  SkillMatchCandidate,
  SkillMatchOptions,
  SkillSource,
} from './types.js';

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  filterToolsForSkill(skillName: string, availableTools: string[]): string[] {
    const skill = this.requireSkill(skillName);
    const available = new Set(availableTools);
    return skill.allowedTools.filter((tool) => available.has(tool));
  }

  createExecutionPlan(skillName: string, userInput: string, availableTools: string[]): SkillExecutionPlan {
    const skill = this.requireSkill(skillName);
    return {
      skill,
      userInput: renderDefaults(userInput, skill.defaults),
      ...(skill.systemAddition ? { systemAddition: skill.systemAddition } : {}),
      allowedTools: this.filterToolsForSkill(skillName, availableTools),
      steps: skill.steps,
      outputFormat: skill.outputFormat,
    };
  }

  findMatchingSkills(options: SkillMatchOptions): SkillMatchCandidate[] {
    return findMatchingSkills(this.list(), options);
  }

  createAutoExecutionPlan(options: SkillMatchOptions): SkillAutoExecutionPlan | undefined {
    return createAutoExecutionPlan(this.list(), options);
  }

  private requireSkill(name: string): SkillDefinition {
    const skill = this.get(name);
    if (!skill) throw new Error(`Skill is not registered: ${name}`);
    return skill;
  }
}

export async function loadSkillsFromDirectories(
  directories: Array<{ path: string; source: SkillSource }>,
): Promise<SkillLoadResult> {
  const registry = new SkillRegistry();
  const errors: SkillLoadResult['errors'] = [];

  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries.sort()) {
      if (!['.yaml', '.yml', '.json'].includes(extname(entry))) continue;
      const path = join(directory.path, entry);
      try {
        registry.register(parseSkillDefinition(await readFile(path, 'utf8'), directory.source, path));
      } catch (error) {
        errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { skills: registry.list(), errors };
}

function renderDefaults(input: string, defaults: Record<string, string | number | boolean>): string {
  return input.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    defaults[key] === undefined ? match : String(defaults[key]),
  );
}
