import type { PluginManifest } from '@dbagent/shared';

export type PluginMarketplaceFilter = 'all' | 'installed' | 'enabled' | 'official';

export function listPluginCategories(plugins: PluginManifest[]): string[] {
  return [...new Set(plugins.flatMap((plugin) => plugin.categories))].sort((left, right) => left.localeCompare(right));
}

export function filterPlugins(
  plugins: PluginManifest[],
  options: {
    query: string;
    category: string;
    filter: PluginMarketplaceFilter;
  },
): PluginManifest[] {
  const query = options.query.trim().toLowerCase();
  return plugins
    .filter((plugin) => {
      if (options.category && !plugin.categories.includes(options.category as PluginManifest['categories'][number])) return false;
      if (options.filter === 'installed' && !plugin.installed) return false;
      if (options.filter === 'enabled' && !plugin.enabled) return false;
      if (options.filter === 'official' && !plugin.official) return false;
      if (!query) return true;
      const haystack = [
        plugin.name,
        plugin.publisher,
        plugin.description,
        plugin.id,
        ...plugin.categories,
        ...plugin.activationEvents,
        ...(plugin.contributes.commands ?? []).flatMap((command) => [command.id, command.title, command.category]),
        ...(plugin.contributes.views ?? []).flatMap((view) => [view.id, view.title, view.location]),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((left, right) => Number(right.installed) - Number(left.installed) || left.name.localeCompare(right.name));
}

export function getPluginPrimaryAction(plugin: PluginManifest): {
  installTarget: boolean;
  enableTarget?: boolean;
} {
  if (!plugin.installed) return { installTarget: true };
  return {
    installTarget: false,
    enableTarget: !plugin.enabled,
  };
}
