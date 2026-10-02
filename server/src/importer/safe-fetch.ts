import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Fetches an operator-supplied URL without letting it reach internal services (OWASP SSRF
 * Prevention Cheat Sheet). Every hop is checked: scheme, port, no credentials, and every address
 * the host resolves to must be public unicast. The socket connects to the address that was
 * checked (custom `lookup`), so a DNS answer cannot change between check and use (rebinding).
 */
export class FetchBlockedError extends Error {}
/** Fetch failed for a reason that is not a policy decision (timeout, HTTP error, too large). */
export class FetchFailedError extends Error {}

export interface FetchedFile {
  url: string;
  contentType: string;
  body: string;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface FetchPolicy {
  resolve?: Resolver;
  /** Decides whether an address may be contacted. Default: public unicast only. */
  isAllowedAddress?: (ip: string) => boolean;
  ports?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

const CONTENT_TYPES = [
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/csv',
  'application/json',
];

const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR('2000::/3');

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  // process() turns IPv4-mapped IPv6 (::ffff:127.0.0.1) back into IPv4 before classifying.
  const addr = ipaddr.process(ip);
  if (addr.range() !== 'unicast') return false;
  // ipaddr calls some legacy IPv6 forms "unicast" (e.g. IPv4-compatible ::7f00:1), so IPv6 must
  // also be in the global unicast block.
  return addr.kind() === 'ipv4' || addr.match(GLOBAL_UNICAST_V6);
}

const systemResolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function safeFetch(rawUrl: string, policy: FetchPolicy = {}): Promise<FetchedFile> {
  const {
    resolve = systemResolve,
    isAllowedAddress = isPublicAddress,
    ports = ['', '80', '443'],
    maxBytes = 5 * 1024 * 1024,
    timeoutMs = 10_000,
    maxRedirects = 3,
  } = policy;
  const signal = AbortSignal.timeout(timeoutMs);

  const checkUrl = (value: string, base?: string): URL => {
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      throw new FetchBlockedError('not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new FetchBlockedError(`scheme ${url.protocol} not allowed`);
    }
    if (!ports.includes(url.port)) throw new FetchBlockedError(`port ${url.port} not allowed`);
    if (url.username || url.password) throw new FetchBlockedError('credentials in URL');
    // Node connects to IP literals without calling `lookup`, so check them here. The URL parser
    // has already normalised tricks like http://2130706433/ or http://0x7f.1/ to 127.0.0.1.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(host) && !isAllowedAddress(host)) {
      throw new FetchBlockedError(`address ${host} not allowed`);
    }
    return url;
  };

  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const blocked = addresses.find((a) => !isAllowedAddress(a.address));
        if (addresses.length === 0 || blocked) {
          callback(
            new FetchBlockedError(`${hostname} resolves to ${blocked?.address ?? 'nothing'}`),
            '',
          );
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };

  let url = checkUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await request(url, lookup, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location !== undefined) {
      res.resume();
      if (hop >= maxRedirects) throw new FetchFailedError('too many redirects');
      const next = checkUrl(res.headers.location, url.href);
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new FetchBlockedError('redirect from https to http');
      }
      url = next;
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new FetchFailedError(`HTTP ${status}`);
    }
    const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!CONTENT_TYPES.includes(contentType)) {
      res.resume();
      throw new FetchFailedError(`content type "${contentType}" not supported`);
    }
    if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
      res.resume();
      throw new FetchFailedError('file too large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          throw new FetchFailedError('file too large');
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof FetchFailedError) throw err;
      throw new FetchFailedError(signal.aborted ? 'timed out' : 'connection lost');
    }
    return { url: url.href, contentType, body: Buffer.concat(chunks).toString('utf8') };
  }
}

function request(url: URL, lookup: LookupFunction, signal: AbortSignal) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<http.IncomingMessage>((resolveRes, reject) => {
    // No cookies or auth headers are ever sent; `agent: false` avoids reusing pooled sockets
    // that were connected under a different lookup.
    const req = client.get(
      url,
      { lookup, signal, agent: false, headers: { Accept: CONTENT_TYPES.join(', ') } },
      resolveRes,
    );
    req.on('error', (err) => {
      if (err instanceof FetchBlockedError) reject(err);
      else if (signal.aborted) reject(new FetchFailedError('timed out'));
      else
        reject(
          new FetchFailedError(
            `request failed: ${(err as NodeJS.ErrnoException).code ?? err.name}`,
          ),
        );
    });
  });
}
