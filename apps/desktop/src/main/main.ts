import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConnectionStore, QueryHistoryStore, createDefaultDatabaseDriverRegistry } from '@dbagent/core-db';
import { AuthService } from '@dbagent/core-auth';
import { UsageTracker } from '@dbagent/core-usage';
import { LlmRouter } from '@dbagent/core-llm';
import {
  err,
  ipcChannels,
  ok,
  type ConnectionInput,
  type IpcChannel,
  type IpcRequestMap,
  type IpcResponseMap,
} from '@dbagent/shared';
import { validateConnectionInput } from './connection-validation.js';
import { CredentialVault } from './credential-vault.js';
import { createQueryWorkflow } from './query-workflow.js';
import { createSchemaWorkflow } from './schema-workflow.js';
import { WorkspaceStateStore } from './workspace-state-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const userDataDir = app.getPath('userData');
const dataDir = join(userDataDir, 'data');
const credentialPath = join(dataDir, 'credentials.json');
const workspaceStatePath = join(dataDir, 'workspace-state.json');
const connectionStore = new ConnectionStore(join(dataDir, 'connections.json'));
const queryHistoryStore = new QueryHistoryStore(join(dataDir, 'query-history.json'));
const credentialVault = new CredentialVault(credentialPath, safeStorage);
const workspaceStateStore = new WorkspaceStateStore(workspaceStatePath);
const authService = new AuthService(join(dataDir, 'auth-session.json'));
const usageTracker = new UsageTracker(join(dataDir, 'usage-history.json'));
const llmRouter = new LlmRouter(usageTracker);
const databaseDrivers = createDefaultDatabaseDriverRegistry();
const executeQuery = createQueryWorkflow({
  connections: connectionStore,
  history: queryHistoryStore,
  usage: usageTracker,
  driverForEngine: (engine) => databaseDrivers.get(engine),
});
const schemaWorkflow = createSchemaWorkflow({
  connections: connectionStore,
  driverForEngine: (engine) => databaseDrivers.get(engine),
});

let mainWindow: InstanceType<typeof BrowserWindow> | undefined;

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
  handle(ipcChannels.connection.list, async () => ok(await connectionStore.list()));

  handle(ipcChannels.connection.test, async (input) => {
    const validation = validateConnectionInput(input);
    if (validation) return err(validation);
    const config = toDbConfig(input);
    const result = await databaseDrivers.get(input.engine).test(config);
    return result.ok ? ok({ success: true, latencyMs: result.data.latencyMs }) : result;
  });

  handle(ipcChannels.connection.create, async (input) => {
    const validation = validateConnectionInput(input);
    if (validation) return err(validation);
    const connection = await connectionStore.create(input);
    if (input.password) await credentialVault.save(connection.id, input.password);
    return ok(connection);
  });

  handle(ipcChannels.connection.update, async ({ id, patch }) => {
    const updated = await connectionStore.update(id, patch);
    if (patch.password) await credentialVault.save(id, patch.password);
    if (!updated) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
    await databaseDrivers.get(updated.engine).disconnect(id);
    const disconnected = await connectionStore.markStatus(id, 'disconnected');
    return ok(disconnected ?? updated);
  });

  handle(ipcChannels.connection.remove, async ({ id }) => {
    const existing = (await connectionStore.list()).find((item) => item.id === id);
    if (existing) await databaseDrivers.get(existing.engine).disconnect(id);
    const removed = await connectionStore.remove(id);
    if (removed) await credentialVault.remove(id);
    return removed ? ok({ id }) : err({ code: 'NOT_FOUND', message: 'Connection not found.' });
  });

  handle(ipcChannels.connection.connect, async ({ id }) => {
    const connection = (await connectionStore.list()).find((item) => item.id === id);
    if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
    const password = await credentialVault.load(connection.id);
    const config = {
      ...connection,
      maxClients: 5,
    };
    if (password !== undefined) {
      Object.assign(config, { password });
    }
    const result = await databaseDrivers.get(connection.engine).connect(config);
    if (!result.ok) {
      await connectionStore.markStatus(id, 'error');
      return result;
    }
    const updated = await connectionStore.markStatus(id, 'connected');
    return ok(updated ?? result.data);
  });

  handle(ipcChannels.connection.disconnect, async ({ id }) => {
    const connection = (await connectionStore.list()).find((item) => item.id === id);
    if (connection) await databaseDrivers.get(connection.engine).disconnect(id);
    const updated = await connectionStore.markStatus(id, 'disconnected');
    return updated ? ok(updated) : err({ code: 'NOT_FOUND', message: 'Connection not found.' });
  });

  handle(ipcChannels.db.executeQuery, async (request) => executeQuery(request));
  handle(ipcChannels.db.explainQuery, async (request) =>
    executeQuery({ ...request, sql: `EXPLAIN (FORMAT JSON) ${request.sql}` }),
  );
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
}

function toDbConfig(input: ConnectionInput) {
  return {
    ...input,
    readOnly: input.readOnly ?? true,
    maxClients: 5,
  };
}

void app.whenReady().then(() => {
  logMain('app:ready');
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
