/** All offsets refer to the original text. Replacements are never scanned again. */
export class CommandRedactor {
  private readonly secrets: RegExp | undefined;
  private readonly redactAll: boolean;

  constructor(environment: NodeJS.ProcessEnv) {
    const values = [...new Set(Object.entries(environment)
      .filter(([key, value]) => value && /(?:token|secret|password|passwd|api[_-]?key|credential|authorization|database_url|dsn)/iu.test(key))
      .map(([, value]) => value!))].sort((a, b) => b.length - a.length);
    this.redactAll = values.length > 1024 || values.reduce((total, value) => total + value.length, 0) > 65_536;
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
    const fields = /["']?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|secret|token|authorization|credential|credentials|connection[_-]?string|database[_-]?url|db[_-]?url|dsn)["']?\s*[:=]\s*/giu;
    for (let match = fields.exec(text); match; match = fields.exec(text)) {
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
