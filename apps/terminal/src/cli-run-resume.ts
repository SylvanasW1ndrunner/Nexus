import type { AgentRunHandle } from '@dbagent/agent-host';

type CliRunRuntime<Handle extends Pick<AgentRunHandle, 'resume'>> = {
  openAgentRun(runId: string): Promise<Handle>;
};

/** Reopen the durable Run before asking its controller to continue it. */
export async function resumeCliRun<Handle extends Pick<AgentRunHandle, 'resume'>>(
  runtime: CliRunRuntime<Handle>,
  runId: string,
): Promise<Handle> {
  const handle = await runtime.openAgentRun(runId);
  await handle.resume();
  return handle;
}
