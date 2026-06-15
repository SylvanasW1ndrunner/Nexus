import type { DatabaseEngine, PluginManifest } from '@dbagent/shared';

export type PluginCommandContext = {
  activeDatabaseEngine?: DatabaseEngine;
  editorLanguage: 'sql' | 'python' | 'markdown' | 'plaintext';
  hasWorkspace: boolean;
  hasResult: boolean;
};

export function isPluginCommandAvailable(
  plugin: PluginManifest,
  commandId: string,
  context: PluginCommandContext,
): boolean {
  if (!plugin.installed || !plugin.enabled) return false;
  if (!(plugin.contributes.commands ?? []).some((command) => command.id === commandId)) return false;

  if (commandId === 'dbagent.postgres.connect') return true;
  if (commandId === 'dbagent.postgres.explain') {
    return context.editorLanguage === 'sql' && context.activeDatabaseEngine === 'postgres';
  }
  if (commandId === 'dbagent.python.detect') return true;
  if (commandId === 'dbagent.python.runCurrentFile') {
    return context.editorLanguage === 'python' && context.hasWorkspace;
  }
  if (commandId === 'dbagent.python.createVenv') return context.hasWorkspace;
  if (
    commandId === 'dbagent.result.exportCsv' ||
    commandId === 'dbagent.result.exportExcel' ||
    commandId === 'dbagent.result.exportJson'
  ) {
    return context.hasResult;
  }
  if (commandId === 'dbagent.chart.preview') return context.hasResult && pluginActivationMatches(plugin, context);

  return false;
}

export function pluginActivationMatches(plugin: PluginManifest, context: PluginCommandContext): boolean {
  if (!plugin.activationEvents.length) return true;
  return plugin.activationEvents.some((event) => {
    if (event === 'onResultSet') return context.hasResult;
    if (event.startsWith('onLanguage:')) return event.slice('onLanguage:'.length) === context.editorLanguage;
    if (event.startsWith('onDatabase:')) return event.slice('onDatabase:'.length) === context.activeDatabaseEngine;
    if (event.startsWith('onWorkspaceContains:')) return context.hasWorkspace;
    return false;
  });
}
