import type { PluginManifest } from '@dbagent/shared';

const allowedCategories = new Set<PluginManifest['categories'][number]>([
  'database',
  'python',
  'visualization',
  'export',
  'productivity',
]);
const allowedViewLocations = new Set(['left-sidebar', 'right-sidebar', 'bottom-panel', 'settings']);
const allowedConfigurationTypes = new Set(['string', 'number', 'boolean', 'enum']);

export function validatePluginManifests(plugins: PluginManifest[]): void {
  const pluginIds = new Set<string>();
  const commandIds = new Set<string>();
  const viewIds = new Set<string>();
  const configurationKeys = new Set<string>();

  for (const plugin of plugins) {
    validateRequiredString(plugin.id, 'plugin id');
    validateRequiredString(plugin.name, `${plugin.id} name`);
    validateRequiredString(plugin.publisher, `${plugin.id} publisher`);
    validateRequiredString(plugin.version, `${plugin.id} version`);
    validateRequiredString(plugin.description, `${plugin.id} description`);
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(plugin.id)) {
      throw new Error(`Plugin ${plugin.id} must use a reverse-domain id.`);
    }
    if (pluginIds.has(plugin.id)) throw new Error(`Duplicate plugin id: ${plugin.id}`);
    pluginIds.add(plugin.id);
    if (plugin.enabled && !plugin.installed) throw new Error(`Plugin ${plugin.id} cannot be enabled when not installed.`);
    if (plugin.builtin && !plugin.installed) throw new Error(`Built-in plugin ${plugin.id} must be installed.`);
    if (!plugin.categories.length) throw new Error(`Plugin ${plugin.id} must declare at least one category.`);
    for (const category of plugin.categories) {
      if (!allowedCategories.has(category)) throw new Error(`Plugin ${plugin.id} has invalid category ${category}.`);
    }
    for (const event of plugin.activationEvents) {
      if (!isValidActivationEvent(event)) throw new Error(`Plugin ${plugin.id} has invalid activation event ${event}.`);
    }
    for (const command of plugin.contributes.commands ?? []) {
      validateRequiredString(command.id, `${plugin.id} command id`);
      validateRequiredString(command.title, `${command.id} title`);
      validateRequiredString(command.category, `${command.id} category`);
      if (!sharesRootNamespace(command.id, plugin.id)) throw new Error(`Command ${command.id} must be namespaced by ${plugin.id}.`);
      if (commandIds.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`);
      commandIds.add(command.id);
    }
    for (const view of plugin.contributes.views ?? []) {
      validateRequiredString(view.id, `${plugin.id} view id`);
      validateRequiredString(view.title, `${view.id} title`);
      if (!sharesRootNamespace(view.id, plugin.id)) throw new Error(`View ${view.id} must be namespaced by ${plugin.id}.`);
      if (!allowedViewLocations.has(view.location)) throw new Error(`View ${view.id} has invalid location ${view.location}.`);
      if (viewIds.has(view.id)) throw new Error(`Duplicate view id: ${view.id}`);
      viewIds.add(view.id);
    }
    for (const configuration of plugin.contributes.configuration ?? []) {
      validateRequiredString(configuration.key, `${plugin.id} configuration key`);
      validateRequiredString(configuration.title, `${configuration.key} title`);
      if (!configuration.key.startsWith(plugin.id.replace(/^dbagent\./, ''))) {
        throw new Error(`Configuration ${configuration.key} must be namespaced by ${plugin.id}.`);
      }
      if (!allowedConfigurationTypes.has(configuration.type)) {
        throw new Error(`Configuration ${configuration.key} has invalid type ${configuration.type}.`);
      }
      if (configuration.type === 'enum' && (!configuration.enumValues?.length || !configuration.enumValues.includes(String(configuration.defaultValue)))) {
        throw new Error(`Enum configuration ${configuration.key} must include its default value.`);
      }
      if (configurationKeys.has(configuration.key)) throw new Error(`Duplicate configuration key: ${configuration.key}`);
      configurationKeys.add(configuration.key);
    }
  }
}

function validateRequiredString(value: string, label: string): void {
  if (!value.trim()) throw new Error(`Missing ${label}.`);
}

function isValidActivationEvent(event: string): boolean {
  return (
    event === 'onResultSet' ||
    /^onDatabase:[a-z][a-z0-9-]*$/.test(event) ||
    /^onLanguage:[a-z][a-z0-9-]*$/.test(event) ||
    /^onWorkspaceContains:[A-Za-z0-9._/-]+$/.test(event)
  );
}

function sharesRootNamespace(contributionId: string, pluginId: string): boolean {
  return contributionId.split('.')[0] === pluginId.split('.')[0] && contributionId.includes('.');
}
