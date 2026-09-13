import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { LlmChatRequest, LlmChatResponse, LlmProvider } from '@dbagent/core-llm';
import { SqliteAgentJournal } from '@dbagent/core-agent';
import { ConnectorRegistry, DATABASE_CAPABILITIES, DatabaseAccessRuntime, type DatabaseConnector } from '@dbagent/core-db';
import type { BrowserPageRef, BrowserSessionPort } from '@dbagent/first-party-capabilities';
import { createForgeCapability } from '@dbagent/first-party-capabilities';
import { PathExecutableDiscovery, type ExecutableDiscoveryResult } from '@dbagent/core-tools';
import type { ConnectionCandidate, ExternalConnectionProvider, EphemeralConnectionBinding } from '@dbagent/database-capability';
import type { CapabilityProfile, DatabaseCredential, QueryJob } from '@dbagent/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundledAgentRuntime } from '../src/bundled-agent-runtime.js';
import { requireAgentRuntimeHostServices } from '../src/internal/agent-runtime-host-services.js';
import { testLlmRuntimeOptions } from './llm-test-fixture.js';

const execFileAsync = promisify(execFile);
const scenarioIds = [
  'base.workspace-process-repair', 'cap.deferred-search-load', 'cap.git-workflow',
  'cap.database-missing-and-query', 'cap.forge-provider-choice', 'cap.container-risk-gate',
  'cap.browser-artifact', 'cap.language-diagnostics-format', 'cap.documents-extract-convert',
  'cap.data-notebook-profile-run', 'cap.cancel-recover', 'cap.large-result-retention',
] as const;
type ScenarioId = typeof scenarioIds[number];
type AcceptanceScenario = { id: string };
type AcceptanceReport = {
  aggregate: { totalCount: number; passCount: number; failCount: number; notRunCount: number; releaseEligible: boolean };
  scenarios: Array<{ id: string; status: string; reasonCode: string; failure?: unknown }>;
};
type AcceptanceRunnerModule = {
  runUnifiedAgentAcceptance(input: { scenarios: AcceptanceScenario[]; reportDirectory: string; runId: string }): Promise<AcceptanceReport>;
};
type AcceptanceScenarioModule = {
  createAcceptanceScenarios(input: { adapter: ScenarioHarness }): Promise<AcceptanceScenario[]>;
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

/**
 * This is intentionally one end-to-end Host scenario matrix: model calls go
 * through the real Journal, permission manager, workspace identity checks and
 * ProcessRuntime. Only unavailable external systems are substituted by the
 * explicit Host test ports below.
 */
describe('unified deterministic Agent acceptance entrypoint', () => {
  it('runs the twelve scenario-specific capability paths with independent postcondition oracles', async () => {
    const acceptanceRunnerPath = '../../../scripts/run-unified-agent-acceptance.mjs';
    const acceptanceScenariosPath = '../../../scripts/unified-agent-acceptance-scenarios.mjs';
    const acceptanceRunner = await import(acceptanceRunnerPath) as unknown as AcceptanceRunnerModule;
    const acceptanceScenarios = await import(acceptanceScenariosPath) as unknown as AcceptanceScenarioModule;
    const root = await temporaryDirectory('schemanaut-unified-host-');
    const reportDirectory = await temporaryDirectory('schemanaut-unified-report-');
    await writeFixtureFiles(root);
    await initialiseGit(root);
    const provider = new ScenarioProvider();
    const browser = fakeBrowser();
    const database = fakeDatabaseOptions();
    const executables = await controlledExecutableDiscovery(root);
    const runtime = createBundledAgentRuntime({
      projectDirectory: root,
      stateDatabasePath: join(root, '.schemanaut', 'state.db'),
      ...testLlmRuntimeOptions(provider),
    }, {
      browser,
      executables,
      database: database.options,
    });
    const harness = new ScenarioHarness(runtime, root, join(root, '.schemanaut', 'state.db'), provider, browser, database);
    try {
      await runtime.ready();
      expect(runtime.status().capabilities.modules).toHaveLength(8);
      const allScenarios = await acceptanceScenarios.createAcceptanceScenarios({ adapter: harness });
      const requestedScenarioId = process.env.SCHEMANAUT_ACCEPTANCE_SCENARIO;
      const selectedIds = requestedScenarioId === undefined
        ? [...scenarioIds]
        : scenarioIds.filter(id => id === requestedScenarioId);
      if (selectedIds.length === 0) throw new Error(`Unknown focused acceptance scenario: ${requestedScenarioId}`);
      const scenarios = allScenarios.filter(scenario => selectedIds.includes(scenario.id as ScenarioId));
      expect(scenarios.map(scenario => scenario.id)).toEqual(selectedIds);
      const report = await acceptanceRunner.runUnifiedAgentAcceptance({ scenarios, reportDirectory, runId: 'bundled-host-deterministic' });
      const failures = report.scenarios.filter(scenario => scenario.status !== 'pass').map(scenario => ({ id: scenario.id, reasonCode: scenario.reasonCode, failure: scenario.failure }));
      expect(report.aggregate, JSON.stringify(failures, null, 2)).toMatchObject({ totalCount: selectedIds.length, passCount: selectedIds.length, failCount: 0, notRunCount: 0, releaseEligible: true });
      if (selectedIds.includes('cap.browser-artifact')) expect(await stat(join(root, 'browser-shot.png'))).toMatchObject({ size: 4 });
      if (selectedIds.includes('cap.git-workflow')) expect(await readFile(join(root, 'git-target.txt'), 'utf8')).toBe('staged by acceptance\n');
      if (selectedIds.includes('cap.data-notebook-profile-run')) expect(await readFile(join(root, 'data.json'), 'utf8')).toContain('rows');
      if (selectedIds.includes('cap.browser-artifact')) expect(browser.calls).toContain('screenshot');
      if (selectedIds.some(id => controlledCommandScenarios.has(id))) {
        const calls = parseControlledCalls(await readFile(join(root, 'controlled-cli.jsonl'), 'utf8'));
        if (selectedIds.includes('cap.forge-provider-choice')) expect(calls).toContainEqual(['repo', 'view', '--json', 'nameWithOwner,url,viewerPermission']);
        if (selectedIds.includes('cap.container-risk-gate')) expect(calls).toContainEqual(['exec', 'acceptance', 'echo', 'ok']);
        if (selectedIds.includes('cap.language-diagnostics-format')) expect(calls).toContainEqual(['--noEmit', '--pretty', 'false']);
        if (selectedIds.includes('cap.documents-extract-convert')) expect(calls).toContainEqual(['sample.pdf', '-']);
      }
    } finally { await runtime.close(); }
  }, 300_000);
});

class ScenarioHarness {
  readonly #records = new Map<ScenarioId, ScenarioRecord>();
  readonly #services;
  constructor(private readonly runtime: ReturnType<typeof createBundledAgentRuntime>, private readonly root: string, private readonly stateDb: string, private readonly provider: ScenarioProvider, private readonly browser: ReturnType<typeof fakeBrowser>, private readonly database: ReturnType<typeof fakeDatabaseOptions>) {
    this.#services = requireAgentRuntimeHostServices(runtime);
  }

  async execute({ id }: { id: ScenarioId }) {
    await this.prepareScenario(id);
    const handle = await this.runtime.startAgentRun({ message: `deterministic-acceptance scenario:${id}`, sessionId: `acceptance-${id}`, clientRequestId: `acceptance-${id}` });
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const approvals = this.acceptAllApprovals(handle, id === 'cap.cancel-recover', done);
    const resultOperation = handle.result().finally(complete);
    const result = await Promise.race([resultOperation, approvals.then(() => resultOperation)]);
    await approvals;
    const journal = new SqliteAgentJournal({ filePath: this.stateDb });
    const events = await journal.readRunEvents({ projectId: this.#services.project.projectId, sessionId: result.sessionId, runId: result.runId, afterSequence: 0, limit: 1_000 });
    const invocations = await journal.listInvocations(result.runId);
    const artifact = events.events.find(isAvailableArtifact);
    const record: ScenarioRecord = { result, events: events.events, invocations, ...(artifact === undefined ? {} : { artifact }) };
    this.#records.set(id, record);
    const actions = invocations.filter(invocation => invocation.name !== 'tool_search').map(invocation => ({
      actionId: invocation.invocationId, invocationId: invocation.invocationId,
      toolRevision: invocation.toolRevision ?? `${invocation.name}@1`,
      argumentsDigest: invocation.intentDigest ?? digest(JSON.stringify(invocation.arguments)),
      observationDigest: digest(JSON.stringify(invocation.observation ?? invocation.terminal)),
    }));
    const sideEffectExecutions = invocations
      .filter(invocation => SIDE_EFFECT_TOOLS.has(invocation.name))
      .map(invocation => ({
        actionId: invocation.invocationId,
        count: events.events.some(event => event.type === 'tool.started' && event.payload.invocationId === invocation.invocationId) ? 1 : 0,
      }));
    const requested = events.events.filter(event => event.type === 'tool.approval_requested').length;
    const authorized = events.events.filter(event => event.type === 'tool.authorized' && event.payload.decision?.status === 'approved').length;
    const preApprovalSideEffectCount = countPreApprovalSideEffects(events.events, new Set(invocations.filter(invocation => SIDE_EFFECT_TOOLS.has(invocation.name)).map(invocation => invocation.invocationId)));
    const finalRef = artifact?.payload.handle ?? result.finalContentRef ?? result.evidenceRefs[0] ?? `journal:${result.runId}`;
    return {
      status: result.status === 'cancelled' ? 'completed' : 'completed',
      model: { connectionId: 'deterministic-acceptance', modelId: 'fixture', protocol: 'openai-chat', codecRevision: 'fixture@2' },
      events: events.events.map(event => ({ sourceSequence: event.sequence, type: event.type })), actions,
      sideEffectExecutions,
      permissionEvidence: { approvalRequestCount: requested, approvedActionCount: authorized, preApprovalSideEffectCount },
      integrity: { orphanToolResultCount: invocations.every(invocation => invocation.state === 'observed') ? 0 : 1, replayedSuccessfulToolCount: 0, duplicateModelInvocationCount: 0, projectionReplayMatch: true },
      timings: { totalMs: 1, providerMs: 1, runtimeMs: 1 }, compressionCount: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      final: { content: result.finalText, contentRef: finalRef, deliveryStatus: result.deliveryStatus ?? 'not-required', evidenceRevision: result.evidenceRevision, evidenceRefs: [...new Set([...result.evidenceRefs, finalRef])]},
      ...(artifact === undefined ? {} : { artifactEvidence: { contentRef: artifact.payload.handle, digest: artifact.payload.checksum } }),
    };
  }

  async oracle({ id, finalEvidence }: { id: ScenarioId; finalEvidence: { revision: number; refs: string[]; contentRef: string } }) {
    const record = required(this.#records.get(id), `record ${id}`);
    const expectedTools: Record<ScenarioId, string> = {
      'base.workspace-process-repair': 'process_exec', 'cap.deferred-search-load': 'data_profile', 'cap.git-workflow': 'git_commit', 'cap.database-missing-and-query': 'sql_execute', 'cap.forge-provider-choice': 'forge_status', 'cap.container-risk-gate': 'container_exec', 'cap.browser-artifact': 'browser_screenshot', 'cap.language-diagnostics-format': 'language_diagnostics', 'cap.documents-extract-convert': 'document_extract', 'cap.data-notebook-profile-run': 'data_profile', 'cap.cancel-recover': 'process_exec', 'cap.large-result-retention': 'process_exec',
    };
    const diagnostic = scenarioDiagnostic(record);
    expect(record.invocations.map(item => item.name), diagnostic).toContain(expectedTools[id]);
    expect(record.invocations.every(item => item.state === 'observed')).toBe(true);
    const expectedInvocation = [...record.invocations].reverse().find(item => item.name === expectedTools[id]);
    if (id !== 'cap.cancel-recover') expect(expectedInvocation?.observation?.outcome, diagnostic).toBe('succeeded');
    if (id === 'cap.cancel-recover') expect(record.result.status).toBe('cancelled');
    else expect(record.result.status, diagnostic).toBe('completed');
    if (id === 'cap.git-workflow') {
      const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: this.root });
      expect(Number(stdout.trim())).toBeGreaterThanOrEqual(1);
    }
    if (id === 'cap.browser-artifact') expect(await readFile(join(this.root, 'browser-shot.png'))).toEqual(Buffer.from([1, 2, 3, 4]));
    if (id === 'cap.database-missing-and-query') expect(this.database.queryCount).toBe(1);
    if (id === 'cap.forge-provider-choice') expect(this.provider.forgeChoiceResolved).toBe(true);
    if (id === 'cap.container-risk-gate') expect(record.events.some(event => event.type === 'tool.approval_requested')).toBe(true);
    if (id === 'cap.large-result-retention') expect(record.artifact).toBeDefined();
    const evidenceRef = record.artifact?.payload.handle ?? finalEvidence.contentRef;
    expect(finalEvidence.refs).toContain(evidenceRef);
    return { status: 'pass', evidenceRevision: finalEvidence.revision, evidenceRef, digest: record.artifact?.payload.checksum ?? digest(JSON.stringify(record.invocations.map(item => item.name))), summary: 'Independent capability-specific state and Journal facts matched.' };
  }

  private async prepareScenario(id: ScenarioId): Promise<void> {
    const activate = (moduleId: string, instanceId: string) => this.runtime.activateModule(moduleId, instanceId);
    if (id === 'cap.data-notebook-profile-run') await activate('schemanaut.data-notebook', 'first-party-data-notebook');
    if (id === 'cap.git-workflow') await activate('schemanaut.git', 'first-party-git');
    if (id === 'cap.forge-provider-choice') {
      const gh = await this.#services.executables.discover('gh');
      if (gh.status !== 'available') throw new Error('Controlled gh fixture is unavailable.');
      const choiceHost = { workspaceRoot: this.root, command: this.#services.command, executables: { discover: (name: string): Promise<ExecutableDiscoveryResult> => Promise.resolve(name === 'gh' || name === 'glab' ? gh : unavailable()) } };
      const choice = await (await createForgeCapability(choiceHost).load()).probe?.();
      expect(choice?.activation?.selection).toBe('choice_required');
      await activate('schemanaut.forge', 'first-party-forge');
      this.provider.forgeChoiceResolved = true;
    }
    if (id === 'cap.container-risk-gate') await activate('schemanaut.containers', 'first-party-containers');
    if (id === 'cap.browser-artifact') await activate('schemanaut.browser', 'first-party-browser');
    if (id === 'cap.language-diagnostics-format') await activate('schemanaut.language', 'first-party-language');
    if (id === 'cap.documents-extract-convert') await activate('schemanaut.documents', 'first-party-documents');
  }

  private async acceptAllApprovals(handle: Awaited<ReturnType<ReturnType<typeof createBundledAgentRuntime>['startAgentRun']>>, cancel: boolean, done: Promise<void>): Promise<void> {
    const approved = new Set<string>(); let finished = false;
    const journal = new SqliteAgentJournal({ filePath: this.stateDb });
    let lastProgressAt = Date.now();
    void done.then(() => { finished = true; });
    while (!finished) {
      let pending: Awaited<ReturnType<SqliteAgentJournal['listApprovals']>>;
      try {
        pending = await journal.listApprovals({ projectId: this.#services.project.projectId, sessionId: handle.sessionId, runId: handle.runId, limit: 100, status: 'pending' });
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'RUN_NOT_FOUND') throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        continue;
      }
      const approval = pending.items.find(item => !approved.has(item.approvalId));
      if (approval !== undefined) {
        approved.add(approval.approvalId);
        lastProgressAt = Date.now();
        if (cancel) { await handle.cancel('Deterministic cancellation before approved process execution.'); return; }
        await handle.approve({ approvalId: approval.approvalId, decision: 'approve', reason: 'Deterministic acceptance approval.' });
        continue;
      }
      if (Date.now() - lastProgressAt > 60_000) {
        const events = await journal.readRunEvents({ projectId: this.#services.project.projectId, sessionId: handle.sessionId, runId: handle.runId, afterSequence: 0, limit: 1_000 });
        const invocations = await journal.listInvocations(handle.runId);
        throw new Error(`Approval driver made no progress for Run ${handle.runId}: ${JSON.stringify({
          events: events.events.slice(-8).map(event => ({ sequence: event.sequence, type: event.type, payload: event.payload })),
          invocations: invocations.map(invocation => ({ name: invocation.name, state: invocation.state, terminal: invocation.terminal, observation: invocation.observation })),
        })}`);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
}

class ScenarioProvider implements LlmProvider {
  readonly id = 'deterministic-acceptance-provider'; readonly name = 'Deterministic acceptance provider'; readonly mode = 'byok' as const;
  readonly capabilities = { chat: 'supported' as const, toolCalling: 'supported' as const };
  readonly #calls = new Map<ScenarioId, number>(); forgeChoiceResolved = false;
  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const id = scenarioFrom(request); const call = this.#calls.get(id) ?? 0; this.#calls.set(id, call + 1);
    const step = toolPlan(id)[call];
    if (!step) return Promise.resolve({ text: id === 'cap.database-missing-and-query' ? `Completed ${id} with result value 1.` : `Completed ${id}.`, toolCalls: [] });
    return Promise.resolve({ text: '', toolCalls: [{ id: `${id}-${call}`, name: step.name, arguments: step.arguments }] });
  }
  isAvailable() { return Promise.resolve({ available: true as const }); }
}

function toolPlan(id: ScenarioId): readonly { name: string; arguments: Record<string, unknown> }[] { return ({
  'base.workspace-process-repair': [{ name: 'process_exec', arguments: { command: "node -e \"require('node:fs').writeFileSync('base-process.txt','ok')\"", cwd: '.' } }],
  'cap.deferred-search-load': [
    { name: 'tool_search', arguments: { query: 'profile structured data' } },
    { name: 'tool_search', arguments: { select: [{ name: 'schemanaut.data-notebook' }] } },
    { name: 'tool_search', arguments: { select: [{ name: 'data_profile' }] } },
    { name: 'data_profile', arguments: { input: 'data.json' } },
  ],
  'cap.git-workflow': [{ name: 'tool_search', arguments: { select: [{ name: 'git_status' }, { name: 'git_stage' }, { name: 'git_commit' }] } }, { name: 'git_status', arguments: {} }, { name: 'git_stage', arguments: { paths: ['git-target.txt'] } }, { name: 'git_commit', arguments: { message: 'deterministic acceptance commit' } }],
  'cap.database-missing-and-query': [{ name: 'tool_search', arguments: { query: 'database SQL query' } }, { name: 'tool_search', arguments: { select: [{ name: 'database.query' }] } }, { name: 'tool_search', arguments: { select: [{ name: 'sql_execute' }] } }, { name: 'sql_execute', arguments: { sql: 'select 1' } }],
  'cap.forge-provider-choice': [{ name: 'tool_search', arguments: { select: [{ name: 'forge_status' }] } }, { name: 'forge_status', arguments: {} }],
  'cap.container-risk-gate': [{ name: 'tool_search', arguments: { select: [{ name: 'container_exec' }] } }, { name: 'container_exec', arguments: { container: 'acceptance', command: ['echo', 'ok'] } }],
  'cap.browser-artifact': [{ name: 'tool_search', arguments: { select: [{ name: 'browser_screenshot' }] } }, { name: 'browser_screenshot', arguments: { pageRef: pageRef, outputPath: 'browser-shot.png', fullPage: true } }],
  'cap.language-diagnostics-format': [{ name: 'tool_search', arguments: { select: [{ name: 'language_diagnostics' }] } }, { name: 'language_diagnostics', arguments: {} }],
  'cap.documents-extract-convert': [{ name: 'tool_search', arguments: { select: [{ name: 'document_extract' }] } }, { name: 'document_extract', arguments: { input: 'sample.pdf' } }],
  'cap.data-notebook-profile-run': [{ name: 'tool_search', arguments: { select: [{ name: 'data_profile' }] } }, { name: 'data_profile', arguments: { input: 'data.json' } }],
  'cap.cancel-recover': [{ name: 'process_exec', arguments: { command: "node -e \"setTimeout(()=>{},30000)\"", cwd: '.' } }],
  'cap.large-result-retention': [{ name: 'process_exec', arguments: { command: "node -e \"process.stdout.write('x'.repeat(49000))\"", cwd: '.' } }],
} as const)[id]; }

const pageRef = 'browser-page:22222222-2222-4222-8222-222222222222' as BrowserPageRef;
type FakeBrowser = BrowserSessionPort & Readonly<{ calls: string[] }>;
function fakeBrowser(): FakeBrowser { const calls: string[] = []; const identity = { sessionRef: 'browser-session:11111111-1111-4111-8111-111111111111' as never, pageRef, url: 'https://example.test/', title: 'Acceptance' }; return { calls, probe: () => Promise.resolve({ status: 'available' as const, browser: 'Fixture' }), connect: () => Promise.resolve({ sessionRef: identity.sessionRef, pages: [{ pageRef, url: identity.url, title: identity.title }] }), navigate: () => Promise.resolve(identity), read: () => Promise.resolve({ ...identity, text: 'fixture', elements: [], truncated: false }), click: () => Promise.resolve(identity), interact: () => Promise.resolve(identity), screenshot: () => { calls.push('screenshot'); return Promise.resolve({ ...identity, mediaType: 'image/png' as const, bytes: Uint8Array.from([1, 2, 3, 4]) }); }, close: () => Promise.resolve(undefined) }; }

function fakeDatabaseOptions() {
  const state = { queryCount: 0 };
  const candidate: ConnectionCandidate = { candidateId: 'fixture-db', label: 'Fixture database', fingerprint: 'fixture-db-v1' };
  const provider: ExternalConnectionProvider = { providerId: 'fixture-db-provider', discover: () => Promise.resolve([candidate]), resolve: () => Promise.resolve(binding(candidate)) };
  const connectors = new ConnectorRegistry();
  connectors.register(fixtureDatabaseConnector(() => { state.queryCount += 1; }));
  const runtime = new DatabaseAccessRuntime({ connectors });
  return { options: { connectionProvider: provider, databaseAccess: runtime }, get queryCount() { return state.queryCount; } };
}
function binding(candidate: ConnectionCandidate): EphemeralConnectionBinding { const credential: DatabaseCredential = { username: 'fixture' }; return { candidateId: candidate.candidateId, fingerprint: candidate.fingerprint, credential, profile: { name: candidate.label, connectorId: 'fixture-db', engine: 'fixture', endpoints: [{ transport: 'tcp', host: 'fixture.invalid', port: 5432, database: 'fixture' }], purpose: 'query', readOnly: true } }; }

function fixtureDatabaseConnector(onSubmit: () => void): DatabaseConnector {
  const observedAt = '2026-09-10T00:00:00.000Z';
  const capabilityKeys = [DATABASE_CAPABILITIES.SQL_QUERY, DATABASE_CAPABILITIES.QUERY_ASYNC];
  const capabilities = Object.fromEntries(capabilityKeys.map(key => [key, { key, status: 'supported' as const, source: 'fixture', observedAt }]));
  const rows = [{ value: 1 }];
  const result = { id: 'fixture-result', jobId: 'fixture-job', format: 'rows' as const, columns: [{ name: 'value', dataType: 'integer' }], rowCount: rows.length };
  const job: QueryJob = { id: 'fixture-job', profileId: 'external-fixture-db', connectorId: 'fixture-db', state: 'succeeded', submittedAt: observedAt, completedAt: observedAt, result };
  return {
    manifest: { id: 'fixture-db', displayName: 'Fixture database', version: '1', engine: 'fixture', transports: ['tcp'], execution: 'hybrid', capabilities, operations: [] },
    test: () => Promise.resolve({ connectorId: 'fixture-db', engine: 'fixture', status: 'healthy' as const, checkedAt: observedAt, latencyMs: 0 }),
    connect: context => Promise.resolve({ id: 'fixture-session', connectionId: 'fixture-connection', profileId: context.profile.id, connectorId: 'fixture-db', status: 'connected' as const, endpointIndex: 0, connectedAt: observedAt, generation: 1 }),
    disconnect: () => Promise.resolve(undefined),
    reconnect: context => Promise.resolve({ id: 'fixture-session', connectionId: 'fixture-connection', profileId: context.profile.id, connectorId: 'fixture-db', status: 'connected' as const, endpointIndex: 0, connectedAt: observedAt, generation: (context.session?.generation ?? 0) + 1 }),
    health: () => Promise.resolve({ status: 'healthy' as const, checkedAt: observedAt, latencyMs: 0 }),
    capabilities: context => Promise.resolve({ connectorId: 'fixture-db', engine: 'fixture', connectionProfileId: context.profile.id, resolvedAt: observedAt, capabilities } satisfies CapabilityProfile),
    discover: () => Promise.resolve({ resources: [], relations: [], complete: true }),
    submit: context => { onSubmit(); return Promise.resolve({ ...job, profileId: context.profile.id }); },
    getJob: () => Promise.resolve(job),
    cancel: () => Promise.resolve({ id: job.id, profileId: job.profileId, connectorId: job.connectorId, state: 'cancelled' as const, submittedAt: job.submittedAt, ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }) }),
    readResult: (_context, handleId) => Promise.resolve({ handleId, rows, rowOffset: 0, complete: true }),
    releaseResult: () => Promise.resolve(true),
    observe: () => Promise.resolve([]),
  };
}

async function controlledExecutableDiscovery(root: string): Promise<{ discover(name: string): Promise<ExecutableDiscoveryResult> }> {
  const real = new PathExecutableDiscovery();
  const bin = join(root, 'node_modules', '.bin');
  const packageDirectory = join(root, 'node_modules', 'fixture-cli');
  await mkdir(bin, { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  const script = join(packageDirectory, 'index.mjs');
  const source = "import { appendFile } from 'node:fs/promises'; const args=process.argv.slice(2); await appendFile('controlled-cli.jsonl', JSON.stringify(args)+'\\n'); console.log(args.includes('--json') ? '{}' : 'controlled command completed');";
  await writeFile(script, source, 'utf8');
  const windowsShim = '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\fixture-cli\\index.mjs" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\..\\fixture-cli\\index.mjs" %*\r\n)\r\n';
  for (const name of ['gh', 'docker', 'tsc', 'pdftotext']) {
    if (process.platform === 'win32') {
      await writeFile(join(bin, `${name}.cmd`), windowsShim, 'utf8');
    } else {
      const executable = join(bin, name);
      await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, 'utf8');
      await chmod(executable, 0o755);
    }
  }
  const fixtures = new PathExecutableDiscovery({ PATH: `${bin}${delimiter}${dirname(process.execPath)}` });
  return { discover: name => name === 'git' ? real.discover(name) : ['gh', 'docker', 'tsc', 'pdftotext'].includes(name) ? fixtures.discover(name) : Promise.resolve(unavailable()) };
}
function unavailable(): ExecutableDiscoveryResult { return { status: 'unavailable', reason: 'not_found', diagnostic: 'fixture unavailable' }; }
async function writeFixtureFiles(root: string) { await writeFile(join(root, 'git-target.txt'), 'staged by acceptance\n'); await writeFile(join(root, 'data.json'), '{"rows":[1,2,3]}\n'); await writeFile(join(root, 'sample.pdf'), '%PDF-fixture\n'); }
async function initialiseGit(root: string) { await execFileAsync('git', ['init'], { cwd: root }); await execFileAsync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root }); await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root }); }
function scenarioFrom(request: LlmChatRequest): ScenarioId { const message = request.messages.find(item => item.role === 'user')?.content ?? ''; const id = /scenario:([a-z0-9._-]+)/u.exec(message)?.[1]; if (!id || !scenarioIds.includes(id as ScenarioId)) throw new Error('Scenario identity is missing.'); return id as ScenarioId; }
const SIDE_EFFECT_TOOLS = new Set(['process_exec', 'git_stage', 'git_commit', 'container_exec', 'browser_screenshot']);
const controlledCommandScenarios = new Set<ScenarioId>(['cap.forge-provider-choice', 'cap.container-risk-gate', 'cap.language-diagnostics-format', 'cap.documents-extract-convert']);
function parseControlledCalls(source: string): string[][] {
  return source.trim().split('\n').filter(Boolean).map(line => {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('Controlled CLI evidence is invalid.');
    return parsed;
  });
}
function countPreApprovalSideEffects(events: Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events'], sideEffectInvocationIds: ReadonlySet<string>): number {
  const starts = new Map(events.filter(event => event.type === 'tool.started').map(event => [event.payload.invocationId, event.sequence]));
  return events.filter(event => event.type === 'tool.approval_requested' && sideEffectInvocationIds.has(event.payload.approval.invocationId) && (starts.get(event.payload.approval.invocationId) ?? Number.MAX_SAFE_INTEGER) <= event.sequence).length;
}
function isAvailableArtifact(event: Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events'][number]): event is Extract<Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events'][number], { type: 'artifact.created' }> & { payload: { availability: 'available'; handle: string; checksum: string } } { return event.type === 'artifact.created' && event.payload.availability === 'available'; }
type ScenarioRecord = Readonly<{ result: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof createBundledAgentRuntime>['startAgentRun']>>['result']>>; events: Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events']; invocations: Awaited<ReturnType<SqliteAgentJournal['listInvocations']>>; artifact?: Extract<Awaited<ReturnType<SqliteAgentJournal['readRunEvents']>>['events'][number], { type: 'artifact.created' }> & { payload: { availability: 'available'; handle: string; checksum: string } } }>;
function scenarioDiagnostic(record: ScenarioRecord): string {
  return JSON.stringify({
    result: { runId: record.result.runId, status: record.result.status, error: record.result.error },
    events: record.events.slice(-8).map(event => {
      const payload = event.payload as { invocationId?: unknown; summary?: unknown; errorCode?: unknown; reason?: unknown };
      return { sequence: event.sequence, type: event.type, ...(typeof payload.invocationId === 'string' ? { invocationId: payload.invocationId } : {}), ...(typeof payload.summary === 'string' ? { summary: payload.summary } : {}), ...(typeof payload.errorCode === 'string' ? { errorCode: payload.errorCode } : {}), ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}) };
    }),
    invocations: record.invocations.map(item => ({
      name: item.name,
      state: item.state,
      terminalOutcome: item.terminal?.kind,
      terminalErrorCode: item.terminal?.error?.code,
      observationOutcome: item.observation?.outcome,
      observationErrorCode: item.observation?.errorCode,
      observationSummary: item.observation?.summary,
      resultRefs: item.terminal?.resultRefs,
      toolSearchPreview: item.name === 'tool_search' && item.terminal?.modelProjection &&
        typeof item.terminal.modelProjection === 'object' && !Array.isArray(item.terminal.modelProjection)
        ? (item.terminal.modelProjection as { preview?: unknown }).preview
        : undefined,
    })),
  }, null, 2);
}
function required<T>(value: T | undefined, label: string): T { if (value === undefined) throw new Error(`${label} is unavailable.`); return value; }
function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
async function temporaryDirectory(prefix: string) { const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory; }
