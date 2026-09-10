import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSecureWebTransport, type PreparedWebTarget } from '../src/index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error === undefined ? resolve() : reject(error)))));
});

describe('NodeSecureWebTransport', () => {
  it('keeps HTTP execute headers HTTPS-only while isolating Cookie API values', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.setHeader('set-cookie', 'session=bridge-value');
      response.setHeader('set-cookie2', 'legacy=bridge-value');
      response.end('ok');
    });
    servers.push(server);
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/bridge`;
    const transport = new NodeSecureWebTransport();
    const target = await transport.prepareTarget(url, active());
    expect(target.url).toBe(url);
    await expect(transport.prepareTarget(`http://user:pass@127.0.0.1:${port}/bridge`, active()))
      .rejects.toThrow('user information');

    await expect(transport.request(request(target, { cookie: 'durable=value' }))).rejects.toThrow(
      'Cookie headers are only supported',
    );
    await expect(transport.request(request(target, undefined, { authorization: 'Bearer fixture-value' })))
      .rejects.toThrow('require HTTPS');
    const response = await transport.request(request(target));

    expect(response.headers).not.toHaveProperty('set-cookie');
    expect(response.headers).not.toHaveProperty('set-cookie2');
  });
});

function active(): { signal: AbortSignal; deadline: string } {
  return { signal: new AbortController().signal, deadline: new Date(Date.now() + 10_000).toISOString() };
}

function request(
  target: PreparedWebTarget,
  headers?: Record<string, string>,
  ephemeralHeaders?: Record<string, string>,
) {
  return {
    target,
    ...(headers === undefined ? {} : { headers }),
    ...(ephemeralHeaders === undefined ? {} : { ephemeralHeaders }),
    acceptedContentTypes: ['text/plain'],
    maxCompressedBytes: 8_192,
    maxDecompressedBytes: 8_192,
    timeoutMs: 5_000,
    ...active(),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener.');
  return address.port;
}
