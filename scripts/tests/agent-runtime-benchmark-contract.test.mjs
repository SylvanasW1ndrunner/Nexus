import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(root, 'scripts', 'run-agent-runtime-benchmark.mjs');
const capabilityScriptPath = join(root, 'scripts', 'run-capability-control-plane-benchmark.mjs');

test('agent runtime benchmark reports isolated normative layers without treating durable work as scheduler overhead', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-agent-benchmark-contract-'));
  const reportPath = join(directory, 'performance.json');
  try {
    const result = await runNode(scriptPath, {
      ...process.env,
      SCHEMANAUT_AGENT_BENCHMARK_PROFILE: 'contract',
      SCHEMANAUT_AGENT_BENCHMARK_REPORT_PATH: reportPath,
      SCHEMANAUT_AGENT_BENCHMARK_REFERENCE_ID: '',
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));

    assert.deepEqual(report.protocol.normative.concurrencyLevels, [1, 8]);
    assert.equal(report.protocol.normative.minimumWarmupMs, 10_000);
    assert.equal(report.protocol.normative.minimumJournalSamplesPerLevel, 1_000);
    assert.equal(report.protocol.normative.minimumSchedulerSamplesPerLevel, 500);
    assert.equal(report.protocol.normative.retainedHeapTurns, 100);
    assert.equal(report.protocol.storage.journalMode, 'wal');
    assert.equal(report.protocol.storage.synchronous, 'full');

    const scheduler = report.measurements.schedulerKernel;
    assert.equal(scheduler.absoluteThresholdP95Ms, 25);
    assert.equal(scheduler.includesHandler, false);
    assert.equal(scheduler.includesJournalIo, false);
    assert.equal(scheduler.includesProvider, false);
    assert.deepEqual(Object.keys(scheduler.profiles).sort(), ['concurrency1', 'concurrency8']);
    assert(scheduler.profiles.concurrency1.rawSamplesMs.length > 0);
    assert(scheduler.profiles.concurrency8.rawSamplesMs.length > 0);

    const journal = report.measurements.journalCommit;
    assert.equal(journal.absoluteThresholdP95Ms, 10);
    assert.equal(journal.storagePragmas.journalMode, 'wal');
    assert.equal(journal.storagePragmas.synchronous, 2);
    assert.deepEqual(Object.keys(journal.profiles).sort(), ['concurrency1', 'concurrency8']);

    const durable = report.measurements.durableInvocationBatch;
    assert.equal(durable.classification, 'informational');
    assert.equal(durable.gate, null);
    assert.equal(durable.includesHandler, true);
    assert.equal(durable.includesJournalIo, true);
    assert.equal(durable.includesProviderDecode, false);

    assert.equal(report.measurements.retainedHeap.turns, 100);
    assert.equal(report.measurements.retainedHeap.requiresExposeGc, true);
    assert.equal(report.measurements.writeAmplification.delta.synchronous.requiredChunkCount, 10_000);
    assert.equal(report.measurements.writeAmplification.delta.paced.requiredChunkCount, 10_000);
    assert.equal(report.measurements.writeAmplification.delta.paced.intervalMs, 10);
    const progress = report.measurements.writeAmplification.progress;
    assert.equal(progress.status, 'supported');
    assert.equal(progress.requiredUpdateCount, 10_000);
    assert.equal(progress.actualUpdateCount, 80);
    assert.equal(progress.byteThreshold, 4_096);
    assert.equal(progress.timeThresholdMs, 40);
    assert.equal(progress.terminalOutcome, 'succeeded');
    assert.equal(progress.passed, true);
    assert(progress.journalWriteCount > 0);
    assert(progress.journalWriteCount < progress.actualUpdateCount);
    assert(progress.journalWriteCount <= progress.maximumJournalWrites);
    assert.match(progress.scope, /production ToolInvocationExecutionContext\.reportProgress/iu);

    assert.equal(report.referenceMachine.absoluteGatesApplied, false);
    assert.equal(report.referenceMachine.decision, 'relative-baseline-only');
    assert.equal(typeof report.relativeToFakeProvider.schedulerP95Ratio, 'number');
    assert.equal(report.qualification.normative, false);
    assert(report.qualification.reasons.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capability benchmark exercises the current invocation registry contract end to end', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-capability-benchmark-contract-'));
  const reportPath = join(directory, 'performance.json');
  try {
    const result = await runNode(capabilityScriptPath, {
      ...process.env,
      SCHEMANAUT_CAPABILITY_BENCHMARK_REPORT_PATH: reportPath,
      SCHEMANAUT_CAPABILITY_BENCHMARK_PROFILE: 'contract',
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.kind, 'capability-runtime-performance');
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.results.map(({ size }) => size), [1_000, 10_000]);
    assert.equal(report.results.at(-1).toolExposure.modelToolCount, 14);
    assert(Object.values(report.checks).every(Boolean));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', script], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
