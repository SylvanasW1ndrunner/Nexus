import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate, type BrotliDecompress, type Gunzip, type Inflate } from 'node:zlib';

const MAX_DNS_ADDRESSES = 32;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 8_192;
const MAX_URL_CHARS = 8_192;
const WEB_ADDRESS_POLICY_REVISION = 'iana-special-purpose.v2026-09';

/**
 * Versioned conservative subset of the IANA IPv6 special-purpose registry.
 * Entries remain risky even when a registry entry is technically routable.
 */
const SPECIAL_IPV6_PREFIXES: readonly (readonly [prefix: string, bits: number])[] = Object.freeze([
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]);

export type WebAddressFamily = 4 | 6;

export type WebAddressRisk = Readonly<{
  loopback: boolean;
  private: boolean;
  linkLocal: boolean;
  metadata: boolean;
  special: boolean;
}>;

export type PreparedWebAddress = Readonly<{
  address: string;
  family: WebAddressFamily;
  risk: WebAddressRisk;
}>;

/** Durable target identity produced before authorization. */
export type PreparedWebTarget = Readonly<{
  protocol: 'http:' | 'https:';
  url: string;
  hostname: string;
  port: number;
  addresses: readonly PreparedWebAddress[];
  resolverRevision: string;
}>;

export type SecureWebRequest = Readonly<{
  target: PreparedWebTarget;
  headers?: Readonly<Record<string, string>>;
  /** Execute-only bridge headers. These values must never be copied into a prepared intent. */
  ephemeralHeaders?: Readonly<Record<string, string>>;
  acceptedContentTypes: readonly string[];
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
  deadline: string;
}>;

export type SecureWebResponse = Readonly<{
  url: string;
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  contentType?: string;
  charset?: string;
  contentEncoding: 'identity' | 'gzip' | 'deflate' | 'br';
  compressedBytes: number;
  body: Uint8Array;
}>;

export type SecureWebTransport = Readonly<{
  revision: string;
  resolverRevision: string;
  prepareTarget(url: string, options: Readonly<{ signal: AbortSignal; deadline: string }>): Promise<PreparedWebTarget>;
  revalidateTarget(target: PreparedWebTarget, options: Readonly<{ signal: AbortSignal; deadline: string }>): Promise<boolean>;
  request(input: SecureWebRequest): Promise<SecureWebResponse>;
}>;

export type SecureWebTransportErrorCode =
  | 'invalid_url'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'cancelled'
  | 'target_changed'
  | 'invalid_response'
  | 'unsupported_content'
  | 'limit'
  | 'network';

export class SecureWebTransportError extends Error {
  constructor(readonly code: SecureWebTransportErrorCode, message: string) {
    super(message);
    this.name = 'SecureWebTransportError';
  }
}

/**
 * Node transport that pins each GET to an address captured by prepare. It
 * never follows redirects and never reuses an ambient connection pool.
 */
export class NodeSecureWebTransport implements SecureWebTransport {
  readonly revision = 'node-secure-web-transport.v1';
  readonly resolverRevision = `node-dns-lookup-all.v1+${WEB_ADDRESS_POLICY_REVISION}`;

  async prepareTarget(
    value: string,
    options: Readonly<{ signal: AbortSignal; deadline: string }>,
  ): Promise<PreparedWebTarget> {
    const parsed = parseWebUrl(value);
    const hostname = normalizeHostname(parsed.hostname);
    const addresses = await resolveAddresses(hostname, options.signal, options.deadline);
    return Object.freeze({
      protocol: parsed.protocol as 'http:' | 'https:',
      url: canonicalWebUrl(parsed),
      hostname,
      port: parsed.port === '' ? parsed.protocol === 'https:' ? 443 : 80 : Number(parsed.port),
      addresses,
      resolverRevision: this.resolverRevision,
    });
  }

  async revalidateTarget(
    target: PreparedWebTarget,
    options: Readonly<{ signal: AbortSignal; deadline: string }>,
  ): Promise<boolean> {
    assertPreparedTarget(target, this.resolverRevision);
    const current = await this.prepareTarget(target.url, options);
    return sameTarget(target, current);
  }

  async request(input: SecureWebRequest): Promise<SecureWebResponse> {
    assertPositiveBound(input.maxCompressedBytes, 'maxCompressedBytes');
    assertPositiveBound(input.maxDecompressedBytes, 'maxDecompressedBytes');
    assertPositiveBound(input.timeoutMs, 'timeoutMs');
    assertPreparedTarget(input.target, this.resolverRevision);
    if (!(await this.revalidateTarget(input.target, { signal: input.signal, deadline: input.deadline }))) {
      throw new SecureWebTransportError('target_changed', 'The web target address changed after authorization.');
    }
    const selected = input.target.addresses[0];
    if (selected === undefined) throw new SecureWebTransportError('dns', 'The web target has no resolved address.');
    if (input.ephemeralHeaders !== undefined && Object.keys(input.ephemeralHeaders).length > 0 && input.target.protocol !== 'https:') {
      throw new SecureWebTransportError('invalid_url', 'Execute-only credential headers require HTTPS.');
    }
    const headers = normalizeRequestHeaders(input.headers, input.ephemeralHeaders);
    return await requestPinnedAddress(input, selected, headers);
  }
}

export function parseWebUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) {
    throw new SecureWebTransportError('invalid_url', 'Provide a bounded HTTP or HTTPS URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecureWebTransportError('invalid_url', 'Provide a valid HTTP or HTTPS URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SecureWebTransportError('invalid_url', 'Only HTTP and HTTPS URLs are supported.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SecureWebTransportError('invalid_url', 'URL user information is not allowed.');
  }
  if (parsed.hostname === '') throw new SecureWebTransportError('invalid_url', 'The URL host is required.');
  if (parsed.port !== '' && (!Number.isSafeInteger(Number(parsed.port)) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
    throw new SecureWebTransportError('invalid_url', 'The URL port is invalid.');
  }
  return parsed;
}

export function canonicalWebUrl(value: string | URL): string {
  const parsed = parseWebUrl(value.toString());
  parsed.hash = '';
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
  return parsed.toString();
}

export function classifyWebAddress(address: string): WebAddressRisk {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 4) return classifyIpv4(normalized);
  if (family === 6) return classifyIpv6(normalized);
  throw new SecureWebTransportError('dns', 'The resolver returned an invalid IP address.');
}

function classifyIpv4(address: string): WebAddressRisk {
  const octets = address.split('.').map(Number);
  const [a = -1, b = -1, c = -1, d = -1] = octets;
  const loopback = a === 127;
  const privateAddress = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  const linkLocal = a === 169 && b === 254;
  const metadata = (a === 169 && b === 254 && c === 169 && d === 254) ||
    (a === 169 && b === 254 && c === 170 && (d === 2 || d === 23)) ||
    (a === 100 && b === 100 && c === 100 && d === 200) ||
    (a === 168 && b === 63 && c === 129 && d === 16);
  const special = a === 0 || a >= 224 ||
    (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  return Object.freeze({ loopback, private: privateAddress, linkLocal, metadata, special });
}

function classifyIpv6(address: string): WebAddressRisk {
  const bits = ipv6Bits(address);
  const upper96 = bits >> 32n;
  if (upper96 === 0xffffn) return classifyIpv4(ipv4FromBits(Number(bits & 0xffff_ffffn)));
  const loopback = bits === 1n;
  const linkLocal = inIpv6Prefix(bits, ipv6Bits('fe80::'), 10);
  const uniqueLocal = inIpv6Prefix(bits, ipv6Bits('fc00::'), 7);
  const deprecatedSiteLocal = inIpv6Prefix(bits, ipv6Bits('fec0::'), 10);
  const privateAddress = uniqueLocal || deprecatedSiteLocal;
  const metadata = bits === ipv6Bits('fd00:ec2::254');
  const transition = upper96 === 0n || inIpv6Prefix(bits, ipv6Bits('64:ff9b::'), 96) ||
    inIpv6Prefix(bits, ipv6Bits('64:ff9b:1::'), 48) || inIpv6Prefix(bits, ipv6Bits('2002::'), 16) ||
    inIpv6Prefix(bits, ipv6Bits('2001::'), 32);
  const globalUnicast = inIpv6Prefix(bits, ipv6Bits('2000::'), 3);
  const multicast = inIpv6Prefix(bits, ipv6Bits('ff00::'), 8);
  const documentation = inIpv6Prefix(bits, ipv6Bits('2001:db8::'), 32);
  const registeredSpecial = SPECIAL_IPV6_PREFIXES.some(([prefix, prefixBits]) =>
    inIpv6Prefix(bits, ipv6Bits(prefix), prefixBits));
  const special = bits === 0n || multicast || documentation || transition || registeredSpecial ||
    (!globalUnicast && !uniqueLocal && !linkLocal && !deprecatedSiteLocal);
  return Object.freeze({ loopback, private: privateAddress, linkLocal, metadata, special });
}

function ipv6Bits(address: string): bigint {
  const value = address.toLowerCase().split('%', 1)[0]!;
  const halves = value.split('::');
  if (halves.length > 2) throw new SecureWebTransportError('dns', 'The resolver returned an invalid IPv6 address.');
  const left = ipv6Hextets(halves[0] ?? '');
  const right = ipv6Hextets(halves[1] ?? '');
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8) || (halves.length === 2 && missing < 1)) {
    throw new SecureWebTransportError('dns', 'The resolver returned an invalid IPv6 address.');
  }
  const parts = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (parts.length !== 8) throw new SecureWebTransportError('dns', 'The resolver returned an invalid IPv6 address.');
  return parts.reduce((result, part) => (result << 16n) | BigInt(part), 0n);
}

function ipv6Hextets(value: string): number[] {
  if (value === '') return [];
  const raw = value.split(':');
  const parts: number[] = [];
  for (const [index, part] of raw.entries()) {
    if (part.includes('.')) {
      if (index !== raw.length - 1 || isIP(part) !== 4) throw new SecureWebTransportError('dns', 'The resolver returned an invalid IPv6 address.');
      const octets = part.split('.').map(Number);
      parts.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(part)) throw new SecureWebTransportError('dns', 'The resolver returned an invalid IPv6 address.');
    parts.push(Number.parseInt(part, 16));
  }
  return parts;
}

function inIpv6Prefix(value: bigint, prefix: bigint, prefixBits: number): boolean {
  const shift = BigInt(128 - prefixBits);
  return value >> shift === prefix >> shift;
}

function ipv4FromBits(value: number): string {
  return `${value >>> 24}.${value >>> 16 & 0xff}.${value >>> 8 & 0xff}.${value & 0xff}`;
}

async function resolveAddresses(hostname: string, signal: AbortSignal, deadline: string): Promise<readonly PreparedWebAddress[]> {
  if (signal.aborted) throw new SecureWebTransportError('cancelled', 'The web request was cancelled.');
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    return Object.freeze([addressRecord(hostname, literalFamily as WebAddressFamily)]);
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await raceBoundary(dnsLookup(hostname, { all: true, verbatim: true }), signal, deadline);
  } catch (error) {
    if (error instanceof SecureWebTransportError) throw error;
    throw new SecureWebTransportError('dns', 'The web host could not be resolved.');
  }
  if (!Array.isArray(records) || records.length === 0) throw new SecureWebTransportError('dns', 'The web host has no address.');
  if (records.length > MAX_DNS_ADDRESSES) throw new SecureWebTransportError('limit', 'The web host resolved to too many addresses.');
  const unique = new Map<string, PreparedWebAddress>();
  for (const record of records) {
    const address = normalizeAddress(record.address);
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new SecureWebTransportError('dns', 'The resolver returned an invalid address.');
    unique.set(`${family}:${address}`, addressRecord(address, family));
  }
  return Object.freeze([...unique.values()].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address)));
}

function addressRecord(address: string, family: WebAddressFamily): PreparedWebAddress {
  return Object.freeze({ address: normalizeAddress(address), family, risk: classifyWebAddress(address) });
}

function requestPinnedAddress(
  input: SecureWebRequest,
  selected: PreparedWebAddress,
  headers: Readonly<Record<string, string>>,
): Promise<SecureWebResponse> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) return reject(new SecureWebTransportError('cancelled', 'The web request was cancelled.'));
    const parsed = parseWebUrl(input.target.url);
    const deadlineMs = Date.parse(input.deadline);
    if (!Number.isFinite(deadlineMs)) return reject(new SecureWebTransportError('timeout', 'The web request deadline is invalid.'));
    const remaining = Math.min(input.timeoutMs, deadlineMs - Date.now());
    if (remaining <= 0) return reject(new SecureWebTransportError('timeout', 'The web request deadline elapsed.'));
    let settled = false;
    let response: IncomingMessage | undefined;
    let decoder: IncomingMessage | Gunzip | Inflate | BrotliDecompress | undefined;
    let request: ClientRequest | undefined;
    const timer = setTimeout(() => finish(new SecureWebTransportError('timeout', 'The web request timed out.')), remaining);
    timer.unref?.();
    const onAbort = () => finish(new SecureWebTransportError('cancelled', 'The web request was cancelled.'));
    input.signal.addEventListener('abort', onAbort, { once: true });
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    try {
      request = requestFn(parsed, {
        method: 'GET',
        agent: false,
        headers,
        maxHeaderSize: 64 * 1024,
        lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => {
          callback(null, selected.address, selected.family);
        }) as never,
      }, (incoming) => {
        response = incoming;
        incoming.on('error', (error) => finish(mapRequestError(error)));
        incoming.once('aborted', () => finish(new SecureWebTransportError('network', 'The web response ended unexpectedly.')));
        if (settled) {
          destroyQuietly(incoming);
          return;
        }
        try {
        const statusCode = incoming.statusCode;
        if (statusCode === undefined) return finish(new SecureWebTransportError('invalid_response', 'The web server omitted its status.'));
        const responseHeaders = normalizeResponseHeaders(incoming.headers);
        const location = responseHeaders.location;
        if (isRedirectStatus(statusCode)) {
          if (location !== undefined && location.length > MAX_URL_CHARS) return finish(new SecureWebTransportError('invalid_response', 'The response Location is too long.'));
          destroyQuietly(incoming);
          return finish(undefined, Object.freeze({
            url: input.target.url,
            statusCode,
            headers: responseHeaders,
            ...(responseHeaders['content-type'] === undefined ? {} : { contentType: mediaType(responseHeaders['content-type']) }),
            contentEncoding: 'identity' as const,
            compressedBytes: 0,
            body: new Uint8Array(),
          }));
        }
        if (isBodylessStatus(statusCode)) {
          destroyQuietly(incoming);
          return finish(undefined, Object.freeze({
            url: input.target.url,
            statusCode,
            headers: responseHeaders,
            contentEncoding: 'identity' as const,
            compressedBytes: 0,
            body: new Uint8Array(),
          }));
        }
        if (location !== undefined && location.length > MAX_URL_CHARS) return finish(new SecureWebTransportError('invalid_response', 'The response Location is too long.'));
        const contentType = responseHeaders['content-type'] === undefined ? undefined : mediaType(responseHeaders['content-type']);
        const charset = contentCharset(responseHeaders['content-type']);
        if (contentType === undefined || !acceptedContentType(contentType, input.acceptedContentTypes)) {
          return finish(new SecureWebTransportError('unsupported_content', 'The web response content type is not supported.'));
        }
        const declaredLength = responseHeaders['content-length'];
        if (declaredLength !== undefined && /^\d+$/u.test(declaredLength) && Number(declaredLength) > input.maxCompressedBytes) {
          return finish(new SecureWebTransportError('limit', 'The declared web response exceeds its compressed byte limit.'));
        }
        const encoding = contentEncoding(responseHeaders['content-encoding']);
        if (encoding instanceof SecureWebTransportError) return finish(encoding);
        let compressedBytes = 0;
        let decompressedBytes = 0;
        const chunks: Buffer[] = [];
        decoder = decodingStream(incoming, encoding);
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return;
          try {
            compressedBytes += chunk.length;
            if (compressedBytes > input.maxCompressedBytes) finish(new SecureWebTransportError('limit', 'The compressed web response exceeded its byte limit.'));
          } catch {
            finish(new SecureWebTransportError('invalid_response', 'The compressed web response could not be processed.'));
          }
        });
        decoder.on('data', (chunk: Buffer) => {
          if (settled) return;
          try {
            decompressedBytes += chunk.length;
            if (decompressedBytes > input.maxDecompressedBytes) {
              finish(new SecureWebTransportError('limit', 'The decompressed web response exceeded its byte limit.'));
              return;
            }
            chunks.push(Buffer.from(chunk));
          } catch {
            finish(new SecureWebTransportError('limit', 'The decompressed web response could not be buffered within its limit.'));
          }
        });
        decoder.on('error', (error) => finish(new SecureWebTransportError('invalid_response', `The web response could not be decoded: ${safeErrorCode(error)}.`)));
        decoder.once('end', () => {
          try {
            if (!incoming.complete) return finish(new SecureWebTransportError('network', 'The web response ended before the message was complete.'));
            finish(undefined, Object.freeze({
              url: input.target.url,
              statusCode,
              headers: responseHeaders,
              contentType,
              ...(charset === undefined ? {} : { charset }),
              contentEncoding: encoding,
              compressedBytes,
              body: new Uint8Array(Buffer.concat(chunks, decompressedBytes)),
            }));
          } catch {
            finish(new SecureWebTransportError('invalid_response', 'The web response body could not be finalized.'));
          }
        });
        } catch (error) {
          finish(error instanceof SecureWebTransportError ? error : new SecureWebTransportError('invalid_response', 'The web response headers are invalid.'));
        }
      });
      request.on('error', (error) => finish(mapRequestError(error)));
      request.once('socket', (socket: Socket) => {
        socket.on('error', (error) => finish(mapRequestError(error)));
        const event = parsed.protocol === 'https:' ? 'secureConnect' : 'connect';
        socket.once(event, () => {
          try {
            if (normalizeAddress(socket.remoteAddress ?? '') !== selected.address) {
              finish(new SecureWebTransportError('target_changed', 'The connected web address did not match the prepared target.'));
            }
          } catch {
            finish(new SecureWebTransportError('target_changed', 'The connected web address could not be verified.'));
          }
        });
      });
      if (input.signal.aborted) return finish(new SecureWebTransportError('cancelled', 'The web request was cancelled.'));
      request.end();
    } catch (error) {
      finish(mapRequestError(error));
    }

    function finish(error?: SecureWebTransportError, value?: SecureWebResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      if (error !== undefined) {
        destroyQuietly(decoder);
        destroyQuietly(response);
        destroyQuietly(request);
        reject(error);
      } else if (value !== undefined) {
        resolve(value);
      } else {
        reject(new SecureWebTransportError('invalid_response', 'The web response was incomplete.'));
      }
    }
  });
}

function decodingStream(response: IncomingMessage, encoding: SecureWebResponse['contentEncoding']): IncomingMessage | Gunzip | Inflate | BrotliDecompress {
  if (encoding === 'identity') return response;
  const stream = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : createBrotliDecompress();
  response.pipe(stream);
  return stream;
}

function contentEncoding(value: string | undefined): SecureWebResponse['contentEncoding'] | SecureWebTransportError {
  if (value === undefined || value.trim() === '' || value.toLowerCase() === 'identity') return 'identity';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gzip' || normalized === 'deflate' || normalized === 'br') return normalized;
  return new SecureWebTransportError('invalid_response', 'The web response uses an unsupported content encoding.');
}

function acceptedContentType(value: string, accepted: readonly string[]): boolean {
  return accepted.some((candidate) => candidate.endsWith('/*') ? value.startsWith(candidate.slice(0, -1)) : value === candidate);
}

function mediaType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function contentCharset(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let charset: string | undefined;
  for (const parameter of splitHeaderParameters(value).slice(1)) {
    const equals = parameter.indexOf('=');
    if (equals < 0) {
      if (/^\s*charset(?:\s|$)/iu.test(parameter)) {
        throw new SecureWebTransportError('invalid_response', 'The web response charset is invalid.');
      }
      continue;
    }
    const name = parameter.slice(0, equals).trim().toLowerCase();
    if (name !== 'charset') continue;
    const candidate = parseCharsetParameter(parameter.slice(equals + 1));
    if (charset !== undefined && charset !== candidate) {
      throw new SecureWebTransportError('invalid_response', 'The web response declares conflicting charsets.');
    }
    charset = candidate;
  }
  return charset;
}

function splitHeaderParameters(value: string): string[] {
  const parameters: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ';' && !quoted) {
      parameters.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new SecureWebTransportError('invalid_response', 'The web response content type is malformed.');
  parameters.push(value.slice(start));
  return parameters;
}

function parseCharsetParameter(value: string): string {
  const trimmed = value.trim();
  let decoded = '';
  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw new SecureWebTransportError('invalid_response', 'The web response charset is invalid.');
    }
    for (let index = 1; index < trimmed.length - 1; index += 1) {
      const character = trimmed[index]!;
      if (character === '\\') {
        index += 1;
        if (index >= trimmed.length - 1) {
          throw new SecureWebTransportError('invalid_response', 'The web response charset is invalid.');
        }
        decoded += trimmed[index]!;
      } else {
        decoded += character;
      }
    }
  } else {
    if (/[\s"\\]/u.test(trimmed)) {
      throw new SecureWebTransportError('invalid_response', 'The web response charset is invalid.');
    }
    decoded = trimmed;
  }
  const charset = decoded.toLowerCase();
  if (!/^[a-z0-9._:-]{1,64}$/u.test(charset)) {
    throw new SecureWebTransportError('invalid_response', 'The web response charset is invalid.');
  }
  return charset;
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 300 || statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function isBodylessStatus(statusCode: number): boolean {
  return statusCode === 204 || statusCode === 205 || statusCode === 304;
}

function destroyQuietly(stream: { destroy(): unknown } | undefined): void {
  if (stream === undefined) return;
  try {
    stream.destroy();
  } catch {
    // The invocation already owns the authoritative error; cleanup must not escape an EventEmitter callback.
  }
}

function normalizeRequestHeaders(
  durable: Readonly<Record<string, string>> | undefined,
  ephemeral: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': 'SchemaNaut/0.1 secure-web-transport',
  };
  for (const [sourceKind, source] of [['durable', durable], ['ephemeral', ephemeral]] as const) {
    if (source === undefined) continue;
    for (const [rawName, rawValue] of Object.entries(source)) {
      const name = rawName.trim().toLowerCase();
      const value = rawValue.trim();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || name.length > MAX_HEADER_NAME_CHARS || value.length > MAX_HEADER_VALUE_CHARS || /[\r\n]/u.test(value)) {
        throw new SecureWebTransportError('invalid_response', 'A web request header is invalid.');
      }
      if (name === 'host' || name === 'connection' || name === 'content-length' || name === 'transfer-encoding' || name === 'proxy-authorization') {
        throw new SecureWebTransportError('invalid_response', `The ${name} request header is controlled by the secure transport.`);
      }
      if (sourceKind === 'durable' && (name === 'cookie' || name === 'set-cookie' || name === 'set-cookie2')) {
        throw new SecureWebTransportError('invalid_response', 'Cookie headers are only supported as execute-only bridge headers.');
      }
      merged[name] = value;
    }
  }
  if (Object.keys(merged).length > MAX_HEADER_COUNT) throw new SecureWebTransportError('limit', 'The web request contains too many headers.');
  return Object.freeze(merged);
}

function normalizeResponseHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  let count = 0;
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    const normalizedName = name.toLowerCase();
    if (normalizedName === 'set-cookie' || normalizedName === 'set-cookie2') continue;
    count += 1;
    if (count > MAX_HEADER_COUNT) throw new SecureWebTransportError('limit', 'The web response contains too many headers.');
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (name.length > MAX_HEADER_NAME_CHARS || value.length > MAX_HEADER_VALUE_CHARS) throw new SecureWebTransportError('limit', 'A web response header is too large.');
    output[normalizedName] = value;
  }
  return Object.freeze(output);
}

function assertPreparedTarget(target: PreparedWebTarget, resolverRevision: string): void {
  const parsed = parseWebUrl(target.url);
  const hostname = normalizeHostname(parsed.hostname);
  const port = parsed.port === '' ? parsed.protocol === 'https:' ? 443 : 80 : Number(parsed.port);
  if (target.resolverRevision !== resolverRevision || target.protocol !== parsed.protocol || target.hostname !== hostname || target.port !== port || target.addresses.length < 1 || target.addresses.length > MAX_DNS_ADDRESSES) {
    throw new SecureWebTransportError('target_changed', 'The prepared web target is invalid or unsupported.');
  }
  for (const address of target.addresses) {
    const expectedRisk = classifyWebAddress(address.address);
    if (normalizeAddress(address.address) !== address.address || isIP(address.address) !== address.family ||
      expectedRisk.loopback !== address.risk.loopback || expectedRisk.private !== address.risk.private ||
      expectedRisk.linkLocal !== address.risk.linkLocal || expectedRisk.metadata !== address.risk.metadata ||
      expectedRisk.special !== address.risk.special) {
      throw new SecureWebTransportError('target_changed', 'A prepared web address is invalid.');
    }
  }
}

function sameTarget(left: PreparedWebTarget, right: PreparedWebTarget): boolean {
  if (left.protocol !== right.protocol || left.url !== right.url || left.hostname !== right.hostname || left.port !== right.port || left.resolverRevision !== right.resolverRevision || left.addresses.length !== right.addresses.length) return false;
  return left.addresses.every((address, index) => {
    const candidate = right.addresses[index];
    return candidate !== undefined && address.address === candidate.address && address.family === candidate.family;
  });
}

function normalizeHostname(value: string): string {
  const normalized = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return normalized.toLowerCase();
}

function normalizeAddress(value: string): string {
  const normalized = normalizeHostname(value).split('%', 1)[0] ?? '';
  if (isIP(normalized) !== 6) return normalized.toLowerCase();
  try {
    return new URL(`http://[${normalized}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

function mapRequestError(error: unknown): SecureWebTransportError {
  if (error instanceof SecureWebTransportError) return error;
  const code = safeErrorCode(error);
  if (/^(?:CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/u.test(code)) {
    return new SecureWebTransportError('tls', 'The web server TLS identity could not be verified.');
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new SecureWebTransportError('timeout', 'The web connection timed out.');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new SecureWebTransportError('dns', 'The web host could not be resolved.');
  return new SecureWebTransportError('network', `The web connection failed (${code}).`);
}

function safeErrorCode(error: unknown): string {
  const value = error as NodeJS.ErrnoException;
  return typeof value?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value.code) ? value.code : 'UNKNOWN';
}

function assertPositiveBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw new SecureWebTransportError('limit', `${label} is invalid.`);
}

function raceBoundary<T>(operation: Promise<T>, signal: AbortSignal, deadline: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new SecureWebTransportError('cancelled', 'The web request was cancelled.'));
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) return Promise.reject(new SecureWebTransportError('timeout', 'The web request deadline elapsed.'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new SecureWebTransportError('timeout', 'The web request timed out.')), deadlineMs - Date.now());
    timer.unref?.();
    const onAbort = () => finish(new SecureWebTransportError('cancelled', 'The web request was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then((value) => finish(undefined, value), (error) => finish(error));
    function finish(error?: unknown, value?: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error instanceof Error ? error : new SecureWebTransportError('network', 'The bounded web operation failed.'));
      else resolve(value as T);
    }
  });
}
