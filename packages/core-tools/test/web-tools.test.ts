import { describe, expect, it } from 'vitest';
import { classifyWebAddress, createWebToolGeneration, type PreparedWebTarget, type SecureWebRequest, type SecureWebTransport } from '../src/index.js';

function target(url: string): PreparedWebTarget {
  const parsed = new URL(url);
  return { protocol: parsed.protocol as 'https:', url: parsed.toString(), hostname: parsed.hostname, port: 443,
    addresses: [{ address: '93.184.216.34', family: 4, risk: { loopback: false, private: false, linkLocal: false, metadata: false, special: false } }], resolverRevision: 'fixture-dns.v1' };
}
function transport(statusCode = 200, requests: SecureWebRequest[] = []): SecureWebTransport {
  return { revision: 'fixture-transport.v1', resolverRevision: 'fixture-dns.v1',
    prepareTarget: url => Promise.resolve(target(url)), revalidateTarget: () => Promise.resolve(true),
    request: input => {
      requests.push(input);
      const search = input.target.hostname === 'search.example.test';
      const body = search ? JSON.stringify({ results: [{ title: 'Nexus', url: 'https://example.test/', snippet: 'result' }] }) : 'hello';
      return Promise.resolve({ url: input.target.url, statusCode, headers: statusCode === 302 ? { location: 'https://example.test/next' } : { 'content-type': search ? 'application/json' : 'text/plain' }, contentType: search ? 'application/json' : 'text/plain', contentEncoding: 'identity' as const, compressedBytes: Buffer.byteLength(body), body: new TextEncoder().encode(body) });
    },
  };
}
describe('web prepared tools', () => {
  it('keeps both direct tools registered and returns unavailable payloads without a backend', async () => {
    const generation = createWebToolGeneration({});
    expect(generation.contributions.map(({ definition }) => definition.name)).toEqual(['web_search', 'web_fetch']);
    await expect(execute(generation, 'web_search', { query: 'Nexus' })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(execute(generation, 'web_fetch', { url: 'https://example.test/' })).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('searches through static adapter mapping and fetches a canonical source payload', async () => {
    const generation = createWebToolGeneration({ transport: transport(), searchAdapter: {
      providerId: 'fixture', revision: 'fixture.v1', request: { endpoint: 'https://search.example.test/api', queryParameter: 'q', limitParameter: 'limit' },
      response: { resultsPath: ['results'], titleField: 'title', urlField: 'url', snippetField: 'snippet' },
    } });
    const result = await execute(generation, 'web_search', { query: 'Nexus', limit: 1 });
    expect(result).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(result)).toContain('sourceId');
  });

  it('keeps Cookie bridge values execute-only and out of prepared input and results', async () => {
    const requests: SecureWebRequest[] = [];
    const generation = createWebToolGeneration({
      transport: transport(200, requests),
      searchAdapter: {
        providerId: 'fixture', revision: 'fixture.v1',
        request: { endpoint: 'https://search.example.test/api', queryParameter: 'q' },
        response: { resultsPath: ['results'], titleField: 'title', urlField: 'url' },
      },
      searchCredentials: { headers: { Cookie: 'session=bridge-fixture' } },
    });
    const prepared = await prepare(generation, 'web_search', { query: 'Nexus' });
    expect(JSON.stringify(prepared.intent)).not.toContain('session=bridge-fixture');
    const result = await prepared.contribution.runtime.execute(prepared.intent.input, prepared.context as never);
    expect(JSON.stringify(result)).not.toContain('session=bridge-fixture');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ headers: {}, ephemeralHeaders: { cookie: 'session=bridge-fixture' } });
  });

  it('treats redirects as partial and classifies private, link-local, and metadata DNS targets as high risk', async () => {
    const generation = createWebToolGeneration({ transport: transport(302) });
    await expect(execute(generation, 'web_fetch', { url: 'https://example.test/start' })).resolves.toMatchObject({ status: 'partial' });
    expect(classifyWebAddress('127.0.0.1')).toMatchObject({ loopback: true });
    expect(classifyWebAddress('10.0.0.1')).toMatchObject({ private: true });
    expect(classifyWebAddress('169.254.169.254')).toMatchObject({ linkLocal: true, metadata: true });
  });
});

async function execute(generation: ReturnType<typeof createWebToolGeneration>, name: string, input: Record<string, unknown>) {
  const prepared = await prepare(generation, name, input);
  return await prepared.contribution.runtime.execute(prepared.intent.input, prepared.context as never);
}

async function prepare(generation: ReturnType<typeof createWebToolGeneration>, name: string, input: Record<string, unknown>) {
  const contribution = generation.contributions.find(({ definition }) => definition.name === name)!;
  const signal = new AbortController().signal;
  const intent = await contribution.runtime.prepare(input as never, { hostId: 'local', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key', descriptor: { flatName: name }, toolRevision: contribution.definition.toolRevision, handlerRevision: contribution.definition.handlerRevision, intentRevision: contribution.definition.intentRevision, generation: 1, limits: contribution.definition.limits, signal } as never);
  const context = { hostId: 'local', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', intent, deadline: new Date(Date.now() + 10_000).toISOString(), signal };
  return { contribution, intent, context };
}
