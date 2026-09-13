import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runUnifiedAgentAcceptance } from '../run-unified-agent-acceptance.mjs';

const execFileAsync = promisify(execFile);

test('runs every scenario independently and aggregates only the current run', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  await writeFile(
    join(reportDirectory, 'stale-pass.json'),
    JSON.stringify({ id: 'plain-project', status: 'pass' }),
    'utf8',
  );

  const executed = [];
  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'acceptance-current',
    now: () => '2026-09-04T00:00:00.000Z',
    scenarios: [
      scenario('plain-project', async () => {
        executed.push('plain-project');
        throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
      }),
      scenario('capability-artifact', async () => {
        executed.push('capability-artifact');
        return successfulExecution('artifact:final', 2);
      }),
      scenario(
        'database-schema',
        async () => {
          executed.push('database-schema');
          return { status: 'not-run', reasonCode: 'POSTGRES_NOT_CONFIGURED' };
        },
        false,
      ),
    ],
  });

  assert.deepEqual(executed, ['plain-project', 'capability-artifact', 'database-schema']);
  assert.deepEqual(
    report.scenarios.map(({ id, status }) => ({ id, status })),
    [
      { id: 'plain-project', status: 'fail' },
      { id: 'capability-artifact', status: 'pass' },
      { id: 'database-schema', status: 'not-run' },
    ],
  );
  assert.deepEqual(report.aggregate, {
    totalCount: 3,
    passCount: 1,
    failCount: 1,
    notRunCount: 1,
    executedCount: 2,
    passRate: 0.5,
    releaseEligible: false,
  });

  const manifest = JSON.parse(
    await readFile(join(reportDirectory, 'acceptance-current', 'manifest.json'), 'utf8'),
  );
  assert.deepEqual(manifest.aggregate, report.aggregate);
  assert.equal(manifest.scenarios.length, 3);
});

test('fails a scenario when the external counter proves a committed action ran twice', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('artifact:counter', 3);
  execution.actions = [
    {
      actionId: 'action-1',
      invocationId: 'invocation-1',
      toolRevision: 'write-file@1',
      argumentsDigest: 'sha256:arguments-1',
      observationDigest: 'sha256:observation-1',
    },
  ];
  execution.sideEffectExecutions = [{ actionId: 'action-1', count: 2 }];

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'duplicate-side-effect',
    scenarios: [scenario('restart-write', async () => execution)],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'DUPLICATE_SIDE_EFFECT');
  assert.equal(report.scenarios[0].duplicateActionCount, 1);
  assert.equal(report.aggregate.releaseEligible, false);
});

test('enforces a zero equivalent-action budget only for scenarios that declare it', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const repeated = successfulExecution('result:schema', 4);
  repeated.actions = [
    action('action-1', 'invocation-1', 'sha256:same-arguments', 'sha256:first-result'),
    action('action-2', 'invocation-2', 'sha256:same-arguments', 'sha256:second-result'),
  ];

  const simpleScenario = scenario('database-schema', async () => repeated);
  simpleScenario.maxEquivalentActionCount = 0;
  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'equivalent-actions',
    scenarios: [simpleScenario, scenario('traffic-cleaning', async () => repeated)],
  });

  assert.deepEqual(
    report.scenarios.map(({ id, status, reasonCode, equivalentActionCount }) => ({
      id,
      status,
      reasonCode,
      equivalentActionCount,
    })),
    [
      {
        id: 'database-schema',
        status: 'fail',
        reasonCode: 'EQUIVALENT_ACTION_LIMIT_EXCEEDED',
        equivalentActionCount: 1,
      },
      {
        id: 'traffic-cleaning',
        status: 'pass',
        reasonCode: 'ACCEPTED',
        equivalentActionCount: 1,
      },
    ],
  );
});

test('requires a strictly increasing event sequence and records its digest', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const valid = successfulExecution('artifact:valid-events', 5);
  const invalid = successfulExecution('artifact:invalid-events', 5);
  invalid.events = [
    { sourceSequence: 20, type: 'run.started' },
    { sourceSequence: 20, type: 'run.completed' },
  ];

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'event-sequence',
    scenarios: [
      scenario('valid-events', async () => valid),
      scenario('invalid-events', async () => invalid),
    ],
  });

  const expectedDigest = `sha256:${createHash('sha256').update(JSON.stringify(valid.events)).digest('hex')}`;
  assert.deepEqual(report.scenarios[0].eventSequence, {
    first: 10,
    last: 11,
    count: 2,
    digest: expectedDigest,
  });
  assert.equal(report.scenarios[1].status, 'fail');
  assert.equal(report.scenarios[1].reasonCode, 'EVENT_SEQUENCE_INVALID');
});

test('does not accept an oracle verdict without a durable digest', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const weakOracleScenario = scenario('weak-oracle', async () =>
    successfulExecution('artifact:final-only', 7),
  );
  weakOracleScenario.oracle = async ({ finalEvidence }) => ({
    status: 'pass',
    evidenceRevision: finalEvidence.revision,
    evidenceRef: finalEvidence.refs[0],
    summary: 'A verdict with no durable digest must not be enough.',
  });

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'weak-oracle',
    scenarios: [weakOracleScenario],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'ORACLE_RESULT_INVALID');
});

test('persists a bounded typed failure message without a stack', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'ordinary-failure',
    scenarios: [
      scenario('provider-failure', async () => {
        throw Object.assign(
          new Error('request failed: external detail=fixture-ordinary-value'),
          {
            code: 'PROVIDER_UNAVAILABLE',
            category: 'provider',
            retryable: true,
          },
        );
      }),
    ],
  });

  assert.deepEqual(report.scenarios[0].failure, {
    code: 'PROVIDER_UNAVAILABLE',
    category: 'provider',
    retryable: true,
    message: 'request failed: external detail=fixture-ordinary-value',
  });
  const persisted = await readFile(
    join(reportDirectory, 'ordinary-failure', 'provider-failure.json'),
    'utf8',
  );
  assert.equal(persisted.includes('fixture-ordinary-value'), true);
  assert.equal(persisted.includes('at TestContext'), false);
});

test('fails when an explicitly injected protocol sentinel reaches the final answer', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('artifact:sentinel', 8);
  execution.final.content = 'Unsafe final: <UNDECLARED_TOOL_SENTINEL>';
  const sentinelScenario = scenario('protocol-sentinel', async () => execution);
  sentinelScenario.forbiddenFinalText = ['<UNDECLARED_TOOL_SENTINEL>'];

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'protocol-sentinel',
    scenarios: [sentinelScenario],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'PROTOCOL_TEXT_LEAK');
  assert.equal(report.scenarios[0].protocolTextLeakCount, 1);
});

test('does not let a passing final oracle hide a recovery integrity failure', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('artifact:orphan', 9);
  execution.integrity.orphanToolResultCount = 1;

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'orphan-result',
    scenarios: [scenario('crash-after-result-write', async () => execution)],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'ORPHAN_TOOL_RESULT');
  assert.deepEqual(report.scenarios[0].integrity, {
    orphanToolResultCount: 1,
    replayedSuccessfulToolCount: 0,
    duplicateModelInvocationCount: 0,
    projectionReplayMatch: true,
  });
});

test('whitelists the complete report evidence schema without persisting undeclared model fields', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('artifact:complete-report', 12);
  execution.model.unusedField = 'ignored-model-value';
  execution.timings.unusedField = 'ignored-timing-value';
  execution.usage.unusedField = 'ignored-usage-value';

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'complete-report',
    scenarios: [scenario('complete-report', async () => execution)],
  });

  assert.deepEqual(report.scenarios[0].model, {
    connectionId: 'fixture-connection',
    modelId: 'fixture-model',
    protocol: 'fixture',
    codecRevision: 'fixture@1',
  });
  assert.deepEqual(report.scenarios[0].timings, {
    totalMs: 20,
    providerMs: 10,
    runtimeMs: 10,
  });
  assert.deepEqual(report.scenarios[0].usage, {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  });
  assert.deepEqual(report.scenarios[0].finalDelivery, {
    status: 'verified',
    contentRef: 'content:final',
    evidenceRevision: 12,
    evidenceRefs: ['artifact:complete-report'],
  });
  assert.deepEqual(report.scenarios[0].permissionEvidence, {
    approvalRequestCount: 0,
    approvedActionCount: 0,
    preApprovalSideEffectCount: 0,
  });
  assert.deepEqual(report.scenarios[0].artifact, {
    contentRef: 'artifact:complete-report',
    digest: 'sha256:artifact-12',
  });
  assert.equal(report.scenarios[0].oracle.digest, 'oracle:complete-report');

  const persisted = await readFile(
    join(reportDirectory, 'complete-report', 'complete-report.json'),
    'utf8',
  );
  assert.equal(persisted.includes('ignored-model-value'), false);
  assert.equal(persisted.includes('ignored-timing-value'), false);
  assert.equal(persisted.includes('ignored-usage-value'), false);
});

test('runs scenario adapters through the command-line acceptance entrypoint', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-cli-'));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const reportDirectory = join(temporaryDirectory, 'reports');
  const scenarioModule = join(temporaryDirectory, 'scenarios.mjs');
  const execution = successfulExecution('artifact:cli', 14);
  await writeFile(
    scenarioModule,
    `export default [{
      id: 'cli-scenario',
      required: true,
      execute: async () => (${JSON.stringify(execution)}),
      oracle: async ({ finalEvidence }) => ({
        status: 'pass',
        evidenceRevision: finalEvidence.revision,
        evidenceRef: finalEvidence.refs[0],
        digest: 'sha256:cli-oracle',
        summary: 'CLI oracle inspected the final evidence only.'
      })
    }];\n`,
    'utf8',
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      'scripts/run-unified-agent-acceptance.mjs',
      '--scenario-module',
      scenarioModule,
      '--report-directory',
      reportDirectory,
      '--run-id',
      'cli-run',
    ],
    { cwd: new URL('../..', import.meta.url) },
  );

  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {
    runId: 'cli-run',
    reportDirectory: join(reportDirectory, 'cli-run'),
    releaseEligible: true,
    passCount: 1,
    failCount: 0,
    notRunCount: 0,
  });
  const manifest = JSON.parse(
    await readFile(join(reportDirectory, 'cli-run', 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.scenarios[0].status, 'pass');
});

test('enforces a scenario-specific final delivery status', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('result:delivery', 15);
  execution.final.deliveryStatus = 'unverified';
  const deliveryScenario = scenario('required-delivery', async () => execution);
  deliveryScenario.requiredDeliveryStatus = 'verified';

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'required-delivery',
    scenarios: [deliveryScenario],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'DELIVERY_STATUS_REJECTED');
  assert.equal(report.scenarios[0].finalDelivery.status, 'unverified');
});

test('returns a failing process exit for a required not-run scenario', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-cli-'));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const reportDirectory = join(temporaryDirectory, 'reports');
  const scenarioModule = join(temporaryDirectory, 'not-run-scenarios.mjs');
  await writeFile(
    scenarioModule,
    `export default [{
      id: 'required-provider',
      required: true,
      execute: async () => ({ status: 'not-run', reasonCode: 'PROVIDER_NOT_CONFIGURED' }),
      oracle: async () => { throw new Error('oracle must not run'); }
    }];\n`,
    'utf8',
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        'scripts/run-unified-agent-acceptance.mjs',
        '--scenario-module',
        scenarioModule,
        '--report-directory',
        reportDirectory,
        '--run-id',
        'required-not-run',
      ],
      { cwd: new URL('../..', import.meta.url) },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, '');
      assert.deepEqual(JSON.parse(error.stdout), {
        runId: 'required-not-run',
        reportDirectory: join(reportDirectory, 'required-not-run'),
        releaseEligible: false,
        passCount: 0,
        failCount: 0,
        notRunCount: 1,
      });
      return true;
    },
  );
});

test('keeps required not-run scenarios release-ineligible when local allow-not-run is explicit', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-cli-'));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const reportDirectory = join(temporaryDirectory, 'reports');
  const scenarioModule = join(temporaryDirectory, 'not-run-scenarios.mjs');
  await writeFile(scenarioModule, `export default [{ id: 'required-provider', required: true, execute: async () => ({ status: 'not-run', reasonCode: 'PROVIDER_NOT_CONFIGURED' }), oracle: async () => { throw new Error('oracle must not run'); } }];\n`, 'utf8');
  const result = await execFileAsync(process.execPath, ['scripts/run-unified-agent-acceptance.mjs', '--scenario-module', scenarioModule, '--report-directory', reportDirectory, '--run-id', 'allowed-local-not-run', '--allow-not-run'], { cwd: new URL('../..', import.meta.url) });
  assert.deepEqual(JSON.parse(result.stdout), { runId: 'allowed-local-not-run', reportDirectory: join(reportDirectory, 'allowed-local-not-run'), releaseEligible: false, passCount: 0, failCount: 0, notRunCount: 1 });
  const manifest = JSON.parse(await readFile(join(reportDirectory, 'allowed-local-not-run', 'manifest.json'), 'utf8'));
  assert.equal(manifest.aggregate.releaseEligible, false);
  assert.equal(manifest.scenarios[0].status, 'not-run');
});

test('defaults to the complete required scenario matrix and keeps Host-wiring gaps release-ineligible', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-cli-'));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const reportDirectory = join(temporaryDirectory, 'reports');
  const result = await execFileAsync(
    process.execPath,
    [
      'scripts/run-unified-agent-acceptance.mjs',
      '--report-directory',
      reportDirectory,
      '--run-id',
      'default-matrix',
      '--allow-not-run',
    ],
    { cwd: new URL('../..', import.meta.url) },
  );

  assert.deepEqual(JSON.parse(result.stdout), {
    runId: 'default-matrix',
    reportDirectory: join(reportDirectory, 'default-matrix'),
    releaseEligible: false,
    passCount: 0,
    failCount: 0,
    notRunCount: 12,
  });
  const manifest = JSON.parse(
    await readFile(join(reportDirectory, 'default-matrix', 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.aggregate.releaseEligible, false);
  assert.equal(manifest.scenarios.length, 12);
  assert.equal(
    manifest.scenarios.every(
      (report) =>
        report.required &&
        report.status === 'not-run' &&
        report.reasonCode === 'HOST_WIRING_UNAVAILABLE',
    ),
    true,
  );
});

test('fails completed scenarios when permission evidence proves a side effect preceded approval', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('artifact:permission', 27);
  execution.permissionEvidence.preApprovalSideEffectCount = 1;

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'pre-approval-side-effect',
    scenarios: [scenario('permission-ordering', async () => execution)],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'PRE_APPROVAL_SIDE_EFFECT');
});

test('rejects an oracle that finds a value only in historical evidence', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('result:final-revision', 22);
  execution.historicalEvidence = [
    {
      revision: 6,
      ref: 'result:old-matching-value',
      value: 42,
    },
  ];
  const historicalOracle = scenario('historical-oracle', async () => execution);
  historicalOracle.oracle = async () => ({
    status: 'pass',
    evidenceRevision: 6,
    evidenceRef: 'result:old-matching-value',
    digest: 'sha256:historical-match',
    summary: 'Found 42 in an earlier result, but not in the final evidence.',
  });

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'historical-oracle',
    scenarios: [historicalOracle],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'FINAL_EVIDENCE_MISMATCH');
  assert.equal(report.scenarios[0].finalDelivery.evidenceRevision, 22);
  assert.deepEqual(report.scenarios[0].finalDelivery.evidenceRefs, ['result:final-revision']);
});

test('proves a tool-call sentinel stayed ordinary text, ran no handler, and missed final delivery', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const sentinel = '<tool_calls>UNDECLARED_SENTINEL_8042</tool_calls>';
  const safe = successfulExecution('artifact:protocol-diagnostic', 23);
  safe.events = [
    { sourceSequence: 30, type: 'run.started' },
    {
      sourceSequence: 31,
      type: 'model_block_completed',
      payload: { block: { type: 'text', text: sentinel } },
    },
    { sourceSequence: 32, type: 'run.completed' },
  ];
  safe.final.content = 'The undeclared protocol envelope was treated as ordinary text.';
  safe.protocolSentinelEvidence = {
    sentinel,
    ordinaryTextCount: 1,
    handlerExecutionCount: 0,
  };
  const unsafe = structuredClone(safe);
  unsafe.final.evidenceRefs = ['artifact:unsafe-protocol'];
  unsafe.artifactEvidence.contentRef = 'artifact:unsafe-protocol';
  unsafe.protocolSentinelEvidence.handlerExecutionCount = 1;

  const safeScenario = scenario('protocol-ordinary-text', async () => safe);
  safeScenario.forbiddenFinalText = [sentinel];
  safeScenario.protocolSentinel = sentinel;
  const unsafeScenario = scenario('protocol-handler-executed', async () => unsafe);
  unsafeScenario.forbiddenFinalText = [sentinel];
  unsafeScenario.protocolSentinel = sentinel;

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'protocol-boundary',
    scenarios: [safeScenario, unsafeScenario],
  });

  assert.deepEqual(report.scenarios[0].protocolSentinel, {
    disposition: 'ordinary-text',
    ordinaryTextCount: 1,
    handlerExecutionCount: 0,
    finalDeliveryLeakCount: 0,
  });
  assert.equal(report.scenarios[0].status, 'pass');
  assert.equal(report.scenarios[1].status, 'fail');
  assert.equal(report.scenarios[1].reasonCode, 'PROTOCOL_SENTINEL_HANDLER_EXECUTED');
  assert.equal(report.scenarios[1].protocolSentinel.handlerExecutionCount, 1);
});

test('uses explicit null evidence fields for a scenario that did not run', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'not-run-schema',
    scenarios: [
      scenario(
        'optional-provider',
        async () => ({
          status: 'not-run',
          reasonCode: 'PROVIDER_NOT_CONFIGURED',
        }),
        false,
      ),
    ],
  });

  assert.deepEqual(report.scenarios[0], {
    schemaVersion: 1,
    acceptanceRunId: 'not-run-schema',
    id: 'optional-provider',
    required: false,
    generatedAt: report.generatedAt,
    status: 'not-run',
    reasonCode: 'PROVIDER_NOT_CONFIGURED',
    model: null,
    eventSequence: null,
    toolCount: null,
    duplicateActionCount: null,
    equivalentActionCount: null,
    permissionEvidence: null,
    artifact: null,
    protocolTextLeakCount: null,
    protocolSentinel: null,
    integrity: null,
    timings: null,
    compressionCount: null,
    usage: null,
    finalDelivery: null,
    oracle: null,
    failure: null,
  });
});

test('rejects forged ordinary-text sentinel evidence that is absent from this run events', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const sentinel = '<tool_calls>FORGED_SENTINEL</tool_calls>';
  const execution = successfulExecution('artifact:forged-sentinel', 24);
  execution.protocolSentinelEvidence = {
    sentinel,
    ordinaryTextCount: 1,
    handlerExecutionCount: 0,
  };
  const forgedScenario = scenario('forged-sentinel', async () => execution);
  forgedScenario.protocolSentinel = sentinel;

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'forged-sentinel',
    scenarios: [forgedScenario],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'PROTOCOL_SENTINEL_EVIDENCE_INVALID');
});

test('accepts a text-only completion whose oracle binds the final content ref', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('unused-business-evidence', 25);
  execution.final.contentRef = 'content:text-only-final';
  execution.final.evidenceRefs = [];
  execution.artifactEvidence.contentRef = 'content:text-only-final';
  execution.final.deliveryStatus = 'not-required';
  const textOnlyScenario = scenario('plain-project-text-only', async () => execution);
  textOnlyScenario.requiredDeliveryStatus = 'not-required';
  textOnlyScenario.oracle = async ({ finalEvidence }) => ({
    status: 'pass',
    evidenceRevision: finalEvidence.revision,
    evidenceRef: finalEvidence.contentRef,
    digest: 'sha256:text-only-content',
    summary: 'The final content itself is the evidence for this plain conversation.',
  });

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'text-only-final',
    scenarios: [textOnlyScenario],
  });

  assert.equal(report.scenarios[0].status, 'pass');
  assert.deepEqual(report.scenarios[0].finalDelivery, {
    status: 'not-required',
    contentRef: 'content:text-only-final',
    evidenceRevision: 25,
    evidenceRefs: [],
  });
  assert.equal(report.scenarios[0].oracle.evidenceRef, 'content:text-only-final');
});

test('fails a completed run that has neither final content nor business evidence refs', async (t) => {
  const reportDirectory = await mkdtemp(join(tmpdir(), 'nexus-unified-acceptance-'));
  t.after(async () => rm(reportDirectory, { recursive: true, force: true }));
  const execution = successfulExecution('unused-business-evidence', 26);
  delete execution.final.contentRef;
  execution.final.evidenceRefs = [];

  const report = await runUnifiedAgentAcceptance({
    reportDirectory,
    runId: 'missing-final-evidence',
    scenarios: [scenario('missing-final-evidence', async () => execution)],
  });

  assert.equal(report.scenarios[0].status, 'fail');
  assert.equal(report.scenarios[0].reasonCode, 'FINAL_EVIDENCE_MISSING');
  assert.equal(report.scenarios[0].finalDelivery, null);
});

function scenario(id, execute, required = true) {
  return {
    id,
    required,
    execute,
    oracle: async ({ finalEvidence }) => ({
      status: 'pass',
      evidenceRevision: finalEvidence.revision,
      evidenceRef: finalEvidence.refs[0],
      digest: `oracle:${id}`,
      summary: 'The final evidence matches the externally observed state.',
    }),
  };
}

function successfulExecution(evidenceRef, evidenceRevision) {
  return {
    status: 'completed',
    model: {
      connectionId: 'fixture-connection',
      modelId: 'fixture-model',
      protocol: 'fixture',
      codecRevision: 'fixture@1',
    },
    events: [
      { sourceSequence: 10, type: 'run.started' },
      { sourceSequence: 11, type: 'run.completed' },
    ],
    actions: [],
    timings: { totalMs: 20, providerMs: 10, runtimeMs: 10 },
    compressionCount: 0,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    integrity: {
      orphanToolResultCount: 0,
      replayedSuccessfulToolCount: 0,
      duplicateModelInvocationCount: 0,
      projectionReplayMatch: true,
    },
    permissionEvidence: {
      approvalRequestCount: 0,
      approvedActionCount: 0,
      preApprovalSideEffectCount: 0,
    },
    artifactEvidence: {
      contentRef: evidenceRef,
      digest: `sha256:artifact-${evidenceRevision}`,
    },
    final: {
      content: 'Completed using the final artifact.',
      contentRef: 'content:final',
      deliveryStatus: 'verified',
      evidenceRevision,
      evidenceRefs: [evidenceRef],
    },
  };
}

function action(actionId, invocationId, argumentsDigest, observationDigest) {
  return {
    actionId,
    invocationId,
    toolRevision: 'schema-query@1',
    argumentsDigest,
    observationDigest,
  };
}
