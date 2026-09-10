/** One vocabulary for output fields, environment values and explicit argv flags. */
export const COMMAND_CREDENTIAL_FIELDS = Object.freeze([
  'password', 'passwd', 'pwd', 'api-key', 'access-token', 'refresh-token', 'session-token',
  'secret', 'token', 'proxy-authorization', 'authorization', 'credential', 'credentials',
  'connection-string', 'database-url', 'db-url', 'dsn',
] as const);
const credentialFieldSource = COMMAND_CREDENTIAL_FIELDS.map(name => name.replaceAll('-', '[_-]?')).join('|');
const credentialEnvironmentKey = new RegExp(credentialFieldSource, 'iu');
const credentialArgument = new RegExp('^--?(?:' + credentialFieldSource + ')(?:=|$)', 'iu');

export function isCredentialArgument(argument: string): boolean {
  return credentialArgument.test(argument);
}

function environmentCredentialValues(environment: NodeJS.ProcessEnv): string[] {
  return [...new Set(Object.entries(environment)
    // Shell directory variables are not passwords, including Windows casing.
    .filter(([key, value]) => value && !/^(?:old)?pwd$/iu.test(key) && credentialEnvironmentKey.test(key))
    .map(([, value]) => value!))].sort((a, b) => b.length - a.length);
}

function exceedsCredentialBounds(values: readonly string[]): boolean {
  return values.length > 1024 || values.reduce((total, value) => total + value.length, 0) > 65_536;
}

/** Argv admission is distinct from conservative output masking. */
export class CommandArgumentGuard {
  // Share syntax recognition without applying any Host environment values.
  private readonly syntax = new CommandRedactor({});
  private readonly exactSecrets: ReadonlySet<string>;
  private readonly substringSecrets: readonly string[];
  private readonly rejectAll: boolean;

  constructor(environment: NodeJS.ProcessEnv) {
    const values = environmentCredentialValues(environment);
    this.rejectAll = exceedsCredentialBounds(values);
    this.exactSecrets = new Set(this.rejectAll ? [] : values.filter(value => Buffer.byteLength(value) < 8));
    this.substringSecrets = this.rejectAll ? [] : values.filter(value => Buffer.byteLength(value) >= 8);
  }

  rejects(argument: string): boolean {
    return this.rejectAll || isCredentialArgument(argument) || this.syntax.redact(argument).changed
      || this.exactSecrets.has(argument) || this.substringSecrets.some(value => argument.includes(value));
  }
}

/** All offsets refer to the original text. Replacements are never scanned again. */
export class CommandRedactor {
  private readonly secrets: RegExp | undefined;
  private readonly redactAll: boolean;

  constructor(environment: NodeJS.ProcessEnv) {
    const values = environmentCredentialValues(environment);
    this.redactAll = exceedsCredentialBounds(values);
    this.secrets = values.length && !this.redactAll ? new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu') : undefined;
  }

  redact(text: string): { text: string; changed: boolean } {
    // ProcessRuntime bounds raw output before calling this helper. Keep this
    // independently bounded too, including intermediate buffers and regex state.
    const originalBytes = Buffer.byteLength(text);
    if (originalBytes > 8 * 1024 * 1024) throw new Error('Command output exceeds its redaction bound.');
    if (this.redactAll) return { text: text ? '*' : '', changed: text.length > 0 };
    const masked = new Uint8Array(text.length);
    let changed = false;
    const mark = (start: number, length: number) => {
      if (length > 0) { masked.fill(1, start, start + length); changed = true; }
    };
    if (this.secrets) {
      this.secrets.lastIndex = 0;
      for (let match = this.secrets.exec(text); match; match = this.secrets.exec(text)) mark(match.index, match[0].length);
    }
    // Raw HTTP authentication headers own the entire line: Digest and custom
    // schemes may include comma-separated auth-params or structural characters.
    // Quoted JSON keys cannot match this line-anchored, unquoted header prefix.
    const headers = /^[\t ]*(?:proxy[_-]?)?authorization[\t ]*:[\t ]*/gimu;
    for (let match = headers.exec(text); match; match = headers.exec(text)) {
      const start = headers.lastIndex;
      let end = start;
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
      mark(start, end - start);
      headers.lastIndex = end;
    }
    const fields = new RegExp('["\']?(' + credentialFieldSource + ')["\']?\\s*[:=]\\s*', 'giu');
    for (let match = fields.exec(text); match; match = fields.exec(text)) {
      const authentication = /^(?:proxy[_-]?)?authorization$/iu.test(match[1]!);
      const quote = text[fields.lastIndex];
      const quoted = quote === '"' || quote === "'";
      const start = fields.lastIndex + (quoted ? 1 : 0);
      let end = start;
      // Iterative scanning avoids a backtracking regex stack proportional to an
      // arbitrarily long quoted value. An unterminated value masks the remainder.
      while (end < text.length) {
        if (quoted) {
          if (text[end] === quote) break;
          if (text[end] === '\\') { end = Math.min(end + 2, text.length); continue; }
        } else if (authentication) {
          if (/[\r\n,}\]]/u.test(text[end]!)) break;
          // Authentication headers may contain a scheme plus a quoted token.
          // Keep that whole value in the mask, including commas inside quotes.
          const innerQuote = text[end];
          if (innerQuote === '"' || innerQuote === "'") {
            end++;
            while (end < text.length && text[end] !== innerQuote && !/[\r\n]/u.test(text[end]!)) {
              if (text[end] === '\\' && end + 1 < text.length && !/[\r\n]/u.test(text[end + 1]!)) end++;
              end++;
            }
            if (text[end] === innerQuote) end++;
            continue;
          }
        } else if (/[\s"',}\]]/u.test(text[end]!)) break;
        end++;
      }
      mark(start, end - start);
      fields.lastIndex = end + (quoted && end < text.length ? 1 : 0);
    }
    const bearer = /\bBearer\s+([^\s"',}\]]+)/giu;
    for (let match = bearer.exec(text); match; match = bearer.exec(text)) mark(match.index + match[0].length - match[1]!.length, match[1]!.length);
    const userinfo = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@/giu;
    for (let match = userinfo.exec(text); match; match = userinfo.exec(text)) mark(match.index + match[0].length - match[1]!.length - 1, match[1]!.length);
    const keys = /\bsk-[A-Za-z0-9_-]{8,}/gu;
    for (let match = keys.exec(text); match; match = keys.exec(text)) mark(match.index, match[0].length);
    if (!changed) return { text, changed: false };
    // One output allocation, never larger than the input's UTF-8 bytes. Each
    // nonempty sensitive span becomes one ASCII byte; duplicates cannot expand it.
    const output = Buffer.allocUnsafe(originalBytes);
    let position = 0;
    for (let start = 0; start < text.length;) {
      const secret = masked[start] === 1;
      let end = start + 1;
      while (end < text.length && (masked[end] === 1) === secret) end++;
      if (secret) output[position++] = 42;
      else position += output.write(text.slice(start, end), position, originalBytes - position, 'utf8');
      start = end;
    }
    return { text: output.subarray(0, position).toString('utf8'), changed: true };
  }
}
