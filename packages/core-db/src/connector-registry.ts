import type { DatabaseEndpoint } from '@dbagent/shared';
import type { DatabaseConnector, ConnectorManifest } from './connector.js';

export class ConnectorRegistry {
  readonly #connectors = new Map<string, DatabaseConnector>();

  register(connector: DatabaseConnector): void {
    validateManifest(connector.manifest);
    if (this.#connectors.has(connector.manifest.id)) {
      throw new Error(`Connector already registered: ${connector.manifest.id}`);
    }
    this.#connectors.set(connector.manifest.id, connector);
  }

  replace(connector: DatabaseConnector): void {
    validateManifest(connector.manifest);
    this.#connectors.set(connector.manifest.id, connector);
  }

  unregister(connectorId: string): boolean {
    return this.#connectors.delete(connectorId);
  }

  get(connectorId: string): DatabaseConnector {
    const connector = this.#connectors.get(connectorId);
    if (!connector) throw new ConnectorNotFoundError(connectorId);
    return connector;
  }

  find(input: { engine: string; transport?: DatabaseEndpoint['transport'] }): DatabaseConnector[] {
    return [...this.#connectors.values()].filter(
      (connector) =>
        connector.manifest.engine === input.engine &&
        (!input.transport || connector.manifest.transports.includes(input.transport)),
    );
  }

  list(): ConnectorManifest[] {
    return [...this.#connectors.values()]
      .map((connector) => structuredClone(connector.manifest))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.#connectors.size;
  }
}

export class ConnectorNotFoundError extends Error {
  constructor(readonly connectorId: string) {
    super(`Connector is not registered: ${connectorId}`);
    this.name = 'ConnectorNotFoundError';
  }
}

function validateManifest(manifest: ConnectorManifest): void {
  if (!manifest.id || !manifest.engine || !manifest.version) {
    throw new Error('Connector manifest id, engine and version are required');
  }
  if (manifest.transports.length === 0) {
    throw new Error(`Connector ${manifest.id} must declare at least one transport`);
  }
  for (const [key, capability] of Object.entries(manifest.capabilities)) {
    if (capability.key !== key) {
      throw new Error(`Connector ${manifest.id} capability key mismatch: ${key}`);
    }
  }
}
