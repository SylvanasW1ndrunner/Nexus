import { describe, expect, it } from 'vitest';
import {
  DeliveryVerificationError,
  evaluateDelivery,
  type DeliveryEvidenceSnapshot,
  type DeliveryVerifier,
} from '../src/delivery/delivery-verifier.js';

const evidence = (revision = 4): DeliveryEvidenceSnapshot => ({
  schemaVersion: 1,
  revision,
  finalContentRef: 'artifact:answer',
  evidenceRefs: ['result:orders'],
});

describe('deterministic delivery verification', () => {
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
    expect(() => evaluateDelivery({
      verifier,
      evidence: evidence(6),
      priorDecisions: [{
        verifierId: 'artifact-shape',
        verifierRevision: 'v1',
        evidenceRevision: 6,
        decision: 'revise',
      }],
    })).toThrowError(expect.objectContaining<Partial<DeliveryVerificationError>>({
      code: 'DELIVERY_UNVERIFIED',
    }));
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
      verify: async () => ({ status: 'accepted' as const }),
    } as unknown as DeliveryVerifier;
    expect(() => evaluateDelivery({ verifier: asynchronous, evidence: evidence() }))
      .toThrowError(expect.objectContaining({ code: 'VERIFIER_CONTRACT_INVALID' }));

    const malformed: DeliveryVerifier = {
      verifierId: 'bad', revision: '1', mode: 'required',
      verify: () => ({ status: 'revise', observation: undefined }) as never,
    };
    expect(() => evaluateDelivery({ verifier: malformed, evidence: evidence() }))
      .toThrowError(expect.objectContaining({ code: 'VERIFIER_CONTRACT_INVALID' }));
  });
});
