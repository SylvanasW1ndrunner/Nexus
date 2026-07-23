import { randomUUID } from 'node:crypto';
import type { RegisteredLlmModel } from './model-registry.js';
import { estimateModelCost } from './routing.js';
import { LlmProviderError, type LlmUsage } from './types.js';

export type LlmBudgetScope = {
  tenantId: string;
  userId?: string;
  taskType?: string;
};

export type LlmBudgetLimits = {
  maxRequestTokens?: number;
  maxRequestCost?: number;
  maxScopeTokens?: number;
  maxScopeCost?: number;
};

export type LlmBudgetReservation = {
  id: string;
  scopeKey: string;
  estimatedTokens: number;
  estimatedCost?: number;
};

export type LlmBudgetSnapshot = {
  scopeKey: string;
  committedTokens: number;
  committedCost: number;
  reservedTokens: number;
  reservedCost: number;
};

type MutableBudget = LlmBudgetSnapshot;

export class LlmBudgetController {
  private readonly budgets = new Map<string, MutableBudget>();
  private readonly reservations = new Map<string, LlmBudgetReservation>();

  reserve(input: {
    scope: LlmBudgetScope;
    limits?: LlmBudgetLimits;
    model: RegisteredLlmModel;
    estimatedInputTokens: number;
    maxOutputTokens: number;
  }): LlmBudgetReservation {
    const estimatedTokens = normalizeCount(input.estimatedInputTokens) + normalizeCount(input.maxOutputTokens);
    const estimatedCost = estimateModelCost(input.model, input.estimatedInputTokens, input.maxOutputTokens);
    const limits = input.limits ?? {};
    if (limits.maxRequestTokens !== undefined && estimatedTokens > limits.maxRequestTokens) {
      throw budgetError('Estimated request tokens exceed the per-request limit.', {
        estimatedTokens,
        limit: limits.maxRequestTokens,
      });
    }
    if (limits.maxRequestCost !== undefined) {
      if (estimatedCost === undefined) throw budgetError('Pricing is required to enforce the per-request cost limit.');
      if (estimatedCost > limits.maxRequestCost) {
        throw budgetError('Estimated request cost exceeds the per-request limit.', {
          estimatedCost,
          limit: limits.maxRequestCost,
        });
      }
    }
    const scopeKey = budgetScopeKey(input.scope);
    const budget = this.budgets.get(scopeKey) ?? zeroBudget(scopeKey);
    if (limits.maxScopeTokens !== undefined && budget.committedTokens + budget.reservedTokens + estimatedTokens > limits.maxScopeTokens) {
      throw budgetError('Estimated request tokens exceed the remaining scope budget.');
    }
    if (limits.maxScopeCost !== undefined) {
      if (estimatedCost === undefined) throw budgetError('Pricing is required to enforce the scope cost limit.');
      if (budget.committedCost + budget.reservedCost + estimatedCost > limits.maxScopeCost) {
        throw budgetError('Estimated request cost exceeds the remaining scope budget.');
      }
    }
    const reservation: LlmBudgetReservation = {
      id: randomUUID(),
      scopeKey,
      estimatedTokens,
      ...(estimatedCost === undefined ? {} : { estimatedCost }),
    };
    budget.reservedTokens += estimatedTokens;
    budget.reservedCost += estimatedCost ?? 0;
    this.budgets.set(scopeKey, budget);
    this.reservations.set(reservation.id, reservation);
    return { ...reservation };
  }

  commit(reservationId: string, model: RegisteredLlmModel, usage: LlmUsage): LlmBudgetSnapshot {
    return this.commitActual(
      reservationId,
      usage.totalTokens,
      estimateModelCost(model, usage.promptTokens, usage.completionTokens) ?? 0,
    );
  }

  commitActual(reservationId: string, totalTokens: number, cost: number): LlmBudgetSnapshot {
    const reservation = this.requireReservation(reservationId);
    const budget = this.budgets.get(reservation.scopeKey) ?? zeroBudget(reservation.scopeKey);
    budget.reservedTokens = Math.max(0, budget.reservedTokens - reservation.estimatedTokens);
    budget.reservedCost = Math.max(0, budget.reservedCost - (reservation.estimatedCost ?? 0));
    budget.committedTokens += normalizeCount(totalTokens);
    budget.committedCost += Math.max(0, cost);
    this.reservations.delete(reservationId);
    return { ...budget };
  }

  release(reservationId: string): LlmBudgetSnapshot | undefined {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return undefined;
    const budget = this.budgets.get(reservation.scopeKey) ?? zeroBudget(reservation.scopeKey);
    budget.reservedTokens = Math.max(0, budget.reservedTokens - reservation.estimatedTokens);
    budget.reservedCost = Math.max(0, budget.reservedCost - (reservation.estimatedCost ?? 0));
    this.reservations.delete(reservationId);
    return { ...budget };
  }

  snapshot(scope: LlmBudgetScope): LlmBudgetSnapshot {
    return { ...(this.budgets.get(budgetScopeKey(scope)) ?? zeroBudget(budgetScopeKey(scope))) };
  }

  reset(scope: LlmBudgetScope): void {
    const key = budgetScopeKey(scope);
    if ([...this.reservations.values()].some((reservation) => reservation.scopeKey === key)) {
      throw new Error('Cannot reset a budget while reservations are active.');
    }
    this.budgets.delete(key);
  }

  private requireReservation(id: string): LlmBudgetReservation {
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error(`LLM budget reservation is not active: ${id}`);
    return reservation;
  }
}

function budgetScopeKey(scope: LlmBudgetScope): string {
  if (!scope.tenantId.trim()) throw new Error('tenantId is required for budget isolation.');
  return [scope.tenantId, scope.userId ?? '*', scope.taskType ?? '*'].join(':');
}

function zeroBudget(scopeKey: string): MutableBudget {
  return { scopeKey, committedTokens: 0, committedCost: 0, reservedTokens: 0, reservedCost: 0 };
}

function normalizeCount(value: number): number {
  return Math.max(0, Math.trunc(value));
}

function budgetError(message: string, detail?: Record<string, unknown>): LlmProviderError {
  return new LlmProviderError('LLM_BUDGET_EXCEEDED', message, false, undefined, detail);
}
