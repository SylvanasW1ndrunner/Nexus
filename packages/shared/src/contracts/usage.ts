/** Identifies the account/billing route selected for a model call. */
export type UsageMode = 'byok' | 'managed';

/**
 * A cumulative usage total for one billing route. Values are non-negative
 * integers. `windowStartedAt` is the origin of this cumulative total.
 */
export type UsageSnapshot = {
  mode: UsageMode;
  windowStartedAt: string;
  windowEndsAt?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
