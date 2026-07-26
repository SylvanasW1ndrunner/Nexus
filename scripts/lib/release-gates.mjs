import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const RELEASE_ARCHIVE_PATTERN = /release\/SchemaNaut-v([^/\s)]+)\/schemanaut-v([^/\s)]+)\.tgz/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY)-----\r?\n(?:[A-Za-z0-9+/=]{16,}\r?\n)+-----END \1-----/g;
const KNOWN_TOKEN_PATTERNS = [
  { rule: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'openai-api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
];
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,;#]+))/g;
const DATABASE_URL_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/([^:\s/@]+):([^@\s/]+)@[^\s"'`]+/gi;
const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const LEGACY_PUBLIC_CONTRACT_PATTERN =
  /\$dbagentType\b|\bdbagent\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/g;

export function verifyReleaseChecksum({ artifactPath, checksumPath, artifactName }) {
  const expectedArtifactName = artifactName ?? basename(artifactPath);
  const checksumText = readFileSync(checksumPath, 'utf8');
  const match = /^([0-9a-f]{64})[ ]{2}([A-Za-z0-9][A-Za-z0-9._-]*)\r?\n$/.exec(checksumText);
  if (!match) {
    const nonEmptyLines = checksumText.split(/\r?\n/).filter((line) => line.length > 0);
    if (nonEmptyLines.length !== 1) {
      throw new Error('SHA256SUMS.txt must contain exactly one checksum entry.');
    }
    throw new Error(
      'SHA256SUMS.txt format must be `<lowercase sha256><two spaces><filename>` with a final newline.',
    );
  }
  if (match[2] !== expectedArtifactName) {
    throw new Error(
      `SHA256SUMS.txt filename must be the expected release archive (${expectedArtifactName}).`,
    );
  }

  const expectedDigest = Buffer.from(match[1], 'hex');
  const actualDigest = createHash('sha256').update(readFileSync(artifactPath)).digest();
  if (
    expectedDigest.length !== actualDigest.length ||
    !timingSafeEqual(expectedDigest, actualDigest)
  ) {
    throw new Error('Release archive checksum does not match SHA256SUMS.txt.');
  }
}

export function findSecretMatches(content) {
  const matches = [];
  const seen = new Set();
  const add = (rule, index) => {
    const line = lineNumberAt(content, index);
    const identity = `${rule}:${line}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    matches.push({ rule, line });
  };

  for (const match of content.matchAll(PRIVATE_KEY_PATTERN)) {
    add('private-key', match.index);
  }
  for (const detector of KNOWN_TOKEN_PATTERNS) {
    for (const match of content.matchAll(detector.pattern)) {
      if (!isExplicitPlaceholder(match[0])) add(detector.rule, match.index);
    }
  }
  for (const match of content.matchAll(AWS_ACCESS_KEY_PATTERN)) {
    if (!isExplicitPlaceholder(match[0])) add('aws-access-key', match.index);
  }
  for (const match of content.matchAll(BEARER_PATTERN)) {
    const value = match[1] ?? '';
    if (!isExplicitPlaceholder(value)) add('bearer-token', match.index);
  }
  for (const match of content.matchAll(DATABASE_URL_PATTERN)) {
    const username = match[1] ?? '';
    const password = match[2] ?? '';
    if (!isDatabasePlaceholder(username, password)) {
      add('database-url-userinfo', match.index);
    }
  }
  for (const match of content.matchAll(ASSIGNMENT_PATTERN)) {
    const name = match[1] ?? '';
    const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    if (!isCredentialName(name)) continue;
    if (isExplicitPlaceholder(value)) continue;
    if (/aws[_-]?secret[_-]?access[_-]?key/i.test(name)) {
      if (value.length >= 32) add('aws-secret-key', match.index);
      continue;
    }
    if (/token/i.test(name) && value.length >= 24 && shannonEntropy(value) >= 4) {
      add('high-entropy-token', match.index);
      continue;
    }
    if (value.length >= 16) add('credential-assignment', match.index);
  }

  return matches.sort(
    (left, right) => left.line - right.line || left.rule.localeCompare(right.rule),
  );
}

export function findLegacyPublicContractMarkers(content) {
  return [...new Set(content.match(LEGACY_PUBLIC_CONTRACT_PATTERN) ?? [])];
}

export function verifyReleaseMetadata({
  rootManifest,
  serverManifest,
  readmeEnglish,
  readmeChinese,
  changelog,
}) {
  const rootVersion = requireVersion(rootManifest?.version, 'root package.json');
  const serverVersion = requireVersion(serverManifest?.version, 'apps/server/package.json');
  if (rootVersion !== serverVersion) {
    throw new Error(
      `Release version mismatch: root package.json=${rootVersion}, apps/server/package.json=${serverVersion}.`,
    );
  }

  verifyReadmeArchivePaths('README.md', readmeEnglish, rootVersion);
  verifyReadmeArchivePaths('README.zh-CN.md', readmeChinese, rootVersion);
  const targetHeading = new RegExp(`^## \\[${escapeRegExp(rootVersion)}\\] - (.+)$`, 'm').exec(
    changelog,
  );
  if (!targetHeading) {
    throw new Error(`CHANGELOG.md must contain a section for version ${rootVersion}.`);
  }
  const releaseState = targetHeading[1]?.trim() ?? '';
  const readmesDescribeUnpublished =
    /has not been published|not yet been published/i.test(readmeEnglish) ||
    /尚未发布|还未发布|未发布/.test(readmeChinese);
  if (readmesDescribeUnpublished) {
    if (!/Unreleased/i.test(releaseState) || !/未发布/.test(releaseState)) {
      throw new Error(
        `CHANGELOG.md version ${rootVersion} must remain "Unreleased / 未发布" while the READMEs describe an unpublished package.`,
      );
    }
  } else if (
    !/Unreleased/i.test(releaseState) &&
    !/^\d{4}-\d{2}-\d{2}(?:\s*\/.*)?$/.test(releaseState)
  ) {
    throw new Error(
      `CHANGELOG.md version ${rootVersion} must be marked Unreleased or have an ISO release date.`,
    );
  }
  return rootVersion;
}

export function readPackagePostgresConfig(environment) {
  const enabled = environment.SCHEMANAUT_PACKAGE_VERIFY_POSTGRES;
  if (enabled === undefined || enabled === '' || enabled === '0') return undefined;
  if (enabled !== '1') {
    throw new Error('SCHEMANAUT_PACKAGE_VERIFY_POSTGRES must be 1 when enabled.');
  }
  const database = environment.SCHEMANAUT_PACKAGE_VERIFY_PG_DATABASE ?? 'dbagent_core_db_test';
  if (!/^[A-Za-z0-9_]+_test$/.test(database)) {
    throw new Error(
      'Installed-package PostgreSQL verification requires a dedicated database ending in `_test`.',
    );
  }
  const port = Number(environment.SCHEMANAUT_PACKAGE_VERIFY_PG_PORT ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SCHEMANAUT_PACKAGE_VERIFY_PG_PORT must be an integer from 1 through 65535.');
  }
  return {
    host: environment.SCHEMANAUT_PACKAGE_VERIFY_PG_HOST ?? '127.0.0.1',
    port,
    database,
    username: environment.SCHEMANAUT_PACKAGE_VERIFY_PG_USER ?? 'postgres',
    ...(environment.SCHEMANAUT_PACKAGE_VERIFY_PG_PASSWORD === undefined
      ? {}
      : { password: environment.SCHEMANAUT_PACKAGE_VERIFY_PG_PASSWORD }),
  };
}

export function verifyPublicPackageManifest(manifest) {
  if (manifest?.bin?.schemanaut !== './dist/server/cli.js') {
    throw new Error('The public `schemanaut` CLI entry is missing.');
  }
  const expectedExports = {
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
  };
  for (const [subpath, expected] of Object.entries(expectedExports)) {
    const actual = manifest?.exports?.[subpath];
    if (
      actual?.types !== expected.types ||
      actual?.import !== expected.import ||
      actual?.default !== expected.default
    ) {
      const label = subpath === './server' ? 'server export' : 'SDK export';
      throw new Error(`The public ${label} is missing or points to an unexpected file.`);
    }
  }
}

function verifyReadmeArchivePaths(name, content, version) {
  const expectedPath = `./release/SchemaNaut-v${version}/schemanaut-v${version}.tgz`;
  if (!content.includes(expectedPath)) {
    throw new Error(`${name} must document the local archive path for version ${version}.`);
  }
  const references = [...content.matchAll(RELEASE_ARCHIVE_PATTERN)];
  for (const reference of references) {
    if (reference[1] !== version || reference[2] !== version) {
      throw new Error(`${name} contains a stale or internally inconsistent release archive path.`);
    }
  }
}

function requireVersion(value, location) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${location} must contain a valid release version.`);
  }
  return value;
}

function isDatabasePlaceholder(username, password) {
  return isExplicitPlaceholder(username) && isExplicitPlaceholder(password);
}

function isExplicitPlaceholder(rawValue) {
  const value = rawValue.trim().replace(/^["'`]|["'`]$/g, '');
  if (!value) return true;
  if (value.toUpperCase().includes('EXAMPLE')) return true;
  if (
    /^(?:(?:process|Deno|import\.meta)\.env\b|(?:this|config|options|input|request|environment|env|context|credential|profile|endpoint|provider|settings|params|args)\??\.[A-Za-z_$]|[A-Za-z_$][\w$]*\(|undefined$|null$)/.test(
      value,
    )
  ) {
    return true;
  }
  if (/^\/.*(?:\\[bBdDsSwW]|\(\?:|\[[^\]]+\])/.test(value)) return true;
  if (/^(?:\.{3}|x+|\*+|<[^>]+>|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*)$/i.test(value)) {
    return true;
  }
  if (/^(?:user(?:name)?|pass(?:word)?|token|secret|api[-_ ]?key)$/i.test(value)) return true;
  return /(?:^|[-_./])(?:your|example|sample|placeholder|redacted|dummy|fake|test|changeme|change-me|replace-me|not-a-real)(?:[-_./]|$)/i.test(
    value,
  );
}

function isCredentialName(name) {
  return /(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?token|password|secret|token)$/i.test(
    name,
  );
}

function shannonEntropy(value) {
  const frequencies = new Map();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const frequency of frequencies.values()) {
    const probability = frequency / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
