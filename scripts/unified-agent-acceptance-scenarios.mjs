export const DETERMINISTIC_AGENT_ACCEPTANCE_SCENARIOS = Object.freeze([
  'base.workspace-process-repair',
  'cap.deferred-search-load',
  'cap.git-workflow',
  'cap.database-missing-and-query',
  'cap.forge-provider-choice',
  'cap.container-risk-gate',
  'cap.browser-artifact',
  'cap.language-diagnostics-format',
  'cap.documents-extract-convert',
  'cap.data-notebook-profile-run',
  'cap.cancel-recover',
  'cap.large-result-retention',
]);

/**
 * Declares the deterministic acceptance matrix independently from Host wiring.
 * Task 7 supplies a scripted-model adapter that performs each actual Journal,
 * Artifact, permission, workspace, and process operation.
 */
export async function createAcceptanceScenarios(options = {}) {
  const adapter = options.adapter;
  return Object.freeze(DETERMINISTIC_AGENT_ACCEPTANCE_SCENARIOS.map((id) => Object.freeze({
    id,
    required: true,
    maxEquivalentActionCount: 0,
    execute: async () => {
      if (adapter?.execute === undefined) {
        return { status: 'not-run', reasonCode: 'HOST_WIRING_UNAVAILABLE' };
      }
      return await adapter.execute({ id });
    },
    oracle: async ({ finalEvidence }) => {
      if (adapter?.oracle === undefined) {
        throw new Error(`No external oracle is wired for ${id}.`);
      }
      return await adapter.oracle({ id, finalEvidence });
    },
  })));
}

export default createAcceptanceScenarios;
