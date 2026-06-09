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
  type AuthStatus,
  type IdeSettings,
  type PluginManifest,
  type PythonEnvironmentInfo,
  type QueryExecutionResult,
  type SavedConnection,
  type TableDetail,
  type TableSummary,
  type TerminalSession,
  type WorkspaceProject,
  type WorkspaceFileEntry,
  type WorkspacePythonConfig,
  type WorkspaceTemplate,
} from '@dbagent/shared';
import {
  archiveConversation,
  createWelcomeMessage,
  type AgentConversation,
  type AgentMessage,
} from './agent-chat.js';
import { authCodePurpose, canRequestAuthCode, canSubmitAuthForm, inferAuthChannel, type AuthFormMode } from './auth-form.js';
import { connectionToDraft, defaultConnectionDraft } from './connection-draft.js';
import { formatAppError, summarizePerformanceWarnings } from './diagnostics.js';
import { createTranslator, normalizeLanguage, type AppLanguage } from './i18n.js';
import { filterPlugins, getPluginPrimaryAction, listPluginCategories, type PluginMarketplaceFilter } from './plugin-marketplace.js';
import { selectPythonEnvironment, setCondaEnvironmentInput, switchPythonMode } from './python-config.js';
import { resolveTerminalCloseState, selectTerminalOutputTarget, selectVisibleTerminals } from './terminal-layout.js';
import { toWorkspaceRelativeDirectory } from './workspace-path.js';

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

type ChatMessage = AgentMessage;

type CommandPaletteItem = {
  id: string;
  title: string;
  category: string;
  source: string;
  enabled: boolean;
};

type TerminalView = TerminalSession & {
  input: string;
  output: string;
  running: boolean;
  cursor: number;
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

const defaultIdeSettings: IdeSettings = {
  appearance: {
    language: 'zh-CN',
    theme: 'dark',
    density: 'compact',
  },
  editor: {
    fontFamily: 'JetBrains Mono, Consolas, SFMono-Regular, monospace',
    fontSize: 13,
    tabSize: 2,
    wordWrap: 'on',
    minimap: false,
    lineNumbers: true,
  },
  terminal: {
    defaultShell: '',
    fontFamily: 'JetBrains Mono, Consolas, SFMono-Regular, monospace',
    fontSize: 13,
    scrollback: 5000,
    cursorBlink: true,
  },
};

const defaultEditorDocument: EditorDocument = {
  title: '欢迎',
  language: 'plaintext',
  dirty: false,
};

function createAgentWelcomeMessage(language: AppLanguage): AgentMessage {
  return createWelcomeMessage(
    language === 'zh-CN'
      ? '工作台已就绪。你可以在项目中沉淀 SQL、脚本和文档。'
      : 'Workspace ready. You can organize SQL, scripts, and docs in this project.',
  );
}

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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
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
  const [ideSettings, setIdeSettings] = useState<IdeSettings>(defaultIdeSettings);
  const [workspacePythonDraft, setWorkspacePythonDraft] = useState<WorkspacePythonConfig>(defaultWorkspacePythonDraft);
  const [pythonEnvironments, setPythonEnvironments] = useState<PythonEnvironmentInfo[]>([]);
  const [terminals, setTerminals] = useState<TerminalView[]>([]);
  const terminalsRef = useRef<TerminalView[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState('');
  const [splitTerminalId, setSplitTerminalId] = useState('');
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [createAgentWelcomeMessage(language)]);
  const [chatHistory, setChatHistory] = useState<AgentConversation[]>([]);
  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeConnectionId),
    [activeConnectionId, connections],
  );
  const commandPaletteItems = useMemo(
    () => buildCommandPaletteItems({ activeConnection, activeWorkspace, editorLanguage, plugins, result, t }),
    [activeConnection, activeWorkspace, editorLanguage, plugins, result, t],
  );

  useEffect(() => {
    window.localStorage.setItem(storageKeys.language, language);
    setMessage(createTranslator(language)('assistantReady'));
  }, [language]);

  useEffect(() => {
    void refreshConnections();
    void refreshWorkspace();
    void initializeIdeShell();
    void refreshPlugins();
  }, []);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void pollTerminalOutputs();
    }, 500);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
      if (command === 'command-palette') {
        openCommandPalette();
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
      if (command === 'run-python') {
        void runPythonScript();
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

  function openCommandPalette() {
    setCommandPaletteQuery('');
    setCommandPaletteOpen(true);
  }

  async function runCommandPaletteItem(id: string) {
    setCommandPaletteOpen(false);
    switch (id) {
      case 'core.newProject':
        openCreateProjectDialog();
        return;
      case 'core.openProject':
        await chooseAndOpenWorkspace();
        return;
      case 'core.saveFile':
        await saveCurrentDocument();
        return;
      case 'core.runSql':
        await execute();
        return;
      case 'core.runPython':
      case 'dbagent.python.runCurrentFile':
        await runPythonScript();
        return;
      case 'core.explainSql':
      case 'dbagent.postgres.explain':
        await explain();
        return;
      case 'core.toggleLeftSidebar':
        setLeftSidebarCollapsed((collapsed) => !collapsed);
        return;
      case 'core.toggleRightSidebar':
        setRightSidebarCollapsed((collapsed) => !collapsed);
        return;
      case 'core.openIdeSettings':
        setWorkspaceDialogMode('ide-settings');
        setWorkspaceDialogOpen(true);
        return;
      case 'core.openProjectSettings':
      case 'dbagent.postgres.connect':
        openSettingsDialog();
        return;
      case 'dbagent.python.createVenv':
        await createPythonEnvironment('venv', '.venv');
        return;
      case 'dbagent.python.detect':
        await detectPythonEnvironments();
        return;
      case 'dbagent.result.exportCsv':
        exportCsv();
        return;
      case 'dbagent.result.exportJson':
        exportJson();
        return;
      case 'dbagent.chart.preview':
        setBottomPanel('results');
        setMessage(t('chartPreviewRegistered'));
        return;
      default:
        setMessage(`${id}: ${t('commandNotBound')}`);
    }
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

  async function initializeIdeShell() {
    await refreshIdeSettings();
    await initializeTerminal();
  }

  async function refreshIdeSettings() {
    const response = await window.dbagent.invoke(ipcChannels.app.loadIdeSettings, undefined);
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setIdeSettings(response.data);
    setLanguage(response.data.appearance.language);
  }

  async function saveIdeSettings(nextSettings: IdeSettings) {
    const response = await window.dbagent.invoke(ipcChannels.app.saveIdeSettings, nextSettings);
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setIdeSettings(response.data);
    setLanguage(response.data.appearance.language);
    setMessage(response.data.appearance.language === 'zh-CN' ? 'IDE 设置已保存。' : 'IDE settings saved.');
  }

  async function initializeTerminal() {
    const response = await window.dbagent.invoke(ipcChannels.terminal.create, {});
    if (!response.ok) return;
    const terminal = toTerminalView(response.data);
    setTerminals([terminal]);
    setActiveTerminalId(terminal.id);
  }

  async function createTerminal(): Promise<TerminalView | undefined> {
    const response = await window.dbagent.invoke(ipcChannels.terminal.create, {
      ...(activeWorkspace ? { cwd: activeWorkspace.rootPath } : {}),
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return undefined;
    }
    const terminal = toTerminalView(response.data);
    setTerminals((current) => [...current, terminal]);
    setActiveTerminalId(terminal.id);
    return terminal;
  }

  async function splitTerminal() {
    const primaryTerminalId = activeTerminalId;
    const terminal = await createTerminal();
    if (!terminal) return;
    setActiveTerminalId(primaryTerminalId || terminal.id);
    setSplitTerminalId(terminal.id);
    setBottomPanel('console');
  }

  async function closeTerminal(id: string) {
    const response = await window.dbagent.invoke(ipcChannels.terminal.close, { id });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setTerminals((current) => {
      const next = resolveTerminalCloseState(current, id, activeTerminalId, splitTerminalId);
      setActiveTerminalId(next.activeTerminalId);
      setSplitTerminalId(next.splitTerminalId);
      return next.terminals;
    });
  }

  async function clearTerminal(id: string) {
    const response = await window.dbagent.invoke(ipcChannels.terminal.clear, { id });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setTerminals((current) =>
      current.map((terminal) => (terminal.id === id ? { ...terminal, output: '', cursor: 0 } : terminal)),
    );
  }

  function updateTerminalInput(id: string, input: string) {
    setTerminals((current) => current.map((terminal) => (terminal.id === id ? { ...terminal, input } : terminal)));
  }

  async function pollTerminalOutputs() {
    const snapshot = terminalsRef.current;
    if (!snapshot.length) return;
    const responses = await Promise.all(
      snapshot.map((terminal) =>
        window.dbagent.invoke(ipcChannels.terminal.read, {
          terminalId: terminal.id,
          cursor: terminal.cursor,
        }),
      ),
    );
    setTerminals((current) =>
      current.map((terminal) => {
        const response = responses.find((item) => item.ok && item.data.terminalId === terminal.id);
        if (!response?.ok) return terminal;
        return {
          ...terminal,
          output: response.data.chunk ? `${terminal.output}${response.data.chunk}` : terminal.output,
          cursor: response.data.cursor,
          status: response.data.status,
          running: false,
          ...(response.data.exitCode !== undefined ? { lastExitCode: response.data.exitCode } : {}),
        };
      }),
    );
  }

  async function runTerminalCommand(id: string) {
    const terminal = terminals.find((item) => item.id === id);
    if (!terminal || !terminal.input.trim()) return;
    const command = terminal.input.trim();
    setTerminals((current) =>
      current.map((item) =>
        item.id === id ? { ...item, running: true, input: '', output: `${item.output}\n> ${command}\n` } : item,
      ),
    );
    const response = await window.dbagent.invoke(ipcChannels.terminal.write, {
      terminalId: id,
      data: `${command}\n`,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      setTerminals((current) => current.map((item) => (item.id === id ? { ...item, running: false } : item)));
      return;
    }
    await pollTerminalOutputs();
  }

  async function refreshPlugins() {
    const response = await window.dbagent.invoke(ipcChannels.plugin.list, undefined);
    if (response.ok) setPlugins(response.data);
  }

  async function updatePlugin(id: string, installTarget: boolean) {
    const response = await window.dbagent.invoke(installTarget ? ipcChannels.plugin.install : ipcChannels.plugin.uninstall, { id });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setPlugins((current) => current.map((plugin) => (plugin.id === id ? response.data : plugin)));
  }

  async function setPluginEnabled(id: string, enableTarget: boolean) {
    const response = await window.dbagent.invoke(enableTarget ? ipcChannels.plugin.enable : ipcChannels.plugin.disable, { id });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setPlugins((current) => current.map((plugin) => (plugin.id === id ? response.data : plugin)));
  }

  async function detectPythonEnvironments() {
    const response = await window.dbagent.invoke(ipcChannels.python.detect, {
      ...(activeWorkspace ? { rootPath: activeWorkspace.rootPath } : {}),
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setPythonEnvironments(response.data);
    setMessage(
      language === 'zh-CN' ? `检测到 ${response.data.length} 个 Python 环境。` : `Detected ${response.data.length} Python environments.`,
    );
  }

  async function choosePythonPath(mode: 'file' | 'directory') {
    const response = await window.dbagent.invoke(ipcChannels.python.choosePath, {
      mode,
      title: mode === 'file' ? 'Choose Python executable' : 'Choose Python environment directory',
    });
    return response.ok ? response.data.path : undefined;
  }

  async function createPythonEnvironment(mode: 'venv' | 'conda', name: string) {
    if (!activeWorkspace) {
      setMessage(language === 'zh-CN' ? '请先打开项目。' : 'Open a project first.');
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.python.createEnvironment, {
      rootPath: activeWorkspace.rootPath,
      mode,
      name,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setPythonEnvironments((current) => [response.data, ...current.filter((item) => item.id !== response.data.id)]);
    setWorkspacePythonDraft((current) => ({
      ...current,
      mode,
      ...(response.data.pythonPath ? { pythonPath: response.data.pythonPath } : {}),
      ...(response.data.venvPath ? { venvPath: response.data.venvPath } : {}),
      ...(response.data.condaEnvName ? { condaEnvName: response.data.condaEnvName } : {}),
      ...(response.data.condaPrefix ? { condaPrefix: response.data.condaPrefix } : {}),
    }));
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

  async function runPythonScript() {
    if (editorLanguage !== 'python') {
      setMessage(language === 'zh-CN' ? '当前编辑器不是 Python 文件。' : 'Current editor is not a Python file.');
      return;
    }
    if (!activeWorkspace) {
      setMessage(language === 'zh-CN' ? '请先打开项目。' : 'Open a project first.');
      return;
    }
    if (editorDocument.relativePath && editorDocument.dirty) {
      const saved = await saveCurrentDocument();
      if (saved === false) return;
    }
    let outputTerminalId = selectTerminalOutputTarget(terminals, activeTerminalId)?.id;
    if (!outputTerminalId) {
      const terminal = await createTerminal();
      if (!terminal) return;
      outputTerminalId = terminal.id;
    }
    setBottomPanel('console');
    setActiveTerminalId(outputTerminalId);
    appendTerminalText(`\n> python ${editorDocument.relativePath ?? editorDocument.title}\n`, outputTerminalId);
    const response = await window.dbagent.invoke(ipcChannels.python.runScript, {
      rootPath: activeWorkspace.rootPath,
      config: workspacePythonDraft,
      ...(editorDocument.relativePath ? { relativePath: editorDocument.relativePath } : { code: sql }),
      timeoutMs: 120_000,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      appendTerminalText(`${formatAppError(response.error)}\n`, outputTerminalId);
      return;
    }
    const output = [response.data.stdout, response.data.stderr].filter(Boolean).join('\n');
    appendTerminalText(
      `${output}${output ? '\n' : ''}[python exit ${response.data.exitCode ?? 'unknown'} / ${response.data.elapsedMs} ms]\n`,
      outputTerminalId,
    );
    setMessage(
      response.data.exitCode === 0
        ? language === 'zh-CN'
          ? `Python 运行完成，耗时 ${response.data.elapsedMs} ms。`
          : `Python finished in ${response.data.elapsedMs} ms.`
        : language === 'zh-CN'
          ? `Python 运行失败，退出码 ${response.data.exitCode ?? 'unknown'}。`
          : `Python failed with exit ${response.data.exitCode ?? 'unknown'}.`,
    );
  }

  function appendTerminalText(text: string, targetTerminalId = activeTerminalId) {
    setTerminals((current) => {
      const targetId = selectTerminalOutputTarget(current, targetTerminalId)?.id;
      if (!targetId) return current;
      return current.map((terminal) => (terminal.id === targetId ? { ...terminal, output: `${terminal.output}${text}` } : terminal));
    });
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

  async function saveCurrentDocument(): Promise<boolean | undefined> {
    if (!activeWorkspace) {
      setMessage(language === 'zh-CN' ? '请先打开项目。' : 'Open a project first.');
      return;
    }
    if (!editorDocument.relativePath) {
      requestSaveSql();
      return false;
    }
    const response = await window.dbagent.invoke(ipcChannels.workspace.writeFile, {
      rootPath: activeWorkspace.rootPath,
      relativePath: editorDocument.relativePath,
      content: sql,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return false;
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

  function startNewChatConversation() {
    const now = Date.now();
    setChatHistory((history) => archiveConversation(history, chatMessages, t('newConversation'), now));
    setChatMessages([createAgentWelcomeMessage(language)]);
    setChatDraft('');
  }

  function restoreChatConversation(conversationId: string) {
    const conversation = chatHistory.find((item) => item.id === conversationId);
    if (!conversation) return;
    setChatMessages(conversation.messages);
    setChatDraft('');
  }

  return (
    <main className={`app-shell theme-${ideSettings.appearance.theme} density-${ideSettings.appearance.density}`}>
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
          <section className={terminalMaximized ? 'center-stage terminal-panel-maximized' : 'center-stage'}>
            <EditorPane
              activeConnection={activeConnection}
              bottomPanel={bottomPanel}
              document={editorDocument}
              editorLanguage={editorLanguage}
              message={message}
              result={result}
              sql={sql}
              t={t}
              activeTerminalId={activeTerminalId}
              ideSettings={ideSettings}
              splitTerminalId={splitTerminalId}
              terminalMaximized={terminalMaximized}
              terminals={terminals}
              onChangeSql={handleEditorChange}
              onClearTerminal={(id) => void clearTerminal(id)}
              onCloseTerminal={(id) => void closeTerminal(id)}
              onCreateTerminal={() => void createTerminal()}
              onExecuteSql={(nextSql) => void executeSql(nextSql)}
              onExplain={() => void explain()}
              onExportCsv={exportCsv}
              onExportExcel={exportExcel}
              onExportJson={exportJson}
              onSaveSql={() => void saveCurrentDocument()}
              onRunTerminal={(id) => void runTerminalCommand(id)}
              onSelectTerminal={setActiveTerminalId}
              onSplitTerminal={() => void splitTerminal()}
              onToggleTerminalMaximized={() => setTerminalMaximized((maximized) => !maximized)}
              onUpdateTerminalInput={updateTerminalInput}
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
              history={chatHistory}
              messages={chatMessages}
              setDraft={setChatDraft}
              t={t}
              onNewConversation={startNewChatConversation}
              onRestoreConversation={restoreChatConversation}
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
          pythonEnvironments={pythonEnvironments}
          plugins={plugins}
          ideSettings={ideSettings}
          setConnectionDraft={setConnectionDraft}
          setCreateConnection={setCreateConnectionDuringWorkspace}
          setSelectedDatabaseEngine={setSelectedDatabaseEngine}
          setSettingsDraft={setWorkspaceSettingsDraft}
          setWorkspaceDraft={setWorkspaceDraft}
          setPythonDraft={setWorkspacePythonDraft}
          t={t}
          tables={tables}
          workspaceDraft={workspaceDraft}
          pythonDraft={workspacePythonDraft}
          onChooseDirectory={() => void chooseWorkspaceDirectory()}
          onChoosePythonPath={(mode) => choosePythonPath(mode)}
          onConnect={() => void connectActive()}
          onClose={() => setWorkspaceDialogOpen(false)}
          onCreatePythonEnvironment={(mode, name) => void createPythonEnvironment(mode, name)}
          onCreate={() => void createWorkspace()}
          onCreateConnection={() => void createConnection()}
          onDeleteConnection={() => void removeActiveConnection()}
          onDescribeTable={(table) => void describeTable(table)}
          onDisconnect={() => void disconnectActive()}
          onPreviewTable={previewTable}
          onSaveSettings={() => void updateWorkspaceSettings()}
          onSaveIdeSettings={(settings) => void saveIdeSettings(settings)}
          onDetectPython={() => void detectPythonEnvironments()}
          onSetPluginEnabled={(id, enabled) => void setPluginEnabled(id, enabled)}
          onUpdatePlugin={(id, installed) => void updatePlugin(id, installed)}
          onSelectConnection={selectConnection}
          onTestConnection={() => void testConnection()}
          onUpdateConnection={() => void updateActiveConnection()}
        />
      ) : null}
      {commandPaletteOpen ? (
        <CommandPalette
          commands={commandPaletteItems}
          query={commandPaletteQuery}
          setQuery={setCommandPaletteQuery}
          t={t}
          onClose={() => setCommandPaletteOpen(false)}
          onRun={(id) => void runCommandPaletteItem(id)}
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

function CommandPalette({
  commands,
  query,
  setQuery,
  t,
  onClose,
  onRun,
}: {
  commands: CommandPaletteItem[];
  query: string;
  setQuery: (query: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onRun: (id: string) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = commands
    .filter((command) =>
      [command.title, command.category, command.source, command.id].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    )
    .slice(0, 40);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop command-backdrop" role="presentation">
      <section className="command-palette" role="dialog" aria-modal="true" aria-label={t('commandPalette')}>
        <input
          autoFocus
          placeholder={t('searchCommands')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && filtered[0]?.enabled) onRun(filtered[0].id);
          }}
        />
        <div className="command-list">
          {filtered.length ? (
            filtered.map((command) => (
              <button
                className="command-item"
                disabled={!command.enabled}
                key={command.id}
                type="button"
                onClick={() => onRun(command.id)}
              >
                <span>{command.title}</span>
                <small>
                  {command.category} / {command.source}
                </small>
              </button>
            ))
          ) : (
            <div className="command-empty">{t('noCommands')}</div>
          )}
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
  mode,
  selectedDatabaseEngine,
  selectedTable,
  ideSettings,
  settingsDraft,
  pythonEnvironments,
  plugins,
  setConnectionDraft,
  setCreateConnection,
  setSelectedDatabaseEngine,
  setSettingsDraft,
  setWorkspaceDraft,
  setPythonDraft,
  t,
  tables,
  workspaceDraft,
  pythonDraft,
  onChooseDirectory,
  onChoosePythonPath,
  onConnect,
  onClose,
  onCreate,
  onCreatePythonEnvironment,
  onCreateConnection,
  onDeleteConnection,
  onDescribeTable,
  onDisconnect,
  onPreviewTable,
  onSaveSettings,
  onSaveIdeSettings,
  onDetectPython,
  onSetPluginEnabled,
  onUpdatePlugin,
  onSelectConnection,
  onTestConnection,
  onUpdateConnection,
}: {
  activeConnectionId: string;
  activeWorkspace: WorkspaceProject | undefined;
  connectionDraft: ConnectionInput;
  connections: SavedConnection[];
  createConnection: boolean;
  mode: WorkspaceDialogMode;
  selectedDatabaseEngine: ConnectionInput['engine'];
  selectedTable: TableDetail | undefined;
  ideSettings: IdeSettings;
  settingsDraft: WorkspaceProject['assetPaths'];
  pythonEnvironments: PythonEnvironmentInfo[];
  plugins: PluginManifest[];
  setConnectionDraft: (draft: ConnectionInput) => void;
  setCreateConnection: (enabled: boolean) => void;
  setSelectedDatabaseEngine: (engine: ConnectionInput['engine']) => void;
  setSettingsDraft: (draft: WorkspaceProject['assetPaths']) => void;
  setWorkspaceDraft: (draft: WorkspaceDraft) => void;
  setPythonDraft: (draft: WorkspacePythonConfig) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  tables: TableSummary[];
  workspaceDraft: WorkspaceDraft;
  pythonDraft: WorkspacePythonConfig;
  onChooseDirectory: () => void;
  onChoosePythonPath: (mode: 'file' | 'directory') => Promise<string | undefined>;
  onConnect: () => void;
  onClose: () => void;
  onCreate: () => void;
  onCreatePythonEnvironment: (mode: 'venv' | 'conda', name: string) => void;
  onCreateConnection: () => void;
  onDeleteConnection: () => void;
  onDescribeTable: (table: TableSummary) => void;
  onDisconnect: () => void;
  onPreviewTable: (table: TableSummary) => void;
  onSaveSettings: () => void;
  onSaveIdeSettings: (settings: IdeSettings) => void;
  onDetectPython: () => void;
  onSetPluginEnabled: (id: string, enableTarget: boolean) => void;
  onUpdatePlugin: (id: string, installTarget: boolean) => void;
  onSelectConnection: (connection: SavedConnection) => void;
  onTestConnection: () => void;
  onUpdateConnection: () => void;
}) {
  const isCreate = mode === 'create';
  const isProjectSettings = mode === 'project-settings';
  const [settingsSection, setSettingsSection] = useState<'assets' | 'python' | 'connections'>('assets');
  const [ideSettingsSection, setIdeSettingsSection] = useState<'appearance' | 'editor' | 'terminal' | 'account' | 'plugins'>(
    'appearance',
  );
  const [ideDraft, setIdeDraft] = useState<IdeSettings>(ideSettings);
  useEffect(() => {
    setIdeDraft(ideSettings);
  }, [ideSettings]);
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
                <PythonConfigForm
                  environments={pythonEnvironments}
                  pythonDraft={pythonDraft}
                  setPythonDraft={setPythonDraft}
                  t={t}
                  workspaceRoot={workspaceDraft.rootPath}
                  onChoosePythonPath={onChoosePythonPath}
                  onCreateEnvironment={onCreatePythonEnvironment}
                  onDetectPython={onDetectPython}
                />
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
                  <PythonConfigForm
                    environments={pythonEnvironments}
                    pythonDraft={pythonDraft}
                    setPythonDraft={setPythonDraft}
                    t={t}
                    {...(activeWorkspace?.rootPath ? { workspaceRoot: activeWorkspace.rootPath } : {})}
                    onChoosePythonPath={onChoosePythonPath}
                    onCreateEnvironment={onCreatePythonEnvironment}
                    onDetectPython={onDetectPython}
                  />
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
                <button
                  className={ideSettingsSection === 'account' ? 'active' : ''}
                  type="button"
                  onClick={() => setIdeSettingsSection('account')}
                >
                  {t('accountSettings')}
                </button>
                <button
                  className={ideSettingsSection === 'plugins' ? 'active' : ''}
                  type="button"
                  onClick={() => setIdeSettingsSection('plugins')}
                >
                  {t('pluginMarketplace')}
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
                        <select
                          value={ideDraft.appearance.language}
                          onChange={(event) =>
                            setIdeDraft({
                              ...ideDraft,
                              appearance: { ...ideDraft.appearance, language: event.target.value as AppLanguage },
                            })
                          }
                        >
                          <option value="zh-CN">中文</option>
                          <option value="en">English</option>
                        </select>
                      </label>
                      <label>
                        <span>{t('theme')}</span>
                        <select
                          value={ideDraft.appearance.theme}
                          onChange={(event) =>
                            setIdeDraft({
                              ...ideDraft,
                              appearance: {
                                ...ideDraft.appearance,
                                theme: event.target.value as IdeSettings['appearance']['theme'],
                              },
                            })
                          }
                        >
                          <option value="dark">{t('themeDark')}</option>
                          <option value="light">Light</option>
                        </select>
                      </label>
                      <label>
                        <span>密度</span>
                        <select
                          value={ideDraft.appearance.density}
                          onChange={(event) =>
                            setIdeDraft({
                              ...ideDraft,
                              appearance: {
                                ...ideDraft.appearance,
                                density: event.target.value as IdeSettings['appearance']['density'],
                              },
                            })
                          }
                        >
                          <option value="compact">紧凑</option>
                          <option value="comfortable">舒适</option>
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
                        <input
                          value={ideDraft.editor.fontFamily}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, fontFamily: event.target.value } })
                          }
                        />
                      </label>
                      <label>
                        <span>{t('fontSize')}</span>
                        <input
                          max={28}
                          min={10}
                          type="number"
                          value={ideDraft.editor.fontSize}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, fontSize: Number(event.target.value) } })
                          }
                        />
                      </label>
                      <label>
                        <span>Tab Size</span>
                        <input
                          max={8}
                          min={2}
                          type="number"
                          value={ideDraft.editor.tabSize}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, tabSize: Number(event.target.value) } })
                          }
                        />
                      </label>
                      <label className="switch-row">
                        <input
                          checked={ideDraft.editor.wordWrap === 'on'}
                          type="checkbox"
                          onChange={(event) =>
                            setIdeDraft({
                              ...ideDraft,
                              editor: { ...ideDraft.editor, wordWrap: event.target.checked ? 'on' : 'off' },
                            })
                          }
                        />
                        <span>自动换行</span>
                      </label>
                      <label className="switch-row">
                        <input
                          checked={ideDraft.editor.minimap}
                          type="checkbox"
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, minimap: event.target.checked } })
                          }
                        />
                        <span>Minimap</span>
                      </label>
                      <label className="switch-row">
                        <input
                          checked={ideDraft.editor.lineNumbers}
                          type="checkbox"
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, lineNumbers: event.target.checked } })
                          }
                        />
                        <span>行号</span>
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
                        <input
                          placeholder="留空则使用系统默认 shell"
                          value={ideDraft.terminal.defaultShell}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, terminal: { ...ideDraft.terminal, defaultShell: event.target.value } })
                          }
                        />
                      </label>
                      <label>
                        <span>{t('fontFamily')}</span>
                        <input
                          value={ideDraft.terminal.fontFamily}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, terminal: { ...ideDraft.terminal, fontFamily: event.target.value } })
                          }
                        />
                      </label>
                      <label>
                        <span>{t('fontSize')}</span>
                        <input
                          max={28}
                          min={10}
                          type="number"
                          value={ideDraft.terminal.fontSize}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, terminal: { ...ideDraft.terminal, fontSize: Number(event.target.value) } })
                          }
                        />
                      </label>
                      <label>
                        <span>Scrollback</span>
                        <input
                          max={100000}
                          min={1000}
                          step={1000}
                          type="number"
                          value={ideDraft.terminal.scrollback}
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, terminal: { ...ideDraft.terminal, scrollback: Number(event.target.value) } })
                          }
                        />
                      </label>
                      <label className="switch-row">
                        <input
                          checked={ideDraft.terminal.cursorBlink}
                          type="checkbox"
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, terminal: { ...ideDraft.terminal, cursorBlink: event.target.checked } })
                          }
                        />
                        <span>光标闪烁</span>
                      </label>
                    </div>
                  </section>
                ) : null}
                {ideSettingsSection === 'account' ? <AccountSettingsPanel t={t} /> : null}
                {ideSettingsSection === 'plugins' ? (
                  <PluginMarketplacePanel
                    plugins={plugins}
                    t={t}
                    onSetPluginEnabled={onSetPluginEnabled}
                    onUpdatePlugin={onUpdatePlugin}
                  />
                ) : null}
              </div>
            </div>
            <div className="modal-actions">
              <button className="secondary" type="button" onClick={() => setIdeDraft(ideSettings)}>
                重置
              </button>
              <button className="primary-action" type="button" onClick={() => onSaveIdeSettings(ideDraft)}>
                {t('saveSettings')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function AccountSettingsPanel({
  t,
}: {
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}) {
  const [status, setStatus] = useState<AuthStatus>({ authenticated: false });
  const [mode, setMode] = useState<AuthFormMode>('login');
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const channel = inferAuthChannel(target);
  const codeRequestEnabled = canRequestAuthCode({ mode, target, busy });
  const submitEnabled = canSubmitAuthForm({ mode, target, password, code, busy });

  useEffect(() => {
    void window.dbagent.invoke(ipcChannels.auth.status, undefined).then((response) => {
      if (response.ok) setStatus(response.data);
    });
  }, []);

  async function requestCode() {
    if (!codeRequestEnabled) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await window.dbagent.invoke(ipcChannels.auth.requestCode, { target, channel, purpose: authCodePurpose(mode) });
      setMessage(response.ok ? `${t('verificationCodeSent')}: ${response.data.devCode ?? response.data.expiresAt}` : formatAppError(response.error));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!submitEnabled) return;
    setBusy(true);
    setMessage('');
    try {
      const response =
        mode === 'login'
          ? await window.dbagent.invoke(ipcChannels.auth.login, { identifier: target, password })
          : mode === 'register'
            ? await window.dbagent.invoke(ipcChannels.auth.register, {
                ...(channel === 'email' ? { email: target } : { phone: target }),
                password,
                verificationCode: code,
              })
            : mode === 'code-login'
              ? await window.dbagent.invoke(ipcChannels.auth.verifyCodeLogin, { target, channel, verificationCode: code })
              : await window.dbagent.invoke(ipcChannels.auth.resetPassword, {
                  target,
                  channel,
                  verificationCode: code,
                  newPassword: password,
                });
      if (response.ok) {
        setStatus(response.data);
        setMessage(t('accountUpdated'));
      } else {
        setMessage(formatAppError(response.error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      const response = await window.dbagent.invoke(ipcChannels.auth.logout, undefined);
      if (response.ok) setStatus(response.data);
    } finally {
      setBusy(false);
    }
  }

  function changeMode(nextMode: AuthFormMode) {
    setMode(nextMode);
    setCode('');
    setMessage('');
  }

  return (
    <section className="settings-card">
      <div className="subform-heading">
        <strong>{t('accountSettings')}</strong>
        <small>{status.authenticated ? status.user?.email || status.user?.phone : t('authDatabaseHint')}</small>
      </div>
      <div className="segmented-control">
        <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => changeMode('login')}>
          {t('passwordLogin')}
        </button>
        <button className={mode === 'code-login' ? 'active' : ''} type="button" onClick={() => changeMode('code-login')}>
          {t('codeLogin')}
        </button>
        <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => changeMode('register')}>
          {t('register')}
        </button>
        <button className={mode === 'reset-password' ? 'active' : ''} type="button" onClick={() => changeMode('reset-password')}>
          {t('forgotPassword')}
        </button>
      </div>
      <div className="modal-grid two">
        <label>
          <span>{t('emailOrPhone')}</span>
          <input
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setCode('');
              setMessage('');
            }}
          />
        </label>
        {mode === 'login' || mode === 'register' || mode === 'reset-password' ? (
          <label>
            <span>{mode === 'reset-password' ? t('newPassword') : t('password')}</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        ) : null}
        {mode !== 'login' ? (
          <label>
            <span>{t('verificationCode')}</span>
            <div className="path-row">
              <input value={code} onChange={(event) => setCode(event.target.value)} />
              <button className="secondary" disabled={!codeRequestEnabled} type="button" onClick={() => void requestCode()}>
                {busy ? t('running') : t('sendCode')}
              </button>
            </div>
          </label>
        ) : null}
      </div>
      <div className="modal-actions split">
        <small>{message}</small>
        <div>
          {status.authenticated ? (
            <button className="secondary" disabled={busy} type="button" onClick={() => void logout()}>
              {t('logout')}
            </button>
          ) : null}
          <button className="primary-action" disabled={!submitEnabled} type="button" onClick={() => void submit()}>
            {busy ? t('running') : t('apply')}
          </button>
        </div>
      </div>
    </section>
  );
}

function PluginMarketplacePanel({
  plugins,
  t,
  onSetPluginEnabled,
  onUpdatePlugin,
}: {
  plugins: PluginManifest[];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onSetPluginEnabled: (id: string, enableTarget: boolean) => void;
  onUpdatePlugin: (id: string, installTarget: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [filter, setFilter] = useState<PluginMarketplaceFilter>('all');
  const categories = useMemo(() => listPluginCategories(plugins), [plugins]);
  const visiblePlugins = useMemo(() => filterPlugins(plugins, { query, category, filter }), [plugins, query, category, filter]);

  return (
    <section className="settings-card">
      <div className="subform-heading">
        <strong>{t('pluginMarketplace')}</strong>
        <small>{t('pluginMarketplaceHint')}</small>
      </div>
      <div className="plugin-marketplace-toolbar">
        <input value={query} placeholder={t('searchPlugins')} onChange={(event) => setQuery(event.target.value)} />
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">{t('allCategories')}</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select value={filter} onChange={(event) => setFilter(event.target.value as PluginMarketplaceFilter)}>
          <option value="all">{t('allPlugins')}</option>
          <option value="installed">{t('installedPlugins')}</option>
          <option value="enabled">{t('enabledPlugins')}</option>
          <option value="official">{t('officialPlugins')}</option>
        </select>
      </div>
      <div className="plugin-grid">
        {visiblePlugins.map((plugin) => {
          const action = getPluginPrimaryAction(plugin);
          return (
            <div className="plugin-item" key={plugin.id}>
              <div>
                <strong>{plugin.name}</strong>
                <small>
                  {plugin.publisher} / {plugin.version} {plugin.official ? `/ ${t('officialPlugin')}` : ''}{' '}
                  {plugin.builtin ? `/ ${t('builtinPlugin')}` : ''}
                </small>
              </div>
              <p>{plugin.description}</p>
              <div className="plugin-meta">
                <span>{plugin.categories.join(', ')}</span>
                <span>{plugin.activationEvents.join(', ')}</span>
              </div>
              <div className="plugin-contributes">
                {(plugin.contributes.commands ?? []).slice(0, 3).map((command) => (
                  <span key={command.id}>{command.title}</span>
                ))}
                {(plugin.contributes.views ?? []).slice(0, 2).map((view) => (
                  <span key={view.id}>{view.title}</span>
                ))}
              </div>
              <div className="plugin-actions">
                {plugin.installed ? (
                  <button className="secondary" type="button" onClick={() => onSetPluginEnabled(plugin.id, action.enableTarget ?? false)}>
                    {plugin.enabled ? t('disable') : t('enable')}
                  </button>
                ) : null}
                {!plugin.builtin ? (
                  <button className="secondary" type="button" onClick={() => onUpdatePlugin(plugin.id, action.installTarget)}>
                    {plugin.installed ? t('uninstall') : t('install')}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {visiblePlugins.length === 0 ? <div className="empty-state">{t('noMatchingPlugins')}</div> : null}
      </div>
    </section>
  );
}

function PythonConfigForm({
  environments,
  pythonDraft,
  setPythonDraft,
  t,
  workspaceRoot,
  onChoosePythonPath,
  onCreateEnvironment,
  onDetectPython,
}: {
  environments: PythonEnvironmentInfo[];
  pythonDraft: WorkspacePythonConfig;
  setPythonDraft: (draft: WorkspacePythonConfig) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  workspaceRoot?: string;
  onChoosePythonPath: (mode: 'file' | 'directory') => Promise<string | undefined>;
  onCreateEnvironment: (mode: 'venv' | 'conda', name: string) => void;
  onDetectPython: () => void;
}) {
  const [newEnvironmentName, setNewEnvironmentName] = useState('.venv');
  const modeEnvironments = useMemo(
    () => environments.filter((environment) => environment.mode === pythonDraft.mode),
    [environments, pythonDraft.mode],
  );

  useEffect(() => {
    setNewEnvironmentName(pythonDraft.mode === 'conda' ? 'dbagent-analytics' : '.venv');
  }, [pythonDraft.mode]);

  function switchMode(mode: WorkspacePythonConfig['mode']) {
    setPythonDraft(switchPythonMode(pythonDraft, mode));
  }

  async function choosePath(mode: 'file' | 'directory') {
    const path = await onChoosePythonPath(mode);
    if (!path) return;
    if (pythonDraft.mode === 'venv') {
      const relativePath = toWorkspaceRelativeDirectory(path, workspaceRoot);
      if (!relativePath) {
        window.alert(t('venvMustBeInsideWorkspace'));
        return;
      }
      setPythonDraft({ ...pythonDraft, venvPath: relativePath });
    } else if (pythonDraft.mode === 'conda') {
      setPythonDraft(setCondaEnvironmentInput(pythonDraft, path));
    } else setPythonDraft({ ...pythonDraft, pythonPath: path });
  }

  function selectEnvironment(id: string) {
    const environment = environments.find((item) => item.id === id);
    if (!environment) return;
    setPythonDraft(selectPythonEnvironment(pythonDraft, environment));
  }

  return (
    <section className="subform-section">
      <div className="subform-heading">
        <strong>{t('pythonEnvironment')}</strong>
        <small>{t('pythonEnvironmentHint')}</small>
      </div>
      <div className="python-toolbar">
        <button className="secondary" type="button" onClick={onDetectPython}>
          {t('detectPython')}
        </button>
        <select value="" onChange={(event) => selectEnvironment(event.target.value)}>
          <option value="">{t('detectedPythonPlaceholder')}</option>
          {(modeEnvironments.length > 0 ? modeEnvironments : environments).map((environment) => (
            <option disabled={!environment.valid} key={environment.id} value={environment.id}>
              {environment.label} {environment.version ? `(${environment.version})` : ''} {environment.valid ? '' : ' - invalid'}
            </option>
          ))}
        </select>
      </div>
      <div className="modal-grid two">
        <label>
          <span>{t('pythonMode')}</span>
          <select value={pythonDraft.mode} onChange={(event) => switchMode(event.target.value as WorkspacePythonConfig['mode'])}>
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
        {pythonDraft.mode === 'system' ? (
          <label>
            <span>{t('pythonPath')}</span>
            <div className="path-row">
              <input
                placeholder={t('pythonPathPlaceholder')}
                value={pythonDraft.pythonPath ?? ''}
                onChange={(event) => setPythonDraft({ ...pythonDraft, pythonPath: event.target.value })}
              />
              <button className="icon-button" type="button" onClick={() => void choosePath('file')}>
                ...
              </button>
            </div>
          </label>
        ) : null}
        {pythonDraft.mode === 'venv' ? (
          <label>
            <span>{t('venvPath')}</span>
            <div className="path-row">
              <input
                placeholder=".venv"
                value={pythonDraft.venvPath ?? ''}
                onChange={(event) => setPythonDraft({ mode: 'venv', requirementsPath: pythonDraft.requirementsPath, venvPath: event.target.value })}
              />
              <button className="icon-button" type="button" onClick={() => void choosePath('directory')}>
                ...
              </button>
            </div>
          </label>
        ) : null}
        {pythonDraft.mode === 'conda' ? (
          <label>
            <span>{t('condaEnvironment')}</span>
            <div className="path-row">
              <input
                placeholder="base / analytics / C:\\Miniconda3\\envs\\analytics"
                value={pythonDraft.condaEnvName ?? pythonDraft.condaPrefix ?? ''}
                onChange={(event) => setPythonDraft(setCondaEnvironmentInput(pythonDraft, event.target.value))}
              />
              <button className="icon-button" type="button" onClick={() => void choosePath('directory')}>
                ...
              </button>
            </div>
          </label>
        ) : null}
      </div>
      {pythonDraft.mode === 'venv' || pythonDraft.mode === 'conda' ? (
        <div className="python-create-row">
          <input value={newEnvironmentName} onChange={(event) => setNewEnvironmentName(event.target.value)} />
          <button
            className="secondary"
            type="button"
            onClick={() => {
              if (pythonDraft.mode === 'venv' || pythonDraft.mode === 'conda') {
                onCreateEnvironment(pythonDraft.mode, newEnvironmentName);
              }
            }}
          >
            {t('createPythonEnvironment')}
          </button>
        </div>
      ) : null}
      {environments.length > 0 ? (
        <div className="python-env-list">
          {environments.slice(0, 6).map((environment) => (
            <button key={environment.id} type="button" onClick={() => selectEnvironment(environment.id)}>
              <strong>{environment.label}</strong>
              <small>{environment.version ?? environment.detail ?? environment.pythonPath}</small>
            </button>
          ))}
        </div>
      ) : null}
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
  activeTerminalId,
  bottomPanel,
  document,
  editorLanguage,
  ideSettings,
  message,
  result,
  sql,
  splitTerminalId,
  t,
  terminalMaximized,
  terminals,
  onChangeSql,
  onClearTerminal,
  onCloseTerminal,
  onCreateTerminal,
  onExecuteSql,
  onExplain,
  onExportCsv,
  onExportExcel,
  onExportJson,
  onSaveSql,
  onRunTerminal,
  onSelectTerminal,
  onSplitTerminal,
  onToggleTerminalMaximized,
  onUpdateTerminalInput,
  setBottomPanel,
}: {
  activeConnection: SavedConnection | undefined;
  activeTerminalId: string;
  bottomPanel: 'results' | 'console';
  document: EditorDocument;
  editorLanguage: EditorLanguage;
  ideSettings: IdeSettings;
  message: string;
  result: QueryExecutionResult | undefined;
  sql: string;
  splitTerminalId: string;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  terminalMaximized: boolean;
  terminals: TerminalView[];
  onChangeSql: (sql: string) => void;
  onClearTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  onCreateTerminal: () => void;
  onExecuteSql: (sql: string) => void;
  onExplain: () => void;
  onExportCsv: () => void;
  onExportExcel: () => void;
  onExportJson: () => void;
  onSaveSql: () => void;
  onRunTerminal: (id: string) => void;
  onSelectTerminal: (id: string) => void;
  onSplitTerminal: () => void;
  onToggleTerminalMaximized: () => void;
  onUpdateTerminalInput: (id: string, input: string) => void;
  setBottomPanel: (panel: 'results' | 'console') => void;
}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selectedSql: string } | undefined>();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const isSqlDocument = editorLanguage === 'sql';
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];

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
              fontFamily: ideSettings.editor.fontFamily,
              fontSize: ideSettings.editor.fontSize,
              lineNumbers: ideSettings.editor.lineNumbers ? 'on' : 'off',
              minimap: { enabled: ideSettings.editor.minimap },
              padding: { top: 14 },
              scrollBeyondLastLine: false,
              tabSize: ideSettings.editor.tabSize,
              wordWrap: ideSettings.editor.wordWrap,
            }}
            theme={ideSettings.appearance.theme === 'light' ? 'light' : 'vs-dark'}
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
      <section className={terminalMaximized ? 'result-pane terminal-maximized' : 'result-pane'}>
        <div className="bottom-panel-tabs">
          <button disabled type="button">
            {t('problems')}
          </button>
          <button
            className={bottomPanel === 'results' ? 'active' : ''}
            type="button"
            onClick={() => setBottomPanel('results')}
          >
            {t('output')}
          </button>
          <button
            className={bottomPanel === 'console' ? 'active' : ''}
            type="button"
            onClick={() => setBottomPanel('console')}
          >
            {t('terminal')}
          </button>
          <button disabled type="button">
            {t('ports')}
          </button>
          <small>{message}</small>
          {bottomPanel === 'results' ? (
            <div className="bottom-panel-tools">
              <button
                className="icon-tool"
                disabled={!result}
                title={t('exportResult')}
                type="button"
                onClick={() => setExportMenuOpen((open) => !open)}
              >
                <span className="icon-glyph export" aria-hidden="true" />
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
          ) : null}
          {bottomPanel === 'console' ? (
            <div className="bottom-panel-tools terminal-title-tools">
              <div className="terminal-session-list">
                {terminals.map((terminal) => (
                  <button
                    className={terminal.id === activeTerminal?.id ? 'active' : ''}
                    key={terminal.id}
                    type="button"
                    title={terminal.cwd ?? terminal.name}
                    onClick={() => onSelectTerminal(terminal.id)}
                  >
                    <span className="icon-glyph terminal-shell" aria-hidden="true" />
                    <span>{terminal.shell ?? terminal.name}</span>
                    <small>{terminal.lastExitCode === undefined ? '' : terminal.lastExitCode}</small>
                  </button>
                ))}
              </div>
              <button className="terminal-tool" type="button" title={t('newTerminal')} onClick={onCreateTerminal}>
                <span className="icon-glyph new-chat" aria-hidden="true" />
              </button>
              <button
                className="terminal-tool"
                disabled={!activeTerminal}
                type="button"
                title={t('splitTerminal')}
                onClick={onSplitTerminal}
              >
                <span className="icon-glyph split-terminal" aria-hidden="true" />
              </button>
              <button
                className="terminal-tool"
                disabled={!activeTerminal}
                type="button"
                title={t('clear')}
                onClick={() => {
                  if (activeTerminal) onClearTerminal(activeTerminal.id);
                }}
              >
                <span className="icon-glyph clear-terminal" aria-hidden="true" />
              </button>
              <button className="terminal-tool" disabled type="button" title={t('moreActions')}>
                <span className="icon-glyph more" aria-hidden="true" />
              </button>
              <button
                className={terminalMaximized ? 'terminal-tool active' : 'terminal-tool'}
                type="button"
                title={terminalMaximized ? t('restorePanel') : t('maximizePanel')}
                onClick={onToggleTerminalMaximized}
              >
                <span className="icon-glyph maximize" aria-hidden="true" />
              </button>
              <button
                className="terminal-tool"
                disabled={!activeTerminal}
                type="button"
                title={t('close')}
                onClick={() => {
                  if (activeTerminal) onCloseTerminal(activeTerminal.id);
                }}
              >
                <span className="icon-glyph close" aria-hidden="true" />
              </button>
            </div>
          ) : null}
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
          <TerminalPanel
            activeTerminalId={activeTerminalId}
            splitTerminalId={splitTerminalId}
            terminals={terminals}
            terminalSettings={ideSettings.terminal}
            t={t}
            onCreateTerminal={onCreateTerminal}
            onRunTerminal={onRunTerminal}
            onSelectTerminal={onSelectTerminal}
            onUpdateTerminalInput={onUpdateTerminalInput}
          />
        )}
      </section>
    </>
  );
}

function TerminalPanel({
  activeTerminalId,
  splitTerminalId,
  terminals,
  terminalSettings,
  t,
  onCreateTerminal,
  onRunTerminal,
  onSelectTerminal,
  onUpdateTerminalInput,
}: {
  activeTerminalId: string;
  splitTerminalId: string;
  terminals: TerminalView[];
  terminalSettings: IdeSettings['terminal'];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onCreateTerminal: () => void;
  onRunTerminal: (id: string) => void;
  onSelectTerminal: (id: string) => void;
  onUpdateTerminalInput: (id: string, input: string) => void;
}) {
  const visibleTerminals = selectVisibleTerminals(terminals, activeTerminalId, splitTerminalId);
  return (
    <div className="console-panel">
      {visibleTerminals.length ? (
        <div className={visibleTerminals.length > 1 ? 'terminal-split-grid' : 'terminal-split-grid single'}>
          {visibleTerminals.map((terminal) => (
            <TerminalViewport
              key={terminal.id}
              terminal={terminal}
              terminalSettings={terminalSettings}
              t={t}
              onRunTerminal={onRunTerminal}
              onSelectTerminal={onSelectTerminal}
              onUpdateTerminalInput={onUpdateTerminalInput}
            />
          ))}
        </div>
      ) : (
        <div className="terminal-empty">
          <span>{t('consoleHint')}</span>
          <button type="button" onClick={onCreateTerminal}>
            +
          </button>
        </div>
      )}
    </div>
  );
}

function TerminalViewport({
  terminal,
  terminalSettings,
  t,
  onRunTerminal,
  onSelectTerminal,
  onUpdateTerminalInput,
}: {
  terminal: TerminalView;
  terminalSettings: IdeSettings['terminal'];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onRunTerminal: (id: string) => void;
  onSelectTerminal: (id: string) => void;
  onUpdateTerminalInput: (id: string, input: string) => void;
}) {
  return (
    <div
      className="terminal-viewport"
      style={{ fontFamily: terminalSettings.fontFamily, fontSize: terminalSettings.fontSize }}
      onClick={() => onSelectTerminal(terminal.id)}
    >
      <pre className={terminalSettings.cursorBlink ? 'terminal-output cursor-blink' : 'terminal-output'}>
        {terminal.output}
      </pre>
      <div className="terminal-command-row">
        <span className="terminal-prompt">
          {terminal.shell?.toLowerCase().includes('powershell') ? 'PS' : '$'} {terminal.cwd ? `${terminal.cwd}>` : '>'}
        </span>
        <input
          aria-label={t('terminalCommand')}
          placeholder={terminal.output ? '' : t('consoleHint')}
          value={terminal.input}
          onChange={(event) => onUpdateTerminalInput(terminal.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onRunTerminal(terminal.id);
          }}
        />
        <button className="terminal-run" disabled={terminal.running} type="button" onClick={() => onRunTerminal(terminal.id)}>
          {terminal.running ? '...' : '>'}
        </button>
      </div>
    </div>
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
            <span className="icon-glyph filter" aria-hidden="true" />
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
  history,
  messages,
  setDraft,
  t,
  onNewConversation,
  onRestoreConversation,
  onSend,
}: {
  activeConnection: SavedConnection | undefined;
  activeWorkspace: WorkspaceProject | undefined;
  document: EditorDocument;
  draft: string;
  history: AgentConversation[];
  messages: ChatMessage[];
  setDraft: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onNewConversation: () => void;
  onRestoreConversation: (conversationId: string) => void;
  onSend: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<'history' | 'settings' | undefined>();
  const [contextSettings, setContextSettings] = useState({
    workspace: true,
    connection: true,
    file: true,
  });

  function toggleMenu(menu: 'history' | 'settings') {
    setOpenMenu((current) => (current === menu ? undefined : menu));
  }

  return (
    <section className="panel chat-panel simple-chat-panel">
      <div className="chat-titlebar">
        <div className="agent-heading">
          <strong>DBAgent</strong>
          <small>{t('assistantReady')}</small>
        </div>
        <div className="agent-toolbar" aria-label="Agent toolbar">
          <button
            className={openMenu === 'history' ? 'active' : ''}
            type="button"
            title={t('conversationHistory')}
            onClick={() => toggleMenu('history')}
          >
            <span className="icon-glyph history" aria-hidden="true" />
          </button>
          <button
            className={openMenu === 'settings' ? 'active' : ''}
            type="button"
            title={t('settings')}
            onClick={() => toggleMenu('settings')}
          >
            <span className="icon-glyph settings" aria-hidden="true" />
          </button>
          <button
            type="button"
            title={t('newConversation')}
            onClick={() => {
              setOpenMenu(undefined);
              onNewConversation();
            }}
          >
            <span className="icon-glyph new-chat" aria-hidden="true" />
          </button>
        </div>
        {openMenu === 'history' ? (
          <div className="agent-popover history-popover">
            <strong>{t('conversationHistory')}</strong>
            <button
              type="button"
              onClick={() => {
                setOpenMenu(undefined);
                onNewConversation();
              }}
            >
              {t('newConversation')}
            </button>
            {history.length ? (
              history.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  title={conversation.title}
                  onClick={() => {
                    setOpenMenu(undefined);
                    onRestoreConversation(conversation.id);
                  }}
                >
                  <span>{conversation.title}</span>
                  <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
                </button>
              ))
            ) : (
              <small>{t('noConversationHistory')}</small>
            )}
          </div>
        ) : null}
        {openMenu === 'settings' ? (
          <div className="agent-popover settings-popover">
            <strong>{t('agentPanelSettings')}</strong>
            <label>
              <input
                checked={contextSettings.workspace}
                type="checkbox"
                onChange={(event) => setContextSettings({ ...contextSettings, workspace: event.target.checked })}
              />
              <span>{t('agentUseWorkspaceContext')}</span>
            </label>
            <label>
              <input
                checked={contextSettings.connection}
                type="checkbox"
                onChange={(event) => setContextSettings({ ...contextSettings, connection: event.target.checked })}
              />
              <span>{t('agentUseConnectionContext')}</span>
            </label>
            <label>
              <input
                checked={contextSettings.file}
                type="checkbox"
                onChange={(event) => setContextSettings({ ...contextSettings, file: event.target.checked })}
              />
              <span>{t('agentUseFileContext')}</span>
            </label>
          </div>
        ) : null}
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
            {contextSettings.workspace ? (
              <span title={activeWorkspace?.rootPath ?? t('noProject')}>{activeWorkspace?.name ?? t('noProject')}</span>
            ) : null}
            {contextSettings.connection ? (
              <span title={activeConnection?.name ?? t('noConnection')}>{activeConnection?.name ?? t('noConnection')}</span>
            ) : null}
            {contextSettings.file ? (
              <span title={document.relativePath ?? document.title}>{document.relativePath ?? document.title}</span>
            ) : null}
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

function toTerminalView(session: TerminalSession): TerminalView {
  return {
    ...session,
    input: '',
    output: '',
    running: false,
    cursor: 0,
  };
}

function buildCommandPaletteItems({
  activeConnection,
  activeWorkspace,
  editorLanguage,
  plugins,
  result,
  t,
}: {
  activeConnection: SavedConnection | undefined;
  activeWorkspace: WorkspaceProject | undefined;
  editorLanguage: EditorLanguage;
  plugins: PluginManifest[];
  result: QueryExecutionResult | undefined;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
}): CommandPaletteItem[] {
  const isSql = editorLanguage === 'sql';
  const coreSource = t('commandSourceCore');
  const fileCategory = t('commandCategoryFile');
  const settingsCategory = t('commandCategorySettings');
  const viewCategory = t('commandCategoryView');
  const coreCommands: CommandPaletteItem[] = [
    { id: 'core.newProject', title: t('createProject'), category: fileCategory, source: coreSource, enabled: true },
    { id: 'core.openProject', title: t('openProject'), category: fileCategory, source: coreSource, enabled: true },
    { id: 'core.saveFile', title: t('saveFile'), category: fileCategory, source: coreSource, enabled: true },
    {
      id: 'core.runPython',
      title: t('commandRunPython'),
      category: 'Python',
      source: coreSource,
      enabled: editorLanguage === 'python' && Boolean(activeWorkspace),
    },
    { id: 'core.runSql', title: t('commandRunSql'), category: 'SQL', source: coreSource, enabled: isSql && Boolean(activeConnection) },
    {
      id: 'core.explainSql',
      title: t('commandExplainSql'),
      category: 'SQL',
      source: coreSource,
      enabled: isSql && Boolean(activeConnection),
    },
    { id: 'core.openIdeSettings', title: t('commandOpenIdeSettings'), category: settingsCategory, source: coreSource, enabled: true },
    {
      id: 'core.openProjectSettings',
      title: t('commandOpenProjectSettings'),
      category: settingsCategory,
      source: coreSource,
      enabled: Boolean(activeWorkspace),
    },
    { id: 'core.toggleLeftSidebar', title: t('commandToggleExplorer'), category: viewCategory, source: coreSource, enabled: true },
    { id: 'core.toggleRightSidebar', title: t('commandToggleAgentPanel'), category: viewCategory, source: coreSource, enabled: true },
  ];

  const pluginCommands = plugins.flatMap((plugin) => {
    if (!plugin.installed || !plugin.enabled) return [];
    return (plugin.contributes.commands ?? []).map((command) => ({
      id: command.id,
      title: command.title,
      category: command.category,
      source: plugin.name,
      enabled: isPluginCommandEnabled(command.id, { activeConnection, activeWorkspace, editorLanguage, result }),
    }));
  });

  return [...coreCommands, ...pluginCommands].sort((left, right) =>
    `${left.category}:${left.title}`.localeCompare(`${right.category}:${right.title}`),
  );
}

function isPluginCommandEnabled(
  commandId: string,
  context: {
    activeConnection: SavedConnection | undefined;
    activeWorkspace: WorkspaceProject | undefined;
    editorLanguage: EditorLanguage;
    result: QueryExecutionResult | undefined;
  },
): boolean {
  if (commandId === 'dbagent.postgres.connect') return true;
  if (commandId === 'dbagent.postgres.explain') return context.editorLanguage === 'sql' && Boolean(context.activeConnection);
  if (commandId === 'dbagent.python.detect') return true;
  if (commandId === 'dbagent.python.runCurrentFile') return context.editorLanguage === 'python' && Boolean(context.activeWorkspace);
  if (commandId === 'dbagent.python.createVenv') return Boolean(context.activeWorkspace);
  if (commandId === 'dbagent.result.exportCsv' || commandId === 'dbagent.result.exportJson') return Boolean(context.result);
  if (commandId === 'dbagent.chart.preview') return Boolean(context.result);
  return false;
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
