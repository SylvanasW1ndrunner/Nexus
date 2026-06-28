import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConnectionStore, QueryCancellationRegistry, QueryHistoryStore, createDefaultDatabaseDriverRegistry } from '@dbagent/core-db';
import { AuthDatabaseUnavailableError, AuthService, PostgresAuthRepository, TestAuthRepository } from '@dbagent/core-auth';
import { UsageTracker } from '@dbagent/core-usage';
import { LlmRouter } from '@dbagent/core-llm';
import { ReactAgent, ToolRegistry } from '@dbagent/core-agent';
import { SkillRegistry } from '@dbagent/core-skills';
import {
  ipcChannels,
  err,
  ok,
  type AuthCapabilities,
  type AuthStatus,
  type IpcChannel,
  type IpcRequestMap,
  type IpcResponseMap,
} from '@dbagent/shared';
import { createConnectionWorkflow } from './connection-workflow.js';
import { CredentialVault } from './credential-vault.js';
import { createExplainWorkflow } from './explain-workflow.js';
import { createQueryCancellationWorkflow, createQueryWorkflow } from './query-workflow.js';
import { createSchemaWorkflow } from './schema-workflow.js';
import { IdeSettingsStore } from './ide-settings-store.js';
import { PluginRegistry } from './plugin-registry.js';
import { PythonEnvironmentService } from './python-environment.js';
import { TerminalService } from './terminal-service.js';
import { WorkspaceStateStore } from './workspace-state-store.js';
import { WorkspaceProjectStore } from './workspace-project-store.js';
import { HeadlessAgentService } from './agent-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const userDataDir = app.getPath('userData');
const dataDir = join(userDataDir, 'data');
const credentialPath = join(dataDir, 'credentials.json');
const workspaceStatePath = join(dataDir, 'workspace-state.json');
const workspaceProjectStatePath = join(dataDir, 'workspaces.json');
const pluginStatePath = join(dataDir, 'plugins.json');
const ideSettingsPath = join(dataDir, 'ide-settings.json');
const connectionStore = new ConnectionStore(join(dataDir, 'connections.json'));
const queryHistoryStore = new QueryHistoryStore(join(dataDir, 'query-history.json'));
const credentialVault = new CredentialVault(credentialPath, safeStorage);
const workspaceStateStore = new WorkspaceStateStore(workspaceStatePath);
const workspaceProjectStore = new WorkspaceProjectStore(workspaceProjectStatePath);
const ideSettingsStore = new IdeSettingsStore(ideSettingsPath);
const authRepository = process.env.DBAGENT_AUTH_DATABASE_URL
  ? new PostgresAuthRepository(process.env.DBAGENT_AUTH_DATABASE_URL)
  : new TestAuthRepository();
const authCapabilities: AuthCapabilities = process.env.DBAGENT_AUTH_DATABASE_URL
  ? {
      mode: 'postgres',
      passwordLogin: true,
      verificationLogin: true,
      registration: true,
      passwordReset: true,
      testAccount: false,
    }
  : {
      mode: 'local-test',
      passwordLogin: true,
      verificationLogin: false,
      registration: false,
      passwordReset: false,
      testAccount: true,
    };
const authService = new AuthService(join(dataDir, 'auth-session.json'), authRepository);
const usageTracker = new UsageTracker(join(dataDir, 'usage-history.json'));
const llmRouter = new LlmRouter(usageTracker);
const agentToolRegistry = new ToolRegistry();
const agentSkillRegistry = new SkillRegistry();
const reactAgent = new ReactAgent(llmRouter, agentToolRegistry, usageTracker);
const headlessAgentService = new HeadlessAgentService({
  agent: reactAgent,
  toolRegistry: agentToolRegistry,
  loadSkills: () => agentSkillRegistry.list(),
});
const pythonEnvironmentService = new PythonEnvironmentService();
const terminalService = new TerminalService();
const pluginRegistry = new PluginRegistry(pluginStatePath);
const databaseDrivers = createDefaultDatabaseDriverRegistry();
const queryCancellations = new QueryCancellationRegistry();
const connectionWorkflow = createConnectionWorkflow({
  connections: connectionStore,
  credentials: credentialVault,
  driverForEngine: (engine) => databaseDrivers.get(engine),
});
const executeQuery = createQueryWorkflow({
  connections: connectionStore,
  history: queryHistoryStore,
  usage: usageTracker,
  driverForEngine: (engine) => databaseDrivers.get(engine),
  cancellations: queryCancellations,
});
const cancelQuery = createQueryCancellationWorkflow({
  cancellations: queryCancellations,
  connections: connectionStore,
  driverForEngine: (engine) => databaseDrivers.get(engine),
});
const explainQuery = createExplainWorkflow({ executeQuery });
const schemaWorkflow = createSchemaWorkflow({
  connections: connectionStore,
  driverForEngine: (engine) => databaseDrivers.get(engine),
});

let mainWindow: InstanceType<typeof BrowserWindow> | undefined;

function sendMenuCommand(command: string): void {
  mainWindow?.webContents.send('app:menu-command', command);
}

function withAuthCapabilities(status: AuthStatus): AuthStatus {
  return { ...status, capabilities: authCapabilities };
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '\u6587\u4ef6',
      submenu: [
        { label: '\u65b0\u5efa\u9879\u76ee', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new-project') },
        { label: '\u6253\u5f00\u9879\u76ee...', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open-project') },
        { type: 'separator' },
        { label: '\u4fdd\u5b58\u6587\u4ef6', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand('save-file') },
        { type: 'separator' },
        { label: '\u9000\u51fa', role: 'quit' },
      ],
    },
    {
      label: '\u7f16\u8f91',
      submenu: [
        { label: '\u64a4\u9500', role: 'undo' },
        { label: '\u91cd\u505a', role: 'redo' },
        { type: 'separator' },
        { label: '\u526a\u5207', role: 'cut' },
        { label: '\u590d\u5236', role: 'copy' },
        { label: '\u7c98\u8d34', role: 'paste' },
        { label: '\u5168\u9009', role: 'selectAll' },
      ],
    },
    {
      label: '\u8fd0\u884c',
      submenu: [
        { label: '\u8fd0\u884c\u5f53\u524d SQL', accelerator: 'F5', click: () => sendMenuCommand('run-sql') },
        { label: '\u5206\u6790\u5f53\u524d SQL', accelerator: 'CmdOrCtrl+Enter', click: () => sendMenuCommand('explain-sql') },
        { label: '\u8fd0\u884c\u5f53\u524d Python', accelerator: 'F6', click: () => sendMenuCommand('run-python') },
      ],
    },
    {
      label: '\u89c6\u56fe',
      submenu: [
        { label: '\u547d\u4ee4\u9762\u677f...', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendMenuCommand('command-palette') },
        { type: 'separator' },
        { label: '\u5207\u6362\u5de6\u4fa7\u680f', accelerator: 'CmdOrCtrl+B', click: () => sendMenuCommand('toggle-left-sidebar') },
        { label: '\u5207\u6362 Agent', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendMenuCommand('toggle-right-sidebar') },
        { type: 'separator' },
        { label: '\u95ee\u9898', accelerator: 'CmdOrCtrl+Shift+M', click: () => sendMenuCommand('show-problems') },
        { label: '\u8f93\u51fa', click: () => sendMenuCommand('show-results') },
        { label: '\u7ec8\u7aef', accelerator: 'CmdOrCtrl+`', click: () => sendMenuCommand('show-terminal') },
        { label: '\u7aef\u53e3', click: () => sendMenuCommand('show-ports') },
        { type: 'separator' },
        { label: '\u91cd\u65b0\u52a0\u8f7d', role: 'reload' },
        { label: '\u5f00\u53d1\u8005\u5de5\u5177', role: 'toggleDevTools' },
      ],
    },
    {
      label: '\u8bbe\u7f6e',
      submenu: [{ label: '\u8bbe\u7f6e...', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('project-settings') }],
    },
    {
      label: '\u5e2e\u52a9',
      submenu: [{ label: '\u5173\u4e8e DBAgent', click: () => sendMenuCommand('about') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function logMain(message: string, error?: unknown): void {
  const detail = serializeLogDetail(error);
  appendFileSync(join(userDataDir, 'main.log'), `[${new Date().toISOString()}] ${message} ${detail}\n`, 'utf8');
}

function serializeLogDetail(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value);
}

process.on('uncaughtException', (error) => {
  logMain('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  logMain('unhandledRejection', reason);
});

async function createWindow(): Promise<void> {
  logMain('createWindow:start');
  await mkdir(dataDir, { recursive: true });

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1100,
    minHeight: 720,
    title: 'DBAgent',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadURL(pathToFileURL(join(__dirname, '../renderer/index.html')).toString());
  }
  logMain('createWindow:loaded');
}

function handle<Channel extends IpcChannel>(
  channel: Channel,
  listener: (request: IpcRequestMap[Channel]) => Promise<IpcResponseMap[Channel]>,
): void {
  ipcMain.handle(channel, (_event, request: IpcRequestMap[Channel]) => listener(request));
}

async function safeResult<T>(operation: () => Promise<T>): Promise<ReturnType<typeof ok<T>> | ReturnType<typeof err>> {
  try {
    return ok(await operation());
  } catch (error) {
    if (error instanceof AuthDatabaseUnavailableError) {
      return err({
        code: 'AUTH_DATABASE_UNAVAILABLE',
        message: 'Authentication requires a PostgreSQL account database.',
        detail: error.message,
      });
    }
    return err({
      code: 'VALIDATION_ERROR',
      message: error instanceof Error ? error.message : 'Operation failed.',
    });
  }
}

function registerIpcHandlers(): void {
  handle(ipcChannels.connection.list, async () => connectionWorkflow.list());
  handle(ipcChannels.connection.test, async (input) => connectionWorkflow.test(input));
  handle(ipcChannels.connection.create, async (input) => connectionWorkflow.create(input));
  handle(ipcChannels.connection.update, async ({ id, patch }) => connectionWorkflow.update(id, patch));
  handle(ipcChannels.connection.remove, async ({ id }) => connectionWorkflow.remove(id));
  handle(ipcChannels.connection.connect, async ({ id }) => connectionWorkflow.connect(id));
  handle(ipcChannels.connection.disconnect, async ({ id }) => connectionWorkflow.disconnect(id));

  handle(ipcChannels.db.executeQuery, async (request) => executeQuery(request));
  handle(ipcChannels.db.cancelQuery, async (request) => cancelQuery(request));
  handle(ipcChannels.db.explainQuery, async (request) => explainQuery(request));
  handle(ipcChannels.db.listTables, async ({ connectionId }) => schemaWorkflow.listTables(connectionId));
  handle(ipcChannels.db.describeTable, async ({ connectionId, schema, table }) =>
    schemaWorkflow.describeTable(connectionId, schema, table),
  );
  handle(ipcChannels.db.queryHistory, async (request) => ok(await queryHistoryStore.list(request ?? {})));

  handle(ipcChannels.auth.status, async () => ok(withAuthCapabilities(await authService.status())));
  handle(ipcChannels.auth.login, async (request) =>
    safeResult(async () => withAuthCapabilities(await authService.login(request.identifier, request.password))),
  );
  handle(ipcChannels.auth.register, async (request) => safeResult(async () => withAuthCapabilities(await authService.register(request))));
  handle(ipcChannels.auth.requestCode, async (request) => safeResult(() => authService.requestCode(request)));
  handle(ipcChannels.auth.verifyCodeLogin, async (request) =>
    safeResult(async () => withAuthCapabilities(await authService.verifyCodeLogin(request))),
  );
  handle(ipcChannels.auth.resetPassword, async (request) =>
    safeResult(async () => withAuthCapabilities(await authService.resetPassword(request))),
  );
  handle(ipcChannels.auth.logout, async () => ok(withAuthCapabilities(await authService.logout())));

  handle(ipcChannels.python.detect, async (request) => safeResult(() => pythonEnvironmentService.detect(request)));
  handle(ipcChannels.python.choosePath, async (request) => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: request?.title ?? 'Choose Python path',
      properties: request.mode === 'directory' ? ['openDirectory'] : ['openFile'],
    });
    const path = selection.canceled ? undefined : selection.filePaths[0];
    return ok(path ? { path } : {});
  });
  handle(ipcChannels.python.createEnvironment, async (request) =>
    safeResult(() => pythonEnvironmentService.createEnvironment(request)),
  );
  handle(ipcChannels.python.runScript, async (request) => safeResult(() => pythonEnvironmentService.runScript(request)));

  handle(ipcChannels.terminal.create, (request) => Promise.resolve(ok(terminalService.create(request ?? {}))));
  handle(ipcChannels.terminal.close, ({ id }) => Promise.resolve(ok(terminalService.close(id))));
  handle(ipcChannels.terminal.clear, ({ id }) => Promise.resolve(ok(terminalService.clear(id))));
  handle(ipcChannels.terminal.resize, (request) => Promise.resolve(ok(terminalService.resize(request))));
  handle(ipcChannels.terminal.write, (request) => Promise.resolve(ok(terminalService.write(request))));
  handle(ipcChannels.terminal.read, (request) => Promise.resolve(ok(terminalService.read(request))));
  handle(ipcChannels.terminal.run, async (request) => safeResult(() => terminalService.run(request)));
  handle(ipcChannels.terminal.list, () => Promise.resolve(ok(terminalService.list())));

  handle(ipcChannels.plugin.list, async () => safeResult(() => pluginRegistry.list()));
  handle(ipcChannels.plugin.install, async ({ id }) => safeResult(() => pluginRegistry.install(id)));
  handle(ipcChannels.plugin.uninstall, async ({ id }) => safeResult(() => pluginRegistry.uninstall(id)));
  handle(ipcChannels.plugin.enable, async ({ id }) => safeResult(() => pluginRegistry.enable(id)));
  handle(ipcChannels.plugin.disable, async ({ id }) => safeResult(() => pluginRegistry.disable(id)));

  handle(ipcChannels.skills.match, async (request) => safeResult(() => headlessAgentService.matchSkills(request)));
  handle(ipcChannels.agent.toolPolicyPreview, (request) =>
    safeResult(() => Promise.resolve(headlessAgentService.previewToolPolicy(request ?? {}))),
  );
  handle(ipcChannels.agent.run, async (request) => safeResult(() => headlessAgentService.run(request)));
  handle(ipcChannels.agent.abort, (request) => safeResult(() => Promise.resolve(headlessAgentService.abort(request))));

  handle(ipcChannels.usage.currentQuota, async () => ok(await usageTracker.current()));
  handle(ipcChannels.usage.history, async (request) => ok(await usageTracker.history(request?.limit)));

  handle(ipcChannels.app.loadWorkspaceState, async () => ok(await workspaceStateStore.load()));
  handle(ipcChannels.app.saveWorkspaceState, async (state) => {
    return ok(await workspaceStateStore.save(state));
  });
  handle(ipcChannels.app.loadIdeSettings, async () => {
    const settings = await ideSettingsStore.load();
    terminalService.configure({
      defaultShell: settings.terminal.defaultShell,
      maxOutputChars: terminalScrollbackToChars(settings.terminal.scrollback),
    });
    return ok(settings);
  });
  handle(ipcChannels.app.saveIdeSettings, async (patch) => {
    const settings = await ideSettingsStore.save(patch);
    terminalService.configure({
      defaultShell: settings.terminal.defaultShell,
      maxOutputChars: terminalScrollbackToChars(settings.terminal.scrollback),
    });
    return ok(settings);
  });

  handle(ipcChannels.workspace.chooseDirectory, async (request) => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: request?.title ?? 'Choose DBAgent workspace folder',
      buttonLabel: request?.buttonLabel ?? 'Choose folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = selection.canceled ? undefined : selection.filePaths[0];
    return ok(path ? { path } : {});
  });
  handle(ipcChannels.workspace.create, async (request) => {
    try {
      return ok(await workspaceProjectStore.create(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: error instanceof Error ? error.message : 'Unable to create workspace.',
      });
    }
  });
  handle(ipcChannels.workspace.open, async ({ rootPath }) => {
    try {
      return ok(await workspaceProjectStore.open(rootPath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to open this workspace.',
        ...(detail ? { detail } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.listRecent, async () => ok(await workspaceProjectStore.listRecent()));
  handle(ipcChannels.workspace.loadActive, async () => ok(await workspaceProjectStore.loadActive()));
  handle(ipcChannels.workspace.listFiles, async ({ rootPath }) => {
    try {
      return ok(await workspaceProjectStore.listFiles(rootPath));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to list workspace files.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.readFile, async (request) => {
    try {
      return ok(await workspaceProjectStore.readFile(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to read workspace file.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.writeFile, async (request) => {
    try {
      return ok(await workspaceProjectStore.writeFile(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to write workspace file.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.createDirectory, async (request) => {
    try {
      return ok(await workspaceProjectStore.createDirectory(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to create workspace directory.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.renameFile, async (request) => {
    try {
      return ok(await workspaceProjectStore.renameFile(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to rename workspace file.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.deleteFile, async (request) => {
    try {
      return ok(await workspaceProjectStore.deleteFile(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to delete workspace file.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.deleteDirectory, async (request) => {
    try {
      return ok(await workspaceProjectStore.deleteDirectory(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to delete workspace directory.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.saveSqlFile, async (request) => {
    try {
      return ok(await workspaceProjectStore.saveSqlFile(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to save SQL file.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
  handle(ipcChannels.workspace.updateSettings, async (request) => {
    try {
      return ok(await workspaceProjectStore.updateSettings(request));
    } catch (error) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Unable to update workspace settings.',
        ...(error instanceof Error ? { detail: error.message } : {}),
      });
    }
  });
}

function terminalScrollbackToChars(scrollback: number): number {
  return Math.max(1, Math.floor(scrollback)) * 200;
}

void app.whenReady().then(() => {
  logMain('app:ready');
  installApplicationMenu();
  registerIpcHandlers();
  void llmRouter;
  void createWindow().catch((error) => {
    logMain('createWindow:error', error);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
