import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse, resolve } from 'node:path';
import { PUBLIC_RUNTIME_DEPENDENCY_SOURCES } from './public-dependencies.mjs';

export const SUPPLY_CHAIN_FILES = Object.freeze({
  sbom: 'SBOM.cdx.json',
  licenses: 'LICENSES.json',
  vulnerabilities: 'VULNERABILITIES.json',
});

export function createSupplyChainDocuments({
  repositoryRoot,
  packageManifest,
  auditReport,
}) {
  const dependencies = Object.entries(packageManifest.dependencies ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, requested]) =>
      resolveInstalledDependency(repositoryRoot, name, requested),
    );
  const rootComponent = {
    type: 'application',
    'bom-ref': `pkg:npm/${encodePurlName(packageManifest.name)}@${packageManifest.version}`,
    name: packageManifest.name,
    version: packageManifest.version,
  };
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: deterministicSerial(packageManifest, dependencies),
    version: 1,
    metadata: { component: rootComponent },
    components: dependencies.map((dependency) => ({
      type: 'library',
      'bom-ref': dependency.purl,
      name: dependency.name,
      version: dependency.version,
      purl: dependency.purl,
      hashes: [{ alg: 'SHA-256', content: dependency.manifestSha256 }],
      licenses: [{ license: { id: dependency.license } }],
      properties: [
        { name: 'schemanaut:requestedVersion', value: dependency.requested },
      ],
    })),
    dependencies: [
      {
        ref: rootComponent['bom-ref'],
        dependsOn: dependencies.map((dependency) => dependency.purl),
      },
      ...dependencies.map((dependency) => ({ ref: dependency.purl, dependsOn: [] })),
    ],
  };
  const licenses = {
    schemaVersion: 1,
    package: { name: packageManifest.name, version: packageManifest.version },
    dependencies: dependencies.map(({ manifestSha256: _hash, purl: _purl, ...dependency }) => ({
      name: dependency.name,
      version: dependency.version,
      requested: dependency.requested,
      license: dependency.license,
    })),
  };
  const vulnerabilities = normalizeAuditReport(auditReport, packageManifest, dependencies);
  return { sbom, licenses, vulnerabilities };
}

export function assertSupplyChainDocuments({
  packageManifest,
  sbom,
  licenses,
  vulnerabilities,
}) {
  const expectedNames = Object.keys(packageManifest.dependencies ?? {}).sort();
  if (
    sbom?.bomFormat !== 'CycloneDX' ||
    sbom?.specVersion !== '1.5' ||
    !Array.isArray(sbom.components)
  ) {
    throw new Error('SBOM.cdx.json is not a CycloneDX 1.5 document.');
  }
  const componentNames = sbom.components.map((component) => component.name).sort();
  if (JSON.stringify(componentNames) !== JSON.stringify(expectedNames)) {
    throw new Error('SBOM.cdx.json does not cover every published runtime dependency.');
  }
  if (!Array.isArray(licenses?.dependencies)) {
    throw new Error('LICENSES.json is missing its dependency inventory.');
  }
  const licenseNames = licenses.dependencies.map((dependency) => dependency.name).sort();
  if (
    JSON.stringify(licenseNames) !== JSON.stringify(expectedNames) ||
    licenses.dependencies.some(
      (dependency) => typeof dependency.license !== 'string' || !dependency.license.trim(),
    )
  ) {
    throw new Error('LICENSES.json does not identify every runtime dependency license.');
  }
  if (
    vulnerabilities?.schemaVersion !== 1 ||
    !['scanned', 'not-scanned-offline'].includes(vulnerabilities?.status) ||
    !Array.isArray(vulnerabilities?.vulnerabilities)
  ) {
    throw new Error('VULNERABILITIES.json has an invalid or ambiguous scan status.');
  }
  if (
    vulnerabilities.status === 'not-scanned-offline' &&
    vulnerabilities.vulnerabilities.length !== 0
  ) {
    throw new Error('An offline vulnerability report cannot contain unverified findings.');
  }
}

function resolveInstalledDependency(repositoryRoot, name, requested) {
  if (typeof requested !== 'string' || !requested.trim() || requested.startsWith('workspace:')) {
    throw new Error(`Invalid published dependency version for ${name}.`);
  }
  const workspace = PUBLIC_RUNTIME_DEPENDENCY_SOURCES[name];
  if (!workspace) throw new Error(`No workspace source is registered for ${name}.`);
  const workspaceRoot = join(resolve(repositoryRoot), ...workspace.split('/'));
  const directManifest = join(workspaceRoot, 'node_modules', ...name.split('/'), 'package.json');
  const manifestPath = existsSync(directManifest)
    ? directManifest
    : findPackageManifest(
        createRequire(join(workspaceRoot, 'package.json')).resolve(name),
        name,
      );
  const source = readFileSync(manifestPath);
  const manifest = JSON.parse(source.toString('utf8'));
  const license = normalizeLicense(manifest.license ?? manifest.licenses);
  if (!license) throw new Error(`Installed dependency ${name} does not declare a license.`);
  const version = String(manifest.version ?? '').trim();
  if (!version) throw new Error(`Installed dependency ${name} does not declare a version.`);
  return {
    name,
    version,
    requested,
    license,
    manifestSha256: createHash('sha256').update(source).digest('hex'),
    purl: `pkg:npm/${encodePurlName(name)}@${version}`,
  };
}

function findPackageManifest(entry, expectedName) {
  let directory = dirname(entry);
  const volumeRoot = parse(directory).root;
  while (directory !== volumeRoot) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
      if (manifest.name === expectedName) return candidate;
    }
    directory = dirname(directory);
  }
  throw new Error(`Unable to locate installed package manifest for ${expectedName}.`);
}

function normalizeLicense(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => (typeof item === 'string' ? item : item?.type))
    .filter((item) => typeof item === 'string' && item.trim())
    .join(' OR ');
}

function normalizeAuditReport(auditReport, packageManifest, dependencies) {
  const identity = { name: packageManifest.name, version: packageManifest.version };
  if (auditReport === undefined) {
    return {
      schemaVersion: 1,
      package: identity,
      status: 'not-scanned-offline',
      scanner: 'none',
      disclaimer:
        'No advisory database was available during this offline build. This is not a claim that the dependency graph has zero vulnerabilities.',
      dependencies: dependencies.map(({ name, version }) => ({ name, version })),
      vulnerabilities: [],
    };
  }
  const advisories = auditReport.advisories ?? auditReport.vulnerabilities ?? {};
  const vulnerabilities = Object.entries(advisories)
    .map(([id, finding]) => ({
      id: String(finding?.id ?? id),
      module: String(finding?.module_name ?? finding?.name ?? 'unknown'),
      severity: String(finding?.severity ?? 'unknown'),
      title: String(finding?.title ?? finding?.overview ?? 'Dependency advisory'),
      url: typeof finding?.url === 'string' ? finding.url : undefined,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    package: identity,
    status: 'scanned',
    scanner: 'pnpm-audit-json',
    dependencies: dependencies.map(({ name, version }) => ({ name, version })),
    vulnerabilities,
  };
}

function encodePurlName(name) {
  return name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
}

function deterministicSerial(packageManifest, dependencies) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        name: packageManifest.name,
        version: packageManifest.version,
        dependencies: dependencies.map(({ name, version }) => ({ name, version })),
      }),
    )
    .digest('hex');
  return `urn:uuid:${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(
    17,
    20,
  )}-${hash.slice(20, 32)}`;
}
