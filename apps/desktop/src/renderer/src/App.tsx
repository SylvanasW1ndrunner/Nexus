import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { Editor } from '@monaco-editor/react';
import {
  ipcChannels,
  queryResultToCsv,
  queryResultToJson,
  type ConnectionInput,
  type QueryExecutionResult,
  type QueryHistoryItem,
  type SavedConnection,
  type TableDetail,
  type TableSummary,
  type WorkspaceProject,
  type WorkspaceRecentState,
  type WorkspaceFileEntry,
  type WorkspacePythonConfig,
  type WorkspaceTemplate,
} from '@dbagent/shared';
import { connectionToDraft, defaultConnectionDraft } from './connection-draft.js';
import { formatAppError, summarizePerformanceWarnings } from './diagnostics.js';
import { createTranslator, normalizeLanguage, type AppLanguage } from './i18n.js';

const starterSql = `select
  now() as checked_at,
  current_database() as database_name;`;

const storageKeys = {
  language: 'dbagent.language',
};

type WorkspaceDraft = {
  name: string;
  rootPath: string;
  description: string;
  template: WorkspaceTemplate;
};

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  content: string;
};

type TopBarAction = 'new-project' | 'open-project' | 'save-sql' | 'run-sql' | 'explain-sql' | 'project-settings';

type EditorLanguage = 'sql' | 'python' | 'markdown' | 'plaintext';

type WorkspaceDialogMode = 'create' | 'settings';

type DatabaseEngineOption = {
  id: ConnectionInput['engine'];
  label: string;
  description: string;
};

const defaultWorkspaceDraft: WorkspaceDraft = {
  name: '电商分析项目',
  rootPath: '',
  description: '',
  template: 'standard',
};

const defaultWorkspacePythonDraft: WorkspacePythonConfig = {
  mode: 'system',
  requirementsPath: 'scripts/requirements.txt',
};

const databaseEngineOptions: DatabaseEngineOption[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    description: 'M0-M1.5 默认支持',
  },
];

export function App() {
  const [language, setLanguage] = useState<AppLanguage>(() =>
    normalizeLanguage(window.localStorage.getItem(storageKeys.language)),
  );
  const t = useMemo(() => createTranslator(language), [language]);
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState('');
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState<TableDetail | undefined>();
  const [sql, setSql] = useState(starterSql);
  const [editorLanguage, setEditorLanguage] = useState<EditorLanguage>('sql');
  const [result, setResult] = useState<QueryExecutionResult | undefined>();
  const [message, setMessage] = useState(t('assistantReady'));
  const [connectionDraft, setConnectionDraft] = useState<ConnectionInput>(defaultConnectionDraft);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft>(defaultWorkspaceDraft);
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceRecentState>({ workspaces: [] });
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceProject | undefined>();
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceDialogMode, setWorkspaceDialogMode] = useState<WorkspaceDialogMode>('create');
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [createConnectionDuringWorkspace, setCreateConnectionDuringWorkspace] = useState(false);
  const [selectedDatabaseEngine, setSelectedDatabaseEngine] = useState<ConnectionInput['engine']>('postgres');
  const [workspaceSettingsDraft, setWorkspaceSettingsDraft] = useState({
    sqlLibrary: 'sql/analytics',
    scripts: 'scripts',
    docs: 'docs',
    outputs: 'outputs',
  });
  const [workspacePythonDraft, setWorkspacePythonDraft] = useState<WorkspacePythonConfig>(defaultWorkspacePythonDraft);
  const [chatDraft, setChatDraft] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: '工作台已就绪。你可以在项目中沉淀 SQL、脚本和文档。',
    },
  ]);
  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeConnectionId),
    [activeConnectionId, connections],
  );

  useEffect(() => {
    window.localStorage.setItem(storageKeys.language, language);
    setMessage(createTranslator(language)('assistantReady'));
  }, [language]);

  useEffect(() => {
    void refreshConnections();
    void refreshHistory();
    void restoreWorkspaceState();
    void refreshWorkspace();
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const state = {
        sqlDraft: sql,
        updatedAt: new Date().toISOString(),
        ...(activeConnectionId ? { activeConnectionId } : {}),
      };
      void window.dbagent.invoke(ipcChannels.app.saveWorkspaceState, state);
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [activeConnectionId, sql]);

  useEffect(() => {
    if (!activeConnectionId) {
      setTables([]);
      setSelectedTable(undefined);
      return;
    }
    void refreshTables(activeConnectionId);
  }, [activeConnectionId, connections]);

  async function restoreWorkspaceState() {
    const response = await window.dbagent.invoke(ipcChannels.app.loadWorkspaceState, undefined);
    if (!response.ok || !response.data) return;
    setSql(response.data.sqlDraft);
    if (response.data.activeConnectionId) setActiveConnectionId(response.data.activeConnectionId);
  }

  async function refreshWorkspace() {
    const [recentResponse, activeResponse] = await Promise.all([
      window.dbagent.invoke(ipcChannels.workspace.listRecent, undefined),
      window.dbagent.invoke(ipcChannels.workspace.loadActive, undefined),
    ]);
    if (recentResponse.ok) setRecentWorkspaces(recentResponse.data);
    if (activeResponse.ok) {
      setActiveWorkspace(activeResponse.data);
      if (activeResponse.data) {
        setWorkspaceSettingsDraft(activeResponse.data.assetPaths);
        setWorkspacePythonDraft(activeResponse.data.python);
        await refreshWorkspaceFiles(activeResponse.data.rootPath);
      }
    }
  }

  async function refreshWorkspaceFiles(rootPath: string) {
    const response = await window.dbagent.invoke(ipcChannels.workspace.listFiles, { rootPath });
    if (response.ok) {
      setWorkspaceFiles(response.data);
    } else {
      setWorkspaceFiles([]);
      setMessage(formatAppError(response.error));
    }
  }

  async function chooseWorkspaceDirectory() {
    const response = await window.dbagent.invoke(ipcChannels.workspace.chooseDirectory, {
      title: t('chooseFolder'),
      buttonLabel: t('chooseFolder'),
    });
    if (response.ok && response.data.path) {
      setWorkspaceDraft((draft) => ({ ...draft, rootPath: response.data.path ?? '' }));
    } else if (!response.ok) {
      setMessage(formatAppError(response.error));
    }
  }

  async function chooseAndOpenWorkspace() {
    const response = await window.dbagent.invoke(ipcChannels.workspace.chooseDirectory, {
      title: t('openProject'),
      buttonLabel: t('openProject'),
    });
    if (response.ok && response.data.path) {
      await openWorkspace(response.data.path);
    } else if (!response.ok) {
      setMessage(formatAppError(response.error));
    }
  }

  async function createWorkspace() {
    setMessage(language === 'zh-CN' ? '正在创建项目...' : 'Creating project...');
    const response = await window.dbagent.invoke(ipcChannels.workspace.create, {
      ...workspaceDraft,
      python: workspacePythonDraft,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setActiveWorkspace(response.data);
    setWorkspaceSettingsDraft(response.data.assetPaths);
    setWorkspacePythonDraft(response.data.python);
    await refreshWorkspaceFiles(response.data.rootPath);
    setWorkspaceDraft({ ...defaultWorkspaceDraft, rootPath: response.data.rootPath });
    setMessage(language === 'zh-CN' ? `已打开项目 ${response.data.name}` : `Opened ${response.data.name}`);
    if (createConnectionDuringWorkspace) {
      const connectionResponse = await window.dbagent.invoke(ipcChannels.connection.create, {
        ...connectionDraft,
        engine: selectedDatabaseEngine,
      });
      if (connectionResponse.ok) {
        setActiveConnectionId(connectionResponse.data.id);
        setConnectionDraft(connectionToDraft(connectionResponse.data));
        await refreshConnections();
      } else {
        setMessage(formatAppError(connectionResponse.error));
      }
    }
    setWorkspaceDialogOpen(false);
    await refreshWorkspace();
  }

  async function openWorkspace(rootPath: string) {
    setMessage(language === 'zh-CN' ? '正在打开项目...' : 'Opening project...');
    const response = await window.dbagent.invoke(ipcChannels.workspace.open, { rootPath });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setActiveWorkspace(response.data);
    setWorkspaceSettingsDraft(response.data.assetPaths);
    setWorkspacePythonDraft(response.data.python);
    await refreshWorkspaceFiles(response.data.rootPath);
    setMessage(language === 'zh-CN' ? `已打开项目 ${response.data.name}` : `Opened ${response.data.name}`);
    await refreshWorkspace();
  }

  async function refreshConnections() {
    const response = await window.dbagent.invoke(ipcChannels.connection.list, undefined);
    if (response.ok) {
      setConnections(response.data);
      setActiveConnectionId((current) => {
        const currentConnection = response.data.find((connection) => connection.id === current);
        if (currentConnection) return currentConnection.id;
        const fallback = response.data[0];
        setConnectionDraft(fallback ? connectionToDraft(fallback) : defaultConnectionDraft);
        return fallback?.id ?? '';
      });
    } else {
      setMessage(formatAppError(response.error));
    }
  }

  async function refreshHistory() {
    const response = await window.dbagent.invoke(ipcChannels.db.queryHistory, { limit: 30 });
    if (response.ok) setHistory(response.data);
  }

  async function refreshTables(connectionId: string) {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection || connection.status !== 'connected') {
      setTables([]);
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.db.listTables, { connectionId });
    if (response.ok) {
      setTables(response.data);
    } else {
      setTables([]);
      setSelectedTable(undefined);
      setMessage(formatAppError(response.error));
    }
  }

  async function createConnection() {
    setMessage(language === 'zh-CN' ? '正在保存连接...' : 'Saving connection...');
    const response = await window.dbagent.invoke(ipcChannels.connection.create, connectionDraft);
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setActiveConnectionId(response.data.id);
    setConnectionDraft(connectionToDraft(response.data));
    setMessage(language === 'zh-CN' ? `已保存 ${response.data.name}` : `Saved ${response.data.name}`);
    await refreshConnections();
  }

  async function updateActiveConnection() {
    if (!activeConnectionId) {
      setMessage(language === 'zh-CN' ? '请先选择连接。' : 'Select a connection first.');
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.connection.update, {
      id: activeConnectionId,
      patch: connectionDraft,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setTables([]);
    setSelectedTable(undefined);
    setConnectionDraft(connectionToDraft(response.data));
    setMessage(language === 'zh-CN' ? `已更新 ${response.data.name}` : `Updated ${response.data.name}`);
    await refreshConnections();
  }

  async function removeActiveConnection() {
    if (!activeConnectionId || !activeConnection) return;
    if (!window.confirm(`Delete connection "${activeConnection.name}"?`)) return;
    const response = await window.dbagent.invoke(ipcChannels.connection.remove, { id: activeConnectionId });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setActiveConnectionId('');
    setTables([]);
    setSelectedTable(undefined);
    setResult(undefined);
    setConnectionDraft(defaultConnectionDraft);
    setMessage(language === 'zh-CN' ? `已删除 ${activeConnection.name}` : `Deleted ${activeConnection.name}`);
    await refreshConnections();
  }

  async function testConnection() {
    const response = await window.dbagent.invoke(ipcChannels.connection.test, connectionDraft);
    setMessage(response.ok ? `Connection OK in ${response.data.latencyMs} ms.` : formatAppError(response.error));
  }

  async function connectActive() {
    if (!activeConnectionId) return;
    const response = await window.dbagent.invoke(ipcChannels.connection.connect, { id: activeConnectionId });
    setMessage(response.ok ? `${t('connected')}: ${response.data.name}` : formatAppError(response.error));
    await refreshConnections();
    if (response.ok) await refreshTables(activeConnectionId);
  }

  async function disconnectActive() {
    if (!activeConnectionId) return;
    const response = await window.dbagent.invoke(ipcChannels.connection.disconnect, { id: activeConnectionId });
    setMessage(response.ok ? `${t('disconnected')}: ${response.data.name}` : formatAppError(response.error));
    await refreshConnections();
    setTables([]);
    setSelectedTable(undefined);
  }

  async function execute() {
    if (editorLanguage !== 'sql') {
      setMessage(language === 'zh-CN' ? '当前编辑器不是 SQL 文件。' : 'Current editor is not a SQL file.');
      return;
    }
    if (!activeConnectionId) {
      setMessage(language === 'zh-CN' ? '请先连接数据库。' : 'Connect a database first.');
      return;
    }
    await executeSql(sql);
  }

  async function explain() {
    if (editorLanguage !== 'sql') {
      setMessage(language === 'zh-CN' ? '当前编辑器不是 SQL 文件。' : 'Current editor is not a SQL file.');
      return;
    }
    if (!activeConnectionId) {
      setMessage(language === 'zh-CN' ? '请先连接数据库。' : 'Connect a database first.');
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.db.explainQuery, {
      connectionId: activeConnectionId,
      sql,
    });
    if (response.ok) {
      setResult(response.data);
      setMessage(`EXPLAIN ${response.data.elapsedMs} ms`);
    } else {
      setMessage(formatAppError(response.error));
    }
    await refreshHistory();
  }

  function previewTable(table: TableSummary) {
    const nextSql = buildPreviewSql(table);
    setSql(nextSql);
    void executeSql(nextSql);
  }

  async function describeTable(table: TableSummary) {
    if (!activeConnectionId) return;
    const response = await window.dbagent.invoke(ipcChannels.db.describeTable, {
      connectionId: activeConnectionId,
      schema: table.schema,
      table: table.name,
    });
    if (response.ok) {
      setSelectedTable(response.data);
      setMessage(`${response.data.schema}.${response.data.name}`);
    } else {
      setSelectedTable(undefined);
      setMessage(formatAppError(response.error));
    }
  }

  function selectConnection(connection: SavedConnection) {
    setActiveConnectionId(connection.id);
    setConnectionDraft(connectionToDraft(connection));
  }

  async function executeSql(nextSql: string, confirmed = false) {
    if (!activeConnectionId) {
      setMessage(language === 'zh-CN' ? '请先连接数据库。' : 'Connect a database first.');
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.db.executeQuery, {
      connectionId: activeConnectionId,
      sql: nextSql,
      confirmed,
    });
    if (response.ok) {
      setResult(response.data);
      setMessage(`${response.data.rowCount} rows / ${response.data.elapsedMs} ms`);
    } else {
      if (response.error.code === 'CONFIRMATION_REQUIRED' && !confirmed) {
        const confirmedByUser = window.confirm(
          `${response.error.message}\n\n${response.error.detail ?? ''}\n\nExecute this SQL now?`,
        );
        if (confirmedByUser) await executeSql(nextSql, true);
        return;
      }
      setMessage(formatAppError(response.error));
    }
    await refreshHistory();
  }

  function exportCsv() {
    if (!result) return;
    downloadResult(`dbagent-result-${result.queryId}.csv`, queryResultToCsv(result), 'text/csv;charset=utf-8');
  }

  function exportJson() {
    if (!result) return;
    downloadResult(
      `dbagent-result-${result.queryId}.json`,
      queryResultToJson(result),
      'application/json;charset=utf-8',
    );
  }

  async function saveCurrentSql() {
    if (editorLanguage !== 'sql') {
      setMessage(language === 'zh-CN' ? '当前编辑器不是 SQL 文件。' : 'Current editor is not a SQL file.');
      return;
    }
    if (!activeWorkspace) {
      setMessage(language === 'zh-CN' ? '请先打开项目。' : 'Open a project first.');
      return;
    }
    const name = window.prompt(language === 'zh-CN' ? 'SQL 名称' : 'SQL name', activeWorkspace.name);
    if (!name) return;
    const response = await window.dbagent.invoke(ipcChannels.workspace.saveSqlFile, {
      rootPath: activeWorkspace.rootPath,
      name,
      sql,
      ...(activeConnectionId ? { connectionId: activeConnectionId } : {}),
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    await refreshWorkspaceFiles(activeWorkspace.rootPath);
    setMessage(
      language === 'zh-CN' ? `已保存 ${response.data.relativePath}` : `Saved ${response.data.relativePath}`,
    );
  }

  async function updateWorkspaceSettings() {
    if (!activeWorkspace) return;
    const response = await window.dbagent.invoke(ipcChannels.workspace.updateSettings, {
      rootPath: activeWorkspace.rootPath,
      assetPaths: workspaceSettingsDraft,
      python: workspacePythonDraft,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setActiveWorkspace(response.data);
    setWorkspaceSettingsDraft(response.data.assetPaths);
    setWorkspacePythonDraft(response.data.python);
    await refreshWorkspaceFiles(response.data.rootPath);
    setWorkspaceDialogOpen(false);
    setMessage(language === 'zh-CN' ? '项目配置已保存。' : 'Project settings saved.');
  }

  async function openWorkspaceFile(file: WorkspaceFileEntry) {
    if (!activeWorkspace || file.type !== 'file') return;
    const response = await window.dbagent.invoke(ipcChannels.workspace.readFile, {
      rootPath: activeWorkspace.rootPath,
      relativePath: file.relativePath,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    if (response.data.relativePath.endsWith('.sql')) {
      setSql(stripSqlMetadata(response.data.content));
      setEditorLanguage('sql');
      setMessage(language === 'zh-CN' ? `已打开 ${response.data.relativePath}` : `Opened ${response.data.relativePath}`);
      return;
    }
    if (response.data.relativePath.endsWith('.py')) {
      setSql(response.data.content);
      setEditorLanguage('python');
      setMessage(language === 'zh-CN' ? `已打开 ${response.data.relativePath}` : `Opened ${response.data.relativePath}`);
      return;
    }
    setChatMessages((items) => [
      ...items,
      {
        id: `${Date.now()}-file`,
        role: 'assistant',
        content: `${response.data.relativePath}\n\n${response.data.content.slice(0, 1200)}`,
      },
    ]);
    setMessage(language === 'zh-CN' ? `已读取 ${response.data.relativePath}` : `Read ${response.data.relativePath}`);
  }

  function sendChatMessage() {
    const content = chatDraft.trim();
    if (!content) return;
    setChatMessages((items) => [
      ...items,
      { id: `${Date.now()}-user`, role: 'user', content },
      {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content:
          language === 'zh-CN'
            ? '我已经记录这个问题。Agent 执行链路会在后续版本接入。'
            : 'Noted. The agent execution loop will be connected in a later version.',
      },
    ]);
    setChatDraft('');
  }

  return (
    <main className="app-shell">
      <TopBar
        language={language}
        setLanguage={setLanguage}
        t={t}
        onAction={(action) => {
          if (action === 'new-project') {
            setWorkspaceDialogMode('create');
            setWorkspaceDialogOpen(true);
          }
          if (action === 'open-project') void chooseAndOpenWorkspace();
          if (action === 'project-settings') {
            setWorkspaceDialogMode('settings');
            setWorkspaceDialogOpen(true);
          }
          if (action === 'save-sql') void saveCurrentSql();
          if (action === 'run-sql') void execute();
          if (action === 'explain-sql') void explain();
        }}
      />
      <section className="workbench">
        <ErrorBoundary label="Project">
          <aside className="left-rail">
            <ProjectPanel
              activeWorkspace={activeWorkspace}
              files={workspaceFiles}
              recent={recentWorkspaces}
              t={t}
              onOpenFile={(file) => void openWorkspaceFile(file)}
              onOpen={(rootPath) => void openWorkspace(rootPath)}
            />
            <ConnectionPanel
              activeConnectionId={activeConnectionId}
              connections={connections}
              draft={connectionDraft}
              selectedTable={selectedTable}
              setDraft={setConnectionDraft}
              tables={tables}
              t={t}
              onConnect={() => void connectActive()}
              onCreate={() => void createConnection()}
              onDelete={() => void removeActiveConnection()}
              onDescribe={(table) => void describeTable(table)}
              onDisconnect={() => void disconnectActive()}
              onPreview={previewTable}
              onSelect={selectConnection}
              onTest={() => void testConnection()}
              onUpdate={() => void updateActiveConnection()}
            />
          </aside>
        </ErrorBoundary>

        <ErrorBoundary label="Editor">
          <section className="center-stage">
            <EditorPane
              activeConnection={activeConnection}
              editorLanguage={editorLanguage}
              message={message}
              result={result}
              sql={sql}
              t={t}
              onChangeSql={setSql}
              onExecute={() => void execute()}
              onExplain={() => void explain()}
              onExportCsv={exportCsv}
              onExportJson={exportJson}
              onSaveSql={() => void saveCurrentSql()}
            />
          </section>
        </ErrorBoundary>

        <ErrorBoundary label="Chat">
          <aside className="right-rail">
            <ChatPanel
              draft={chatDraft}
              history={history}
              messages={chatMessages}
              setDraft={setChatDraft}
              t={t}
              onPickHistory={(item) => setSql(item.sql)}
              onSend={sendChatMessage}
            />
          </aside>
        </ErrorBoundary>
      </section>
      {workspaceDialogOpen ? (
        <WorkspaceDialog
          activeWorkspace={activeWorkspace}
          connectionDraft={connectionDraft}
          createConnection={createConnectionDuringWorkspace}
          mode={workspaceDialogMode}
          selectedDatabaseEngine={selectedDatabaseEngine}
          settingsDraft={workspaceSettingsDraft}
          setConnectionDraft={setConnectionDraft}
          setCreateConnection={setCreateConnectionDuringWorkspace}
          setSelectedDatabaseEngine={setSelectedDatabaseEngine}
          setSettingsDraft={setWorkspaceSettingsDraft}
          setWorkspaceDraft={setWorkspaceDraft}
          setPythonDraft={setWorkspacePythonDraft}
          t={t}
          workspaceDraft={workspaceDraft}
          pythonDraft={workspacePythonDraft}
          onChooseDirectory={() => void chooseWorkspaceDirectory()}
          onClose={() => setWorkspaceDialogOpen(false)}
          onCreate={() => void createWorkspace()}
          onSaveSettings={() => void updateWorkspaceSettings()}
        />
      ) : null}
    </main>
  );
}

function TopBar({
  language,
  onAction,
  setLanguage,
  t,
}: {
  language: AppLanguage;
  onAction: (action: TopBarAction) => void;
  setLanguage: (language: AppLanguage) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <strong>DBAgent</strong>
        <span>{t('appSubtitle')}</span>
      </div>
      <nav className="menu-strip" aria-label="Application menu">
        <MenuButton
          label={t('file')}
          items={[
            { label: t('createProject'), onClick: () => onAction('new-project') },
            { label: t('openProject'), onClick: () => onAction('open-project') },
            { label: t('saveSql'), onClick: () => onAction('save-sql') },
          ]}
        />
        <MenuButton
          label={t('run')}
          items={[
            { label: t('runCurrentSql'), onClick: () => onAction('run-sql') },
            { label: t('explainQuery'), onClick: () => onAction('explain-sql') },
          ]}
        />
        <MenuButton
          label={t('settings')}
          items={[
            { label: t('projectSettings'), onClick: () => onAction('project-settings') },
            { label: t('languageSettings'), onClick: () => undefined },
          ]}
        />
      </nav>
      <label className="language-switch">
        <span>{t('language')}</span>
        <select value={language} onChange={(event) => setLanguage(normalizeLanguage(event.target.value))}>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      </label>
    </header>
  );
}

function MenuButton({
  items,
  label,
}: {
  items: Array<{ label: string; onClick: () => void }>;
  label: string;
}) {
  return (
    <div className="menu-group">
      <button className="menu-button" type="button">
        {label}
      </button>
      <div className="menu-popover">
        {items.map((item) => (
          <button className="menu-item" key={item.label} type="button" onClick={item.onClick}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkspaceDialog({
  activeWorkspace,
  connectionDraft,
  createConnection,
  mode,
  selectedDatabaseEngine,
  settingsDraft,
  setConnectionDraft,
  setCreateConnection,
  setSelectedDatabaseEngine,
  setSettingsDraft,
  setWorkspaceDraft,
  setPythonDraft,
  t,
  workspaceDraft,
  pythonDraft,
  onChooseDirectory,
  onClose,
  onCreate,
  onSaveSettings,
}: {
  activeWorkspace: WorkspaceProject | undefined;
  connectionDraft: ConnectionInput;
  createConnection: boolean;
  mode: WorkspaceDialogMode;
  selectedDatabaseEngine: ConnectionInput['engine'];
  settingsDraft: WorkspaceProject['assetPaths'];
  setConnectionDraft: (draft: ConnectionInput) => void;
  setCreateConnection: (enabled: boolean) => void;
  setSelectedDatabaseEngine: (engine: ConnectionInput['engine']) => void;
  setSettingsDraft: (draft: WorkspaceProject['assetPaths']) => void;
  setWorkspaceDraft: (draft: WorkspaceDraft) => void;
  setPythonDraft: (draft: WorkspacePythonConfig) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  workspaceDraft: WorkspaceDraft;
  pythonDraft: WorkspacePythonConfig;
  onChooseDirectory: () => void;
  onClose: () => void;
  onCreate: () => void;
  onSaveSettings: () => void;
}) {
  const isCreate = mode === 'create';
  const isEnglish = t('project') === 'Project';
  const databaseTypeLabel = isEnglish ? 'Database Type' : '数据库类型';
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel" role="dialog" aria-modal="true" aria-label={isCreate ? t('createProject') : t('projectSettings')}>
        <div className="modal-heading">
          <div>
            <strong>{isCreate ? t('createProject') : t('projectSettings')}</strong>
            <small>{activeWorkspace?.rootPath ?? t('noProject')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        {isCreate ? (
          <>
            <div className="project-wizard">
              <aside className="database-selector" aria-label={databaseTypeLabel}>
                <span>{databaseTypeLabel}</span>
                {databaseEngineOptions.map((engine) => (
                  <button
                    className={selectedDatabaseEngine === engine.id ? 'database-option active' : 'database-option'}
                    key={engine.id}
                    type="button"
                    onClick={() => {
                      setSelectedDatabaseEngine(engine.id);
                      setConnectionDraft({ ...connectionDraft, engine: engine.id });
                    }}
                  >
                    <strong>{engine.label}</strong>
                    <small>{engine.description}</small>
                  </button>
                ))}
              </aside>
              <div className="wizard-main">
                <div className="modal-grid">
                  <input
                    aria-label={t('projectName')}
                    placeholder={t('projectName')}
                    value={workspaceDraft.name}
                    onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })}
                  />
                  <div className="path-row">
                    <input
                      aria-label={t('projectPath')}
                      placeholder={t('projectPath')}
                      value={workspaceDraft.rootPath}
                      onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, rootPath: event.target.value })}
                    />
                    <button className="icon-button" type="button" title={t('chooseFolder')} onClick={onChooseDirectory}>
                      ...
                    </button>
                  </div>
                  <input
                    aria-label={t('description')}
                    placeholder={t('description')}
                    value={workspaceDraft.description}
                    onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, description: event.target.value })}
                  />
                  <div className="segmented-control">
                    <button
                      className={workspaceDraft.template === 'standard' ? 'active' : ''}
                      type="button"
                      onClick={() => setWorkspaceDraft({ ...workspaceDraft, template: 'standard' })}
                    >
                      {t('standard')}
                    </button>
                    <button
                      className={workspaceDraft.template === 'minimal' ? 'active' : ''}
                      type="button"
                      onClick={() => setWorkspaceDraft({ ...workspaceDraft, template: 'minimal' })}
                    >
                      {t('minimal')}
                    </button>
                  </div>
                  <label className="switch-row">
                    <input
                      checked={createConnection}
                      type="checkbox"
                      onChange={(event) => setCreateConnection(event.target.checked)}
                    />
                    <span>{createConnection ? t('createConnectionNow') : t('skipConnection')}</span>
                  </label>
                </div>
                {createConnection ? (
                  <div className="modal-grid two">
                    <input value={connectionDraft.name} onChange={(event) => setConnectionDraft({ ...connectionDraft, name: event.target.value })} />
                    <input value={connectionDraft.host} onChange={(event) => setConnectionDraft({ ...connectionDraft, host: event.target.value })} />
                    <input value={connectionDraft.database} onChange={(event) => setConnectionDraft({ ...connectionDraft, database: event.target.value })} />
                    <input value={connectionDraft.username} onChange={(event) => setConnectionDraft({ ...connectionDraft, username: event.target.value })} />
                    <input
                      type="password"
                      value={connectionDraft.password}
                      onChange={(event) => setConnectionDraft({ ...connectionDraft, password: event.target.value })}
                    />
                    <input
                      min={1}
                      type="number"
                      value={connectionDraft.port}
                      onChange={(event) => setConnectionDraft({ ...connectionDraft, port: Number(event.target.value) })}
                    />
                  </div>
                ) : null}
                <PythonConfigForm pythonDraft={pythonDraft} setPythonDraft={setPythonDraft} t={t} />
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary-action" type="button" onClick={onCreate}>
                {t('createProject')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-grid two">
              <label>
                <span>{t('sqlLibrary')}</span>
                <input
                  value={settingsDraft.sqlLibrary}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, sqlLibrary: event.target.value })}
                />
              </label>
              <label>
                <span>{t('scriptsPath')}</span>
                <input
                  value={settingsDraft.scripts}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, scripts: event.target.value })}
                />
              </label>
              <label>
                <span>{t('docsPath')}</span>
                <input value={settingsDraft.docs} onChange={(event) => setSettingsDraft({ ...settingsDraft, docs: event.target.value })} />
              </label>
              <label>
                <span>{t('outputsPath')}</span>
                <input
                  value={settingsDraft.outputs}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, outputs: event.target.value })}
                />
              </label>
            </div>
            <PythonConfigForm pythonDraft={pythonDraft} setPythonDraft={setPythonDraft} t={t} />
            <div className="modal-actions">
              <button className="primary-action" disabled={!activeWorkspace} type="button" onClick={onSaveSettings}>
                {t('saveSettings')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function PythonConfigForm({
  pythonDraft,
  setPythonDraft,
  t,
}: {
  pythonDraft: WorkspacePythonConfig;
  setPythonDraft: (draft: WorkspacePythonConfig) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  const isEnglish = t('project') === 'Project';
  const labels = {
    pythonEnvironment: isEnglish ? 'Python Environment' : 'Python 环境',
    pythonEnvironmentHint: isEnglish
      ? 'Used for local scripts, data processing, and analysis jobs'
      : '用于本地脚本、数据处理和分析任务',
    pythonMode: isEnglish ? 'Environment Mode' : '环境模式',
    pythonModeSystem: isEnglish ? 'System Python' : '系统 Python',
    pythonModeVenv: isEnglish ? 'Virtualenv venv' : '虚拟环境 venv',
    pythonModeConda: isEnglish ? 'Conda Environment' : 'Conda 环境',
    pythonPath: isEnglish ? 'Python Path' : 'Python 路径',
    pythonPathPlaceholder: isEnglish ? 'Optional, e.g. python or conda env python' : '可选，例如 python 或 conda 环境 python',
    venvPath: isEnglish ? 'venv Path' : 'venv 目录',
    requirementsPath: isEnglish ? 'requirements Path' : 'requirements 路径',
  };
  return (
    <section className="subform-section">
      <div className="subform-heading">
        <strong>{labels.pythonEnvironment}</strong>
        <small>{labels.pythonEnvironmentHint}</small>
      </div>
      <div className="modal-grid two">
        <label>
          <span>{labels.pythonMode}</span>
          <select
            value={pythonDraft.mode}
            onChange={(event) =>
              setPythonDraft({ ...pythonDraft, mode: event.target.value as WorkspacePythonConfig['mode'] })
            }
          >
            <option value="system">{labels.pythonModeSystem}</option>
            <option value="venv">{labels.pythonModeVenv}</option>
            <option value="conda">{labels.pythonModeConda}</option>
          </select>
        </label>
        <label>
          <span>{labels.requirementsPath}</span>
          <input
            value={pythonDraft.requirementsPath}
            onChange={(event) => setPythonDraft({ ...pythonDraft, requirementsPath: event.target.value })}
          />
        </label>
        <label>
          <span>{labels.pythonPath}</span>
          <input
            placeholder={labels.pythonPathPlaceholder}
            value={pythonDraft.pythonPath ?? ''}
            onChange={(event) => {
              const next = { ...pythonDraft };
              if (event.target.value.trim()) next.pythonPath = event.target.value;
              else delete next.pythonPath;
              setPythonDraft(next);
            }}
          />
        </label>
        <label>
          <span>{labels.venvPath}</span>
          <input
            placeholder=".venv"
            value={pythonDraft.venvPath ?? ''}
            onChange={(event) => {
              const next = { ...pythonDraft };
              if (event.target.value.trim()) next.venvPath = event.target.value;
              else delete next.venvPath;
              setPythonDraft(next);
            }}
          />
        </label>
      </div>
    </section>
  );
}

function ProjectPanel({
  activeWorkspace,
  files,
  recent,
  t,
  onOpenFile,
  onOpen,
}: {
  activeWorkspace: WorkspaceProject | undefined;
  files: WorkspaceFileEntry[];
  recent: WorkspaceRecentState;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onOpenFile: (file: WorkspaceFileEntry) => void;
  onOpen: (rootPath: string) => void;
}) {
  return (
    <section className="panel project-panel">
      <div className="panel-heading">
        <span>{t('project')}</span>
        <small>{activeWorkspace?.name ?? t('noProject')}</small>
      </div>
      {activeWorkspace ? (
        <div className="active-project">
          <strong>{activeWorkspace.name}</strong>
          <span>{activeWorkspace.rootPath}</span>
          <div className="project-files">
            {files.length > 0 ? (
              files.map((file) => <FileNode entry={file} key={file.relativePath} onOpenFile={onOpenFile} />)
            ) : (
              <>
                <FileNode label=".dbagent/workspace.json" />
                <FileNode label="sql/" />
                <FileNode label="scripts/" />
                <FileNode label="docs/" />
                <FileNode label="outputs/" />
              </>
            )}
          </div>
        </div>
      ) : null}
      <div className="recent-list">
        {recent.workspaces.map((workspace) => (
          <button className="recent-workspace" key={workspace.id} type="button" onClick={() => onOpen(workspace.rootPath)}>
            <span>{workspace.name}</span>
            <small>{workspace.rootPath}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function FileNode({
  entry,
  label,
  onOpenFile,
}: {
  entry?: WorkspaceFileEntry;
  label?: string;
  onOpenFile?: (file: WorkspaceFileEntry) => void;
}) {
  const display = entry?.type === 'directory' ? `${entry.name}/` : (entry?.name ?? label ?? '');
  return (
    <>
      <button
        className={`file-node ${entry?.type ?? 'file'}`}
        disabled={!entry || entry.type === 'directory'}
        type="button"
        onClick={() => {
          if (entry) onOpenFile?.(entry);
        }}
      >
        <span />
        <small title={entry?.relativePath ?? label}>{display}</small>
      </button>
      {entry?.children?.length ? (
        <div className="file-children">
          {entry.children.map((child) => (
            <FileNode entry={child} key={child.relativePath} {...(onOpenFile ? { onOpenFile } : {})} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ConnectionPanel({
  activeConnectionId,
  connections,
  draft,
  selectedTable,
  setDraft,
  tables,
  t,
  onConnect,
  onCreate,
  onDelete,
  onDescribe,
  onDisconnect,
  onPreview,
  onSelect,
  onTest,
  onUpdate,
}: {
  activeConnectionId: string;
  connections: SavedConnection[];
  draft: ConnectionInput;
  selectedTable: TableDetail | undefined;
  setDraft: (draft: ConnectionInput) => void;
  tables: TableSummary[];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onConnect: () => void;
  onCreate: () => void;
  onDelete: () => void;
  onDescribe: (table: TableSummary) => void;
  onDisconnect: () => void;
  onPreview: (table: TableSummary) => void;
  onSelect: (connection: SavedConnection) => void;
  onTest: () => void;
  onUpdate: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <span>{t('connections')}</span>
        <small>{connections.length}</small>
      </div>
      <div className="connection-list">
        {connections.map((connection) => (
          <button
            className={connection.id === activeConnectionId ? 'connection active' : 'connection'}
            key={connection.id}
            type="button"
            onClick={() => onSelect(connection)}
          >
            <span>{connection.name}</span>
            <small>
              {connection.database} / {connection.status}
            </small>
          </button>
        ))}
      </div>
      <ConnectionForm
        draft={draft}
        hasActiveConnection={Boolean(activeConnectionId)}
        setDraft={setDraft}
        t={t}
        onConnect={onConnect}
        onCreate={onCreate}
        onDelete={onDelete}
        onDisconnect={onDisconnect}
        onTest={onTest}
        onUpdate={onUpdate}
      />
      <SchemaPanel
        selectedTable={selectedTable}
        tables={tables}
        t={t}
        onDescribe={onDescribe}
        onPreview={onPreview}
      />
    </section>
  );
}

function ConnectionForm({
  draft,
  hasActiveConnection,
  setDraft,
  t,
  onConnect,
  onCreate,
  onDelete,
  onDisconnect,
  onTest,
  onUpdate,
}: {
  draft: ConnectionInput;
  hasActiveConnection: boolean;
  setDraft: (draft: ConnectionInput) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onConnect: () => void;
  onCreate: () => void;
  onDelete: () => void;
  onDisconnect: () => void;
  onTest: () => void;
  onUpdate: () => void;
}) {
  return (
    <form className="connection-form" onSubmit={(event) => event.preventDefault()}>
      <input
        aria-label="Connection name"
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <div className="split">
        <input aria-label="Host" value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} />
        <input
          aria-label="Port"
          min={1}
          type="number"
          value={draft.port}
          onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
        />
      </div>
      <input
        aria-label="Database"
        value={draft.database}
        onChange={(event) => setDraft({ ...draft, database: event.target.value })}
      />
      <input
        aria-label="Username"
        value={draft.username}
        onChange={(event) => setDraft({ ...draft, username: event.target.value })}
      />
      <input
        aria-label="Password"
        type="password"
        value={draft.password}
        onChange={(event) => setDraft({ ...draft, password: event.target.value })}
      />
      <div className="toggle-grid">
        <label>
          <input
            type="checkbox"
            checked={draft.readOnly ?? true}
            onChange={(event) => setDraft({ ...draft, readOnly: event.target.checked })}
          />
          {t('readOnly')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.ssl ?? false}
            onChange={(event) => setDraft({ ...draft, ssl: event.target.checked })}
          />
          {t('ssl')}
        </label>
      </div>
      <div className="form-actions">
        <button className="secondary" type="button" onClick={onTest}>
          {t('test')}
        </button>
        <button className="secondary" disabled={!hasActiveConnection} type="button" onClick={onUpdate}>
          {t('apply')}
        </button>
        <button type="button" onClick={onCreate}>
          {t('saveNew')}
        </button>
        <button className="secondary" disabled={!hasActiveConnection} type="button" onClick={onConnect}>
          {t('connect')}
        </button>
        <button className="secondary" disabled={!hasActiveConnection} type="button" onClick={onDisconnect}>
          {t('disconnect')}
        </button>
        <button className="danger" disabled={!hasActiveConnection} type="button" onClick={onDelete}>
          {t('delete')}
        </button>
      </div>
    </form>
  );
}

function SchemaPanel({
  selectedTable,
  tables,
  t,
  onDescribe,
  onPreview,
}: {
  selectedTable: TableDetail | undefined;
  tables: TableSummary[];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onDescribe: (table: TableSummary) => void;
  onPreview: (table: TableSummary) => void;
}) {
  const grouped = tables.reduce<Record<string, TableSummary[]>>((groups, table) => {
    groups[table.schema] = [...(groups[table.schema] ?? []), table];
    return groups;
  }, {});

  return (
    <section className="schema-panel">
      <div className="panel-heading compact">
        <span>{t('schema')}</span>
        <small>{tables.length}</small>
      </div>
      {Object.entries(grouped).map(([schema, schemaTables]) => (
        <div className="schema-group" key={schema}>
          <div className="schema-title">{schema}</div>
          {schemaTables.map((table) => (
            <div className="table-node-row" key={`${table.schema}.${table.name}`}>
              <button
                className={
                  selectedTable?.schema === table.schema && selectedTable.name === table.name
                    ? 'table-node active'
                    : 'table-node'
                }
                type="button"
                onClick={() => onDescribe(table)}
              >
                <span>{table.name}</span>
                <small>{table.type}</small>
              </button>
              <button className="table-preview" type="button" onClick={() => onPreview(table)}>
                SQL
              </button>
            </div>
          ))}
        </div>
      ))}
      {selectedTable ? <TableDetailPanel detail={selectedTable} /> : null}
    </section>
  );
}

function TableDetailPanel({ detail }: { detail: TableDetail }) {
  return (
    <section className="table-detail">
      <strong>
        {detail.schema}.{detail.name}
      </strong>
      <div className="column-list">
        {detail.columns.map((column) => (
          <div className="column-row" key={column.name}>
            <span>{column.name}</span>
            <small>
              {column.dataType}
              {column.nullable ? '' : ' / not null'}
              {column.isPrimaryKey ? ' / PK' : ''}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function EditorPane({
  activeConnection,
  editorLanguage,
  message,
  result,
  sql,
  t,
  onChangeSql,
  onExecute,
  onExplain,
  onExportCsv,
  onExportJson,
  onSaveSql,
}: {
  activeConnection: SavedConnection | undefined;
  editorLanguage: EditorLanguage;
  message: string;
  result: QueryExecutionResult | undefined;
  sql: string;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onChangeSql: (sql: string) => void;
  onExecute: () => void;
  onExplain: () => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  onSaveSql: () => void;
}) {
  return (
    <>
      <section className="editor-pane">
        <div className="pane-toolbar">
          <div>
            <span>{t('editor')}</span>
            <small>
              {activeConnection?.name ?? t('noConnection')}
              {activeConnection?.readOnly ? ` / ${t('readOnly')}` : ''}
            </small>
          </div>
          <div className="toolbar-actions">
            <button className="secondary" type="button" onClick={onExplain}>
              {t('explain')}
            </button>
            <button className="secondary" type="button" onClick={onSaveSql}>
              {t('saveSql')}
            </button>
            <button type="button" onClick={onExecute}>
              {t('runSql')}
            </button>
          </div>
        </div>
        <div className="monaco-shell">
          <Editor
            height="100%"
            language={editorLanguage}
            options={{
              fontFamily: 'JetBrains Mono, Consolas, SFMono-Regular, monospace',
              fontSize: 13,
              minimap: { enabled: false },
              padding: { top: 14 },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
            }}
            theme="vs-dark"
            value={sql}
            onChange={(value: string | undefined) => onChangeSql(value ?? '')}
          />
        </div>
      </section>
      <section className="result-pane">
        <div className="pane-toolbar">
          <div>
            <span>{t('results')}</span>
            <small>{message}</small>
          </div>
          <div className="toolbar-actions">
            <button className="secondary" disabled={!result} type="button" onClick={onExportCsv}>
              {t('exportCsv')}
            </button>
            <button className="secondary" disabled={!result} type="button" onClick={onExportJson}>
              {t('exportJson')}
            </button>
          </div>
        </div>
        {result ? (
          <>
            <PerformanceWarnings result={result} />
            <ResultTable result={result} />
          </>
        ) : (
          <div className="empty-state">{t('noResults')}</div>
        )}
      </section>
    </>
  );
}

function PerformanceWarnings({ result }: { result: QueryExecutionResult }) {
  const summary = summarizePerformanceWarnings(result.safety.performanceWarnings);
  if (!summary) return null;

  return (
    <section className="performance-panel" aria-label="SQL performance diagnostics">
      <div className="performance-title">{summary.title}</div>
      {summary.items.map((warning) => (
        <div className={`performance-item ${warning.severity}`} key={warning.code}>
          <span>{warning.code.replace(/_/g, ' ')}</span>
          <small>{warning.message}</small>
        </div>
      ))}
    </section>
  );
}

function ResultTable({ result }: { result: QueryExecutionResult }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column.name}>{column.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {result.columns.map((column) => (
                <td key={column.name}>{formatValue(row[column.name])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChatPanel({
  draft,
  history,
  messages,
  setDraft,
  t,
  onPickHistory,
  onSend,
}: {
  draft: string;
  history: QueryHistoryItem[];
  messages: ChatMessage[];
  setDraft: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onPickHistory: (item: QueryHistoryItem) => void;
  onSend: () => void;
}) {
  return (
    <>
      <section className="panel chat-panel">
        <div className="panel-heading">
          <span>{t('chat')}</span>
          <small>Assistant</small>
        </div>
        <div className="message-list">
          {messages.map((message) => (
            <div className={`chat-message ${message.role}`} key={message.id}>
              <span>{message.content}</span>
            </div>
          ))}
        </div>
        <div className="chat-input">
          <input
            aria-label={t('chatPlaceholder')}
            placeholder={t('chatPlaceholder')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSend();
            }}
          />
          <button type="button" onClick={onSend}>
            {t('send')}
          </button>
        </div>
      </section>
      <section className="panel history-panel">
        <div className="panel-heading">
          <span>{t('queryHistory')}</span>
          <small>{history.length}</small>
        </div>
        {history.map((item) => (
          <button className="history-item" key={item.id} type="button" onClick={() => onPickHistory(item)}>
            <span>{item.sql.replace(/\s+/g, ' ').slice(0, 90)}</span>
            <small>
              {item.status} / {item.safety.riskLevel} / {item.elapsedMs ?? '-'} ms
            </small>
          </button>
        ))}
      </section>
    </>
  );
}

type ErrorBoundaryProps = {
  children: ReactNode;
  label: string;
};

type ErrorBoundaryState = {
  error?: Error;
};

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section className="pane-error">
        <strong>{this.props.label}</strong>
        <span>{this.state.error.message}</span>
        <button className="secondary" type="button" onClick={() => this.setState({})}>
          Retry
        </button>
      </section>
    );
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}

function buildPreviewSql(table: TableSummary): string {
  return `select * from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} limit 100;`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function downloadResult(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function stripSqlMetadata(content: string): string {
  const lines = content.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && lines[index]?.startsWith('-- @')) index += 1;
  while (index < lines.length && lines[index]?.trim() === '') index += 1;
  return lines.slice(index).join('\n').trimEnd();
}
