import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { Editor } from '@monaco-editor/react';
import {
  ipcChannels,
  queryResultToCsv,
  queryResultToJson,
  type ConnectionInput,
  type QueryExecutionResult,
  type SavedConnection,
  type TableDetail,
  type TableSummary,
  type WorkspaceProject,
  type WorkspaceFileEntry,
  type WorkspacePythonConfig,
  type WorkspaceTemplate,
} from '@dbagent/shared';
import { connectionToDraft, defaultConnectionDraft } from './connection-draft.js';
import { formatAppError, summarizePerformanceWarnings } from './diagnostics.js';
import { createTranslator, normalizeLanguage, type AppLanguage } from './i18n.js';

const starterSql = '';

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

type EditorLanguage = 'sql' | 'python' | 'markdown' | 'plaintext';

type WorkspaceDialogMode = 'create' | 'project-settings' | 'ide-settings';

type EditorDocument = {
  title: string;
  relativePath?: string;
  language: EditorLanguage;
  dirty: boolean;
};

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

const defaultEditorDocument: EditorDocument = {
  title: '欢迎',
  language: 'plaintext',
  dirty: false,
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
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState<TableDetail | undefined>();
  const [sql, setSql] = useState(starterSql);
  const [editorLanguage, setEditorLanguage] = useState<EditorLanguage>('sql');
  const [editorDocument, setEditorDocument] = useState<EditorDocument>(defaultEditorDocument);
  const [result, setResult] = useState<QueryExecutionResult | undefined>();
  const [message, setMessage] = useState(t('assistantReady'));
  const [connectionDraft, setConnectionDraft] = useState<ConnectionInput>(defaultConnectionDraft);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft>(defaultWorkspaceDraft);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceProject | undefined>();
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceDialogMode, setWorkspaceDialogMode] = useState<WorkspaceDialogMode>('create');
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(268);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(360);
  const [bottomPanel, setBottomPanel] = useState<'results' | 'console'>('results');
  const [saveSqlDialogOpen, setSaveSqlDialogOpen] = useState(false);
  const [saveSqlNameDraft, setSaveSqlNameDraft] = useState('');
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
    void refreshWorkspace();
  }, []);

  useEffect(() => {
    return window.dbagent.onMenuCommand((command) => {
      if (command === 'new-project') {
        openCreateProjectDialog();
        return;
      }
      if (command === 'open-project') {
        void chooseAndOpenWorkspace();
        return;
      }
      if (command === 'project-settings') {
        openSettingsDialog();
        return;
      }
      if (command === 'save-file') {
        void saveCurrentDocument();
        return;
      }
      if (command === 'run-sql') {
        void execute();
        return;
      }
      if (command === 'explain-sql') {
        void explain();
        return;
      }
      if (command === 'toggle-left-sidebar') {
        setLeftSidebarCollapsed((collapsed) => !collapsed);
        return;
      }
      if (command === 'toggle-right-sidebar') {
        setRightSidebarCollapsed((collapsed) => !collapsed);
      }
    });
  }, [activeConnectionId, activeWorkspace, editorDocument, editorLanguage, saveSqlNameDraft, sql]);

  function openCreateProjectDialog() {
    setWorkspaceDialogMode('create');
    setWorkspaceDialogOpen(true);
  }

  function openSettingsDialog() {
    setWorkspaceDialogMode(activeWorkspace ? 'project-settings' : 'ide-settings');
    setWorkspaceDialogOpen(true);
  }

  function startSidebarResize(side: 'left' | 'right', startEvent: ReactMouseEvent<HTMLDivElement>) {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startWidth = side === 'left' ? leftSidebarWidth : rightSidebarWidth;
    const onMove = (event: MouseEvent) => {
      const delta = event.clientX - startX;
      const nextWidth = side === 'left' ? startWidth + delta : startWidth - delta;
      const clamped = Math.min(520, Math.max(220, nextWidth));
      if (side === 'left') setLeftSidebarWidth(clamped);
      else setRightSidebarWidth(clamped);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

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
    setEditorLanguage('sql');
    setEditorDocument({ title: 'Scratch.sql', language: 'sql', dirty: false });
    if (response.data.activeConnectionId) setActiveConnectionId(response.data.activeConnectionId);
  }

  function updateEditorContent(content: string, document: Omit<EditorDocument, 'dirty'> & { dirty?: boolean }) {
    setSql(content);
    setEditorLanguage(document.language);
    setEditorDocument({
      title: document.title,
      language: document.language,
      ...(document.relativePath ? { relativePath: document.relativePath } : {}),
      dirty: document.dirty ?? false,
    });
  }

  function handleEditorChange(content: string) {
    setSql(content);
    setEditorDocument((document) => ({ ...document, dirty: true }));
  }

  async function refreshWorkspace() {
    const activeResponse = await window.dbagent.invoke(ipcChannels.workspace.loadActive, undefined);
    if (activeResponse.ok) {
      setActiveWorkspace(activeResponse.data);
      if (activeResponse.data) {
        setWorkspaceSettingsDraft(activeResponse.data.assetPaths);
        setWorkspacePythonDraft(activeResponse.data.python);
        await refreshWorkspaceFiles(activeResponse.data.rootPath);
        await restoreWorkspaceState();
      } else {
        setWorkspaceFiles([]);
        setSql('');
        setEditorLanguage('plaintext');
        setEditorDocument(defaultEditorDocument);
        setResult(undefined);
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
  }

  function previewTable(table: TableSummary) {
    const nextSql = buildPreviewSql(table);
    updateEditorContent(nextSql, {
      title: `${table.name}.preview.sql`,
      language: 'sql',
      dirty: true,
    });
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

  function exportExcel() {
    if (!result) return;
    downloadResult(
      `dbagent-result-${result.queryId}.xls`,
      queryResultToExcelHtml(result),
      'application/vnd.ms-excel;charset=utf-8',
    );
  }

  async function saveCurrentDocument() {
    if (!activeWorkspace) {
      setMessage(language === 'zh-CN' ? '请先打开项目。' : 'Open a project first.');
      return;
    }
    if (!editorDocument.relativePath) {
      requestSaveSql();
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.workspace.writeFile, {
      rootPath: activeWorkspace.rootPath,
      relativePath: editorDocument.relativePath,
      content: sql,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    await refreshWorkspaceFiles(activeWorkspace.rootPath);
    setEditorDocument((document) => ({ ...document, dirty: false }));
    setMessage(
      language === 'zh-CN' ? `已保存 ${response.data.relativePath}` : `Saved ${response.data.relativePath}`,
    );
  }

  function requestSaveSql() {
    if (editorLanguage !== 'sql') {
      setMessage(language === 'zh-CN' ? '当前编辑器不是 SQL 文件。' : 'Current editor is not a SQL file.');
      return;
    }
    if (!activeWorkspace) {
      setMessage(language === 'zh-CN' ? '请先打开项目。' : 'Open a project first.');
      return;
    }
    const defaultName = editorDocument.title.replace(/\.sql$/i, '').trim() || activeWorkspace.name;
    setSaveSqlNameDraft(defaultName);
    setSaveSqlDialogOpen(true);
  }

  async function confirmSaveSql() {
    if (!activeWorkspace) return;
    const name = saveSqlNameDraft.trim();
    if (!name) {
      setMessage(language === 'zh-CN' ? 'SQL 名称不能为空。' : 'SQL name is required.');
      return;
    }
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
    setEditorDocument({
      title: response.data.name,
      relativePath: response.data.relativePath,
      language: 'sql',
      dirty: false,
    });
    setSaveSqlDialogOpen(false);
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
      updateEditorContent(stripSqlMetadata(response.data.content), {
        title: response.data.name,
        relativePath: response.data.relativePath,
        language: 'sql',
      });
      setMessage(language === 'zh-CN' ? `已打开 ${response.data.relativePath}` : `Opened ${response.data.relativePath}`);
      return;
    }
    if (response.data.relativePath.endsWith('.py')) {
      updateEditorContent(response.data.content, {
        title: response.data.name,
        relativePath: response.data.relativePath,
        language: 'python',
      });
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
        activeConnection={activeConnection}
        activeWorkspace={activeWorkspace}
        document={editorDocument}
        language={language}
        setLanguage={setLanguage}
        t={t}
      />
      <section
        className={`workbench${leftSidebarCollapsed ? ' left-collapsed' : ''}${rightSidebarCollapsed ? ' right-collapsed' : ''}`}
        style={{
          gridTemplateColumns: `${leftSidebarCollapsed ? 32 : leftSidebarWidth}px minmax(520px, 1fr) ${
            rightSidebarCollapsed ? 32 : rightSidebarWidth
          }px`,
        }}
      >
        <ErrorBoundary label="Project">
          <aside className="left-rail">
            <button
              className="sidebar-collapse left"
              title={leftSidebarCollapsed ? '展开项目栏' : '收起项目栏'}
              type="button"
              onClick={() => setLeftSidebarCollapsed((collapsed) => !collapsed)}
            >
              {leftSidebarCollapsed ? '>' : '<'}
            </button>
            <ProjectPanel
              activeWorkspace={activeWorkspace}
              files={workspaceFiles}
              t={t}
              {...(editorDocument.relativePath ? { activeFilePath: editorDocument.relativePath } : {})}
              onCreateProject={() => {
                openCreateProjectDialog();
              }}
              onOpenFile={(file) => void openWorkspaceFile(file)}
              onOpenProject={() => void chooseAndOpenWorkspace()}
            />
            {!leftSidebarCollapsed ? (
              <div
                aria-label="Resize project sidebar"
                className="sidebar-resizer left"
                role="separator"
                onMouseDown={(event) => startSidebarResize('left', event)}
              />
            ) : null}
          </aside>
        </ErrorBoundary>

        <ErrorBoundary label="Editor">
          <section className="center-stage">
            <EditorPane
              activeConnection={activeConnection}
              bottomPanel={bottomPanel}
              document={editorDocument}
              editorLanguage={editorLanguage}
              message={message}
              result={result}
              sql={sql}
              t={t}
              onChangeSql={handleEditorChange}
              onExecuteSql={(nextSql) => void executeSql(nextSql)}
              onExplain={() => void explain()}
              onExportCsv={exportCsv}
              onExportExcel={exportExcel}
              onExportJson={exportJson}
              onSaveSql={() => void saveCurrentDocument()}
              setBottomPanel={setBottomPanel}
            />
          </section>
        </ErrorBoundary>

        <ErrorBoundary label="Chat">
          <aside className="right-rail">
            <button
              className="sidebar-collapse right"
              title={rightSidebarCollapsed ? '展开 Agent' : '收起 Agent'}
              type="button"
              onClick={() => setRightSidebarCollapsed((collapsed) => !collapsed)}
            >
              {rightSidebarCollapsed ? '<' : '>'}
            </button>
            <ChatPanel
              activeConnection={activeConnection}
              activeWorkspace={activeWorkspace}
              document={editorDocument}
              draft={chatDraft}
              messages={chatMessages}
              setDraft={setChatDraft}
              t={t}
              onSend={sendChatMessage}
            />
            {!rightSidebarCollapsed ? (
              <div
                aria-label="Resize agent sidebar"
                className="sidebar-resizer right"
                role="separator"
                onMouseDown={(event) => startSidebarResize('right', event)}
              />
            ) : null}
          </aside>
        </ErrorBoundary>
      </section>
      <StatusBar
        activeConnection={activeConnection}
        activeWorkspace={activeWorkspace}
        document={editorDocument}
        language={language}
        result={result}
        t={t}
      />
      {workspaceDialogOpen ? (
        <WorkspaceDialog
          activeConnectionId={activeConnectionId}
          activeWorkspace={activeWorkspace}
          connectionDraft={connectionDraft}
          connections={connections}
          createConnection={createConnectionDuringWorkspace}
          mode={workspaceDialogMode}
          selectedDatabaseEngine={selectedDatabaseEngine}
          selectedTable={selectedTable}
          settingsDraft={workspaceSettingsDraft}
          language={language}
          setConnectionDraft={setConnectionDraft}
          setCreateConnection={setCreateConnectionDuringWorkspace}
          setLanguage={setLanguage}
          setSelectedDatabaseEngine={setSelectedDatabaseEngine}
          setSettingsDraft={setWorkspaceSettingsDraft}
          setWorkspaceDraft={setWorkspaceDraft}
          setPythonDraft={setWorkspacePythonDraft}
          t={t}
          tables={tables}
          workspaceDraft={workspaceDraft}
          pythonDraft={workspacePythonDraft}
          onChooseDirectory={() => void chooseWorkspaceDirectory()}
          onConnect={() => void connectActive()}
          onClose={() => setWorkspaceDialogOpen(false)}
          onCreate={() => void createWorkspace()}
          onCreateConnection={() => void createConnection()}
          onDeleteConnection={() => void removeActiveConnection()}
          onDescribeTable={(table) => void describeTable(table)}
          onDisconnect={() => void disconnectActive()}
          onPreviewTable={previewTable}
          onSaveSettings={() => void updateWorkspaceSettings()}
          onSelectConnection={selectConnection}
          onTestConnection={() => void testConnection()}
          onUpdateConnection={() => void updateActiveConnection()}
        />
      ) : null}
      {saveSqlDialogOpen ? (
        <SaveSqlDialog
          activeConnection={activeConnection}
          activeWorkspace={activeWorkspace}
          document={editorDocument}
          name={saveSqlNameDraft}
          setName={setSaveSqlNameDraft}
          t={t}
          onClose={() => setSaveSqlDialogOpen(false)}
          onSave={() => void confirmSaveSql()}
        />
      ) : null}
    </main>
  );
}

function TopBar({
  activeConnection,
  activeWorkspace,
  document,
  language,
  setLanguage,
  t,
}: {
  activeConnection: SavedConnection | undefined;
  activeWorkspace: WorkspaceProject | undefined;
  document: EditorDocument;
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-lockup compact">
          <span className="brand-mark">DB</span>
          <strong>DBAgent</strong>
        </div>
      </div>
      <div className="topbar-main">
        <div className="command-context" aria-label="Workspace command context">
          <span title={activeWorkspace?.rootPath ?? t('noProject')}>{activeWorkspace?.name ?? t('noProject')}</span>
          <span title={document.relativePath ?? document.title}>{document.relativePath ?? document.title}</span>
          <span title={activeConnection?.name ?? t('noConnection')}>{activeConnection?.name ?? t('noConnection')}</span>
        </div>
      </div>
      <div className="topbar-actions">
        <div className="language-switch" aria-label={t('language')} role="group">
          <button
            className={language === 'zh-CN' ? 'active' : ''}
            type="button"
            onClick={() => setLanguage('zh-CN')}
          >
            中
          </button>
          <button className={language === 'en' ? 'active' : ''} type="button" onClick={() => setLanguage('en')}>
            EN
          </button>
        </div>
      </div>
    </header>
  );
}

function StatusBar({
  activeConnection,
  activeWorkspace,
  document,
  language,
  result,
  t,
}: {
  activeConnection: SavedConnection | undefined;
  activeWorkspace: WorkspaceProject | undefined;
  document: EditorDocument;
  language: AppLanguage;
  result: QueryExecutionResult | undefined;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  return (
    <footer className="statusbar">
      <div className="statusbar-group">
        <span>
          {t('statusProject')}: {activeWorkspace?.name ?? t('noProject')}
        </span>
        <span>
          {t('statusConnection')}: {activeConnection?.name ?? t('noConnection')}
        </span>
      </div>
      <div className="statusbar-group center">
        <span title={document.relativePath ?? document.title}>{document.relativePath ?? document.title}</span>
        <span>{document.language.toUpperCase()}</span>
        <span>{document.dirty ? t('statusUnsaved') : t('statusSaved')}</span>
      </div>
      <div className="statusbar-group right">
        {result ? (
          <span>
            {result.rowCount} rows / {result.elapsedMs} ms
          </span>
        ) : null}
        <span>
          {t('statusLanguage')}: {language === 'zh-CN' ? '中文' : 'English'}
        </span>
      </div>
    </footer>
  );
}

function SaveSqlDialog({
  activeConnection,
  activeWorkspace,
  document,
  name,
  setName,
  t,
  onClose,
  onSave,
}: {
  activeConnection: SavedConnection | undefined;
  activeWorkspace: WorkspaceProject | undefined;
  document: EditorDocument;
  name: string;
  setName: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="save-sql-panel" role="dialog" aria-modal="true" aria-label={t('saveSql')}>
        <div className="modal-heading">
          <div>
            <strong>{t('saveSql')}</strong>
            <small>{t('saveSqlHint')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        <div className="save-sql-grid">
          <label>
            <span>{t('sqlName')}</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="save-sql-summary">
            <div className="context-row">
              <span>{t('project')}</span>
              <small title={activeWorkspace?.rootPath}>{activeWorkspace?.name ?? t('noProject')}</small>
            </div>
            <div className="context-row">
              <span>{t('sqlLibrary')}</span>
              <small>{activeWorkspace?.assetPaths.sqlLibrary ?? '-'}</small>
            </div>
            <div className="context-row">
              <span>{t('connections')}</span>
              <small>{activeConnection?.name ?? t('noConnection')}</small>
            </div>
            <div className="context-row">
              <span>{t('currentFile')}</span>
              <small title={document.relativePath ?? document.title}>{document.relativePath ?? document.title}</small>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
          <button className="primary-action" type="button" onClick={onSave}>
            {t('saveSql')}
          </button>
        </div>
      </section>
    </div>
  );
}

function WorkspaceDialog({
  activeConnectionId,
  activeWorkspace,
  connectionDraft,
  connections,
  createConnection,
  language,
  mode,
  selectedDatabaseEngine,
  selectedTable,
  settingsDraft,
  setConnectionDraft,
  setCreateConnection,
  setLanguage,
  setSelectedDatabaseEngine,
  setSettingsDraft,
  setWorkspaceDraft,
  setPythonDraft,
  t,
  tables,
  workspaceDraft,
  pythonDraft,
  onChooseDirectory,
  onConnect,
  onClose,
  onCreate,
  onCreateConnection,
  onDeleteConnection,
  onDescribeTable,
  onDisconnect,
  onPreviewTable,
  onSaveSettings,
  onSelectConnection,
  onTestConnection,
  onUpdateConnection,
}: {
  activeConnectionId: string;
  activeWorkspace: WorkspaceProject | undefined;
  connectionDraft: ConnectionInput;
  connections: SavedConnection[];
  createConnection: boolean;
  language: AppLanguage;
  mode: WorkspaceDialogMode;
  selectedDatabaseEngine: ConnectionInput['engine'];
  selectedTable: TableDetail | undefined;
  settingsDraft: WorkspaceProject['assetPaths'];
  setConnectionDraft: (draft: ConnectionInput) => void;
  setCreateConnection: (enabled: boolean) => void;
  setLanguage: (language: AppLanguage) => void;
  setSelectedDatabaseEngine: (engine: ConnectionInput['engine']) => void;
  setSettingsDraft: (draft: WorkspaceProject['assetPaths']) => void;
  setWorkspaceDraft: (draft: WorkspaceDraft) => void;
  setPythonDraft: (draft: WorkspacePythonConfig) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  tables: TableSummary[];
  workspaceDraft: WorkspaceDraft;
  pythonDraft: WorkspacePythonConfig;
  onChooseDirectory: () => void;
  onConnect: () => void;
  onClose: () => void;
  onCreate: () => void;
  onCreateConnection: () => void;
  onDeleteConnection: () => void;
  onDescribeTable: (table: TableSummary) => void;
  onDisconnect: () => void;
  onPreviewTable: (table: TableSummary) => void;
  onSaveSettings: () => void;
  onSelectConnection: (connection: SavedConnection) => void;
  onTestConnection: () => void;
  onUpdateConnection: () => void;
}) {
  const isCreate = mode === 'create';
  const isProjectSettings = mode === 'project-settings';
  const [settingsSection, setSettingsSection] = useState<'assets' | 'python' | 'connections'>('assets');
  const [ideSettingsSection, setIdeSettingsSection] = useState<'appearance' | 'editor' | 'terminal'>('appearance');
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={isCreate ? t('createProject') : isProjectSettings ? t('projectSettings') : t('ideSettings')}
      >
        <div className="modal-heading">
          <div>
            <strong>{isCreate ? t('createProject') : isProjectSettings ? t('projectSettings') : t('ideSettings')}</strong>
            <small>{activeWorkspace?.rootPath ?? t('noProject')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        {isCreate ? (
          <>
            <div className="project-wizard">
              <aside className="database-selector" aria-label={t('databaseType')}>
                <span>{t('databaseType')}</span>
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
                <section className="wizard-card">
                  <div className="subform-heading">
                    <strong>{t('projectBasics')}</strong>
                    <small>{t('projectBasicsHint')}</small>
                  </div>
                  <div className="modal-grid">
                    <label>
                      <span>{t('projectName')}</span>
                      <input
                        aria-label={t('projectName')}
                        placeholder={t('projectName')}
                        value={workspaceDraft.name}
                        onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t('projectPath')}</span>
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
                    </label>
                    <label>
                      <span>{t('description')}</span>
                      <input
                        aria-label={t('description')}
                        placeholder={t('description')}
                        value={workspaceDraft.description}
                        onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, description: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t('template')}</span>
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
                    </label>
                    <label className="switch-row">
                      <input
                        checked={createConnection}
                        type="checkbox"
                        onChange={(event) => setCreateConnection(event.target.checked)}
                      />
                      <span>{createConnection ? t('createConnectionNow') : t('skipConnection')}</span>
                    </label>
                  </div>
                </section>
                {createConnection ? (
                  <section className="wizard-card">
                    <div className="subform-heading">
                      <strong>{t('databaseConnection')}</strong>
                      <small>{t('databaseConnectionHint')}</small>
                    </div>
                    <div className="modal-grid two">
                      <label>
                        <span>{t('connectionName')}</span>
                        <input value={connectionDraft.name} onChange={(event) => setConnectionDraft({ ...connectionDraft, name: event.target.value })} />
                      </label>
                      <label>
                        <span>{t('host')}</span>
                        <input value={connectionDraft.host} onChange={(event) => setConnectionDraft({ ...connectionDraft, host: event.target.value })} />
                      </label>
                      <label>
                        <span>{t('database')}</span>
                        <input value={connectionDraft.database} onChange={(event) => setConnectionDraft({ ...connectionDraft, database: event.target.value })} />
                      </label>
                      <label>
                        <span>{t('username')}</span>
                        <input value={connectionDraft.username} onChange={(event) => setConnectionDraft({ ...connectionDraft, username: event.target.value })} />
                      </label>
                      <label>
                        <span>{t('password')}</span>
                        <input
                          type="password"
                          value={connectionDraft.password}
                          onChange={(event) => setConnectionDraft({ ...connectionDraft, password: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>{t('port')}</span>
                        <input
                          min={1}
                          type="number"
                          value={connectionDraft.port}
                          onChange={(event) => setConnectionDraft({ ...connectionDraft, port: Number(event.target.value) })}
                        />
                      </label>
                    </div>
                  </section>
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
        ) : isProjectSettings ? (
          <>
            <div className="settings-layout">
              <aside className="settings-nav" aria-label={t('projectSettings')}>
                <button
                  className={settingsSection === 'assets' ? 'active' : ''}
                  type="button"
                  onClick={() => setSettingsSection('assets')}
                >
                  {t('workspaceAssets')}
                </button>
                <button
                  className={settingsSection === 'python' ? 'active' : ''}
                  type="button"
                  onClick={() => setSettingsSection('python')}
                >
                  {t('pythonEnvironment')}
                </button>
                <button
                  className={settingsSection === 'connections' ? 'active' : ''}
                  type="button"
                  onClick={() => setSettingsSection('connections')}
                >
                  {t('databaseConnection')}
                </button>
              </aside>
              <div className="settings-content">
                {settingsSection === 'assets' ? (
                  <>
                    <div className="subform-heading">
                      <strong>{t('workspaceAssets')}</strong>
                      <small>{t('workspaceAssetsHint')}</small>
                    </div>
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
                        <input
                          value={settingsDraft.docs}
                          onChange={(event) => setSettingsDraft({ ...settingsDraft, docs: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>{t('outputsPath')}</span>
                        <input
                          value={settingsDraft.outputs}
                          onChange={(event) => setSettingsDraft({ ...settingsDraft, outputs: event.target.value })}
                        />
                      </label>
                    </div>
                  </>
                ) : null}
                {settingsSection === 'python' ? (
                  <PythonConfigForm pythonDraft={pythonDraft} setPythonDraft={setPythonDraft} t={t} />
                ) : null}
                {settingsSection === 'connections' ? (
                  <ConnectionPanel
                    activeConnectionId={activeConnectionId}
                    connections={connections}
                    draft={connectionDraft}
                    selectedTable={selectedTable}
                    setDraft={setConnectionDraft}
                    tables={tables}
                    t={t}
                    onConnect={onConnect}
                    onCreate={onCreateConnection}
                    onDelete={onDeleteConnection}
                    onDescribe={onDescribeTable}
                    onDisconnect={onDisconnect}
                    onPreview={onPreviewTable}
                    onSelect={onSelectConnection}
                    onTest={onTestConnection}
                    onUpdate={onUpdateConnection}
                  />
                ) : null}
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary-action" disabled={!activeWorkspace} type="button" onClick={onSaveSettings}>
                {t('saveSettings')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-layout">
              <aside className="settings-nav" aria-label={t('ideSettings')}>
                <button
                  className={ideSettingsSection === 'appearance' ? 'active' : ''}
                  type="button"
                  onClick={() => setIdeSettingsSection('appearance')}
                >
                  {t('appearance')}
                </button>
                <button
                  className={ideSettingsSection === 'editor' ? 'active' : ''}
                  type="button"
                  onClick={() => setIdeSettingsSection('editor')}
                >
                  {t('editorSettings')}
                </button>
                <button
                  className={ideSettingsSection === 'terminal' ? 'active' : ''}
                  type="button"
                  onClick={() => setIdeSettingsSection('terminal')}
                >
                  {t('terminalSettings')}
                </button>
              </aside>
              <div className="settings-content">
                {ideSettingsSection === 'appearance' ? (
                  <section className="settings-card">
                    <div className="subform-heading">
                      <strong>{t('appearance')}</strong>
                      <small>{t('appearanceHint')}</small>
                    </div>
                    <div className="modal-grid two">
                      <label>
                        <span>{t('language')}</span>
                        <select value={language} onChange={(event) => setLanguage(event.target.value as AppLanguage)}>
                          <option value="zh-CN">中文</option>
                          <option value="en">English</option>
                        </select>
                      </label>
                      <label>
                        <span>{t('theme')}</span>
                        <select value="dark" disabled>
                          <option value="dark">{t('themeDark')}</option>
                        </select>
                      </label>
                    </div>
                  </section>
                ) : null}
                {ideSettingsSection === 'editor' ? (
                  <section className="settings-card">
                    <div className="subform-heading">
                      <strong>{t('editorSettings')}</strong>
                      <small>{t('editorSettingsHint')}</small>
                    </div>
                    <div className="modal-grid two">
                      <label>
                        <span>{t('fontFamily')}</span>
                        <input disabled value="JetBrains Mono, Consolas" />
                      </label>
                      <label>
                        <span>{t('fontSize')}</span>
                        <input disabled type="number" value={13} />
                      </label>
                    </div>
                  </section>
                ) : null}
                {ideSettingsSection === 'terminal' ? (
                  <section className="settings-card">
                    <div className="subform-heading">
                      <strong>{t('terminalSettings')}</strong>
                      <small>{t('terminalSettingsHint')}</small>
                    </div>
                    <div className="modal-grid two">
                      <label>
                        <span>{t('defaultShell')}</span>
                        <input disabled value="PowerShell / bash" />
                      </label>
                      <label>
                        <span>{t('terminalCount')}</span>
                        <input disabled type="number" value={1} />
                      </label>
                    </div>
                  </section>
                ) : null}
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary-action" type="button" onClick={onClose}>
                {t('close')}
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
  return (
    <section className="subform-section">
      <div className="subform-heading">
        <strong>{t('pythonEnvironment')}</strong>
        <small>{t('pythonEnvironmentHint')}</small>
      </div>
      <div className="modal-grid two">
        <label>
          <span>{t('pythonMode')}</span>
          <select
            value={pythonDraft.mode}
            onChange={(event) =>
              setPythonDraft({ ...pythonDraft, mode: event.target.value as WorkspacePythonConfig['mode'] })
            }
          >
            <option value="system">{t('pythonModeSystem')}</option>
            <option value="venv">{t('pythonModeVenv')}</option>
            <option value="conda">{t('pythonModeConda')}</option>
          </select>
        </label>
        <label>
          <span>{t('requirementsPath')}</span>
          <input
            value={pythonDraft.requirementsPath}
            onChange={(event) => setPythonDraft({ ...pythonDraft, requirementsPath: event.target.value })}
          />
        </label>
        <label>
          <span>{t('pythonPath')}</span>
          <input
            placeholder={t('pythonPathPlaceholder')}
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
          <span>{t('venvPath')}</span>
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
  activeFilePath,
  files,
  t,
  onCreateProject,
  onOpenFile,
  onOpenProject,
}: {
  activeWorkspace: WorkspaceProject | undefined;
  activeFilePath?: string;
  files: WorkspaceFileEntry[];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onCreateProject: () => void;
  onOpenFile: (file: WorkspaceFileEntry) => void;
  onOpenProject: () => void;
}) {
  return (
    <section className="project-panel">
      <div className="explorer-heading">
        <span>{t('workspaceFiles')}</span>
        <small title={activeWorkspace?.rootPath ?? t('noProject')}>{activeWorkspace?.name ?? t('noProject')}</small>
      </div>
      {activeWorkspace ? (
        <div className="explorer-tree" aria-label={t('workspaceFiles')}>
          <div className="explorer-root" title={activeWorkspace.rootPath}>
            {activeWorkspace.rootPath}
          </div>
          <div className="project-files">
            {files.length > 0 ? (
              files.map((file) => (
                <FileNode
                  entry={file}
                  key={file.relativePath}
                  {...(activeFilePath ? { activeFilePath } : {})}
                  onOpenFile={onOpenFile}
                />
              ))
            ) : (
              <div className="workspace-scaffold">
                <FileNode label=".dbagent/workspace.json" />
                <FileNode label="sql/" />
                <FileNode label="scripts/" />
                <FileNode label="docs/" />
                <FileNode label="outputs/" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="project-empty">
          <strong>{t('projectEmptyTitle')}</strong>
          <div className="project-empty-actions">
            <button className="primary-action" type="button" onClick={onCreateProject}>
              {t('createProject')}
            </button>
            <button className="secondary" type="button" onClick={onOpenProject}>
              {t('openProject')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function FileNode({
  activeFilePath,
  entry,
  label,
  onOpenFile,
}: {
  activeFilePath?: string;
  entry?: WorkspaceFileEntry;
  label?: string;
  onOpenFile?: (file: WorkspaceFileEntry) => void;
}) {
  const display = entry?.type === 'directory' ? `${entry.name}/` : (entry?.name ?? label ?? '');
  const isActive = Boolean(entry?.relativePath && activeFilePath === entry.relativePath);
  return (
    <>
      <button
        className={`file-node ${entry?.type ?? 'file'}${isActive ? ' active' : ''}`}
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
            <FileNode
              entry={child}
              key={child.relativePath}
              {...(activeFilePath ? { activeFilePath } : {})}
              {...(onOpenFile ? { onOpenFile } : {})}
            />
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
  const activeConnection = connections.find((connection) => connection.id === activeConnectionId);
  const schemaState = !activeConnection
    ? 'none'
    : activeConnection.status === 'connected'
      ? 'connected'
      : 'disconnected';

  return (
    <section className="panel">
      <div className="panel-heading">
        <span>{t('connections')}</span>
        <small>{connections.length}</small>
      </div>
      <div className="connection-list">
        {connections.length ? (
          connections.map((connection) => (
            <button
              className={connection.id === activeConnectionId ? 'connection active' : 'connection'}
              key={connection.id}
              type="button"
              onClick={() => onSelect(connection)}
            >
              <span>{connection.name}</span>
              <small>
                {connection.database} / {connection.status === 'connected' ? t('connected') : t('disconnected')}
              </small>
            </button>
          ))
        ) : (
          <div className="connection-empty">
            <strong>{t('connectionEmptyTitle')}</strong>
            <span>{t('connectionEmptyDescription')}</span>
          </div>
        )}
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
        connectionState={schemaState}
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
  connectionState,
  selectedTable,
  tables,
  t,
  onDescribe,
  onPreview,
}: {
  connectionState: 'none' | 'disconnected' | 'connected';
  selectedTable: TableDetail | undefined;
  tables: TableSummary[];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onDescribe: (table: TableSummary) => void;
  onPreview: (table: TableSummary) => void;
}) {
  const emptyCopy =
    connectionState === 'none'
      ? { description: t('schemaEmptyNoConnectionDescription'), title: t('schemaEmptyNoConnectionTitle') }
      : connectionState === 'disconnected'
        ? { description: t('schemaEmptyDisconnectedDescription'), title: t('schemaEmptyDisconnectedTitle') }
        : { description: t('schemaEmptyConnectedDescription'), title: t('schemaEmptyConnectedTitle') };
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
      {tables.length ? (
        Object.entries(grouped).map(([schema, schemaTables]) => (
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
        ))
      ) : (
        <div className="schema-empty">
          <strong>{emptyCopy.title}</strong>
          <span>{emptyCopy.description}</span>
        </div>
      )}
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
  bottomPanel,
  document,
  editorLanguage,
  message,
  result,
  sql,
  t,
  onChangeSql,
  onExecuteSql,
  onExplain,
  onExportCsv,
  onExportExcel,
  onExportJson,
  onSaveSql,
  setBottomPanel,
}: {
  activeConnection: SavedConnection | undefined;
  bottomPanel: 'results' | 'console';
  document: EditorDocument;
  editorLanguage: EditorLanguage;
  message: string;
  result: QueryExecutionResult | undefined;
  sql: string;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onChangeSql: (sql: string) => void;
  onExecuteSql: (sql: string) => void;
  onExplain: () => void;
  onExportCsv: () => void;
  onExportExcel: () => void;
  onExportJson: () => void;
  onSaveSql: () => void;
  setBottomPanel: (panel: 'results' | 'console') => void;
}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selectedSql: string } | undefined>();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const isSqlDocument = editorLanguage === 'sql';

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(undefined);
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [contextMenu]);

  function getSelectedSql(): string {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!editor || !model || !selection || selection.isEmpty()) return '';
    return model.getValueInRange(selection).trim();
  }

  function openSqlContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!isSqlDocument) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, selectedSql: getSelectedSql() });
  }

  function runSqlText(nextSql: string) {
    setContextMenu(undefined);
    if (!nextSql.trim()) return;
    onExecuteSql(nextSql);
  }

  return (
    <>
      <section className="editor-pane">
        <div className="editor-tabs" aria-label="Open editor tabs">
          <button className="editor-tab active" type="button" title={document.relativePath ?? document.title}>
            <span>{document.title}</span>
            <small>{document.language.toUpperCase()}</small>
            {document.dirty ? <i aria-label="Unsaved changes" /> : null}
          </button>
          {document.relativePath ? <div className="editor-path">{document.relativePath}</div> : null}
        </div>
        <div className="pane-toolbar compact">
          <div>
            <span>{t('editor')}</span>
            <small>
              {activeConnection?.name ?? t('noConnection')}
              {activeConnection?.readOnly ? ` / ${t('readOnly')}` : ''}
            </small>
          </div>
        </div>
        <div className="editor-context-strip" aria-label="Editor context">
          <span title={document.relativePath ?? document.title}>
            {t('currentFile')}: {document.relativePath ?? document.title}
          </span>
          <span>
            {t('statusConnection')}: {activeConnection?.name ?? t('noConnection')}
          </span>
          <span>{document.dirty ? t('statusUnsaved') : t('statusSaved')}</span>
          {activeConnection?.readOnly ? <span>{t('readOnly')}</span> : null}
        </div>
        <div className="monaco-shell" onContextMenu={openSqlContextMenu}>
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
            onMount={(editor) => {
              editorRef.current = editor;
            }}
          />
          {contextMenu ? (
            <div className="editor-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button disabled={!contextMenu.selectedSql} type="button" onClick={() => runSqlText(contextMenu.selectedSql)}>
                {t('runSelectedSql')}
              </button>
              <button type="button" onClick={() => runSqlText(sql)}>
                {t('runFileSql')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(undefined);
                  onExplain();
                }}
              >
                {t('explain')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setContextMenu(undefined);
                  onSaveSql();
                }}
              >
                {t('saveFile')}
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <section className="result-pane">
        <div className="bottom-panel-tabs">
          <button
            className={bottomPanel === 'results' ? 'active' : ''}
            type="button"
            onClick={() => setBottomPanel('results')}
          >
            {t('results')}
          </button>
          <button
            className={bottomPanel === 'console' ? 'active' : ''}
            type="button"
            onClick={() => setBottomPanel('console')}
          >
            {t('console')}
          </button>
          <small>{message}</small>
          <div className="bottom-panel-tools">
            <button
              className="icon-tool"
              disabled={!result}
              title={t('exportResult')}
              type="button"
              onClick={() => setExportMenuOpen((open) => !open)}
            >
              ⇩
            </button>
            {exportMenuOpen && result ? (
              <div className="tool-menu">
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    onExportCsv();
                  }}
                >
                  {t('exportCsv')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    onExportExcel();
                  }}
                >
                  {t('exportExcel')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportMenuOpen(false);
                    onExportJson();
                  }}
                >
                  {t('exportJson')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {bottomPanel === 'results' ? (
          <div className="bottom-panel-body">
            {result ? (
              <>
                <ResultSummary result={result} t={t} />
                <PerformanceWarnings result={result} />
                <ResultTable result={result} t={t} />
              </>
            ) : (
              <div className="result-empty">
                <strong>{t('resultEmptyTitle')}</strong>
                <span>{t('resultEmptyDescription')}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="console-panel">
            <div className="terminal-tabs">
              <button className="active" type="button">
                Terminal 1
              </button>
              <button type="button">+</button>
            </div>
            <pre>{`DBAgent console\n\n${t('consoleHint')}`}</pre>
          </div>
        )}
      </section>
    </>
  );
}

function ResultSummary({
  result,
  t,
}: {
  result: QueryExecutionResult;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  return (
    <div className="result-summary" aria-label="Query result summary">
      <ResultMetric label={t('resultRows')} value={String(result.rowCount)} />
      <ResultMetric label={t('resultElapsed')} value={`${result.elapsedMs} ms`} />
      <ResultMetric label={t('resultRisk')} value={result.safety.riskLevel} />
      <ResultMetric label={t('resultStatement')} value={result.safety.statementKind} />
    </div>
  );
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="result-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function ResultTable({
  result,
  t,
}: {
  result: QueryExecutionResult;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  const [searchText, setSearchText] = useState('');
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => result.columns.map((column) => column.name));
  const activeColumns = useMemo(() => {
    const selected = result.columns.filter((column) => visibleColumns.includes(column.name));
    return selected.length > 0 ? selected : result.columns;
  }, [result.columns, visibleColumns]);
  const filteredRows = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) return result.rows;
    return result.rows.filter((row) =>
      activeColumns.some((column) => formatValue(row[column.name]).toLowerCase().includes(keyword)),
    );
  }, [activeColumns, result.rows, searchText]);

  useEffect(() => {
    setVisibleColumns(result.columns.map((column) => column.name));
    setSearchText('');
    setColumnMenuOpen(false);
  }, [result.queryId, result.columns]);

  function toggleColumn(columnName: string) {
    setVisibleColumns((current) => {
      if (current.includes(columnName)) return current.filter((name) => name !== columnName);
      return [...current, columnName];
    });
  }

  return (
    <div className="result-table-shell">
      <div className="result-table-tools">
        <input
          aria-label={t('searchResults')}
          placeholder={t('searchResults')}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
        <div className="column-filter">
          <button className="icon-tool" title={t('filterColumns')} type="button" onClick={() => setColumnMenuOpen((open) => !open)}>
            ⛃
          </button>
          {columnMenuOpen ? (
            <div className="tool-menu column-menu">
              {result.columns.map((column) => (
                <label key={column.name}>
                  <input
                    checked={visibleColumns.includes(column.name)}
                    type="checkbox"
                    onChange={() => toggleColumn(column.name)}
                  />
                  <span>{column.name}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {activeColumns.map((column) => (
                <th key={column.name}>{column.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, index) => (
              <tr key={index}>
                {activeColumns.map((column) => (
                  <td key={column.name}>{formatValue(row[column.name])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filteredRows.length === 0 ? <div className="result-filter-empty">{t('noFilteredRows')}</div> : null}
      </div>
    </div>
  );
}

function ChatPanel({
  activeConnection,
  activeWorkspace,
  document,
  draft,
  messages,
  setDraft,
  t,
  onSend,
}: {
  activeConnection: SavedConnection | undefined;
  activeWorkspace: WorkspaceProject | undefined;
  document: EditorDocument;
  draft: string;
  messages: ChatMessage[];
  setDraft: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onSend: () => void;
}) {
  return (
    <section className="panel chat-panel simple-chat-panel">
      <div className="chat-titlebar">
        <div className="agent-tabs" aria-label={t('chat')}>
          <button type="button">CHAT</button>
          <button className="active" type="button">
            AGENT
          </button>
        </div>
        <div className="agent-toolbar" aria-label="Agent toolbar">
          <button type="button" title="More">
            ...
          </button>
          <button type="button" title="Refresh">
            o
          </button>
          <button type="button" title={t('settings')}>
            *
          </button>
          <button type="button" title="New chat">
            +
          </button>
        </div>
      </div>
      <div className="message-list simple-message-list">
        {messages.map((message) => (
          <div className={`chat-message ${message.role}`} key={message.id}>
            <span>{message.content}</span>
          </div>
        ))}
      </div>
      <div className="agent-composer">
        <textarea
          className="agent-composer-input"
          aria-label={t('chatPlaceholder')}
          placeholder={t('chatPlaceholder')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="agent-composer-footer">
          <div className="agent-composer-actions">
            <button type="button" title="Attach">
              +
            </button>
            <span title={activeWorkspace?.rootPath ?? t('noProject')}>{activeWorkspace?.name ?? t('noProject')}</span>
            <span title={activeConnection?.name ?? t('noConnection')}>{activeConnection?.name ?? t('noConnection')}</span>
            <span title={document.relativePath ?? document.title}>{document.relativePath ?? document.title}</span>
          </div>
          <button className="agent-send" type="button" onClick={onSend}>
            ^
          </button>
        </div>
      </div>
    </section>
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

function queryResultToExcelHtml(result: QueryExecutionResult): string {
  const header = result.columns.map((column) => `<th>${escapeHtml(column.name)}</th>`).join('');
  const rows = result.rows
    .map(
      (row) =>
        `<tr>${result.columns.map((column) => `<td>${escapeHtml(formatValue(row[column.name]))}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><table>${header ? `<thead><tr>${header}</tr></thead>` : ''}<tbody>${rows}</tbody></table></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
