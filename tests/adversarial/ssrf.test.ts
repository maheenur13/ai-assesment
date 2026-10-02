import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FetchBlockedError,
  FetchFailedError,
  isPublicAddress,
  safeFetch,
  type FetchPolicy,
} from '../../server/src/importer/safe-fetch.js';

/**
 * A local server stands in for "the internet". The test policy lets the fetcher reach exactly one
 * address (127.0.0.1, this server) on its port; every other address goes through the real
 * public-unicast check. Hostnames resolve through a fake DNS table, never the network.
 */
let server: Server;
let port: number;
const dns: Record<string, string[]> = {
  'files.test': ['127.0.0.1'],
  'internal.test': ['10.0.0.7'],
  'rebind.test': ['93.184.215.14', '192.168.1.1'],
  'metadata.test': ['169.254.169.254'],
  'v6-loopback.test': ['::1'],
  'v4-compat.test': ['::a00:7'],
};

const policy = (extra: Partial<FetchPolicy> = {}): FetchPolicy => ({
  ports: [String(port)],
  isAllowedAddress: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
  resolve: (host) =>
    Promise.resolve(
      (dns[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    ),
  ...extra,
});
/** The production policy (no test exceptions, system DNS): even this test server is refused. */
const strict: FetchPolicy = { isAllowedAddress: isPublicAddress, ports: ['', '80', '443'] };
const url = (host: string, path: string) => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/products.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      res.end('sku,name,price\nA-1,Thing,1.00\n');
    } else if (path === '/redirect-ok') {
      res.writeHead(302, { Location: '/products.csv' }).end();
    } else if (path === '/redirect-internal') {
      res.writeHead(302, { Location: 'http://10.0.0.7/products.csv' }).end();
    } else if (path === '/redirect-metadata-host') {
      res.writeHead(301, { Location: `http://metadata.test:${port}/latest/meta-data/` }).end();
    } else if (path === '/loop') {
      res.writeHead(302, { Location: '/loop' }).end();
    } else if (path === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html></html>');
    } else if (path === '/big-declared') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Length': '2000' });
      res.end('x'.repeat(2000));
    } else if (path === '/big-streamed') {
      res.writeHead(200, { 'Content-Type': 'text/csv' }); // chunked, no length
      for (let i = 0; i < 20; i++) res.write('x'.repeat(100));
      res.end();
    } else if (path === '/slow') {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      res.write('sku');
      setTimeout(() => res.end(',name\n'), 2_000).unref();
    } else if (path === '/hang') {
      // Never sends headers; the socket is closed by the client's timeout.
    } else if (path === '/echo-headers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const blocked = (target: string, p = policy()) =>
  expect(safeFetch(target, p)).rejects.toBeInstanceOf(FetchBlockedError);
const failed = (target: string, reason: RegExp, p = policy()) =>
  expect(safeFetch(target, p)).rejects.toThrow(
    expect.objectContaining({
      constructor: FetchFailedError,
      message: expect.stringMatching(reason),
    }),
  );

describe('safeFetch: allowed requests', () => {
  it('downloads a CSV through the vetted address (the fake DNS, not the system resolver)', async () => {
    const file = await safeFetch(url('files.test', '/products.csv'), policy());
    expect(file).toMatchObject({
      contentType: 'text/csv',
      body: 'sku,name,price\nA-1,Thing,1.00\n',
    });
  });

  it('follows a redirect to an allowed place', async () => {
    const file = await safeFetch(url('files.test', '/redirect-ok'), policy());
    expect(file.url).toBe(url('files.test', '/products.csv'));
  });

  it('sends no credentials, cookies or forwarded headers', async () => {
    const file = await safeFetch(url('files.test', '/echo-headers'), policy());
    const headers = JSON.parse(file.body) as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(['accept', 'connection', 'host']);
  });
});

describe('safeFetch: SSRF defences (OWASP SSRF cheat sheet)', () => {
  it('rejects non-http schemes, other ports and credentials in the URL', async () => {
    await blocked('file:///etc/passwd');
    await blocked('gopher://files.test/');
    await blocked('ftp://files.test/products.csv');
    await blocked('http://files.test:22/');
    await blocked(`http://user:pass@files.test:${port}/products.csv`);
    await blocked('not a url');
  });

  it('rejects private, loopback, link-local and other non-public IP literals in every spelling', async () => {
    for (const target of [
      'http://127.0.0.1/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.0.0.1/', // hex
      'http://0177.0.0.1/', // octal
      'http://127.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6
      'http://[::127.0.0.1]/', // IPv4-compatible IPv6 (deprecated, ipaddr calls it unicast)
      'http://[::]/',
      'http://[64:ff9b::a00:1]/', // NAT64 of 10.0.0.1
      'http://127.0.0.1./', // trailing dot
      'http://[::ffff:a9fe:a9fe]/', // mapped 169.254.169.254
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.0.1/',
      'http://100.64.0.1/', // carrier-grade NAT
      'http://[fd00::1]/', // unique local
      'http://[fe80::1]/', // link-local
      'http://224.0.0.1/', // multicast
    ]) {
      await blocked(target, strict);
    }
  });

  it('rejects hostnames that resolve to internal addresses (including localhost)', async () => {
    await blocked(url('internal.test', '/'));
    await blocked(url('metadata.test', '/'));
    await blocked(url('v6-loopback.test', '/'));
    await blocked(url('v4-compat.test', '/'));
    await blocked(url('unknown.test', '/')); // resolves to nothing
    await blocked('http://localhost/', strict); // real system resolver: 127.0.0.1 / ::1
  });

  it('rejects a host if any of its addresses is internal (DNS rebinding / mixed answers)', async () => {
    await blocked(url('rebind.test', '/'));
  });

  it('re-validates every redirect hop', async () => {
    await blocked(url('files.test', '/redirect-internal'));
    await blocked(url('files.test', '/redirect-metadata-host'));
  });

  it('stops after three redirects', async () => {
    await failed(url('files.test', '/loop'), /too many redirects/);
  });
});

describe('safeFetch: unsafe consumption limits (OWASP API4/API10)', () => {
  it('only accepts CSV/JSON/plain-text content types', async () => {
    await failed(url('files.test', '/html'), /content type "text\/html"/);
  });

  it('enforces the size cap from Content-Length and while streaming', async () => {
    await failed(url('files.test', '/big-declared'), /too large/, policy({ maxBytes: 1000 }));
    await failed(url('files.test', '/big-streamed'), /too large/, policy({ maxBytes: 1000 }));
  });

  it('times out slow responses', async () => {
    await failed(url('files.test', '/slow'), /timed out/, policy({ timeoutMs: 300 }));
  });

  it('times out a server that never answers (one deadline for connect, headers and body)', async () => {
    await failed(url('files.test', '/hang'), /timed out/, policy({ timeoutMs: 300 }));
  });

  it('reports HTTP errors', async () => {
    await failed(url('files.test', '/missing'), /HTTP 404/);
  });
});
