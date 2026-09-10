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
  /** Static pnpm module search roots; an inherited NODE_PATH is appended by the Host. */
  nodePath: readonly string[];
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
  if (!descriptor || !['executable', 'node-npm-shim'].includes(descriptor.kind) || !Array.isArray(descriptor.files) || descriptor.files.length > 2 || !Array.isArray(descriptor.prefixArgv) || !Array.isArray(descriptor.nodePath) || descriptor.nodePath.length > 64) throw new Error('Executable descriptor is invalid.');
  if (descriptor.kind === 'executable' ? descriptor.files.length !== 0 || descriptor.prefixArgv.length !== 0 || descriptor.nodePath.length !== 0 : descriptor.files.length !== 2 || descriptor.prefixArgv.length !== 1 || descriptor.prefixArgv[0] !== descriptor.files[1]?.path || basename(descriptor.executable.path).toLowerCase() !== 'node.exe') throw new Error('Executable descriptor is invalid.');
  const executable = await identify(descriptor.executable.path, true, platform);
  const files = await Promise.all(descriptor.files.map(file => identify(file.path, false, platform)));
  if (JSON.stringify(executable) !== JSON.stringify(descriptor.executable) || JSON.stringify(files) !== JSON.stringify(descriptor.files)) throw new Error('Executable identity changed.');
  if (descriptor.kind === 'node-npm-shim') {
    const parsed = await readNodeShim(descriptor.files[0]!.path);
    if (await realpath(parsed.entry) !== descriptor.prefixArgv[0] || JSON.stringify(parsed.nodePath) !== JSON.stringify(descriptor.nodePath)) throw new Error('Executable shim binding changed.');
  }
  executablePolicyName(descriptor);
}

/** The caller cannot supply a policy alias: derive it from the validated launch file. */
export function executablePolicyName(descriptor: ExecutableLaunchDescriptor): string {
  const path = descriptor.kind === 'executable' ? descriptor.executable.path : descriptor.files[0]!.path;
  const name = basename(path).replace(/\.(?:exe|cmd)$/iu, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) throw new Error('Executable policy identity is invalid.');
  return name;
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
          const launch: ExecutableLaunchDescriptor = Object.freeze({ kind: 'executable', executable: await identify(candidate, true, this.platform), prefixArgv: Object.freeze([]), files: Object.freeze([]), nodePath: Object.freeze([]) });
          executablePolicyName(launch);
          return { status: 'available', launch };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unsupported = true; }
      }
    }
    return unavailable(unsupported ? 'unsupported_launcher' : 'not_found');
  }
  private async nodeShim(path: string): Promise<ExecutableLaunchDescriptor> {
    const shim = await identify(path, false, this.platform);
    const parsed = await readNodeShim(shim.path);
    const root = dirname(shim.path);
    let node: ExecutableFileIdentity | undefined;
    for (const directory of [root, ...this.directories]) {
      try { node = await identify(join(directory, 'node.exe'), true, this.platform); break; } catch { /* Continue static discovery. */ }
    }
    if (!node) throw new Error('Node executable is unavailable.');
    const script = await identify(parsed.entry, false, this.platform);
    const descriptor: ExecutableLaunchDescriptor = Object.freeze({ kind: 'node-npm-shim', executable: node, prefixArgv: Object.freeze([script.path]), files: Object.freeze([shim, script]), nodePath: Object.freeze(parsed.nodePath) });
    await validateExecutableDescriptor(descriptor, this.platform);
    return descriptor;
  }
}

async function readNodeShim(path: string): Promise<{ entry: string; nodePath: string[] }> {
  if (extname(path).toLowerCase() !== '.cmd') throw new Error('Unsupported launcher.');
  const handle = await open(path, 'r');
  let source: string;
  try {
    const bytes = Buffer.alloc(16_385);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 16_384) throw new Error('Unsupported launcher.');
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
  } finally { await handle.close(); }
  const lines = source.replaceAll('\r\n', '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const root = dirname(path);
  let entry: string;
  let nodePath: string[] = [];
  let pnpm = false;
  if (lines[0] === '@SETLOCAL') {
    pnpm = true;
    if (basename(root) !== '.bin' || basename(dirname(root)) !== 'node_modules') throw new Error('Unsupported pnpm launcher location.');
    const modules = dirname(root);
    let cursor = 1;
    if (lines[cursor] === '@IF NOT DEFINED NODE_PATH (') {
      const first = /^@SET "NODE_PATH=([^"%&|<>^`\r\n]+)"$/u.exec(lines[cursor + 1] ?? '');
      if (!first || lines[cursor + 2] !== ') ELSE (' || lines[cursor + 3] !== '@SET "NODE_PATH=' + first[1] + ';%NODE_PATH%"' || lines[cursor + 4] !== ')') throw new Error('Unsupported module path wrapper.');
      nodePath = first[1]!.split(';');
      if (nodePath.length > 64) throw new Error('Module paths exceed their bound.');
      for (const directory of nodePath) { safePath(directory); assertWithin(modules, resolve(directory)); }
      cursor += 5;
    }
    const thenEntry = /^"%~dp0\\node\.exe"\s+"%~dp0\\([^"%]+)" %\*$/u.exec(lines[cursor + 1] ?? '');
    const elseEntry = /^node\s+"%~dp0\\([^"%]+)" %\*$/u.exec(lines[cursor + 4] ?? '');
    if (lines[cursor] !== '@IF EXIST "%~dp0\\node.exe" (' || !thenEntry || lines[cursor + 2] !== ') ELSE (' || lines[cursor + 3] !== '@SET PATHEXT=%PATHEXT:;.JS;=;%' || !elseEntry || thenEntry[1] !== elseEntry[1] || lines[cursor + 5] !== ')' || lines.length !== cursor + 6) throw new Error('Unsupported pnpm launch body.');
    entry = thenEntry[1]!;
  } else {
    const prefix = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', 'IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"', ') ELSE (', 'SET "_prog=node"'];
    if (prefix.some((line, index) => lines[index] !== line)) throw new Error('Unsupported npm launcher.');
    let cursor = prefix.length;
    const elsePathext = lines[cursor] === 'SET PATHEXT=%PATHEXT:;.JS;=;%';
    if (elsePathext) cursor++;
    if (lines[cursor++] !== ')') throw new Error('Unsupported npm branch.');
    const last = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (set PATHEXT=%PATHEXT:;\.JS;=;% & )?"%_prog%"\s+"%dp0%\\([^"%]+)" %\*$/u.exec(lines[cursor] ?? '');
    if (!last || elsePathext === (last[1] !== undefined) || lines.length !== cursor + 1) throw new Error('Unsupported npm launch body.');
    entry = last[2]!;
  }
  if (!/^[\p{L}\p{N} _./\\@+-]+$/u.test(entry) || !['', '.js', '.cjs', '.mjs'].includes(extname(entry).toLowerCase())) throw new Error('Unsupported Node entry.');
  const segments = entry.split(/[\\/]/u);
  if (pnpm && segments[0] === '..') segments.shift();
  if (segments.length < (pnpm ? 2 : 1) || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Unsupported entry traversal.');
  const entryPath = resolve(root, entry);
  const allowed = pnpm ? dirname(root) : root;
  assertWithin(allowed, entryPath);
  assertWithin(await realpath(allowed), await realpath(entryPath));
  return { entry: entryPath, nodePath };
}

function assertWithin(root: string, path: string): void {
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new Error('Launcher target leaves its package boundary.');
}
function unavailable(reason: 'not_found' | 'unsupported_launcher'): ExecutableDiscoveryResult {
  return { status: 'unavailable', reason, diagnostic: 'Install a supported CLI externally, then retry. Restart the Host after changing its PATH.' };
}
