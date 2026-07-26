import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  findSecretMatches,
  findLegacyPublicContractMarkers,
  readPackagePostgresConfig,
  verifyPublicPackageManifest,
  verifyReleaseChecksum,
  verifyReleaseMetadata,
} from '../lib/release-gates.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

test('public package manifest exposes both SDK and trusted-host server entrypoints', () => {
  const valid = {
    bin: { schemanaut: './dist/server/cli.js' },
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './server': {
        types: './dist/server/index.d.ts',
        import: './dist/server/index.js',
        default: './dist/server/index.js',
      },
    },
  };
  assert.doesNotThrow(() => verifyPublicPackageManifest(valid));
  assert.throws(
    () =>
      verifyPublicPackageManifest({
        ...valid,
        exports: { '.': valid.exports['.'] },
      }),
    /server.*export/i,
  );
});

test('legacy public wire markers are rejected without flagging internal package names', () => {
  assert.deepEqual(
    findLegacyPublicContractMarkers(
      'const tag = "$dbagentType"; const contract = "dbagent.resource.list";',
    ),
    ['$dbagentType', 'dbagent.resource.list'],
  );
  assert.deepEqual(
    findLegacyPublicContractMarkers(
      'import value from "@dbagent/shared"; const tag = "$schemanautType";',
    ),
    [],
  );
});

test('release checksum accepts one exact entry and rejects tampering or ambiguous manifests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-release-gates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactName = 'schemanaut-v0.1.0.tgz';
  const artifactPath = join(directory, artifactName);
  const checksumPath = join(directory, 'SHA256SUMS.txt');
  const payload = Buffer.from('local package fixture');
  await writeFile(artifactPath, payload);
  const digest = createHash('sha256').update(payload).digest('hex');

  await writeFile(checksumPath, `${digest}  ${artifactName}\n`);
  assert.doesNotThrow(() => verifyReleaseChecksum({ artifactPath, checksumPath, artifactName }));

  await writeFile(checksumPath, `${'0'.repeat(64)}  ${artifactName}\n`);
  assert.throws(
    () => verifyReleaseChecksum({ artifactPath, checksumPath, artifactName }),
    /checksum does not match/i,
  );

  await writeFile(checksumPath, `${digest}  ${artifactName}\n${digest}  ${artifactName}\n`);
  assert.throws(
    () => verifyReleaseChecksum({ artifactPath, checksumPath, artifactName }),
    /exactly one/i,
  );

  await writeFile(checksumPath, `${digest} *renamed.tgz\n`);
  assert.throws(
    () => verifyReleaseChecksum({ artifactPath, checksumPath, artifactName }),
    /format|filename/i,
  );
});

test('secret scanner detects release-risk formats without returning the matched value', () => {
  const samples = [
    ['unquoted assignment', 'API_KEY=longLiveCredentialValue_1234567890', 'credential-assignment'],
    [
      'database userinfo',
      'DATABASE_URL=postgresql://app:actual-db-credential-42@db.internal:5432/app',
      'database-url-userinfo',
    ],
    [
      'database placeholder username with real password',
      'DATABASE_URL=postgresql://user:RealProductionSecret_42@db.internal:5432/app',
      'database-url-userinfo',
    ],
    [
      'bearer authorization',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature-value-123456',
      'bearer-token',
    ],
    [
      'private key',
      '-----BEGIN PRIVATE KEY-----\nZmFrZS1wcml2YXRlLWtleS1ibG9jaw==\n-----END PRIVATE KEY-----\n',
      'private-key',
    ],
    ['aws access key', 'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF', 'aws-access-key'],
    [
      'aws secret',
      'AWS_SECRET_ACCESS_KEY=QwertyUiop1234567890+/qwertyUiop123456789',
      'aws-secret-key',
    ],
    [
      'high entropy token',
      'session_token=J7f/Za9Qp2Wk8Xm4Rc6Vb1Ln3Hs5Dt0UyEe+Gi=',
      'high-entropy-token',
    ],
  ];

  for (const [name, content, expectedRule] of samples) {
    const matches = findSecretMatches(content);
    assert.ok(
      matches.some((match) => match.rule === expectedRule),
      `${name} was not detected: ${JSON.stringify(matches)}`,
    );
    assert.deepEqual(
      Object.keys(matches[0] ?? {}).sort(),
      ['line', 'rule'].sort(),
      'scanner results must not expose matched values',
    );
  }
});

test('secret scanner exempts explicit examples and placeholders', () => {
  const placeholders = [
    'SCHEMANAUT_LLM_API_KEY="..."',
    'API_KEY=<your-api-key>',
    'AUTH_TOKEN=${AUTH_TOKEN}',
    'DATABASE_URL=postgresql://user:password@127.0.0.1:5432/app',
    'Authorization: Bearer YOUR_TOKEN_HERE',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'token=replace-me-before-use',
    'const apiKey = process.env.LLM_API_KEY;',
    'password: config.databasePassword',
    'password: context.credential?.password',
    'const privateKeyMarker = "-----BEGIN PRIVATE KEY-----";',
    String.raw`const SECRET_TOKEN = /\b(?:sk|key|token)-[a-z0-9_-]{16,}/iu;`,
  ];
  for (const placeholder of placeholders) {
    assert.deepEqual(findSecretMatches(placeholder), [], placeholder);
  }
});

test('release metadata requires aligned manifests, README archive paths and changelog state', () => {
  const valid = {
    rootManifest: { version: '0.1.0' },
    serverManifest: { version: '0.1.0' },
    readmeEnglish:
      'The public npm package has not been published yet.\n' +
      'npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz\n',
    readmeChinese:
      '公开 npm 包尚未发布。\n' + 'npm install ./release/SchemaNaut-v0.1.0/schemanaut-v0.1.0.tgz\n',
    changelog: '## [0.1.0] - Unreleased / 未发布\n\n### Added / 新增\n',
  };
  assert.equal(verifyReleaseMetadata(valid), '0.1.0');
  assert.throws(
    () =>
      verifyReleaseMetadata({
        ...valid,
        serverManifest: { version: '0.1.1' },
      }),
    /version/i,
  );
  assert.throws(
    () =>
      verifyReleaseMetadata({
        ...valid,
        readmeEnglish:
          'The public npm package has not been published yet.\n' +
          'npm install ./release/SchemaNaut-v0.0.9/schemanaut-v0.0.9.tgz\n',
      }),
    /README.*0\.1\.0/i,
  );
  assert.throws(
    () =>
      verifyReleaseMetadata({
        ...valid,
        changelog: '## [0.0.9] - Unreleased / 未发布\n',
      }),
    /CHANGELOG.*0\.1\.0/i,
  );
});

test('isolated-package PostgreSQL acceptance is explicit and limited to a test database', () => {
  assert.equal(readPackagePostgresConfig({}), undefined);
  assert.deepEqual(
    readPackagePostgresConfig({
      SCHEMANAUT_PACKAGE_VERIFY_POSTGRES: '1',
      SCHEMANAUT_PACKAGE_VERIFY_PG_HOST: '127.0.0.1',
      SCHEMANAUT_PACKAGE_VERIFY_PG_PORT: '5432',
      SCHEMANAUT_PACKAGE_VERIFY_PG_DATABASE: 'schemanaut_release_test',
      SCHEMANAUT_PACKAGE_VERIFY_PG_USER: 'postgres',
      SCHEMANAUT_PACKAGE_VERIFY_PG_PASSWORD: 'local-fixture-only',
    }),
    {
      host: '127.0.0.1',
      port: 5432,
      database: 'schemanaut_release_test',
      username: 'postgres',
      password: 'local-fixture-only',
    },
  );
  assert.throws(
    () =>
      readPackagePostgresConfig({
        SCHEMANAUT_PACKAGE_VERIFY_POSTGRES: '1',
        SCHEMANAUT_PACKAGE_VERIFY_PG_DATABASE: 'production',
      }),
    /dedicated.*_test/i,
  );
  assert.throws(
    () =>
      readPackagePostgresConfig({
        SCHEMANAUT_PACKAGE_VERIFY_POSTGRES: 'yes',
      }),
    /must be 1/i,
  );
});

test('CI uses least privilege, Node 24-compatible immutable action pins and Windows release evidence', async () => {
  const workflow = await readFile(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
  const approvedActionPins = new Set([
    'actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd',
    'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
    'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
    'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  ]);
  const actionUses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionUses.length >= 10, 'all CI action uses must be audited');
  for (const actionUse of actionUses) {
    assert.match(actionUse, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    assert.ok(approvedActionPins.has(actionUse), `unreviewed CI action pin: ${actionUse}`);
  }
  const checkouts = [
    ...workflow.matchAll(
      /uses:\s+actions\/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd[\s\S]*?persist-credentials:\s+false/g,
    ),
  ];
  assert.ok(checkouts.length >= 3, 'every CI job checkout must disable credential persistence');
  assert.match(workflow, /runs-on:\s+windows-latest/);
  assert.match(workflow, /pnpm (?:run )?typecheck/);
  assert.match(workflow, /pnpm (?:run )?lint/);
  assert.match(workflow, /pnpm (?:run )?test/);
  assert.match(workflow, /pnpm test:npm-package:functional/);
  assert.match(workflow, /SCHEMANAUT_PACKAGE_VERIFY_POSTGRES:\s*['"]?1['"]?/);
  assert.match(workflow, /SCHEMANAUT_PACKAGE_VERIFY_PG_DATABASE:\s*dbagent_core_db_test/);
});
