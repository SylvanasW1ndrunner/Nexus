#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export async function runUnifiedAgentAcceptance(options) {
  const scenarios = normalizeScenarios(options?.scenarios);
  const reportDirectory = requireText(options?.reportDirectory, 'reportDirectory');
  const runId = normalizeIdentifier(options?.runId ?? randomUUID(), 'runId');
  const now = options?.now ?? (() => new Date().toISOString());
  const generatedAt = requireText(now(), 'now()');
  const runDirectory = join(reportDirectory, runId);
  await mkdir(runDirectory, { recursive: true });

  const reports = [];
  for (const scenario of scenarios) {
    const report = await runScenario({ scenario, runId, generatedAt });
    reports.push(report);
    await writeJsonAtomic(join(runDirectory, `${scenario.id}.json`), report);
  }

  const aggregate = aggregateReports(reports);
  const manifest = {
    schemaVersion: 1,
    runId,
    generatedAt,
    aggregate,
    scenarios: reports,
  };
  await writeJsonAtomic(join(runDirectory, 'manifest.json'), manifest);
  return manifest;
}

async function runScenario({ scenario, runId, generatedAt }) {
  try {
    const execution = await scenario.execute();
    if (execution?.status === 'not-run') {
      return baseReport(
        { scenario, runId, generatedAt },
        {
          status: 'not-run',
          reasonCode: normalizeReasonCode(execution.reasonCode, 'NOT_RUN'),
        },
      );
    }
    if (execution?.status !== 'completed') {
      return baseReport(
        { scenario, runId, generatedAt },
        {
          status: 'fail',
          reasonCode: normalizeReasonCode(execution?.reasonCode, 'RUN_NOT_COMPLETED'),
        },
      );
    }

    const finalEvidence = normalizeFinalEvidence(execution.final);
    const actionSummary = summarizeActions(execution.actions, execution.sideEffectExecutions);
    const permissionEvidence = normalizePermissionEvidence(execution.permissionEvidence);
    const permissionFailure = permissionFailureCode(permissionEvidence);
    const artifact = normalizeArtifactEvidence(execution.artifactEvidence, finalEvidence);
    const integrity = normalizeIntegrity(execution.integrity);
    const integrityFailure = integrityFailureCode(integrity);
    const oracle = normalizeOracleResult(await scenario.oracle({ finalEvidence }));
    const oracleMatchesFinal =
      oracle.status === 'pass' &&
      oracle.evidenceRevision === finalEvidence.revision &&
      (oracle.evidenceRef === finalEvidence.contentRef ||
        finalEvidence.refs.includes(oracle.evidenceRef));
    const equivalentLimitExceeded =
      scenario.maxEquivalentActionCount !== undefined &&
      actionSummary.equivalentActionCount > scenario.maxEquivalentActionCount;
    const protocolTextLeakCount = countExactOccurrences(
      finalEvidence.content,
      scenario.forbiddenFinalText,
    );
    const protocolSentinel = normalizeProtocolSentinelEvidence({
      expected: scenario.protocolSentinel,
      actual: execution.protocolSentinelEvidence,
      events: execution.events,
      finalDeliveryLeakCount: protocolTextLeakCount,
    });
    const protocolSentinelFailure = protocolSentinelFailureCode(protocolSentinel);
    const deliveryStatusRejected =
      scenario.requiredDeliveryStatus !== undefined &&
      finalEvidence.deliveryStatus !== scenario.requiredDeliveryStatus;
    const status =
      oracleMatchesFinal &&
      actionSummary.duplicateActionCount === 0 &&
      !equivalentLimitExceeded &&
      protocolTextLeakCount === 0 &&
      permissionFailure === null &&
      integrityFailure === null &&
      !deliveryStatusRejected &&
      protocolSentinelFailure === null
        ? 'pass'
        : 'fail';
    const reasonCode =
      actionSummary.duplicateActionCount > 0
        ? 'DUPLICATE_SIDE_EFFECT'
        : equivalentLimitExceeded
          ? 'EQUIVALENT_ACTION_LIMIT_EXCEEDED'
          : permissionFailure !== null
            ? permissionFailure
          : protocolTextLeakCount > 0
            ? 'PROTOCOL_TEXT_LEAK'
            : protocolSentinelFailure !== null
              ? protocolSentinelFailure
              : (integrityFailure ??
                (deliveryStatusRejected
                  ? 'DELIVERY_STATUS_REJECTED'
                  : oracle.status === 'fail'
                    ? 'ORACLE_REJECTED'
                    : status === 'pass'
                      ? 'ACCEPTED'
                      : 'FINAL_EVIDENCE_MISMATCH'));
    return baseReport(
      { scenario, runId, generatedAt },
      {
        status,
        reasonCode,
        model: normalizeModel(execution.model),
        eventSequence: summarizeEventSequence(execution.events),
        ...actionSummary,
        permissionEvidence,
        artifact,
        protocolTextLeakCount,
        ...(protocolSentinel === undefined ? {} : { protocolSentinel }),
        integrity,
        timings: normalizeTimings(execution.timings),
        compressionCount: normalizeCount(execution.compressionCount, 'compressionCount'),
        usage: normalizeUsage(execution.usage),
        finalDelivery: {
          status: finalEvidence.deliveryStatus,
          contentRef: finalEvidence.contentRef,
          evidenceRevision: finalEvidence.revision,
          evidenceRefs: finalEvidence.refs,
        },
        oracle: {
          status: oracle.status,
          evidenceRevision: oracle.evidenceRevision,
          evidenceRef: oracle.evidenceRef,
          digest: oracle.digest,
          summary: oracle.summary,
        },
      },
    );
  } catch (error) {
    return baseReport(
      { scenario, runId, generatedAt },
      {
        status: 'fail',
        reasonCode: normalizeReasonCode(error?.code, 'SCENARIO_EXECUTION_FAILED'),
        failure: normalizeFailure(error),
      },
    );
  }
}

function baseReport({ scenario, runId, generatedAt }, detail) {
  return {
    schemaVersion: 1,
    acceptanceRunId: runId,
    id: scenario.id,
    required: scenario.required,
    generatedAt,
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
    ...detail,
  };
}

function aggregateReports(reports) {
  const passCount = reports.filter(({ status }) => status === 'pass').length;
  const failCount = reports.filter(({ status }) => status === 'fail').length;
  const notRunCount = reports.filter(({ status }) => status === 'not-run').length;
  const executedCount = passCount + failCount;
  return {
    totalCount: reports.length,
    passCount,
    failCount,
    notRunCount,
    executedCount,
    passRate: executedCount === 0 ? 0 : passCount / executedCount,
    releaseEligible:
      failCount === 0 && reports.every((report) => !report.required || report.status === 'pass'),
  };
}

function normalizeScenarios(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('scenarios must be a non-empty array.');
  }
  const ids = new Set();
  return value.map((scenario, index) => {
    if (scenario === null || typeof scenario !== 'object') {
      throw new TypeError(`scenarios[${index}] must be an object.`);
    }
    const id = normalizeIdentifier(scenario.id, `scenarios[${index}].id`);
    if (ids.has(id)) throw new TypeError(`Duplicate scenario id: ${id}`);
    ids.add(id);
    if (typeof scenario.execute !== 'function') {
      throw new TypeError(`scenarios[${index}].execute must be a function.`);
    }
    if (typeof scenario.oracle !== 'function') {
      throw new TypeError(`scenarios[${index}].oracle must be a function.`);
    }
    const maxEquivalentActionCount = scenario.maxEquivalentActionCount;
    if (
      maxEquivalentActionCount !== undefined &&
      (!Number.isSafeInteger(maxEquivalentActionCount) || maxEquivalentActionCount < 0)
    ) {
      throw new TypeError(
        `scenarios[${index}].maxEquivalentActionCount must be a non-negative safe integer.`,
      );
    }
    const forbiddenFinalText = normalizeTextList(
      scenario.forbiddenFinalText,
      `scenarios[${index}].forbiddenFinalText`,
    );
    const protocolSentinel =
      scenario.protocolSentinel === undefined
        ? undefined
        : requireText(scenario.protocolSentinel, `scenarios[${index}].protocolSentinel`);
    if (protocolSentinel !== undefined && !forbiddenFinalText.includes(protocolSentinel)) {
      forbiddenFinalText.push(protocolSentinel);
    }
    const requiredDeliveryStatus = scenario.requiredDeliveryStatus;
    if (
      requiredDeliveryStatus !== undefined &&
      !['not-required', 'verified', 'unverified'].includes(requiredDeliveryStatus)
    ) {
      throw new TypeError(`scenarios[${index}].requiredDeliveryStatus is invalid.`);
    }
    return {
      ...scenario,
      id,
      required: scenario.required !== false,
      ...(maxEquivalentActionCount === undefined ? {} : { maxEquivalentActionCount }),
      forbiddenFinalText,
      ...(protocolSentinel === undefined ? {} : { protocolSentinel }),
      ...(requiredDeliveryStatus === undefined ? {} : { requiredDeliveryStatus }),
    };
  });
}

function normalizeFinalEvidence(final) {
  if (final === null || typeof final !== 'object') {
    throw Object.assign(new TypeError('Completed runs require final evidence.'), {
      code: 'FINAL_EVIDENCE_MISSING',
    });
  }
  if (!Number.isSafeInteger(final.evidenceRevision) || final.evidenceRevision < 0) {
    throw Object.assign(new TypeError('Final evidence revision is invalid.'), {
      code: 'FINAL_EVIDENCE_INVALID',
    });
  }
  let contentRef;
  try {
    contentRef = requireText(final.contentRef, 'final.contentRef');
  } catch {
    throw Object.assign(new TypeError('Completed runs require a final content reference.'), {
      code: 'FINAL_EVIDENCE_MISSING',
    });
  }
  if (
    !Array.isArray(final.evidenceRefs) ||
    final.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.trim().length === 0)
  ) {
    throw Object.assign(new TypeError('Final business evidence references are invalid.'), {
      code: 'FINAL_EVIDENCE_INVALID',
    });
  }
  return Object.freeze({
    revision: final.evidenceRevision,
    refs: Object.freeze([...new Set(final.evidenceRefs.map((ref) => ref.trim()))]),
    contentRef,
    content: typeof final.content === 'string' ? final.content : '',
    deliveryStatus: normalizeDeliveryStatus(final.deliveryStatus),
  });
}

function normalizeDeliveryStatus(value) {
  if (value === 'not-required' || value === 'verified' || value === 'unverified') {
    return value;
  }
  throw acceptanceError('Final delivery status is invalid.', 'FINAL_EVIDENCE_INVALID');
}

function normalizeModel(value) {
  if (value === null || typeof value !== 'object') {
    throw acceptanceError('A completed run requires model metadata.', 'MODEL_METADATA_INVALID');
  }
  try {
    return {
      connectionId: requireText(value.connectionId, 'model.connectionId'),
      modelId: requireText(value.modelId, 'model.modelId'),
      protocol: requireText(value.protocol, 'model.protocol'),
      codecRevision: requireText(value.codecRevision, 'model.codecRevision'),
    };
  } catch {
    throw acceptanceError('Model metadata is incomplete.', 'MODEL_METADATA_INVALID');
  }
}

function normalizeTimings(value) {
  if (value === null || typeof value !== 'object') {
    throw acceptanceError('Timing evidence is missing.', 'TIMING_EVIDENCE_INVALID');
  }
  const timings = {
    totalMs: normalizeDuration(value.totalMs, 'timings.totalMs'),
    providerMs: normalizeDuration(value.providerMs, 'timings.providerMs'),
    runtimeMs: normalizeDuration(value.runtimeMs, 'timings.runtimeMs'),
  };
  if (timings.providerMs > timings.totalMs || timings.runtimeMs > timings.totalMs) {
    throw acceptanceError('Timing evidence exceeds total duration.', 'TIMING_EVIDENCE_INVALID');
  }
  return timings;
}

function normalizeUsage(value) {
  if (value === null || typeof value !== 'object') {
    throw acceptanceError('Token usage evidence is missing.', 'TOKEN_USAGE_INVALID');
  }
  const usage = {
    inputTokens: normalizeCount(value.inputTokens, 'usage.inputTokens'),
    outputTokens: normalizeCount(value.outputTokens, 'usage.outputTokens'),
    totalTokens: normalizeCount(value.totalTokens, 'usage.totalTokens'),
  };
  if (usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw acceptanceError('Total token usage is inconsistent.', 'TOKEN_USAGE_INVALID');
  }
  return usage;
}

function normalizeDuration(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw acceptanceError(`${name} is invalid.`, 'TIMING_EVIDENCE_INVALID');
  }
  return value;
}

function normalizeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw acceptanceError(`${name} is invalid.`, 'COUNT_EVIDENCE_INVALID');
  }
  return value;
}

function normalizeOracleResult(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value.status !== 'pass' && value.status !== 'fail') ||
    !Number.isSafeInteger(value.evidenceRevision) ||
    value.evidenceRevision < 0
  ) {
    throw acceptanceError('Oracle returned an invalid verdict.', 'ORACLE_RESULT_INVALID');
  }
  let evidenceRef;
  let digest;
  let summary;
  try {
    evidenceRef = requireText(value.evidenceRef, 'oracle.evidenceRef');
    digest = requireText(value.digest, 'oracle.digest');
    summary = requireText(value.summary, 'oracle.summary');
  } catch {
    throw acceptanceError('Oracle returned incomplete evidence.', 'ORACLE_RESULT_INVALID');
  }
  return {
    status: value.status,
    evidenceRevision: value.evidenceRevision,
    evidenceRef,
    digest,
    summary,
  };
}

function normalizePermissionEvidence(value) {
  if (value === null || typeof value !== 'object') {
    throw acceptanceError(
      'A completed run requires permission evidence.',
      'PERMISSION_EVIDENCE_MISSING',
    );
  }
  const countNames = [
    'approvalRequestCount',
    'approvedActionCount',
    'preApprovalSideEffectCount',
  ];
  for (const name of countNames) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) {
      throw acceptanceError(
        `permissionEvidence.${name} is invalid.`,
        'PERMISSION_EVIDENCE_INVALID',
      );
    }
  }
  return {
    approvalRequestCount: value.approvalRequestCount,
    approvedActionCount: value.approvedActionCount,
    preApprovalSideEffectCount: value.preApprovalSideEffectCount,
  };
}

function permissionFailureCode(permissionEvidence) {
  return permissionEvidence.preApprovalSideEffectCount > 0 ? 'PRE_APPROVAL_SIDE_EFFECT' : null;
}

function normalizeArtifactEvidence(value, finalEvidence) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    throw acceptanceError('artifactEvidence is invalid.', 'ARTIFACT_EVIDENCE_INVALID');
  }
  let contentRef;
  let digest;
  try {
    contentRef = requireText(value.contentRef, 'artifactEvidence.contentRef');
    digest = requireText(value.digest, 'artifactEvidence.digest');
  } catch {
    throw acceptanceError('artifactEvidence is incomplete.', 'ARTIFACT_EVIDENCE_INVALID');
  }
  if (contentRef !== finalEvidence.contentRef && !finalEvidence.refs.includes(contentRef)) {
    throw acceptanceError('artifactEvidence is not bound to final evidence.', 'ARTIFACT_EVIDENCE_INVALID');
  }
  return { contentRef, digest };
}

function normalizeIntegrity(value) {
  if (value === null || typeof value !== 'object') {
    throw acceptanceError(
      'A completed run requires recovery integrity evidence.',
      'RECOVERY_INTEGRITY_MISSING',
    );
  }
  const countNames = [
    'orphanToolResultCount',
    'replayedSuccessfulToolCount',
    'duplicateModelInvocationCount',
  ];
  for (const name of countNames) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) {
      throw acceptanceError(`integrity.${name} is invalid.`, 'RECOVERY_INTEGRITY_INVALID');
    }
  }
  if (typeof value.projectionReplayMatch !== 'boolean') {
    throw acceptanceError(
      'integrity.projectionReplayMatch is invalid.',
      'RECOVERY_INTEGRITY_INVALID',
    );
  }
  return {
    orphanToolResultCount: value.orphanToolResultCount,
    replayedSuccessfulToolCount: value.replayedSuccessfulToolCount,
    duplicateModelInvocationCount: value.duplicateModelInvocationCount,
    projectionReplayMatch: value.projectionReplayMatch,
  };
}

function integrityFailureCode(integrity) {
  if (integrity.orphanToolResultCount > 0) return 'ORPHAN_TOOL_RESULT';
  if (integrity.replayedSuccessfulToolCount > 0) return 'SUCCESSFUL_TOOL_REPLAYED';
  if (integrity.duplicateModelInvocationCount > 0) return 'DUPLICATE_MODEL_INVOCATION';
  if (!integrity.projectionReplayMatch) return 'PROJECTION_REPLAY_MISMATCH';
  return null;
}

function summarizeEventSequence(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { first: null, last: null, count: 0 };
  }
  const sequences = events.map((event) => event?.sourceSequence);
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)) {
    throw Object.assign(new TypeError('Event sourceSequence is invalid.'), {
      code: 'EVENT_SEQUENCE_INVALID',
    });
  }
  for (let index = 1; index < sequences.length; index += 1) {
    if (sequences[index] <= sequences[index - 1]) {
      throw acceptanceError(
        'Event sourceSequence must be strictly increasing.',
        'EVENT_SEQUENCE_INVALID',
      );
    }
  }
  const serialized = JSON.stringify(events);
  if (serialized === undefined) {
    throw acceptanceError('Events are not JSON serializable.', 'EVENT_SEQUENCE_INVALID');
  }
  return {
    first: sequences[0],
    last: sequences.at(-1),
    count: sequences.length,
    digest: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
  };
}

function summarizeActions(actions, sideEffectExecutions) {
  if (!Array.isArray(actions)) {
    throw acceptanceError('A completed run requires an actions array.', 'ACTIONS_INVALID');
  }
  const actionIds = new Set();
  const equivalenceCounts = new Map();
  for (const [index, action] of actions.entries()) {
    if (action === null || typeof action !== 'object') {
      throw acceptanceError(`actions[${index}] is invalid.`, 'ACTIONS_INVALID');
    }
    const actionId = requireText(action.actionId, `actions[${index}].actionId`);
    requireText(action.invocationId, `actions[${index}].invocationId`);
    const toolRevision = requireText(action.toolRevision, `actions[${index}].toolRevision`);
    const argumentsDigest = requireText(
      action.argumentsDigest,
      `actions[${index}].argumentsDigest`,
    );
    requireText(action.observationDigest, `actions[${index}].observationDigest`);
    if (actionIds.has(actionId)) {
      throw acceptanceError(`Duplicate committed action id: ${actionId}`, 'ACTIONS_INVALID');
    }
    actionIds.add(actionId);
    const equivalenceKey = `${toolRevision}\0${argumentsDigest}`;
    equivalenceCounts.set(equivalenceKey, (equivalenceCounts.get(equivalenceKey) ?? 0) + 1);
  }

  const counterIds = new Set();
  let duplicateActionCount = 0;
  for (const [index, counter] of (sideEffectExecutions ?? []).entries()) {
    if (counter === null || typeof counter !== 'object') {
      throw acceptanceError(
        `sideEffectExecutions[${index}] is invalid.`,
        'SIDE_EFFECT_COUNTER_INVALID',
      );
    }
    const actionId = requireText(counter.actionId, `sideEffectExecutions[${index}].actionId`);
    if (
      !actionIds.has(actionId) ||
      counterIds.has(actionId) ||
      !Number.isSafeInteger(counter.count) ||
      counter.count < 0
    ) {
      throw acceptanceError(
        `sideEffectExecutions[${index}] does not match one committed action.`,
        'SIDE_EFFECT_COUNTER_INVALID',
      );
    }
    counterIds.add(actionId);
    duplicateActionCount += Math.max(0, counter.count - 1);
  }

  const equivalentActionCount = [...equivalenceCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  return {
    toolCount: actions.length,
    duplicateActionCount,
    equivalentActionCount,
  };
}

function countExactOccurrences(content, needles) {
  let count = 0;
  for (const needle of needles) {
    let offset = 0;
    while (offset < content.length) {
      const index = content.indexOf(needle, offset);
      if (index === -1) break;
      count += 1;
      offset = index + needle.length;
    }
  }
  return count;
}

function normalizeProtocolSentinelEvidence({ expected, actual, events, finalDeliveryLeakCount }) {
  if (expected === undefined) return undefined;
  if (actual === null || typeof actual !== 'object' || actual.sentinel !== expected) {
    throw acceptanceError(
      'Protocol sentinel evidence does not match the injected sentinel.',
      'PROTOCOL_SENTINEL_EVIDENCE_INVALID',
    );
  }
  const ordinaryTextCount = normalizeCount(
    actual.ordinaryTextCount,
    'protocolSentinelEvidence.ordinaryTextCount',
  );
  const handlerExecutionCount = normalizeCount(
    actual.handlerExecutionCount,
    'protocolSentinelEvidence.handlerExecutionCount',
  );
  const observedOrdinaryTextCount = countSentinelInOrdinaryTextBlocks(events, expected);
  if (ordinaryTextCount !== observedOrdinaryTextCount) {
    throw acceptanceError(
      'Protocol sentinel ordinary-text evidence does not match this run event stream.',
      'PROTOCOL_SENTINEL_EVIDENCE_INVALID',
    );
  }
  return {
    disposition: ordinaryTextCount > 0 ? 'ordinary-text' : 'not-observed',
    ordinaryTextCount,
    handlerExecutionCount,
    finalDeliveryLeakCount,
  };
}

function countSentinelInOrdinaryTextBlocks(events, sentinel) {
  if (!Array.isArray(events)) {
    throw acceptanceError(
      'Protocol sentinel events are missing.',
      'PROTOCOL_SENTINEL_EVIDENCE_INVALID',
    );
  }
  let count = 0;
  for (const event of events) {
    const block = event?.type === 'model_block_completed' ? event?.payload?.block : undefined;
    if (block?.type === 'text' && typeof block.text === 'string') {
      count += countExactOccurrences(block.text, [sentinel]);
    }
  }
  return count;
}

function protocolSentinelFailureCode(evidence) {
  if (evidence === undefined) return null;
  if (evidence.handlerExecutionCount > 0) return 'PROTOCOL_SENTINEL_HANDLER_EXECUTED';
  if (evidence.ordinaryTextCount === 0) return 'PROTOCOL_SENTINEL_NOT_OBSERVED';
  return null;
}

function normalizeFailure(error) {
  const category =
    typeof error?.category === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(error.category)
      ? error.category
      : 'internal';
  return {
    code: normalizeReasonCode(error?.code, 'SCENARIO_EXECUTION_FAILED'),
    category,
    retryable: error?.retryable === true,
    message: boundedFailureMessage(error instanceof Error ? error.message : String(error)),
  };
}

function boundedFailureMessage(value) {
  return value.length <= 4_096 ? value : value.slice(0, 4_096);
}

function normalizeReasonCode(value, fallback) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) return fallback;
  return value;
}

function normalizeIdentifier(value, name) {
  const normalized = requireText(value, name);
  if (!SCENARIO_ID_PATTERN.test(normalized)) {
    throw new TypeError(
      `${name} must contain only lowercase letters, digits, dots, underscores or hyphens.`,
    );
  }
  return normalized;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeTextList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError(`${name} must be an array of at most 100 strings.`);
  }
  return [...new Set(value.map((entry, index) => requireText(entry, `${name}[${index}]`)))];
}

function acceptanceError(message, code) {
  return Object.assign(new TypeError(message), { code });
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function runCommandLine(argv) {
  const input = parseCommandLine(argv);
  const scenarioModuleUrl = pathToFileURL(resolve(input.scenarioModule)).href;
  const loaded = await import(scenarioModuleUrl);
  const source = loaded.createAcceptanceScenarios ?? loaded.default ?? loaded.scenarios;
  const scenarios = typeof source === 'function' ? await source() : source;
  const reportDirectory = resolve(input.reportDirectory);
  const report = await runUnifiedAgentAcceptance({
    scenarios,
    reportDirectory,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
  process.stdout.write(
    `${JSON.stringify({
      runId: report.runId,
      reportDirectory: join(reportDirectory, report.runId),
      releaseEligible: report.aggregate.releaseEligible,
      passCount: report.aggregate.passCount,
      failCount: report.aggregate.failCount,
      notRunCount: report.aggregate.notRunCount,
    })}\n`,
  );
  if (!report.aggregate.releaseEligible && !(input.allowNotRun && report.aggregate.failCount === 0)) {
    process.exitCode = 1;
  }
}

function parseCommandLine(argv) {
  const values = new Map();
  const allowed = new Set(['--scenario-module', '--report-directory', '--run-id', '--allow-not-run']);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.has(name)) {
      throw new TypeError(`Invalid acceptance argument: ${name ?? '<missing>'}`);
    }
    if (values.has(name)) throw new TypeError(`Duplicate acceptance argument: ${name}`);
    if (name === '--allow-not-run') {
      values.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`Invalid acceptance argument: ${name ?? '<missing>'}`);
    }
    values.set(name, value);
    index += 1;
  }
  return {
    scenarioModule: values.get('--scenario-module') ?? 'scripts/unified-agent-acceptance-scenarios.mjs',
    reportDirectory: values.get('--report-directory') ?? 'reports/unified-agent-acceptance',
    runId: values.get('--run-id'),
    allowNotRun: values.get('--allow-not-run') === true,
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runCommandLine(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify(normalizeFailure(error))}\n`);
    process.exitCode = 1;
  });
}
