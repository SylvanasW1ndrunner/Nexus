import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ExecutableFileIdentity = Readonly<{ path: string; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string }>;
/** Serializable launch identity. Every file is checked again immediately before spawn. */
export type ExecutableLaunchDescriptor = Readonly<{
  kind: 'executable' | 'node-npm-shim';
  executable: ExecutableFileIdentity;
  prefixArgv: readonly string[];
  files: readonly ExecutableFileIdentity[];
}>;
export type ExecutableDiscoveryResult = Readonly<{ status: 'available'; launch: ExecutableLaunchDescriptor }> | Readonly<{ status: 'unavailable'; reason: 'not_found' | 'unsupported_launcher'; diagnostic: string }>;

function safePath(value: string): void {
  if (typeof value !== 'string' || value.length > 8192 || !isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Executable path is invalid.');
}
async function identify(path: string, executable: boolean, platform: NodeJS.Platform): Promise<ExecutableFileIdentity> {
  safePath(path);
  const canonical = await realpath(path);
  safePath(canonical);
  const info = await stat(canonical, { bigint: true });
  if (!info.isFile()) throw new Error('Executable must be a regular file.');
  if (executable) {
    if (platform === 'win32' && extname(canonical).toLowerCase() !== '.exe') throw new Error('Only native executable launch is supported.');
    if (platform !== 'win32') await access(canonical, constants.X_OK);
  }
  return Object.freeze({ path: canonical, dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
}

export async function validateExecutableDescriptor(descriptor: ExecutableLaunchDescriptor, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!descriptor || !['executable', 'node-npm-shim'].includes(descriptor.kind) || !Array.isArray(descriptor.files) || descriptor.files.length > 2 || !Array.isArray(descriptor.prefixArgv)) throw new Error('Executable descriptor is invalid.');
  if (descriptor.kind === 'executable' ? descriptor.files.length !== 0 || descriptor.prefixArgv.length !== 0 : descriptor.files.length !== 2 || descriptor.prefixArgv.length !== 1 || descriptor.prefixArgv[0] !== descriptor.files[1]?.path || basename(descriptor.executable.path).toLowerCase() !== 'node.exe') throw new Error('Executable descriptor is invalid.');
  const executable = await identify(descriptor.executable.path, true, platform);
  const files = await Promise.all(descriptor.files.map(file => identify(file.path, false, platform)));
  if (JSON.stringify(executable) !== JSON.stringify(descriptor.executable) || JSON.stringify(files) !== JSON.stringify(descriptor.files)) throw new Error('Executable identity changed.');
}

/** Captures only the Host startup PATH; probes never spawn a process or inspect credentials. */
export class PathExecutableDiscovery {
  private readonly directories: readonly string[];
  constructor(environment: NodeJS.ProcessEnv = process.env, private readonly platform: NodeJS.Platform = process.platform) {
    const path = Object.entries(environment).find(([key]) => this.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')?.[1] ?? '';
    this.directories = Object.freeze(path.split(platform === 'win32' ? ';' : ':').filter(value => isAbsolute(value) && value.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(value)).slice(0, 256));
  }
  async discover(name: string): Promise<ExecutableDiscoveryResult> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name)) return unavailable('unsupported_launcher');
    let unsupported = false;
    for (const directory of this.directories) {
      for (const suffix of this.platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
        const candidate = join(directory, name + suffix);
        try {
          if (suffix === '.cmd') return { status: 'available', launch: await this.nodeShim(candidate) };
          return { status: 'available', launch: Object.freeze({ kind: 'executable', executable: await identify(candidate, true, this.platform), prefixArgv: Object.freeze([]), files: Object.freeze([]) }) };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unsupported = true; }
      }
    }
    return unavailable(unsupported ? 'unsupported_launcher' : 'not_found');
  }
  private async nodeShim(path: string): Promise<ExecutableLaunchDescriptor> {
    const shim = await identify(path, false, this.platform);
    if (Number(shim.size) > 16_384) throw new Error('Unsupported launcher.');
    const handle = await open(shim.path, 'r');
    let source: string;
    try {
      const bytes = Buffer.alloc(16_385);
      const result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 16_384) throw new Error('Unsupported launcher.');
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead)).replaceAll('\r\n', '\n').trim();
    } finally { await handle.close(); }
    // Only the exact cmd-shim Node template is supported. No batch evaluation,
    // substitutions, extra flags, custom wrappers or shell fallback are allowed.
    const prefix = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\';
    const tail = '" %*';
    if (!source.startsWith(prefix) || !source.endsWith(tail)) throw new Error('Unsupported launcher.');
    const entry = source.slice(prefix.length, -tail.length);
    if (!/^[\p{L}\p{N} _./\\@+-]+\.(?:js|cjs|mjs)$/u.test(entry)) throw new Error('Unsupported launcher.');
    const root = dirname(shim.path);
    const entryPath = resolve(root, entry);
    const child = relative(root, entryPath);
    if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new Error('Unsupported launcher.');
    let node: ExecutableFileIdentity | undefined;
    for (const directory of [root, ...this.directories]) {
      try { node = await identify(join(directory, 'node.exe'), true, this.platform); break; } catch { /* Continue static discovery. */ }
    }
    if (!node) throw new Error('Node executable is unavailable.');
    const script = await identify(entryPath, false, this.platform);
    const descriptor: ExecutableLaunchDescriptor = Object.freeze({ kind: 'node-npm-shim', executable: node, prefixArgv: Object.freeze([script.path]), files: Object.freeze([shim, script]) });
    await validateExecutableDescriptor(descriptor, this.platform);
    return descriptor;
  }
}
function unavailable(reason: 'not_found' | 'unsupported_launcher'): ExecutableDiscoveryResult {
  return { status: 'unavailable', reason, diagnostic: 'Install a supported CLI externally, then retry. Restart the Host after changing its PATH.' };
}
