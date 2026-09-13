import type { CapabilityCommandRuntime, ExecutableDiscoveryResult } from '@dbagent/core-tools';
import type { FirstPartyCapabilityHost } from '../src/types.js';

const launch = Object.freeze({ kind: 'executable', executable: { path: 'C:/external/tool.exe', dev: '1', ino: '1', size: '1', mtimeNs: '1', ctimeNs: '1' }, prefixArgv: [], files: [], nodePath: [] });
export function available(): ExecutableDiscoveryResult { return { status: 'available', launch }; }
export function unavailable(): ExecutableDiscoveryResult { return { status: 'unavailable', reason: 'not_found', diagnostic: 'Install externally.' }; }
export function host(discover: (name: string) => Promise<ExecutableDiscoveryResult>, command: unknown = {}): FirstPartyCapabilityHost {
  return { workspaceRoot: process.cwd(), executables: { discover }, command: command as CapabilityCommandRuntime };
}
