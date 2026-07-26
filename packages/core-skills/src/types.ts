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
 * Standard Agent Skills frontmatter. `allowed-tools` is represented as
 * `preapprovedTools` to preserve its ecosystem meaning: it is a hint about
 * tools that may be pre-approved, not a runtime tool allowlist.
 */
export type SkillFrontmatter = {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Readonly<Record<string, string>>;
  preapprovedTools: readonly string[];
  /**
   * Unknown top-level fields are retained for round-trip diagnostics only.
   * SchemaNaut never assigns behavior to them.
   */
  extensions: Readonly<Record<string, unknown>>;
};

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
  };

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
 * SDK/developer diagnostic. This shape is not part of the model catalog.
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
};

export type SkillListOptions = {
  scope?: SkillScope;
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
