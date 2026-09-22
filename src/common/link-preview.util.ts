/* eslint-disable prettier/prettier */
import * as dns from 'dns';
import * as net from 'net';

// Server-side link-preview resolver (WhatsApp/Instagram-style "unfurl a URL
// into a card"). Deliberately no new npm dependency (no `cheerio`/`node-html-
// parser`, no `link-preview-js`) — a real browser fetch() to an arbitrary
// third-party site is CORS-blocked anyway, so this has to run server-side,
// and a lightweight regex extraction over the small <head> slice we actually
// read is enough for the standard <meta property="og:..."> tags every real
// site (and every fallback <title>/<meta name="description">) already uses.
//
// SSRF protection is the real point of this file, not an afterthought: a
// message composer that fetches "whatever URL the sender typed" is a classic
// internal-network-probing vector (http://169.254.169.254/..., http://
// localhost:6379, a Docker-internal hostname, etc.) if left unguarded — this
// resolves the hostname's real IP via DNS *before* fetching and rejects
// anything in a private/loopback/link-local/reserved range, mirroring the
// same "verify via a real DNS lookup, never trust the string alone"
// principle this codebase's Custom Domain CNAME verification already uses
// (see store.service.ts's `verifyCustomDomain`).

export interface LinkPreviewResult {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // 512KB — a page's <head> is always well inside this
const MAX_REDIRECTS = 3;

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved (224-255)
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (private)
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped — re-check the embedded IPv4 address
    return isPrivateOrReservedIpv4(lower.replace('::ffff:', ''));
  }
  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateOrReservedIpv6(ip);
  return true; // unrecognized shape — fail closed
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Host not allowed');
  }
  // If the "hostname" is already a literal IP, dns.lookup just echoes it back.
  const { address } = await dns.promises.lookup(hostname);
  if (isPrivateOrReservedIp(address)) throw new Error('Host resolves to a non-public address');
}

function extractMeta(html: string, prop: string): string | null {
  // Matches both attribute orders: property="og:title" content="..." AND content="..." property="og:title"
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function fetchHeadSlice(targetUrl: string): Promise<{ html: string; finalUrl: string } | null> {
  let currentUrl = targetUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    await assertPublicHost(parsed.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SolvexoLinkPreview/1.0)' },
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return null;
      currentUrl = new URL(location, currentUrl).toString();
      continue; // re-validated against SSRF at the top of the next loop iteration
    }

    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    // Read only up to MAX_BYTES — the <head> we need is always near the top.
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    let html = '';
    const decoder = new TextDecoder();
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    return { html, finalUrl: currentUrl };
  }
  return null; // too many redirects
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  try {
    const result = await fetchHeadSlice(parsed.toString());
    if (!result) return null;
    const { html, finalUrl } = result;

    const title = extractMeta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null);
    const description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
    const image = extractMeta(html, 'og:image');
    const siteName = extractMeta(html, 'og:site_name');

    if (!title && !description && !image) return null;

    return {
      url: finalUrl,
      title: title ? title.slice(0, 200) : null,
      description: description ? description.slice(0, 300) : null,
      image: image ? new URL(image, finalUrl).toString() : null,
      siteName: siteName ? siteName.slice(0, 100) : null,
    };
  } catch {
    return null; // timeout, DNS failure, SSRF rejection, or a malformed page — never surfaces an error to the composer, it just shows no preview
  }
}
