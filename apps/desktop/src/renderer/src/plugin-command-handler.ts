export type PluginCommandAction =
  | 'open-settings'
  | 'explain-sql'
  | 'run-python'
  | 'create-venv'
  | 'detect-python'
  | 'export-csv'
  | 'export-excel'
  | 'export-json'
  | 'preview-chart'
  | 'unbound';

const pluginCommandActions: Record<string, PluginCommandAction> = {
  'dbagent.postgres.connect': 'open-settings',
  'dbagent.postgres.explain': 'explain-sql',
  'dbagent.python.runCurrentFile': 'run-python',
  'dbagent.python.createVenv': 'create-venv',
  'dbagent.python.detect': 'detect-python',
  'dbagent.result.exportCsv': 'export-csv',
  'dbagent.result.exportExcel': 'export-excel',
  'dbagent.result.exportJson': 'export-json',
  'dbagent.chart.preview': 'preview-chart',
};

export function resolvePluginCommandAction(commandId: string): PluginCommandAction {
  return pluginCommandActions[commandId] ?? 'unbound';
}
