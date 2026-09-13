import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateDelivery,
  type DeliveryEvidenceSnapshot,
  type DeliveryVerifier,
} from '../src/delivery/delivery-verifier.js';
import { mintContentReference } from '../src/artifacts/content-reference.js';
import { isPendingActionFinalText } from '../src/delivery/delivery-evidence.js';
import { EVIDENCE_REFERENCE_REVISION, mintRuntimeEvidenceReference } from '../src/evidence-reference.js';

const evidence = (revision = 4): DeliveryEvidenceSnapshot => ({
  schemaVersion: 2,
  revision,
  finalContentRef: 'artifact:answer',
  finalText: 'The query returned 42 orders.',
  finalTextDigest: textDigest('The query returned 42 orders.'),
  evidenceRefs: [runtimeEvidenceRef('orders')],
  selection: 'latest-delivery-ready',
  toolEvidence: [{
    evidenceRevision: revision,
    observationId: 'observation-orders',
    invocationId: 'invocation-orders',
    summary: 'Query returned 42 orders.',
    evidenceRefs: [runtimeEvidenceRef('orders')],
    completionEvidence: {
      kind: 'database-result', deliveryReady: true, outcome: 'succeeded',
      provenance: {
        issuer: 'runtime', ownerId: 'direct:sql_execute', toolName: 'sql_execute',
        toolRevision: 'sql_execute.v1', handlerRevision: 'sql_execute.handler.v1',
        intentRevision: 'prepared-tool-intent.v1', toolSource: 'database',
        sourceId: 'schemanaut.database', generation: '1',
      },
      executionId: 'orders', metrics: { rowCount: 42 },
    },
    modelProjection: { rows: [{ order_count: 42 }] },
  }],
});

describe('deterministic delivery verification', () => {
  it('recognizes explicit unfinished tool promises without rejecting completed summaries', () => {
    expect(isPendingActionFinalText('git_stage is available. Let me stage the file.')).toBe(true);
    expect(isPendingActionFinalText('Let me get the details of the other three tables in parallel.')).toBe(true);
    expect(isPendingActionFinalText('Let me examine the data relationships with more detail. Let me sample joined data and understand severities.')).toBe(true);
    expect(isPendingActionFinalText('Now let me materialize the complete NDJSON result as instructed.')).toBe(true);
    expect(isPendingActionFinalText('Page 2 done (accounts 40-79). Continue to page 3.')).toBe(true);
    expect(isPendingActionFinalText('接下来我会运行测试进行验证。')).toBe(true);
    expect(isPendingActionFinalText('I ran the tests and all 12 passed.')).toBe(false);
    expect(isPendingActionFinalText('I fetched the other three tables and included their details.')).toBe(false);
    expect(isPendingActionFinalText('I examined the data relationships and summarized the severities.')).toBe(false);
    expect(isPendingActionFinalText('Pages 1-3 are complete. You can continue with page 4 if desired.')).toBe(false);
    expect(isPendingActionFinalText('Pages 1-3 are complete. All requested accounts were analyzed.')).toBe(false);
    expect(isPendingActionFinalText('You can run the test command later if desired.')).toBe(false);
    expect(isPendingActionFinalText('You can fetch the other tables later if desired.')).toBe(false);
    expect(isPendingActionFinalText('You can examine the data relationships later if desired.')).toBe(false);
  });

  it('completes an ordinary conversation as not-required without a verifier', () => {
    expect(evaluateDelivery({ evidence: evidence() })).toEqual({
      action: 'complete',
      deliveryStatus: 'not-required',
      evidenceRevision: 4,
    });
  });

  it('accepts a required verifier only against the exact immutable evidence revision', () => {
    const verifier: DeliveryVerifier = {
      verifierId: 'orders-created',
      revision: 'v3',
      mode: 'required',
      verify(snapshot) {
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.evidenceRefs)).toBe(true);
        expect(Object.isFrozen(snapshot.toolEvidence)).toBe(true);
        expect(snapshot.finalText).toBe('The query returned 42 orders.');
        expect(snapshot.toolEvidence[0]?.completionEvidence).toMatchObject({
          kind: 'database-result', deliveryReady: true,
        });
        return { status: 'accepted' };
      },
    };
    expect(evaluateDelivery({ verifier, evidence: evidence(9) })).toEqual({
      action: 'complete',
      deliveryStatus: 'verified',
      evidenceRevision: 9,
      verifier: { verifierId: 'orders-created', revision: 'v3' },
      decision: { status: 'accepted' },
    });
  });

  it('allows at most one revision request for a verifier and evidence revision', () => {
    const verifier: DeliveryVerifier = {
      verifierId: 'artifact-shape',
      revision: 'v1',
      mode: 'required',
      verify: () => ({ status: 'revise', observation: { issue: 'missing-column' } }),
    };
    const first = evaluateDelivery({ verifier, evidence: evidence(6) });
    expect(first).toEqual(expect.objectContaining({
      action: 'revise',
      evidenceRevision: 6,
      observation: { issue: 'missing-column' },
    }));
    expectErrorCode(() => evaluateDelivery({
      verifier,
      evidence: evidence(6),
      priorDecisions: [{
        verifierId: 'artifact-shape',
        verifierRevision: 'v1',
        evidenceRevision: 6,
        decision: 'revise',
      }],
    }), 'DELIVERY_UNVERIFIED');
  });

  it('fails required indeterminate delivery and honestly completes optional delivery unverified', () => {
    const required: DeliveryVerifier = {
      verifierId: 'required', revision: '1', mode: 'required',
      verify: () => ({ status: 'indeterminate', reason: 'evidence-expired' }),
    };
    expect(evaluateDelivery({ verifier: required, evidence: evidence() })).toEqual({
      action: 'fail',
      code: 'DELIVERY_UNVERIFIED',
      deliveryStatus: 'unverified',
      evidenceRevision: 4,
      verifier: { verifierId: 'required', revision: '1' },
      decision: { status: 'indeterminate', reason: 'evidence-expired' },
    });

    const optional: DeliveryVerifier = {
      ...required, verifierId: 'optional', mode: 'optional',
    };
    expect(evaluateDelivery({ verifier: optional, evidence: evidence() })).toEqual({
      action: 'complete',
      deliveryStatus: 'unverified',
      evidenceRevision: 4,
      verifier: { verifierId: 'optional', revision: '1' },
      decision: { status: 'indeterminate', reason: 'evidence-expired' },
    });
  });

  it('rejects asynchronous, malformed and mismatched verifier decisions', () => {
    const asynchronous = {
      verifierId: 'async', revision: '1', mode: 'required',
      verify: () => Promise.resolve({ status: 'accepted' as const }),
    } as unknown as DeliveryVerifier;
    expectErrorCode(
      () => evaluateDelivery({ verifier: asynchronous, evidence: evidence() }),
      'VERIFIER_CONTRACT_INVALID',
    );

    const malformed: DeliveryVerifier = {
      verifierId: 'bad', revision: '1', mode: 'required',
      verify: () => ({ status: 'revise', observation: undefined }) as never,
    };
    expectErrorCode(
      () => evaluateDelivery({ verifier: malformed, evidence: evidence() }),
      'VERIFIER_CONTRACT_INVALID',
    );
  });

  it('rejects unbounded or causally mismatched final evidence before invoking a verifier', () => {
    let calls = 0;
    const verifier: DeliveryVerifier = {
      verifierId: 'bounded', revision: '1', mode: 'required',
      verify: () => {
        calls += 1;
        return { status: 'accepted' };
      },
    };
    expectErrorCode(() => evaluateDelivery({
      verifier,
      evidence: {
        ...evidence(),
        evidenceRefs: Array.from({ length: 33 }, (_, index) => runtimeEvidenceRef(index.toString(16))),
      },
    }), 'EVIDENCE_SNAPSHOT_INVALID');
    expectErrorCode(() => evaluateDelivery({
      verifier,
      evidence: {
        ...evidence(),
        evidenceRefs: [runtimeEvidenceRef('other')],
      },
    }), 'EVIDENCE_SNAPSHOT_INVALID');
    expect(calls).toBe(0);
  });
});

function expectErrorCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (caught === null || typeof caught !== 'object' || !('code' in caught)) {
    throw new Error(`Expected an error with code ${code}.`);
  }
  expect(caught.code).toBe(code);
}

function textDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function runtimeEvidenceRef(seed: string): string {
  const artifactId = `artifact_${createHash('sha256').update(seed).digest('hex')}`;
  const owner = {
    hostId: 'host-delivery', projectId: 'project-delivery', sessionId: 'session-delivery',
    runId: 'run-delivery', invocationId: 'invocation-orders',
  };
  const contentRef = mintContentReference({
    artifactId, owner, revision: 'content-reference.v1', nonce: `content-${seed}`,
  });
  return mintRuntimeEvidenceReference({
    artifactId, contentRef, owner, revision: EVIDENCE_REFERENCE_REVISION,
    issuedAt: '2026-09-10T00:00:00.000Z', nonce: `evidence-${seed}`,
  }).evidenceRef;
}
