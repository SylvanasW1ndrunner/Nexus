import {
  Component,
  useCallback,
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
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
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
  type AgentConversation,
  type AgentMessage,
} from './agent-chat.js';
import { agentPanelActions, type AgentPanelActionId } from './agent-panel.js';
import {
  availableAuthModes,
  authCodePurpose,
  canRequestAuthCode,
  canSubmitAuthForm,
  inferAuthChannel,
  isAuthModeAvailable,
  isValidAuthTarget,
  type AuthFormMode,
} from './auth-form.js';
import { connectionToDraft, defaultConnectionDraft } from './connection-draft.js';
import { formatAppError, summarizePerformanceWarnings } from './diagnostics.js';
import { shouldCloseAuthDialog, shouldInitializeIdeShell } from './ide-shell-startup.js';
import { createTranslator, normalizeLanguage, type AppLanguage } from './i18n.js';
import { resolvePluginCommandAction } from './plugin-command-handler.js';
import { isPluginCommandAvailable } from './plugin-command.js';
import { filterPlugins, getPluginPrimaryAction, listPluginCategories, type PluginMarketplaceFilter } from './plugin-marketplace.js';
import { formatPythonRunTranscript, pythonRunSucceeded } from './python-run-output.js';
import {
  filterResultRows,
  formatResultCell,
  resolveVisibleResultColumns,
  toggleResultColumnVisibility,
} from './result-table.js';
import {
  canCreatePythonEnvironment,
  isWorkspaceRelativeDirectoryPath,
  pythonEnvironmentsForMode,
  pythonExecutableForEnvironmentCreation,
  selectPythonEnvironment,
  setCondaEnvironmentInput,
  switchPythonMode,
} from './python-config.js';
import { buildTerminalActionMenu, type TerminalActionId } from './terminal-actions.js';
import { normalizeTerminalName, terminalStatusLabelKey, terminalStatusValue, terminalTabLabel } from './terminal-display.js';
import { shouldForwardTerminalData } from './terminal-input.js';
import {
  appendTerminalSession,
  bottomPanelAfterTerminalCreate,
  resolveTerminalCloseState,
  selectTerminalOutputTarget,
  selectVisibleTerminals,
} from './terminal-layout.js';
import {
  createWorkspaceFileTemplate,
  inferWorkspaceFileLanguage,
  normalizeNewWorkspaceDirectoryPath,
  normalizeNewWorkspaceFilePath,
} from './workspace-file.js';
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

type ConfirmDialogState = {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void | Promise<void>;
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
  title: 'Untitled',
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
  const [authDialogOpen, setAuthDialogOpen] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(268);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(360);
  const [bottomPanel, setBottomPanel] = useState<'results' | 'console'>('results');
  const [saveSqlDialogOpen, setSaveSqlDialogOpen] = useState(false);
  const [saveSqlNameDraft, setSaveSqlNameDraft] = useState('');
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFilePathDraft, setNewFilePathDraft] = useState('scripts/analysis.py');
  const [newDirectoryDialogOpen, setNewDirectoryDialogOpen] = useState(false);
  const [newDirectoryPathDraft, setNewDirectoryPathDraft] = useState('docs/runbooks');
  const [fileContextMenu, setFileContextMenu] =
    useState<{ x: number; y: number; entry: WorkspaceFileEntry } | undefined>();
  const [renameFileDialog, setRenameFileDialog] = useState<{ file: WorkspaceFileEntry; path: string } | undefined>();
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | undefined>();
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
  const terminalPollingRef = useRef(false);
  const ideShellInitializedRef = useRef(false);
  const [activeTerminalId, setActiveTerminalId] = useState('');
  const [splitTerminalId, setSplitTerminalId] = useState('');
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [renameTerminalDialog, setRenameTerminalDialog] = useState<{ id: string; name: string } | undefined>();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
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
    void refreshPlugins();
    void window.dbagent.invoke(ipcChannels.auth.status, undefined).then((response) => {
      if (!response.ok) return;
      if (shouldCloseAuthDialog(response.data)) setAuthDialogOpen(false);
      if (shouldInitializeIdeShell({ authenticated: response.data.authenticated, initialized: ideShellInitializedRef.current })) {
        void ensureIdeShellInitialized();
      }
    });
  }, []);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  useEffect(() => {
    if (!fileContextMenu) return undefined;
    const closeMenu = () => setFileContextMenu(undefined);
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [fileContextMenu]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void pollTerminalOutputs();
    }, 120);
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
        await runPythonScript();
        return;
      case 'core.explainSql':
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
        openSettingsDialog();
        return;
      default:
        await runPluginCommandAction(id);
    }
  }

  async function runPluginCommandAction(id: string) {
    switch (resolvePluginCommandAction(id)) {
      case 'open-settings':
        openSettingsDialog();
        return;
      case 'explain-sql':
        await explain();
        return;
      case 'run-python':
        await runPythonScript();
        return;
      case 'create-venv':
        await createPythonEnvironment('venv', '.venv');
        return;
      case 'detect-python':
        await detectPythonEnvironments();
        return;
      case 'export-csv':
        exportCsv();
        return;
      case 'export-excel':
        exportExcel();
        return;
      case 'export-json':
        exportJson();
        return;
      case 'preview-chart':
        setBottomPanel('results');
        setMessage(t('chartPreviewRegistered'));
        return;
      case 'unbound':
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
  }

  async function ensureIdeShellInitialized() {
    if (ideShellInitializedRef.current) return;
    ideShellInitializedRef.current = true;
    await initializeIdeShell();
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

  async function createTerminal(options: { cwd?: string; name?: string } = {}): Promise<TerminalView | undefined> {
    setBottomPanel(bottomPanelAfterTerminalCreate());
    const response = await window.dbagent.invoke(ipcChannels.terminal.create, {
      ...(options.cwd ? { cwd: options.cwd } : activeWorkspace ? { cwd: activeWorkspace.rootPath } : {}),
      ...(options.name ? { name: options.name } : {}),
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return undefined;
    }
    const terminal = toTerminalView(response.data);
    setTerminals((current) => {
      const next = appendTerminalSession(current, terminal);
      terminalsRef.current = next;
      return next;
    });
    setActiveTerminalId(terminal.id);
    window.setTimeout(() => {
      void pollTerminalOutputs();
    }, 0);
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

  async function openTerminalPanel() {
    setBottomPanel('console');
    if (!terminalsRef.current.length) await createTerminal();
  }

  async function closeTerminal(id: string) {
    const response = await window.dbagent.invoke(ipcChannels.terminal.close, { id });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setTerminals((current) => {
      const next = resolveTerminalCloseState(current, id, activeTerminalId, splitTerminalId);
      terminalsRef.current = next.terminals;
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
    setTerminals((current) => {
      const next = current.map((terminal) => (terminal.id === id ? { ...terminal, output: '', cursor: 0 } : terminal));
      terminalsRef.current = next;
      return next;
    });
  }

  function requestRenameTerminal(id: string) {
    const terminal = terminals.find((item) => item.id === id);
    if (!terminal) return;
    setRenameTerminalDialog({ id, name: terminalTabLabel(terminal) });
  }

  function confirmRenameTerminal() {
    if (!renameTerminalDialog) return;
    const nextName = normalizeTerminalName(renameTerminalDialog.name);
    if (!nextName) {
      setMessage(t('terminalNameRequired'));
      return;
    }
    setTerminals((current) =>
      current.map((terminal) => (terminal.id === renameTerminalDialog.id ? { ...terminal, name: nextName } : terminal)),
    );
    setRenameTerminalDialog(undefined);
    setMessage(`${t('renameTerminal')}: ${nextName}`);
  }

  const writeTerminalData = useCallback(async (id: string, data: string) => {
    const response = await window.dbagent.invoke(ipcChannels.terminal.write, {
      terminalId: id,
      data,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    void pollTerminalOutputs();
  }, []);

  const handleWriteTerminalData = useCallback(
    (id: string, data: string) => {
      void writeTerminalData(id, data);
    },
    [writeTerminalData],
  );

  async function pollTerminalOutputs() {
    if (terminalPollingRef.current) return;
    const snapshot = terminalsRef.current;
    if (!snapshot.length) return;
    terminalPollingRef.current = true;
    try {
      const responses = await Promise.all(
        snapshot.map((terminal) =>
          window.dbagent.invoke(ipcChannels.terminal.read, {
            terminalId: terminal.id,
            cursor: terminal.cursor,
          }),
        ),
      );
      setTerminals((current) => {
        const next = current.map((terminal) => {
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
        });
        terminalsRef.current = next;
        return next;
      });
    } finally {
      terminalPollingRef.current = false;
    }
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
    const pythonExecutable = pythonExecutableForEnvironmentCreation(workspacePythonDraft, mode);
    const response = await window.dbagent.invoke(ipcChannels.python.createEnvironment, {
      rootPath: activeWorkspace.rootPath,
      mode,
      name,
      ...(pythonExecutable ? { pythonExecutable } : {}),
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    setPythonEnvironments((current) => [response.data, ...current.filter((item) => item.id !== response.data.id)]);
    setWorkspacePythonDraft((current) => selectPythonEnvironment(current, response.data));
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
    await createTerminal({ cwd: response.data.rootPath, name: response.data.name });
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
    await createTerminal({ cwd: response.data.rootPath, name: response.data.name });
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

  function removeActiveConnection() {
    if (!activeConnectionId || !activeConnection) return;
    const connectionId = activeConnectionId;
    const connectionName = activeConnection.name;
    setConfirmDialog({
      title: t('deleteConnection'),
      message: t('deleteConnectionConfirm'),
      detail: connectionName,
      confirmLabel: t('delete'),
      tone: 'danger',
      onConfirm: async () => {
        const response = await window.dbagent.invoke(ipcChannels.connection.remove, { id: connectionId });
        if (!response.ok) {
          setMessage(formatAppError(response.error));
          return;
        }
        setActiveConnectionId('');
        setTables([]);
        setSelectedTable(undefined);
        setResult(undefined);
        setConnectionDraft(defaultConnectionDraft);
        setMessage(language === 'zh-CN' ? `已删除 ${connectionName}` : `Deleted ${connectionName}`);
        await refreshConnections();
      },
    });
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
    appendTerminalText(formatPythonRunTranscript(response.data), outputTerminalId);
    setMessage(
      pythonRunSucceeded(response.data)
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
      const next = current.map((terminal) =>
        terminal.id === targetId ? { ...terminal, output: `${terminal.output}${text}` } : terminal,
      );
      terminalsRef.current = next;
      return next;
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
        setConfirmDialog({
          title: t('dangerousSqlTitle'),
          message: response.error.message,
          confirmLabel: t('executeAnyway'),
          tone: 'danger',
          onConfirm: () => executeSql(nextSql, true),
          ...(response.error.detail ? { detail: response.error.detail } : {}),
        });
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

  async function createWorkspaceFile() {
    if (!activeWorkspace) {
      setMessage(t('openProjectFirst'));
      return;
    }
    let relativePath = '';
    try {
      relativePath = normalizeNewWorkspaceFilePath(newFilePathDraft);
    } catch {
      setMessage(t('invalidFilePath'));
      return;
    }
    const content = createWorkspaceFileTemplate(relativePath);
    const response = await window.dbagent.invoke(ipcChannels.workspace.writeFile, {
      rootPath: activeWorkspace.rootPath,
      relativePath,
      content,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    await refreshWorkspaceFiles(activeWorkspace.rootPath);
    updateEditorContent(content, {
      title: response.data.name,
      relativePath: response.data.relativePath,
      language: inferWorkspaceFileLanguage(response.data.relativePath),
    });
    setNewFileDialogOpen(false);
    setMessage(`${t('fileCreated')}: ${response.data.relativePath}`);
  }

  async function createWorkspaceDirectory() {
    if (!activeWorkspace) {
      setMessage(t('openProjectFirst'));
      return;
    }
    let relativePath = '';
    try {
      relativePath = normalizeNewWorkspaceDirectoryPath(newDirectoryPathDraft);
    } catch {
      setMessage(t('invalidDirectoryPath'));
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.workspace.createDirectory, {
      rootPath: activeWorkspace.rootPath,
      relativePath,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    await refreshWorkspaceFiles(activeWorkspace.rootPath);
    setNewDirectoryDialogOpen(false);
    setMessage(`${t('directoryCreated')}: ${response.data.relativePath}`);
  }

  function requestRenameWorkspaceFile(file: WorkspaceFileEntry) {
    setFileContextMenu(undefined);
    setRenameFileDialog({ file, path: file.relativePath });
  }

  async function confirmRenameWorkspaceFile() {
    if (!renameFileDialog) return;
    const file = renameFileDialog.file;
    if (!activeWorkspace || file.type !== 'file') return;
    let relativePath = '';
    try {
      relativePath = normalizeNewWorkspaceFilePath(renameFileDialog.path);
    } catch {
      setMessage(t('invalidFilePath'));
      return;
    }
    if (relativePath === file.relativePath) {
      setRenameFileDialog(undefined);
      return;
    }
    const response = await window.dbagent.invoke(ipcChannels.workspace.renameFile, {
      rootPath: activeWorkspace.rootPath,
      fromRelativePath: file.relativePath,
      toRelativePath: relativePath,
    });
    if (!response.ok) {
      setMessage(formatAppError(response.error));
      return;
    }
    await refreshWorkspaceFiles(activeWorkspace.rootPath);
    if (editorDocument.relativePath === file.relativePath) {
      setEditorDocument((document) => ({
        ...document,
        title: response.data.name,
        relativePath: response.data.relativePath,
        language: inferWorkspaceFileLanguage(response.data.relativePath),
      }));
      setEditorLanguage(inferWorkspaceFileLanguage(response.data.relativePath));
    }
    setRenameFileDialog(undefined);
    setMessage(`${t('renameFile')}: ${response.data.relativePath}`);
  }

  function deleteWorkspaceFile(file: WorkspaceFileEntry) {
    if (!activeWorkspace || file.type !== 'file') return;
    const rootPath = activeWorkspace.rootPath;
    const relativePath = file.relativePath;
    setConfirmDialog({
      title: t('deleteFile'),
      message: t('deleteFileConfirm'),
      detail: relativePath,
      confirmLabel: t('delete'),
      tone: 'danger',
      onConfirm: async () => {
        const response = await window.dbagent.invoke(ipcChannels.workspace.deleteFile, {
          rootPath,
          relativePath,
        });
        if (!response.ok) {
          setMessage(formatAppError(response.error));
          return;
        }
        await refreshWorkspaceFiles(rootPath);
        if (editorDocument.relativePath === relativePath) {
          setSql('');
          setEditorLanguage('plaintext');
          setEditorDocument(defaultEditorDocument);
        }
        setFileContextMenu(undefined);
        setMessage(`${t('delete')}: ${response.data.relativePath}`);
      },
    });
  }

  function deleteWorkspaceDirectory(directory: WorkspaceFileEntry) {
    if (!activeWorkspace || directory.type !== 'directory') return;
    const rootPath = activeWorkspace.rootPath;
    const relativePath = directory.relativePath;
    setConfirmDialog({
      title: t('deleteFolder'),
      message: t('deleteDirectoryConfirm'),
      detail: relativePath,
      confirmLabel: t('delete'),
      tone: 'danger',
      onConfirm: async () => {
        const response = await window.dbagent.invoke(ipcChannels.workspace.deleteDirectory, {
          rootPath,
          relativePath,
        });
        if (!response.ok) {
          setMessage(formatAppError(response.error));
          return;
        }
        await refreshWorkspaceFiles(rootPath);
        setFileContextMenu(undefined);
        setMessage(`${t('delete')}: ${response.data.relativePath}`);
      },
    });
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
    const fileLanguage = inferWorkspaceFileLanguage(response.data.relativePath);
    if (fileLanguage === 'sql') {
      updateEditorContent(stripSqlMetadata(response.data.content), {
        title: response.data.name,
        relativePath: response.data.relativePath,
        language: 'sql',
      });
      setMessage(language === 'zh-CN' ? `已打开 ${response.data.relativePath}` : `Opened ${response.data.relativePath}`);
      return;
    }
    if (fileLanguage === 'python' || fileLanguage === 'markdown') {
      updateEditorContent(response.data.content, {
        title: response.data.name,
        relativePath: response.data.relativePath,
        language: fileLanguage,
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
    setChatMessages([]);
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
              onCreateFile={() => setNewFileDialogOpen(true)}
              onCreateDirectory={() => setNewDirectoryDialogOpen(true)}
              onOpenFile={(file) => void openWorkspaceFile(file)}
              onOpenProject={() => void chooseAndOpenWorkspace()}
              onRefreshFiles={() => {
                if (activeWorkspace) void refreshWorkspaceFiles(activeWorkspace.rootPath);
              }}
              onOpenEntryMenu={(entry, event) => {
                event.preventDefault();
                setFileContextMenu({ x: event.clientX, y: event.clientY, entry });
              }}
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
              onRunPython={() => void runPythonScript()}
              onRenameTerminal={requestRenameTerminal}
              onSelectTerminal={setActiveTerminalId}
              onSplitTerminal={() => void splitTerminal()}
              onToggleTerminalMaximized={() => setTerminalMaximized((maximized) => !maximized)}
              onWriteTerminalData={handleWriteTerminalData}
              onOpenTerminalPanel={() => void openTerminalPanel()}
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
            <AgentPanel
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
      {authDialogOpen ? (
        <AuthStartupDialog
          t={t}
          onAuthenticated={() => {
            setAuthDialogOpen(false);
            void ensureIdeShellInitialized();
          }}
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
      {newFileDialogOpen ? (
        <NewFileDialog
          path={newFilePathDraft}
          setPath={setNewFilePathDraft}
          t={t}
          onClose={() => setNewFileDialogOpen(false)}
          onCreate={() => void createWorkspaceFile()}
        />
      ) : null}
      {newDirectoryDialogOpen ? (
        <NewDirectoryDialog
          path={newDirectoryPathDraft}
          setPath={setNewDirectoryPathDraft}
          t={t}
          onClose={() => setNewDirectoryDialogOpen(false)}
          onCreate={() => void createWorkspaceDirectory()}
        />
      ) : null}
      {renameFileDialog ? (
        <RenameFileDialog
          path={renameFileDialog.path}
          setPath={(path) => setRenameFileDialog((current) => (current ? { ...current, path } : current))}
          t={t}
          onClose={() => setRenameFileDialog(undefined)}
          onRename={() => void confirmRenameWorkspaceFile()}
        />
      ) : null}
      {renameTerminalDialog ? (
        <RenameTerminalDialog
          name={renameTerminalDialog.name}
          setName={(name) => setRenameTerminalDialog((current) => (current ? { ...current, name } : current))}
          t={t}
          onClose={() => setRenameTerminalDialog(undefined)}
          onRename={confirmRenameTerminal}
        />
      ) : null}
      {confirmDialog ? (
        <ConfirmDialog
          dialog={confirmDialog}
          t={t}
          onClose={() => setConfirmDialog(undefined)}
          onConfirm={() => {
            const action = confirmDialog.onConfirm;
            setConfirmDialog(undefined);
            void action();
          }}
        />
      ) : null}
      {fileContextMenu ? (
        <div className="editor-context-menu file-context-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }}>
          {fileContextMenu.entry.type === 'file' ? (
            <>
              <button type="button" onClick={() => void openWorkspaceFile(fileContextMenu.entry)}>
                {t('openFile')}
              </button>
              <button type="button" onClick={() => requestRenameWorkspaceFile(fileContextMenu.entry)}>
                {t('rename')}
              </button>
              <button type="button" onClick={() => void deleteWorkspaceFile(fileContextMenu.entry)}>
                {t('delete')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setNewFilePathDraft(`${fileContextMenu.entry.relativePath}/analysis.py`);
                  setNewFileDialogOpen(true);
                  setFileContextMenu(undefined);
                }}
              >
                {t('newFile')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewDirectoryPathDraft(`${fileContextMenu.entry.relativePath}/new-folder`);
                  setNewDirectoryDialogOpen(true);
                  setFileContextMenu(undefined);
                }}
              >
                {t('newFolder')}
              </button>
              <button type="button" onClick={() => void deleteWorkspaceDirectory(fileContextMenu.entry)}>
                {t('delete')}
              </button>
            </>
          )}
        </div>
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

function NewFileDialog({
  path,
  setPath,
  t,
  onClose,
  onCreate,
}: {
  path: string;
  setPath: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="save-sql-panel" role="dialog" aria-modal="true" aria-label={t('newFile')}>
        <div className="modal-heading">
          <div>
            <strong>{t('newFile')}</strong>
            <small>{t('newFileHint')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        <div className="save-sql-grid single">
          <label>
            <span>{t('filePath')}</span>
            <input
              autoFocus
              placeholder={t('filePathPlaceholder')}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onCreate();
              }}
            />
          </label>
          <p className="field-hint">{t('newFileExamples')}</p>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
          <button className="primary-action" type="button" onClick={onCreate}>
            {t('create')}
          </button>
        </div>
      </section>
    </div>
  );
}

function NewDirectoryDialog({
  path,
  setPath,
  t,
  onClose,
  onCreate,
}: {
  path: string;
  setPath: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="save-sql-panel" role="dialog" aria-modal="true" aria-label={t('newFolder')}>
        <div className="modal-heading">
          <div>
            <strong>{t('newFolder')}</strong>
            <small>{t('newFolderHint')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        <div className="save-sql-grid single">
          <label>
            <span>{t('folderPath')}</span>
            <input
              autoFocus
              placeholder={t('folderPathPlaceholder')}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onCreate();
              }}
            />
          </label>
          <p className="field-hint">{t('newFolderExamples')}</p>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
          <button className="primary-action" type="button" onClick={onCreate}>
            {t('create')}
          </button>
        </div>
      </section>
    </div>
  );
}

function RenameFileDialog({
  path,
  setPath,
  t,
  onClose,
  onRename,
}: {
  path: string;
  setPath: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onRename: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="save-sql-panel" role="dialog" aria-modal="true" aria-label={t('renameFile')}>
        <div className="modal-heading">
          <div>
            <strong>{t('renameFile')}</strong>
            <small>{t('renameFilePrompt')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        <div className="save-sql-grid single">
          <label>
            <span>{t('filePath')}</span>
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRename();
              }}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
          <button className="primary-action" type="button" onClick={onRename}>
            {t('rename')}
          </button>
        </div>
      </section>
    </div>
  );
}

function RenameTerminalDialog({
  name,
  setName,
  t,
  onClose,
  onRename,
}: {
  name: string;
  setName: (value: string) => void;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onRename: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="save-sql-panel" role="dialog" aria-modal="true" aria-label={t('renameTerminal')}>
        <div className="modal-heading">
          <div>
            <strong>{t('renameTerminal')}</strong>
            <small>{t('terminalName')}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        <div className="save-sql-grid single">
          <label>
            <span>{t('terminalName')}</span>
            <input
              autoFocus
              placeholder={t('terminalNamePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRename();
              }}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
          <button className="primary-action" type="button" onClick={onRename}>
            {t('rename')}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConfirmDialog({
  dialog,
  t,
  onClose,
  onConfirm,
}: {
  dialog: ConfirmDialogState;
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className={dialog.tone === 'danger' ? 'save-sql-panel confirm-panel danger' : 'save-sql-panel confirm-panel'}
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
      >
        <div className="modal-heading">
          <div>
            <strong>{dialog.title}</strong>
            <small>{dialog.message}</small>
          </div>
          <button className="secondary" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        {dialog.detail ? <pre className="confirm-detail">{dialog.detail}</pre> : null}
        <div className="modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className={dialog.tone === 'danger' ? 'danger-action' : 'primary-action'} type="button" onClick={onConfirm}>
            {dialog.confirmLabel}
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
                          <option value="light">{t('themeLight')}</option>
                        </select>
                      </label>
                      <label>
                        <span>{t('density')}</span>
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
                          <option value="compact">{t('densityCompact')}</option>
                          <option value="comfortable">{t('densityComfortable')}</option>
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
                        <span>{t('tabSize')}</span>
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
                        <span>{t('wordWrap')}</span>
                      </label>
                      <label className="switch-row">
                        <input
                          checked={ideDraft.editor.minimap}
                          type="checkbox"
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, minimap: event.target.checked } })
                          }
                        />
                        <span>{t('minimap')}</span>
                      </label>
                      <label className="switch-row">
                        <input
                          checked={ideDraft.editor.lineNumbers}
                          type="checkbox"
                          onChange={(event) =>
                            setIdeDraft({ ...ideDraft, editor: { ...ideDraft.editor, lineNumbers: event.target.checked } })
                          }
                        />
                        <span>{t('lineNumbers')}</span>
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
                          placeholder={t('defaultShellPlaceholder')}
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

function AuthStartupDialog({
  t,
  onAuthenticated,
}: {
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onAuthenticated: () => void;
}) {
  return (
    <div className="modal-backdrop auth-backdrop" role="presentation">
      <section className="auth-startup-panel" role="dialog" aria-modal="true" aria-label={t('accountSettings')}>
        <div className="auth-startup-hero">
          <div className="auth-brand-mark">DB</div>
          <div>
            <strong>{t('authWelcomeTitle')}</strong>
            <span>{t('authWelcomeSubtitle')}</span>
          </div>
        </div>
        <AccountSettingsPanel compact t={t} onAuthenticated={onAuthenticated} />
      </section>
    </div>
  );
}

function AccountSettingsPanel({
  compact = false,
  onAuthenticated,
  t,
}: {
  compact?: boolean;
  onAuthenticated?: () => void;
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
  const authModes = useMemo(() => availableAuthModes(status.capabilities), [status.capabilities]);
  const verificationFeaturesAvailable = Boolean(
    status.capabilities?.verificationLogin || status.capabilities?.registration || status.capabilities?.passwordReset,
  );
  const targetInvalid = mode !== 'login' && Boolean(target.trim()) && !isValidAuthTarget(target);
  const codeRequestEnabled = canRequestAuthCode({ mode, target, busy }) && isAuthModeAvailable(mode, status.capabilities);
  const submitEnabled = canSubmitAuthForm({ mode, target, password, code, busy, capabilities: status.capabilities });

  useEffect(() => {
    void window.dbagent.invoke(ipcChannels.auth.status, undefined).then((response) => {
      if (response.ok) {
        setStatus(response.data);
        if (response.data.authenticated) onAuthenticated?.();
      }
    });
  }, [onAuthenticated]);

  useEffect(() => {
    if (!isAuthModeAvailable(mode, status.capabilities)) {
      setMode(authModes[0] ?? 'login');
      setCode('');
      setMessage('');
    }
  }, [authModes, mode, status.capabilities]);

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
        if (response.data.authenticated) onAuthenticated?.();
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
    if (!isAuthModeAvailable(nextMode, status.capabilities)) return;
    setMode(nextMode);
    setCode('');
    setMessage('');
  }

  const submitLabel =
    mode === 'login'
      ? t('passwordLogin')
      : mode === 'code-login'
        ? t('codeLogin')
        : mode === 'register'
          ? t('createAccount')
          : t('resetPasswordAction');
  const formTitle =
    mode === 'login'
      ? t('passwordLogin')
      : mode === 'code-login'
        ? t('codeLogin')
        : mode === 'register'
          ? t('createAccount')
          : t('forgotPassword');

  return (
    <section className={compact ? 'settings-card auth-card compact' : 'settings-card auth-card'}>
      {!compact ? (
        <div className="subform-heading">
          <strong>{t('accountSettings')}</strong>
          <small>{status.authenticated ? status.user?.email || status.user?.phone : t('authDatabaseHint')}</small>
        </div>
      ) : null}
      {compact ? (
        <div className="auth-form-heading">
          <strong>{formTitle}</strong>
          <span>
            {status.capabilities?.testAccount ? t('authTestAccountHint') : mode === 'login' ? t('authPasswordHint') : t('authSecureHint')}
          </span>
        </div>
      ) : null}
      <div className="segmented-control auth-login-tabs">
        {authModes.includes('login') ? (
          <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => changeMode('login')}>
            {t('passwordLogin')}
          </button>
        ) : null}
        {authModes.includes('code-login') ? (
          <button className={mode === 'code-login' ? 'active' : ''} type="button" onClick={() => changeMode('code-login')}>
            {t('codeLogin')}
          </button>
        ) : null}
      </div>
      {verificationFeaturesAvailable ? (
        <div className="auth-mode-links">
          {authModes.includes('register') ? (
            <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => changeMode('register')}>
              {t('register')}
            </button>
          ) : null}
          {authModes.includes('reset-password') ? (
            <button className={mode === 'reset-password' ? 'active' : ''} type="button" onClick={() => changeMode('reset-password')}>
              {t('forgotPassword')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="modal-grid two">
        <label>
          <span>{mode === 'login' ? t('accountIdentifier') : t('emailOrPhone')}</span>
          <input
            autoFocus={compact}
            placeholder={mode === 'login' ? t('accountIdentifierPlaceholder') : t('emailOrPhone')}
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
            <input
              placeholder={mode === 'reset-password' ? t('newPassword') : t('password')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        ) : null}
        {mode !== 'login' ? (
          <label>
            <span>{t('verificationCode')}</span>
            <div className="path-row">
              <input placeholder={t('verificationCode')} value={code} onChange={(event) => setCode(event.target.value)} />
              <button className="secondary" disabled={!codeRequestEnabled} type="button" onClick={() => void requestCode()}>
                {busy ? t('running') : t('sendCode')}
              </button>
            </div>
          </label>
        ) : null}
      </div>
      <div className="auth-form-footer">
        <small>{message || (targetInvalid ? t('authTargetInvalid') : compact ? '' : t('authDatabaseHint'))}</small>
        <div>
          {status.authenticated ? (
            <button className="secondary" disabled={busy} type="button" onClick={() => void logout()}>
              {t('logout')}
            </button>
          ) : null}
          <button className="primary-action" disabled={!submitEnabled} type="button" onClick={() => void submit()}>
            {busy ? t('running') : submitLabel}
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
  const [pathError, setPathError] = useState('');
  const modeEnvironments = useMemo(
    () => pythonEnvironmentsForMode(environments, pythonDraft.mode),
    [environments, pythonDraft.mode],
  );
  const canCreateEnvironment =
    pythonDraft.mode === 'venv' || pythonDraft.mode === 'conda'
      ? canCreatePythonEnvironment(newEnvironmentName, pythonDraft.mode)
      : false;

  useEffect(() => {
    setNewEnvironmentName(pythonDraft.mode === 'conda' ? 'dbagent-analytics' : '.venv');
  }, [pythonDraft.mode]);

  function switchMode(mode: WorkspacePythonConfig['mode']) {
    setPathError('');
    setPythonDraft(switchPythonMode(pythonDraft, mode));
  }

  async function choosePath(mode: 'file' | 'directory') {
    const path = await onChoosePythonPath(mode);
    if (!path) return;
    setPathError('');
    if (pythonDraft.mode === 'venv') {
      const relativePath = toWorkspaceRelativeDirectory(path, workspaceRoot);
      if (!relativePath) {
        setPathError(t('venvMustBeInsideWorkspace'));
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
    setPathError('');
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
          {modeEnvironments.map((environment) => (
            <option disabled={!environment.valid} key={environment.id} value={environment.id}>
              {environment.label} {environment.version ? `(${environment.version})` : ''} {environment.valid ? '' : ` - ${t('invalidEnvironment')}`}
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
                onChange={(event) => {
                  const nextPath = event.target.value;
                  if (!isWorkspaceRelativeDirectoryPath(nextPath)) {
                    setPathError(t('venvMustBeInsideWorkspace'));
                    return;
                  }
                  setPathError('');
                  setPythonDraft({ mode: 'venv', requirementsPath: pythonDraft.requirementsPath, venvPath: nextPath.trim() });
                }}
              />
              <button className="icon-button" type="button" onClick={() => void choosePath('directory')}>
                ...
              </button>
            </div>
            {pathError ? <p className="field-hint danger">{pathError}</p> : null}
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
          <input
            placeholder={pythonDraft.mode === 'conda' ? t('condaEnvironmentNamePlaceholder') : t('venvNamePlaceholder')}
            value={newEnvironmentName}
            onChange={(event) => setNewEnvironmentName(event.target.value)}
          />
          <button
            className="secondary"
            disabled={!canCreateEnvironment}
            type="button"
            onClick={() => {
              if ((pythonDraft.mode === 'venv' || pythonDraft.mode === 'conda') && canCreateEnvironment) {
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
  onCreateDirectory,
  onCreateFile,
  onCreateProject,
  onOpenFile,
  onOpenEntryMenu,
  onOpenProject,
  onRefreshFiles,
}: {
  activeWorkspace: WorkspaceProject | undefined;
  activeFilePath?: string;
  files: WorkspaceFileEntry[];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onCreateDirectory: () => void;
  onCreateFile: () => void;
  onCreateProject: () => void;
  onOpenFile: (file: WorkspaceFileEntry) => void;
  onOpenEntryMenu: (entry: WorkspaceFileEntry, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onOpenProject: () => void;
  onRefreshFiles: () => void;
}) {
  return (
    <section className="project-panel">
      <div className="explorer-heading">
        <div>
          <span>{t('workspaceFiles')}</span>
          <small title={activeWorkspace?.rootPath ?? t('noProject')}>{activeWorkspace?.name ?? t('noProject')}</small>
        </div>
        {activeWorkspace ? (
          <div className="explorer-actions">
            <button className="explorer-action" title={t('newFile')} type="button" onClick={onCreateFile}>
              +
            </button>
            <button className="explorer-action folder" title={t('newFolder')} type="button" onClick={onCreateDirectory}>
              □
            </button>
            <button className="explorer-action refresh" title={t('refreshFiles')} type="button" onClick={onRefreshFiles}>
              ↻
            </button>
          </div>
        ) : null}
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
                  onOpenEntryMenu={onOpenEntryMenu}
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
  onOpenEntryMenu,
}: {
  activeFilePath?: string;
  entry?: WorkspaceFileEntry;
  label?: string;
  onOpenFile?: (file: WorkspaceFileEntry) => void;
  onOpenEntryMenu?: (entry: WorkspaceFileEntry, event: ReactMouseEvent<HTMLButtonElement>) => void;
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
        onContextMenu={(event) => {
          if (entry) onOpenEntryMenu?.(entry, event);
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
              {...(onOpenEntryMenu ? { onOpenEntryMenu } : {})}
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
  onRunPython,
  onSaveSql,
  onRenameTerminal,
  onSelectTerminal,
  onSplitTerminal,
  onToggleTerminalMaximized,
  onWriteTerminalData,
  onOpenTerminalPanel,
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
  onRunPython: () => void;
  onSaveSql: () => void;
  onRenameTerminal: (id: string) => void;
  onSelectTerminal: (id: string) => void;
  onSplitTerminal: () => void;
  onToggleTerminalMaximized: () => void;
  onWriteTerminalData: (id: string, data: string) => void;
  onOpenTerminalPanel: () => void;
  setBottomPanel: (panel: 'results' | 'console') => void;
}) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selectedSql: string } | undefined>();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const isSqlDocument = editorLanguage === 'sql';
  const isPythonDocument = editorLanguage === 'python';
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];
  const terminalActions = buildTerminalActionMenu({ hasActiveTerminal: Boolean(activeTerminal), maximized: terminalMaximized });

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

  useEffect(() => {
    if (bottomPanel !== 'console') setTerminalMenuOpen(false);
  }, [bottomPanel]);

  function getSelectedSql(): string {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!editor || !model || !selection || selection.isEmpty()) return '';
    return model.getValueInRange(selection).trim();
  }

  function openEditorContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!isSqlDocument && !isPythonDocument) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, selectedSql: getSelectedSql() });
  }

  function runSqlText(nextSql: string) {
    setContextMenu(undefined);
    if (!nextSql.trim()) return;
    onExecuteSql(nextSql);
  }

  function runTerminalAction(actionId: TerminalActionId) {
    setTerminalMenuOpen(false);
    if (actionId === 'new') onCreateTerminal();
    if (actionId === 'split') onSplitTerminal();
    if (actionId === 'rename' && activeTerminal) onRenameTerminal(activeTerminal.id);
    if (actionId === 'clear' && activeTerminal) onClearTerminal(activeTerminal.id);
    if (actionId === 'close' && activeTerminal) onCloseTerminal(activeTerminal.id);
    if (actionId === 'toggle-maximize') onToggleTerminalMaximized();
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
        <div className="monaco-shell" onContextMenu={openEditorContextMenu}>
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
              {isSqlDocument ? (
                <>
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
                </>
              ) : null}
              {isPythonDocument ? (
                <button
                  type="button"
                  onClick={() => {
                    setContextMenu(undefined);
                    onRunPython();
                  }}
                >
                  {t('commandRunPython')}
                </button>
              ) : null}
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
            onClick={() => {
              onOpenTerminalPanel();
            }}
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
          <div className="terminal-panel-body">
            <div className="terminal-command-bar">
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
                    <span>{terminalTabLabel(terminal)}</span>
                    <small>
                      {t(terminalStatusLabelKey(terminal))}
                      {terminalStatusValue(terminal) ? ` ${terminalStatusValue(terminal)}` : ''}
                    </small>
                  </button>
                ))}
              </div>
              <div className="terminal-command-actions">
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
                <button
                  className={terminalMenuOpen ? 'terminal-tool active' : 'terminal-tool'}
                  type="button"
                  title={t('moreActions')}
                  onClick={() => setTerminalMenuOpen((open) => !open)}
                >
                  <span className="icon-glyph more" aria-hidden="true" />
                </button>
                {terminalMenuOpen ? (
                  <div className="tool-menu terminal-menu">
                    {terminalActions.map((action) => (
                      <button disabled={!action.enabled} key={action.id} type="button" onClick={() => runTerminalAction(action.id)}>
                        {t(action.labelKey)}
                      </button>
                    ))}
                  </div>
                ) : null}
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
            </div>
            <TerminalPanel
              activeTerminalId={activeTerminalId}
              splitTerminalId={splitTerminalId}
              terminals={terminals}
              terminalSettings={ideSettings.terminal}
              t={t}
              onCreateTerminal={onCreateTerminal}
              onSelectTerminal={onSelectTerminal}
              onWriteTerminalData={onWriteTerminalData}
            />
          </div>
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
  onSelectTerminal,
  onWriteTerminalData,
}: {
  activeTerminalId: string;
  splitTerminalId: string;
  terminals: TerminalView[];
  terminalSettings: IdeSettings['terminal'];
  t: (key: Parameters<ReturnType<typeof createTranslator>>[0]) => string;
  onCreateTerminal: () => void;
  onSelectTerminal: (id: string) => void;
  onWriteTerminalData: (id: string, data: string) => void;
}) {
  const visibleTerminals = selectVisibleTerminals(terminals, activeTerminalId, splitTerminalId);
  return (
    <div className="console-panel">
      {visibleTerminals.length ? (
        <div className={visibleTerminals.length > 1 ? 'terminal-split-grid' : 'terminal-split-grid single'}>
          {visibleTerminals.map((terminal) => (
            <TerminalViewport
              key={terminal.id}
              active={terminal.id === activeTerminalId}
              terminal={terminal}
              terminalSettings={terminalSettings}
              onSelectTerminal={onSelectTerminal}
              onWriteTerminalData={onWriteTerminalData}
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
  active,
  terminal,
  terminalSettings,
  onSelectTerminal,
  onWriteTerminalData,
}: {
  active: boolean;
  terminal: TerminalView;
  terminalSettings: IdeSettings['terminal'];
  onSelectTerminal: (id: string) => void;
  onWriteTerminalData: (id: string, data: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const onWriteTerminalDataRef = useRef(onWriteTerminalData);

  useEffect(() => {
    onWriteTerminalDataRef.current = onWriteTerminalData;
  }, [onWriteTerminalData]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const xterm = new XTerm({
      convertEol: true,
      cursorBlink: terminalSettings.cursorBlink,
      fontFamily: terminalSettings.fontFamily,
      fontSize: terminalSettings.fontSize,
      scrollback: terminalSettings.scrollback,
      theme: {
        background: '#181818',
        foreground: '#cccccc',
        cursor: '#7ee787',
        selectionBackground: '#264f78',
      },
    });
    const fitAddon = new FitAddon();
    terminalRef.current = xterm;
    fitAddonRef.current = fitAddon;
    xterm.loadAddon(fitAddon);
    xterm.open(container);
    const fitTerminal = () => {
      try {
        fitAddon.fit();
        void window.dbagent.invoke(ipcChannels.terminal.resize, {
          terminalId: terminal.id,
          cols: xterm.cols,
          rows: xterm.rows,
        });
      } catch {
        // xterm can throw while the container is temporarily hidden during panel resizing.
      }
    };
    fitTerminal();
    window.requestAnimationFrame(() => {
      fitTerminal();
      if (active) xterm.focus();
    });

    const dataDisposable = xterm.onData((data) => {
      if (shouldForwardTerminalData(data)) onWriteTerminalDataRef.current(terminal.id, data);
    });
    const resize = () => fitTerminal();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      xterm.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      writtenLengthRef.current = 0;
    };
  }, [terminal.id]);

  useEffect(() => {
    const xterm = terminalRef.current;
    if (!xterm) return;
    xterm.options.cursorBlink = terminalSettings.cursorBlink;
    xterm.options.fontFamily = terminalSettings.fontFamily;
    xterm.options.fontSize = terminalSettings.fontSize;
    xterm.options.scrollback = terminalSettings.scrollback;
    try {
      fitAddonRef.current?.fit();
    } catch {
      // Ignore transient fit failures while the panel is collapsed.
    }
  }, [terminalSettings.cursorBlink, terminalSettings.fontFamily, terminalSettings.fontSize, terminalSettings.scrollback]);

  useEffect(() => {
    if (!active) return;
    try {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    } catch {
      // Ignore transient focus/fit failures while the terminal is being mounted or resized.
    }
  }, [active]);

  useEffect(() => {
    const xterm = terminalRef.current;
    if (!xterm) return;
    if (terminal.output.length < writtenLengthRef.current) {
      xterm.clear();
      writtenLengthRef.current = 0;
    }
    const nextChunk = terminal.output.slice(writtenLengthRef.current);
    if (nextChunk) {
      xterm.write(nextChunk);
      writtenLengthRef.current = terminal.output.length;
    }
  }, [terminal.output]);

  return (
    <div
      className={active ? 'terminal-viewport active' : 'terminal-viewport'}
      style={{ fontFamily: terminalSettings.fontFamily, fontSize: terminalSettings.fontSize }}
      tabIndex={0}
      onMouseDown={() => {
        onSelectTerminal(terminal.id);
        terminalRef.current?.focus();
      }}
    >
      <div ref={containerRef} className="terminal-xterm" />
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
    return resolveVisibleResultColumns(result.columns, visibleColumns);
  }, [result.columns, visibleColumns]);
  const filteredRows = useMemo(() => {
    return filterResultRows(result.rows, activeColumns, searchText);
  }, [activeColumns, result.rows, searchText]);

  useEffect(() => {
    setVisibleColumns(result.columns.map((column) => column.name));
    setSearchText('');
    setColumnMenuOpen(false);
  }, [result.queryId, result.columns]);

  function toggleColumn(columnName: string) {
    setVisibleColumns((current) => toggleResultColumnVisibility(current, columnName));
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
                  <td key={column.name}>{formatResultCell(row[column.name])}</td>
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

function AgentPanel({
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
  const toolbarActions = useMemo(() => agentPanelActions(), []);

  function toggleMenu(menu: 'history' | 'settings') {
    setOpenMenu((current) => (current === menu ? undefined : menu));
  }

  function runToolbarAction(actionId: AgentPanelActionId) {
    if (actionId === 'new-conversation') {
      setOpenMenu(undefined);
      onNewConversation();
      return;
    }
    toggleMenu(actionId);
  }

  return (
    <section className="panel agent-panel">
      <div className="agent-titlebar">
        <div className="agent-heading">
          <strong>DBAgent</strong>
        </div>
        <div className="agent-toolbar" aria-label="Agent toolbar">
          {toolbarActions.map((action) => (
            <button
              className={openMenu === action.id ? 'active' : ''}
              key={action.id}
              type="button"
              title={t(action.labelKey)}
              onClick={() => runToolbarAction(action.id)}
            >
              <span className={`icon-glyph ${action.icon}`} aria-hidden="true" />
            </button>
          ))}
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
      enabled: isPluginCommandAvailable(plugin, command.id, {
        editorLanguage,
        hasWorkspace: Boolean(activeWorkspace),
        hasResult: Boolean(result),
        ...(activeConnection ? { activeDatabaseEngine: activeConnection.engine } : {}),
      }),
    }));
  });

  return [...coreCommands, ...pluginCommands].sort((left, right) =>
    `${left.category}:${left.title}`.localeCompare(`${right.category}:${right.title}`),
  );
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
