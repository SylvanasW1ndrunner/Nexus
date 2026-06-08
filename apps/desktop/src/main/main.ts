import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConnectionStore, QueryHistoryStore, createDefaultDatabaseDriverRegistry } from '@dbagent/core-db';
import { AuthService } from '@dbagent/core-auth';
import { UsageTracker } from '@dbagent/core-usage';
import { LlmRouter } from '@dbagent/core-llm';
import {
  ipcChannels,
  err,
  ok,
  type IpcChannel,
  type IpcRequestMap,
  type IpcResponseMap,
} from '@dbagent/shared';
import { createConnectionWorkflow } from './connection-workflow.js';
import { CredentialVault } from './credential-vault.js';
import { createExplainWorkflow } from './explain-workflow.js';
import { createQueryWorkflow } from './query-workflow.js';
import { createSchemaWorkflow } from './schema-workflow.js';
import { WorkspaceStateStore } from './workspace-state-store.js';
import { WorkspaceProjectStore } from './workspace-project-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const userDataDir = app.getPath('userData');
const dataDir = join(userDataDir, 'data');
const credentialPath = join(dataDir, 'credentials.json');
const workspaceStatePath = join(dataDir, 'workspace-state.json');
const workspaceProjectStatePath = join(dataDir, 'workspaces.json');
const connectionStore = new ConnectionStore(join(dataDir, 'connections.json'));
const queryHistoryStore = new QueryHistoryStore(join(dataDir, 'query-history.json'));
const credentialVault = new CredentialVault(credentialPath, safeStorage);
const workspaceStateStore = new WorkspaceStateStore(workspaceStatePath);
const workspaceProjectStore = new WorkspaceProjectStore(workspaceProjectStatePath);
const authService = new AuthService(join(dataDir, 'auth-session.json'));
const usageTracker = new UsageTracker(join(dataDir, 'usage-history.json'));
const llmRouter = new LlmRouter(usageTracker);
const databaseDrivers = createDefaultDatabaseDriverRegistry();
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

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new-project') },
        { label: '打开项目...', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open-project') },
        { type: 'separator' },
        { label: '保存文件', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand('save-file') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '运行',
      submenu: [
        { label: '运行当前 SQL', accelerator: 'F5', click: () => sendMenuCommand('run-sql') },
        { label: '分析当前 SQL', accelerator: 'CmdOrCtrl+Enter', click: () => sendMenuCommand('explain-sql') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换左侧栏', accelerator: 'CmdOrCtrl+B', click: () => sendMenuCommand('toggle-left-sidebar') },
        { label: '切换 Agent', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendMenuCommand('toggle-right-sidebar') },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '设置',
      submenu: [
        { label: '项目设置...', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('project-settings') },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 DBAgent', click: () => sendMenuCommand('about') }],
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

function registerIpcHandlers(): void {
  handle(ipcChannels.connection.list, async () => connectionWorkflow.list());
  handle(ipcChannels.connection.test, async (input) => connectionWorkflow.test(input));
  handle(ipcChannels.connection.create, async (input) => connectionWorkflow.create(input));
  handle(ipcChannels.connection.update, async ({ id, patch }) => connectionWorkflow.update(id, patch));
  handle(ipcChannels.connection.remove, async ({ id }) => connectionWorkflow.remove(id));
  handle(ipcChannels.connection.connect, async ({ id }) => connectionWorkflow.connect(id));
  handle(ipcChannels.connection.disconnect, async ({ id }) => connectionWorkflow.disconnect(id));

  handle(ipcChannels.db.executeQuery, async (request) => executeQuery(request));
  handle(ipcChannels.db.explainQuery, async (request) => explainQuery(request));
  handle(ipcChannels.db.listTables, async ({ connectionId }) => schemaWorkflow.listTables(connectionId));
  handle(ipcChannels.db.describeTable, async ({ connectionId, schema, table }) =>
    schemaWorkflow.describeTable(connectionId, schema, table),
  );
  handle(ipcChannels.db.queryHistory, async (request) => ok(await queryHistoryStore.list(request ?? {})));

  handle(ipcChannels.auth.status, async () => ok(await authService.status()));
  handle(ipcChannels.auth.login, async (request) => ok(await authService.login(request.email)));
  handle(ipcChannels.auth.logout, async () => ok(await authService.logout()));

  handle(ipcChannels.usage.currentQuota, async () => ok(await usageTracker.current()));
  handle(ipcChannels.usage.history, async (request) => ok(await usageTracker.history(request?.limit)));

  handle(ipcChannels.app.loadWorkspaceState, async () => ok(await workspaceStateStore.load()));
  handle(ipcChannels.app.saveWorkspaceState, async (state) => {
    return ok(await workspaceStateStore.save(state));
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
