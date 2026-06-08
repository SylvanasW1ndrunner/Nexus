import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConnectionStore, PostgresDriver, QueryHistoryStore, analyzeSqlSafety } from '@dbagent/core-db';
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
  type QueryRequest,
  type WorkspaceState,
} from '@dbagent/shared';
import { validateConnectionInput } from './connection-validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const userDataDir = app.getPath('userData');
const dataDir = join(userDataDir, 'data');
const credentialPath = join(dataDir, 'credentials.json');
const workspaceStatePath = join(dataDir, 'workspace-state.json');
const connectionStore = new ConnectionStore(join(dataDir, 'connections.json'));
const queryHistoryStore = new QueryHistoryStore(join(dataDir, 'query-history.json'));
const authService = new AuthService(join(dataDir, 'auth-session.json'));
const usageTracker = new UsageTracker(join(dataDir, 'usage-history.json'));
const llmRouter = new LlmRouter(usageTracker);
const postgres = new PostgresDriver();

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
    const config = toDbConfig(input);
    const result = await postgres.test(config);
    return result.ok ? ok({ success: true, latencyMs: result.data.latencyMs }) : result;
  });

  handle(ipcChannels.connection.create, async (input) => {
    const validation = validateConnectionInput(input);
    if (validation) return err(validation);
    const connection = await connectionStore.create(input);
    if (input.password) await savePassword(connection.id, input.password);
    return ok(connection);
  });

  handle(ipcChannels.connection.update, async ({ id, patch }) => {
    const updated = await connectionStore.update(id, patch);
    if (patch.password) await savePassword(id, patch.password);
    if (!updated) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
    await postgres.disconnect(id);
    const disconnected = await connectionStore.markStatus(id, 'disconnected');
    return ok(disconnected ?? updated);
  });

  handle(ipcChannels.connection.remove, async ({ id }) => {
    await postgres.disconnect(id);
    const removed = await connectionStore.remove(id);
    if (removed) await removePassword(id);
    return removed ? ok({ id }) : err({ code: 'NOT_FOUND', message: 'Connection not found.' });
  });

  handle(ipcChannels.connection.connect, async ({ id }) => {
    const connection = (await connectionStore.list()).find((item) => item.id === id);
    if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
    const password = await loadPassword(connection.id);
    const config = {
      ...connection,
      maxClients: 5,
    };
    if (password !== undefined) {
      Object.assign(config, { password });
    }
    const result = await postgres.connect(config);
    if (!result.ok) {
      await connectionStore.markStatus(id, 'error');
      return result;
    }
    const updated = await connectionStore.markStatus(id, 'connected');
    return ok(updated ?? result.data);
  });

  handle(ipcChannels.connection.disconnect, async ({ id }) => {
    await postgres.disconnect(id);
    const updated = await connectionStore.markStatus(id, 'disconnected');
    return updated ? ok(updated) : err({ code: 'NOT_FOUND', message: 'Connection not found.' });
  });

  handle(ipcChannels.db.executeQuery, async (request) => executeQuery(request));
  handle(ipcChannels.db.explainQuery, async (request) =>
    executeQuery({ ...request, sql: `EXPLAIN (FORMAT JSON) ${request.sql}` }),
  );
  handle(ipcChannels.db.listTables, async ({ connectionId }) => postgres.listTables(connectionId));
  handle(ipcChannels.db.describeTable, async ({ connectionId, schema, table }) =>
    postgres.describeTable(connectionId, schema, table),
  );
  handle(ipcChannels.db.queryHistory, async (request) => ok(await queryHistoryStore.list(request ?? {})));

  handle(ipcChannels.auth.status, async () => ok(await authService.status()));
  handle(ipcChannels.auth.login, async (request) => ok(await authService.login(request.email)));
  handle(ipcChannels.auth.logout, async () => ok(await authService.logout()));

  handle(ipcChannels.usage.currentQuota, async () => ok(await usageTracker.current()));
  handle(ipcChannels.usage.history, async (request) => ok(await usageTracker.history(request?.limit)));

  handle(ipcChannels.app.loadWorkspaceState, async () => ok(await loadWorkspaceState()));
  handle(ipcChannels.app.saveWorkspaceState, async (state) => {
    const saved = { ...state, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(workspaceStatePath, saved);
    return ok(saved);
  });
}

async function executeQuery(request: QueryRequest): Promise<IpcResponseMap['db:execute-query']> {
  const connection = (await connectionStore.list()).find((item) => item.id === request.connectionId);
  if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

  const safety = analyzeSqlSafety(request.sql, { readOnly: connection.readOnly });
  if (safety.blocked) {
    await queryHistoryStore.append({
      connectionId: request.connectionId,
      sql: request.sql,
      status: 'blocked',
      safety,
      errorMessage: safety.reasons.join(' '),
    });
    return err({
      code: 'READ_ONLY_VIOLATION',
      message: 'This query is blocked by read-only mode.',
      detail: safety.reasons.join(' '),
    });
  }

  const result = await postgres.execute(request, connection);
  if (result.ok) {
    await usageTracker.recordLocalQuery();
    await queryHistoryStore.append({
      connectionId: request.connectionId,
      sql: request.sql,
      status: 'success',
      rowCount: result.data.rowCount,
      elapsedMs: result.data.elapsedMs,
      safety: result.data.safety,
    });
  } else {
    await queryHistoryStore.append({
      connectionId: request.connectionId,
      sql: request.sql,
      status: 'failed',
      safety,
      errorMessage: result.error.message,
    });
  }
  return result;
}

function toDbConfig(input: ConnectionInput) {
  return {
    ...input,
    readOnly: input.readOnly ?? true,
    maxClients: 5,
  };
}

async function savePassword(connectionId: string, password: string): Promise<void> {
  const credentials = await loadCredentials();
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(password).toString('base64')
    : Buffer.from(password, 'utf8').toString('base64');
  credentials[connectionId] = {
    encrypted,
    safeStorage: safeStorage.isEncryptionAvailable(),
  };
  await writeFile(credentialPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
}

async function loadPassword(connectionId: string): Promise<string | undefined> {
  const credentials = await loadCredentials();
  const credential = credentials[connectionId];
  if (!credential) return undefined;
  const buffer = Buffer.from(credential.encrypted, 'base64');
  return credential.safeStorage ? safeStorage.decryptString(buffer) : buffer.toString('utf8');
}

async function removePassword(connectionId: string): Promise<void> {
  const credentials = await loadCredentials();
  if (!(connectionId in credentials)) return;
  delete credentials[connectionId];
  await writeFile(credentialPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
}

async function loadCredentials(): Promise<Record<string, { encrypted: string; safeStorage: boolean }>> {
  try {
    return JSON.parse(await readFile(credentialPath, 'utf8')) as Record<
      string,
      { encrypted: string; safeStorage: boolean }
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function loadWorkspaceState(): Promise<WorkspaceState | undefined> {
  try {
    const state = JSON.parse(await readFile(workspaceStatePath, 'utf8')) as Partial<WorkspaceState>;
    if (typeof state.sqlDraft !== 'string' || typeof state.updatedAt !== 'string') return undefined;
    const restored: WorkspaceState = {
      sqlDraft: state.sqlDraft,
      updatedAt: state.updatedAt,
    };
    if (typeof state.activeConnectionId === 'string') restored.activeConnectionId = state.activeConnectionId;
    return restored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
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
