import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { createAutoExecutionPlan, findMatchingSkills } from './skill-matcher.js';
import { parseSkillDefinition, parseSkillDocument } from './skill-parser.js';
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

  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  filterToolsForSkill(skillName: string, availableTools: string[]): string[] {
    const available = new Set(availableTools);
    return this.requireSkill(skillName).allowedTools.filter((tool) => available.has(tool));
  }

  createExecutionPlan(
    skillName: string,
    userInput: string,
    availableTools: string[],
  ): SkillExecutionPlan {
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
    const candidates = await discoverSkillFiles(directory.path);
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf8');
        registry.register(
          path.endsWith('SKILL.md')
            ? parseSkillDocument(content, directory.source, path, dirname(path))
            : parseSkillDefinition(content, directory.source, path),
        );
      } catch (error) {
        errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { skills: registry.list(), errors };
}

async function discoverSkillFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const candidates: string[] = [];
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    candidates.push(join(root, 'SKILL.md'));
  }
  for (const entry of entries) {
    if (entry.isFile() && ['.yaml', '.yml', '.json'].includes(extname(entry.name))) {
      candidates.push(join(root, entry.name));
    }
    if (entry.isDirectory()) {
      const bundle = join(root, entry.name, 'SKILL.md');
      try {
        await readFile(bundle, 'utf8');
        candidates.push(bundle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return candidates.sort((left, right) => left.localeCompare(right));
}

function renderDefaults(
  input: string,
  defaults: Record<string, string | number | boolean>,
): string {
  return input.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    defaults[key] === undefined ? match : String(defaults[key]),
  );
}
