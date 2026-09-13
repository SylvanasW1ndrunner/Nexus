import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSkillDocument,
  readSkillTextResource,
  SkillRegistry,
  type SkillParseContext,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('Skill snapshot revision contract', () => {
  it('captures the current Session overlay and remains pinned when the source registry changes', async () => {
    const shared = new SkillRegistry({
      sessionOverlay: [
        { content: skillDocument('session-skill', 'captured instructions') },
      ],
    });

    const captured = shared.captureSnapshotView();
    const capturedRevision = captured.inspect('session-skill')!.revisionRef;

    shared.replaceSessionOverlay([
      { content: skillDocument('session-skill', 'replacement instructions') },
    ]);

    expect(captured.list()).toEqual([
      expect.objectContaining({ name: 'session-skill', scope: 'session' }),
    ]);
    expect(captured.inspect('session-skill')?.revisionRef).toEqual(capturedRevision);
    await expect(captured.load('session-skill')).resolves.toMatchObject({
      instructions: 'captured instructions',
      revisionRef: capturedRevision,
    });
    await expect(shared.load('session-skill')).resolves.toMatchObject({
      instructions: 'replacement instructions',
    });
  });

  it('pins capability availability at capture time', () => {
    let available = true;
    const shared = new SkillRegistry({
      capabilityResolver: () => available,
      sessionOverlay: [
        {
          content: [
            '---',
            'name: database-skill',
            'description: Uses database capabilities.',
            'metadata:',
            "  capabilities: 'database'",
            '---',
            'Inspect the database.',
          ].join('\n'),
        },
      ],
    });
    const captured = shared.captureSnapshotView();

    available = false;

    expect(shared.list()).toEqual([]);
    expect(captured.list()).toEqual([
      expect.objectContaining({ name: 'database-skill', scope: 'session' }),
    ]);
  });

  it('binds a content digest and recoverable revision reference into the captured view', async () => {
    const root = await temporaryDirectory();
    const documentPath = await writeSkill(root, 'stable-skill', 'initial instructions');
    const shared = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await shared.refresh();

    const turnView = shared.createSessionView();
    const descriptor = turnView.inspect('stable-skill') as
      | (Record<string, unknown> & {
          contentDigest?: string;
          revisionRef?: Readonly<Record<string, unknown>>;
        })
      | undefined;

    expect(descriptor?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor?.revisionRef).toEqual(
      expect.objectContaining({
        sourcePath: await realpath(documentPath),
        contentDigest: descriptor?.contentDigest,
      }),
    );
  });

  it('loads the Skill revision captured by the Turn instead of rereading the current path', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const shared = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await shared.refresh();
    const firstTurn = shared.createSessionView();

    await writeSkill(root, 'stable-skill', 'replacement instructions');
    await shared.refresh();
    const secondTurn = shared.createSessionView();

    await expect(firstTurn.load('stable-skill')).resolves.toMatchObject({
      instructions: 'initial instructions',
    });
    await expect(secondTurn.load('stable-skill')).resolves.toMatchObject({
      instructions: 'replacement instructions',
    });
  });

  it('advances the Registry revision when only a frozen bundle resource changes', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v1');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    const initial = await registry.refresh();
    const firstRevision = registry.inspect('stable-skill')!.revisionRef;

    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v2');
    const changed = await registry.refresh();
    const secondRevision = registry.inspect('stable-skill')!.revisionRef;

    expect(changed.changed).toBe(true);
    expect(changed.revision).toBe(initial.revision + 1);
    expect(secondRevision.revisionId).not.toBe(firstRevision.revisionId);
  });

  it('captures a UTF-8 BOM SKILL.md without changing its byte identity', async () => {
    const root = await temporaryDirectory();
    const directory = join(root, 'bom-skill');
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from(
      `\uFEFF---\nname: bom-skill\ndescription: BOM skill.\n---\nInstructions.`,
      'utf8',
    );
    await writeFile(join(directory, 'SKILL.md'), bytes);
    const registry = new SkillRegistry({ sources: [{ scope: 'project', path: root }] });

    const result = await registry.refresh();
    expect(result.issues).toEqual([]);
    expect(registry.inspect('bom-skill')?.contentDigest).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    await expect(registry.load('bom-skill')).resolves.toMatchObject({
      instructions: 'Instructions.',
    });
  });

  it('does not expose a mutable reference to the Registry revision identity', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await registry.refresh();
    const before = registry.inspect('stable-skill')!.revisionRef;
    const loaded = await registry.load('stable-skill');

    expect(Object.isFrozen(loaded.revisionRef)).toBe(true);
    expect(() => {
      (loaded.revisionRef as { sourceId: string }).sourceId = 'forged-source';
    }).toThrow();
    expect(registry.inspect('stable-skill')!.revisionRef).toEqual(before);
  });

  it('rejects a revision reference whose identity does not match the captured bytes', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const shared = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await shared.refresh();
    const revisionRef = shared.inspect('stable-skill')!.revisionRef;

    await expect(
      shared.loadRevision({ ...revisionRef, contentDigest: '0'.repeat(64) }),
    ).rejects.toThrow('digest');
  });

  it('does not follow an untrusted revision reference outside configured Skill sources', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const outsidePath = await writeSkill(outside, 'stable-skill', 'outside instructions');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });
    await registry.refresh();
    const captured = registry.inspect('stable-skill')!.revisionRef;
    const outsideContent = await readFile(outsidePath, 'utf8');
    const forged = {
      ...captured,
      sourcePath: outsidePath,
      bundleRoot: join(outside, 'stable-skill'),
      contentDigest: createHash('sha256').update(outsideContent).digest('hex'),
    };

    await expect(registry.loadRevision(forged)).rejects.toThrow(/unavailable|identity/i);
  });

  it('binds every provenance field and the complete bundle manifest to the revision identity', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v1');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root, id: 'project-skills' }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    expect(captured.revisionId).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.bundleDigest).toMatch(/^[a-f0-9]{64}$/);

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    for (const forgedInput of [
      { ...captured, scope: 'user' as const },
      { ...captured, sourceId: 'forged-source' },
      { ...captured, sourceOrder: captured.sourceOrder + 1 },
      { ...captured, sourcePath: join(root, 'forged', 'SKILL.md') },
      { ...captured, bundleRoot: join(root, 'forged') },
      { ...captured, bundleDigest: '1'.repeat(64) },
    ]) {
      const forged = withRevisionIdentity(forgedInput);
      await expect(restarted.loadRevision(forged)).rejects.toThrow(/revision|manifest|identity/i);
    }
  });

  it('derives canonical source, bundle and document paths and rejects symlinked bundle content', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    const outside = join(root, 'outside');
    const documentPath = await writeSkill(source, 'stable-skill', 'initial instructions');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.md'), 'outside', 'utf8');
    await mkdir(join(source, 'stable-skill', 'references'), { recursive: true });
    await symlink(outside, join(source, 'stable-skill', 'references', 'escape'), 'junction');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: source, id: 'project-skills' }],
    });

    const result = await registry.refresh();
    expect(result.skills).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('invalid-document');
    expect(result.issues[0]?.message).toMatch(/symbolic/i);

    await rm(join(source, 'stable-skill', 'references', 'escape'), {
      recursive: true,
      force: true,
    });
    await registry.refresh();
    const descriptor = registry.inspect('stable-skill')!;
    expect(descriptor.sourcePath).toBe(await realpath(documentPath));
    expect(descriptor.bundleRoot).toBe(await realpath(join(source, 'stable-skill')));
  });

  it('rejects a parent-directory symlink introduced before a current resource read', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v1');
    await writeBundleResource(root, 'stable-skill', 'assets/schema.md', 'schema-v1');
    const registry = new SkillRegistry({ sources: [{ scope: 'project', path: root }] });
    await registry.refresh();
    const descriptor = registry.inspect('stable-skill')!;

    await rm(join(root, 'stable-skill', 'references'), { recursive: true, force: true });
    await symlink(
      join(root, 'stable-skill', 'assets'),
      join(root, 'stable-skill', 'references'),
      'junction',
    );

    await expect(readSkillTextResource(descriptor, 'references/schema.md')).rejects.toThrow(
      /symbolic/i,
    );
  });

  it('isolates a Skill whose bundle root is a directory symlink', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeSkill(outside, 'linked-skill', 'outside instructions');
    await symlink(join(outside, 'linked-skill'), join(root, 'linked-skill'), 'junction');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });

    const result = await registry.refresh();
    expect(result.skills).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/bundle root.*symbolic/i);
  });

  it('recovers a captured disk revision after restart even when the source path changed', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    const sourcePath = await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const revisionRef = first.inspect('stable-skill')!.revisionRef;

    await writeSkill(root, 'stable-skill', 'replacement instructions');
    const second = new SkillRegistry({ revisionCachePath: cacheRoot });

    await expect(second.loadRevision(revisionRef)).resolves.toMatchObject({
      instructions: 'initial instructions',
    });
    await unlink(sourcePath);
    await expect(second.loadRevision(revisionRef)).resolves.toMatchObject({
      instructions: 'initial instructions',
    });
  });

  it('returns the frozen SKILL.md metadata and instructions from a cached revision', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkillWithAllowedTools(root, 'stable-skill', 'Read', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    await writeSkillWithAllowedTools(root, 'stable-skill', 'Write', 'replacement instructions');

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(captured)).resolves.toMatchObject({
      allowedTools: ['Read'],
      instructions: 'initial instructions',
      revisionRef: captured,
    });
  });

  it('persists an activated Session overlay revision for restart recovery', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    const first = new SkillRegistry({
      revisionCachePath: cacheRoot,
      sessionOverlay: [{ content: skillDocument('session-skill', 'session instructions') }],
    });
    const revisionRef = first.inspect('session-skill')!.revisionRef;

    await expect(first.load('session-skill')).resolves.toMatchObject({
      instructions: 'session instructions',
    });
    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(revisionRef)).resolves.toMatchObject({
      instructions: 'session instructions',
    });
  });

  it('rediscovers only the exact canonical live revision when no cache is available', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v1');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root, id: 'project-skills' }],
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;

    const restarted = new SkillRegistry({
      sources: [{ scope: 'project', path: root, id: 'project-skills' }],
    });
    await expect(restarted.loadRevision(captured)).resolves.toMatchObject({
      instructions: 'initial instructions',
    });
    await expect(
      restarted.readRevisionResource(captured, 'references/schema.md'),
    ).resolves.toBe('schema-v1');
    await expect(
      restarted.loadRevision({ ...captured, sourceId: 'forged-source' }),
    ).rejects.toThrow(/unavailable|identity/i);
  });

  it('publishes only complete immutable cache entries under concurrent refresh and load', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await registry.refresh();
    const initial = registry.inspect('stable-skill')!.revisionRef;

    await writeSkill(root, 'stable-skill', 'replacement instructions');
    const [loaded] = await Promise.all([
      Promise.all(Array.from({ length: 16 }, async () => await registry.loadRevision(initial))),
      registry.refresh(),
    ]);

    expect(new Set(loaded.map(({ instructions }) => instructions))).toEqual(
      new Set(['initial instructions']),
    );
    await expect(registry.loadRevision(initial)).resolves.toMatchObject({
      instructions: 'initial instructions',
    });
  });

  it('freezes bundle resources for the Turn and recovers them after restart', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v1');
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await registry.refresh();
    const firstTurn = registry.createSessionView();
    const firstRevision = firstTurn.inspect('stable-skill')!.revisionRef;

    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v2');
    await registry.refresh();
    const secondTurn = registry.createSessionView();
    const secondRevision = secondTurn.inspect('stable-skill')!.revisionRef;

    await expect(
      firstTurn.readRevisionResource(firstRevision, 'references/schema.md'),
    ).resolves.toBe('schema-v1');
    await expect(
      secondTurn.readRevisionResource(secondRevision, 'references/schema.md'),
    ).resolves.toBe('schema-v2');
    await expect(
      readSkillTextResource(firstTurn.inspect('stable-skill')!, 'references/schema.md'),
    ).resolves.toBe('schema-v2');

    await rm(join(root, 'stable-skill'), { recursive: true, force: true });
    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(
      restarted.readRevisionResource(firstRevision, 'references/schema.md'),
    ).resolves.toBe('schema-v1');
  });

  it('isolates bundles that exceed the frozen resource limits', async () => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'oversized-skill', 'instructions');
    await writeBundleResource(
      root,
      'oversized-skill',
      'assets/oversized.bin',
      'x'.repeat(4 * 1_024 * 1_024 + 1),
    );
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
    });

    const result = await registry.refresh();
    expect(result.skills).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('file-too-large');
    expect(result.issues[0]?.message).toMatch(/resource/i);
  });

  it('revalidates cached manifests against the configured bundle limits', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'schema-v1');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;

    const restarted = new SkillRegistry({
      revisionCachePath: cacheRoot,
      bundleLimits: { maxFiles: 1 },
    });
    await expect(restarted.loadRevision(captured)).rejects.toThrow(/file limit/i);
  });

  it('does not count revision-manifest JSON overhead as frozen bundle content', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    const serialized = JSON.parse(
      await readFile(join(cacheRoot, 'manifests', `${captured.revisionId}.json`), 'utf8'),
    ) as { resources: { byteSize: number }[] };
    const totalBytes = serialized.resources.reduce((total, entry) => total + entry.byteSize, 0);

    const restarted = new SkillRegistry({
      revisionCachePath: cacheRoot,
      bundleLimits: { maxTotalBytes: totalBytes },
    });
    await expect(restarted.loadRevision(captured)).resolves.toMatchObject({
      instructions: 'initial instructions',
    });
  });

  it('rejects a cached manifest whose declared SKILL.md byte size was forged', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    const path = join(cacheRoot, 'manifests', `${captured.revisionId}.json`);
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      resources: { path: string; byteSize: number }[];
    };
    manifest.resources.find(({ path }) => path === 'SKILL.md')!.byteSize += 1;
    await writeFile(path, JSON.stringify(manifest), 'utf8');

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(captured)).rejects.toThrow(/bundle digest|size|corrupt/i);
  });

  it('rejects a structurally malformed cached revision manifest with a typed boundary error', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    const path = join(cacheRoot, 'manifests', `${captured.revisionId}.json`);
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.resources = [null];
    await writeFile(path, JSON.stringify(manifest), 'utf8');

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(captured)).rejects.toThrow(/manifest.*invalid/i);
  });

  it('rejects a cached content blob whose bytes no longer match its address', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    await writeFile(join(cacheRoot, 'blobs', captured.contentDigest), 'tampered', 'utf8');

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(captured)).rejects.toThrow(/blob digest|corrupt/i);
  });

  it('reports an incomplete cache when a manifest survives without its content blob', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    await unlink(join(cacheRoot, 'blobs', captured.contentDigest));

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(captured)).rejects.toThrow(/cache is incomplete/i);
  });

  it('does not follow a cache directory symlink outside the revision cache root', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    await writeSkill(root, 'stable-skill', 'initial instructions');
    const first = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    await first.refresh();
    const captured = first.inspect('stable-skill')!.revisionRef;
    const content = await readFile(join(cacheRoot, 'blobs', captured.contentDigest));
    await writeFile(join(outside, captured.contentDigest), content);
    await rm(join(cacheRoot, 'blobs'), { recursive: true, force: true });
    await symlink(outside, join(cacheRoot, 'blobs'), 'junction');

    const restarted = new SkillRegistry({ revisionCachePath: cacheRoot });
    await expect(restarted.loadRevision(captured)).rejects.toThrow(/symbolic|escapes/i);
  });

  it.each([
    [{ maxFiles: 1 }, /file limit/i],
    [{ maxTotalBytes: 96 }, /total resource limit/i],
  ] as const)('isolates bundles outside aggregate limit %j', async (bundleLimits, message) => {
    const root = await temporaryDirectory();
    await writeSkill(root, 'stable-skill', 'initial instructions');
    await writeBundleResource(root, 'stable-skill', 'references/schema.md', 'x'.repeat(64));
    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      bundleLimits,
    });

    const result = await registry.refresh();
    expect(result.skills).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('file-too-large');
    expect(result.issues[0]?.message).toMatch(message);
  });
});

describe('Skill allowed-tools runtime contract', () => {
  it('parses allowed-tools as a Runtime allowlist rather than a pre-approval hint', () => {
    const context: SkillParseContext = {
      scope: 'project',
      sourceId: 'project',
      sourcePath: 'C:/workspace/.schemanaut/skills/code-review/SKILL.md',
      bundleRoot: 'C:/workspace/.schemanaut/skills/code-review',
      sourceOrder: 0,
      expectedName: 'code-review',
    };

    const document = parseSkillDocument(
      [
        '---',
        'name: code-review',
        'description: Review a project with a bounded runtime tool set.',
        'allowed-tools: Read Bash(git status) sql_execute',
        '---',
        'Inspect the project and report evidence.',
      ].join('\n'),
      context,
    ) as unknown as Record<string, unknown>;

    expect(document.allowedTools).toEqual(['Read', 'Bash(git status)', 'sql_execute']);
    expect(document).not.toHaveProperty('preapprovedTools');
  });

  it('distinguishes no Skill restriction from an explicit empty allowlist', () => {
    const context: SkillParseContext = {
      scope: 'project',
      sourceId: 'project',
      sourcePath: 'C:/workspace/.schemanaut/skills/code-review/SKILL.md',
      bundleRoot: 'C:/workspace/.schemanaut/skills/code-review',
      sourceOrder: 0,
      expectedName: 'code-review',
    };
    const unrestricted = parseSkillDocument(
      ['---', 'name: code-review', 'description: Review code.', '---', 'Review.'].join('\n'),
      context,
    );
    const emptyValues = [
      'allowed-tools:',
      'allowed-tools: null',
      "allowed-tools: ''",
      "allowed-tools: '   '",
    ].map((allowedTools) =>
      parseSkillDocument(
        [
          '---',
          'name: code-review',
          'description: Review code.',
          allowedTools,
          '---',
          'Review.',
        ].join('\n'),
        context,
      ),
    );

    expect(unrestricted).not.toHaveProperty('allowedTools');
    expect(emptyValues.map(({ allowedTools }) => allowedTools)).toEqual([[], [], [], []]);
  });
});

describe('Session Skill bundle limits', () => {
  it('isolates an oversized Session overlay before it enters the catalog', () => {
    const registry = new SkillRegistry({
      bundleLimits: { maxFileBytes: 96, maxTotalBytes: 96 },
      sessionOverlay: [
        { content: skillDocument('large-session-skill', 'x'.repeat(256)) },
      ],
    });

    expect(registry.list()).toEqual([]);
    expect(registry.issues()).toHaveLength(1);
    expect(registry.issues()[0]?.code).toBe('file-too-large');
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-skill-snapshot-'));
  temporaryDirectories.push(path);
  return path;
}

async function writeSkill(root: string, name: string, body: string): Promise<string> {
  const directory = join(root, name);
  const path = join(directory, 'SKILL.md');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    ['---', `name: ${name}`, `description: ${name} description`, '---', body].join('\n'),
    'utf8',
  );
  return path;
}

async function writeSkillWithAllowedTools(
  root: string,
  name: string,
  allowedTools: string,
  body: string,
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      `allowed-tools: ${allowedTools}`,
      '---',
      body,
    ].join('\n'),
    'utf8',
  );
}

async function writeBundleResource(
  root: string,
  name: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, name, ...relativePath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function withRevisionIdentity<T extends { revisionId: string }>(
  value: T,
): T {
  const identity: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'revisionId') identity[key] = entry;
  }
  return {
    ...value,
    revisionId: createHash('sha256').update(canonicalJson(identity)).digest('hex'),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function skillDocument(name: string, instructions: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    '---',
    instructions,
  ].join('\n');
}
