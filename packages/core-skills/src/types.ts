export const SKILL_SCOPES = ['system', 'user', 'project', 'session'] as const;

export type SkillScope = (typeof SKILL_SCOPES)[number];

/**
 * A directory containing one or more Agent Skills directories.
 *
 * Sources with the same scope are resolved in array order: a later source
 * shadows an earlier source. Scope precedence is always
 * session > project > user > system.
 */
export type SkillDirectorySource = {
  scope: SkillScope;
  path: string;
  id?: string;
};

/**
 * Standard Agent Skills frontmatter. SchemaNaut treats `allowed-tools` as a
 * runtime allowlist for the activated Skill. It never grants approval.
 */
export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Readonly<Record<string, string>>;
  allowedTools?: readonly string[];
  /**
   * Unknown top-level fields are retained for round-trip diagnostics only.
   * SchemaNaut never assigns behavior to them.
   */
  extensions: Readonly<Record<string, unknown>>;
};

export type SkillCapabilityRequirement = {
  capabilityId: string;
};

export type SkillCapabilityResolver = (
  requirements: readonly SkillCapabilityRequirement[],
  descriptor: SkillDescriptor,
) => boolean;

/**
 * Tier-1 progressive-disclosure entry. This is the only shape that should be
 * added to an Agent's initial context.
 */
export type SkillCatalogEntry = {
  name: string;
  description: string;
  scope: SkillScope;
};

/**
 * Internal source descriptor. Keep this out of model-facing catalog output.
 */
export type SkillDescriptor = SkillCatalogEntry &
  SkillFrontmatter & {
    sourceId: string;
    sourcePath: string;
    bundleRoot: string;
    sourceOrder: number;
    modifiedAtMs?: number;
    /** SHA-256 of the complete UTF-8 SKILL.md bytes. */
    contentDigest: string;
    /** Portable identity used to reload exactly this captured revision. */
    revisionRef: SkillRevisionRef;
  };

export type SkillRevisionRef = Readonly<{
  schemaVersion: 1;
  revisionId: string;
  scope: SkillScope;
  sourceId: string;
  sourcePath: string;
  bundleRoot: string;
  sourceOrder: number;
  name: string;
  contentDigest: string;
  bundleDigest: string;
}>;

export type SkillResourceManifestEntry = Readonly<{
  path: string;
  contentDigest: string;
  byteSize: number;
}>;

export type SkillRevisionManifest = Readonly<{
  schemaVersion: 1;
  revisionRef: SkillRevisionRef;
  resources: readonly SkillResourceManifestEntry[];
}>;

/**
 * Tier-2 activated Skill. The Markdown body is loaded only on activation.
 */
export type SkillDocument = SkillDescriptor & {
  instructions: string;
};

export type SkillOverlay = {
  /**
   * Complete Agent Skills-compatible SKILL.md content.
   */
  content: string;
  /**
   * Stable, diagnostic-only label. It is never exposed to the model.
   */
  sourcePath?: string;
};

export type SkillBundleLimits = Readonly<{
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}>;

export type SkillIssueCode =
  | 'directory-unavailable'
  | 'frontmatter-too-large'
  | 'file-too-large'
  | 'invalid-document'
  | 'invalid-frontmatter'
  | 'invalid-name'
  | 'name-directory-mismatch'
  | 'read-failed';

export type SkillLoadIssue = {
  code: SkillIssueCode;
  scope: SkillScope;
  path: string;
  message: string;
};

export type SkillConflictEntry = SkillCatalogEntry & {
  sourceId: string;
  sourcePath: string;
};

/**
 * Host/developer diagnostic. This shape is not part of the model catalog.
 */
export type SkillConflict = {
  name: string;
  selected: SkillConflictEntry;
  shadowed: SkillConflictEntry[];
};

export type SkillRefreshResult = {
  changed: boolean;
  revision: number;
  skills: SkillCatalogEntry[];
  issues: SkillLoadIssue[];
  conflicts: SkillConflict[];
};

export type SkillSearchResult = {
  skill: SkillCatalogEntry;
  score: number;
};

export type SkillLookup = {
  name: string;
  scope?: SkillScope;
};

export type SkillInvocation = SkillLookup & {
  arguments: string;
  raw: string;
};

export type ActivatedSkillInvocation = SkillInvocation & {
  skill: SkillDocument;
};

export type SkillRegistryOptions = {
  sources?: readonly SkillDirectorySource[];
  sessionOverlay?: readonly SkillOverlay[];
  /**
   * Generic host-owned availability resolver. The Skills package parses
   * requirements but never assigns meaning to a capability identifier.
   */
  capabilityResolver?: SkillCapabilityResolver;
  /** Optional durable content-addressed cache used for restart recovery. */
  revisionCachePath?: string;
  bundleLimits?: SkillBundleLimits;
};

export type SkillListOptions = {
  scope?: SkillScope;
  /** Override used when a caller must evaluate one immutable host snapshot. */
  capabilityResolver?: SkillCapabilityResolver;
};

export type SkillSearchOptions = SkillListOptions & {
  limit?: number;
};

export type SkillWatchOptions = {
  debounceMs?: number;
  /**
   * Portable safety net for filesystems that drop native watch events.
   * Set to false to disable. Native events still provide immediate refresh.
   */
  pollIntervalMs?: number | false;
  onChange?: (result: SkillRefreshResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
};

export type SkillWatcher = {
  close(): void;
};
