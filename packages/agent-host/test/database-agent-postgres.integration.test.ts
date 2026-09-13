import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmChatResponse, LlmProvider } from '@dbagent/core-llm';
import { SqliteAgentJournal } from '@dbagent/core-agent';
import { createEnvironmentConnectionProvider } from '@dbagent/database-capability';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundledAgentRuntime } from '../src/bundled-agent-runtime.js';
import { GlobalConfigStore } from '../src/global-config.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';
import { testLlmRuntimeOptions } from './llm-test-fixture.js';

const databaseUrl = process.env.SCHEMANAUT_TEST_POSTGRES_URL;
const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!databaseUrl)('Database Capability through the deterministic Agent and real PostgreSQL', () => {
  it('discovers, activates, queries, and retains a long result through the generic Agent path', async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-database-agent-'));
    temporaryDirectories.push(projectDirectory);
    const stateDatabasePath = join(projectDirectory, '.state', 'agent.db');
    const configPath = join(projectDirectory, '.global-config.toml');
    await mkdir(join(projectDirectory, '.state'), { recursive: true });
    await writeFile(configPath, 'version = 1\n\n[agent]\npermission_mode = "full-access"\n', 'utf8');
    const tableName = `agent_database_${randomUUID().replaceAll('-', '')}`;
    const client = new (postgresClientConstructor())({ connectionString: databaseUrl! });
    await client.connect();
    await client.query(`CREATE TABLE ${tableName} (id integer PRIMARY KEY, payload text NOT NULL)`);
    await client.query(
      `INSERT INTO ${tableName} (id, payload) SELECT value, repeat('x', 2048) FROM generate_series(1, 300) AS value`,
    );

    const provider = new DatabaseScenarioProvider(tableName);
    const runtime = createBundledAgentRuntime({
      projectDirectory,
      stateDatabasePath,
      ...testLlmRuntimeOptions(provider),
      globalConfigStore: new GlobalConfigStore({ path: configPath }),
    }, {
      database: {
        connectionProvider: createEnvironmentConnectionProvider({ DATABASE_URL: databaseUrl }),
      },
    });
    let result;
    try {
      await runtime.ready();
      const handle = await runtime.startAgentRun({
        message: `deterministic real PostgreSQL query for ${tableName}`,
        sessionId: 'deterministic-real-postgres',
        clientRequestId: 'deterministic-real-postgres',
      });
      result = await resultWithin(handle, 30_000);
      const services = requireAgentRuntimeHostServices(runtime);
      const journal = new SqliteAgentJournal({ filePath: stateDatabasePath });
      const events = await journal.readRunEvents({
        projectId: services.project.projectId,
        sessionId: result.sessionId,
        runId: result.runId,
        afterSequence: 0,
        limit: 1_000,
      });
      const invocations = await journal.listInvocations(result.runId);
      const diagnostic = JSON.stringify({
        result: { status: result.status, error: result.error },
        invocations: invocations.map(invocation => ({
          name: invocation.name,
          state: invocation.state,
          terminal: invocation.terminal?.kind,
          summary: invocation.terminal?.summary,
          error: invocation.terminal?.error,
          observation: invocation.observation,
        })),
      }, null, 2);
      expect(result.status, diagnostic).toBe('completed');
      expect(invocations.map(invocation => invocation.name), diagnostic).toContain('sql_execute');
      const sql = invocations.find(invocation => invocation.name === 'sql_execute');
      expect(sql?.terminal?.kind, diagnostic).toBe('succeeded');
      const handles = events.events.flatMap(event =>
        event.type === 'artifact.created' && event.payload.availability === 'available'
          ? [event.payload.handle]
          : [],
      );
      expect(handles.length, diagnostic).toBeGreaterThan(0);
      expect(sql?.terminal?.resultRefs, diagnostic).toEqual(expect.arrayContaining(handles));
      expect(sql?.terminal?.evidenceRefs.length, diagnostic).toBeGreaterThan(0);
      expect(result.evidenceRefs, diagnostic).toEqual(
        expect.arrayContaining(sql?.terminal?.evidenceRefs ?? []),
      );
    } finally {
      await runtime.close();
      try {
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
      } finally {
        await client.end();
      }
    }
  }, 60_000);
});

class DatabaseScenarioProvider implements LlmProvider {
  readonly id = 'deterministic-real-postgres-provider';
  readonly name = 'Deterministic real PostgreSQL provider';
  readonly mode = 'byok' as const;
  readonly capabilities = { chat: 'supported' as const, toolCalling: 'supported' as const };
  private call = 0;

  constructor(private readonly tableName: string) {}

  chat(): Promise<LlmChatResponse> {
    const steps = [
      { name: 'tool_search', arguments: { query: 'Database' } },
      { name: 'tool_search', arguments: { select: [{ name: 'database.query' }] } },
      { name: 'tool_search', arguments: { select: [{ name: 'sql_execute' }] } },
      {
        name: 'sql_execute',
        arguments: {
          sql: `SELECT id, payload FROM ${this.tableName} ORDER BY id`,
          maxRows: 300,
        },
      },
    ] as const;
    const step = steps[this.call++];
    return Promise.resolve(step === undefined
      ? { text: 'The query returned 300 rows.', toolCalls: [] }
      : {
          text: '',
          toolCalls: [{
            id: `deterministic-postgres-${this.call}`,
            name: step.name,
            arguments: step.arguments,
          }],
        });
  }

  isAvailable() {
    return Promise.resolve({ available: true as const });
  }
}

async function resultWithin(
  handle: Awaited<ReturnType<ReturnType<typeof createBundledAgentRuntime>['startAgentRun']>>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void handle.cancel(`Deterministic PostgreSQL Agent scenario exceeded ${timeoutMs}ms.`)
            .then(() => handle.result())
            .then(result => reject(new Error(`Agent timed out with status ${result.status}.`)))
            .catch(reject);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type PostgresQueryResult = Readonly<{ rows: readonly Record<string, unknown>[] }>;
type PostgresClient = Readonly<{
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string): Promise<PostgresQueryResult>;
}>;
type PostgresClientConstructor = new (input: { connectionString: string }) => PostgresClient;

function postgresClientConstructor(): PostgresClientConstructor {
  const module = require('pg') as { Client?: PostgresClientConstructor };
  if (module.Client === undefined) throw new Error('The pg Client constructor is unavailable.');
  return module.Client;
}
