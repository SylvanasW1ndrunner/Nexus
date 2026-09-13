import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SkillRegistry } from './skill-registry.js';
import type { SkillDirectorySource, SkillDocument, SkillRegistryOptions } from './types.js';

export function systemSkillsDirectory(): string {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledDirectory = resolve(runtimeDirectory, 'skills', 'system');
  return existsSync(bundledDirectory)
    ? bundledDirectory
    : resolve(runtimeDirectory, '..', 'skills', 'system');
}

export function systemSkillSource(): SkillDirectorySource {
  return {
    scope: 'system',
    path: systemSkillsDirectory(),
    id: 'schemanaut-system',
  };
}

export async function createSystemSkillRegistry(
  options: Omit<SkillRegistryOptions, 'sources'> & {
    sources?: readonly SkillDirectorySource[];
  } = {},
): Promise<SkillRegistry> {
  const registry = new SkillRegistry({
    sources: [systemSkillSource(), ...(options.sources ?? [])],
    ...(options.sessionOverlay === undefined ? {} : { sessionOverlay: options.sessionOverlay }),
    ...(options.capabilityResolver === undefined
      ? {}
      : { capabilityResolver: options.capabilityResolver }),
    ...(options.revisionCachePath === undefined
      ? {}
      : { revisionCachePath: options.revisionCachePath }),
    ...(options.bundleLimits === undefined ? {} : { bundleLimits: options.bundleLimits }),
  });
  await registry.refresh();
  return registry;
}

export async function loadSystemSkills(): Promise<SkillDocument[]> {
  const registry = await createSystemSkillRegistry();
  return await Promise.all(
    registry.list({ scope: 'system' }).map(async ({ name }) => await registry.load(name)),
  );
}
