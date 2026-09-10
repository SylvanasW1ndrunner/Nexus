import type {
  AgentMode,
  AgentPermissionRule,
  AgentToolPermissionFacts,
  ToolPermissionDecision,
} from './types.js';

export type ToolPermissionEvaluation = Readonly<{
  decision: ToolPermissionDecision;
  mode: AgentMode;
  policyRevision: string;
  facts: AgentToolPermissionFacts;
  matchedRuleIds: readonly string[];
}>;

export class PermissionManager {
  #policy: Readonly<{ revision: string; rules: readonly AgentPermissionRule[] }>;

  snapshot(mode: AgentMode): Readonly<{ mode: AgentMode; revision: string }> {
    return Object.freeze({ mode, revision: this.#policy.revision });
  }

  constructor(
    options: Readonly<{
      rules?: readonly AgentPermissionRule[];
      revision?: string;
    }> = {},
  ) {
    this.#policy = snapshotPolicy(options.rules ?? [], options.revision);
  }

  /** Atomically publishes a new global enterprise policy for subsequent evaluations. */
  replacePolicy(input: Readonly<{
    rules: readonly AgentPermissionRule[];
    revision: string;
  }>): void {
    this.#policy = snapshotPolicy(input.rules, input.revision);
  }

  /** Pure policy resolution used by the Journal-backed Invocation runtime. */
  decide(mode: AgentMode, facts: AgentToolPermissionFacts): ToolPermissionDecision {
    return this.evaluate(mode, facts).decision;
  }

  evaluate(mode: AgentMode, facts: AgentToolPermissionFacts): ToolPermissionEvaluation {
    const policy = this.#policy;
    const normalized = snapshotFacts(facts);
    const matching = policy.rules.filter((rule) => ruleMatches(rule, normalized));
    const explicit = strictestDecision(matching.map((rule) => rule.decision));
    return Object.freeze({
      decision: strictestDecision([decideAutomaticPermission(mode, normalized), ...(explicit === undefined ? [] : [explicit])])!,
      mode,
      policyRevision: policy.revision,
      facts: normalized,
      matchedRuleIds: Object.freeze(matching.map((rule) => rule.id)),
    });
  }
}

export function decideAutomaticPermission(
  mode: AgentMode,
  facts: AgentToolPermissionFacts,
): ToolPermissionDecision {
  if (mode === 'full-access') return 'allow';
  const risky =
    facts.dangerLevel === 'high' ||
    facts.dangerLevel === 'critical' ||
    facts.destructive ||
    facts.credentials ||
    facts.admin || facts.unknownRisk || facts.access === 'destructive' ||
    facts.actions.some(action => ['delete', 'credential', 'admin', 'unknown'].includes(action));
  if (risky) return 'ask';
  if (mode === 'default' && (facts.network || facts.externalWrite || facts.actions.includes('network') || facts.hosts.length > 0 || facts.resolvedAddresses.length > 0)) return 'ask';
  return 'allow';
}

function ruleMatches(rule: AgentPermissionRule, facts: AgentToolPermissionFacts): boolean {
  return (
    selectorMatches(rule.tools, [facts.toolName]) &&
    selectorMatches(rule.actions, facts.actions) &&
    selectorMatches(rule.paths, facts.paths, true) &&
    selectorMatches(rule.hosts, facts.hosts, true)
  );
}

function selectorMatches(
  patterns: readonly string[] | undefined,
  values: readonly string[],
  caseInsensitive = false,
): boolean {
  if (patterns === undefined) return true;
  if (patterns.length === 0) return false;
  if (values.length === 0) return false;
  return patterns.some((pattern) =>
    values.some((value) => wildcardMatches(pattern, value, caseInsensitive)),
  );
}

function snapshotPolicy(
  rules: readonly AgentPermissionRule[],
  revision = 'permission-policy:unversioned',
): Readonly<{ revision: string; rules: readonly AgentPermissionRule[] }> {
  const normalizedRevision = revision.trim();
  if (!normalizedRevision || normalizedRevision.length > 128) throw new Error('Permission policy revision must be bounded.');
  if (rules.length > 128) throw new Error('Permission policy supports at most 128 rules.');
  return Object.freeze({
    revision: normalizedRevision,
    rules: Object.freeze(rules.map(snapshotRule)),
  });
}

function wildcardMatches(pattern: string, value: string, caseInsensitive: boolean): boolean {
  const source = globRegExp(pattern);
  return new RegExp(`^${source}$`, caseInsensitive ? 'iu' : 'u').test(value);
}

function globRegExp(pattern: string): string {
  let result = '';
  for (const character of pattern) {
    if (character === '*') result += '.*';
    else if (character === '?') result += '.';
    else result += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  }
  return result;
}

function strictestDecision(
  decisions: readonly ToolPermissionDecision[],
): ToolPermissionDecision | undefined {
  if (decisions.includes('deny')) return 'deny';
  if (decisions.includes('ask')) return 'ask';
  if (decisions.includes('allow')) return 'allow';
  return undefined;
}

function snapshotRule(rule: AgentPermissionRule): AgentPermissionRule {
  const id = rule.id.trim();
  if (!id || id.length > 2_048) throw new Error('Permission rule id must be bounded.');
  if (!['allow', 'ask', 'deny'].includes(rule.decision)) {
    throw new Error(`Permission rule decision is invalid: ${id}.`);
  }
  return Object.freeze({
    id,
    decision: rule.decision,
    ...(rule.tools === undefined ? {} : { tools: Object.freeze(uniqueStrings(rule.tools)) }),
    ...(rule.actions === undefined ? {} : { actions: Object.freeze(uniqueStrings(rule.actions)) }),
    ...(rule.paths === undefined ? {} : { paths: Object.freeze(uniqueStrings(rule.paths)) }),
    ...(rule.hosts === undefined
      ? {}
      : {
          hosts: Object.freeze(uniqueStrings(rule.hosts).map((host) => host.toLocaleLowerCase())),
        }),
  });
}

function snapshotFacts(facts: AgentToolPermissionFacts): AgentToolPermissionFacts {
  return Object.freeze({
    ...facts,
    actions: Object.freeze([...facts.actions]),
    paths: Object.freeze([...facts.paths]),
    hosts: Object.freeze([...facts.hosts]),
    resolvedAddresses: Object.freeze([...facts.resolvedAddresses]),
    targets: Object.freeze(structuredClone([...facts.targets])),
  });
}

function uniqueStrings<T extends string>(values: readonly T[] | undefined): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized as T);
  }
  return result;
}
