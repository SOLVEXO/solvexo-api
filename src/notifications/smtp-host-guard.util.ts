import { lookup } from 'dns/promises';
import { isIP } from 'net';

// A store can connect its own SMTP server. The host is typed by the seller, so it must never be a way to reach
// the machine's own network: no loopback, private, link-local or cloud-metadata addresses, and only mail ports.

export const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525] as const;

/** True for loopback, private (RFC 1918), link-local, carrier-grade NAT, unspecified and unique-local addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIp(mapped[1]);
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (isIP(v) === 6) return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
  return true; // not an address at all
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isValidSmtpHostName(host: string): boolean {
  const h = String(host ?? '').trim();
  return isIP(h) !== 0 || HOSTNAME.test(h);
}

export class UnsafeSmtpTargetError extends Error {}

/**
 * Checks host + port and returns the public IP to connect to. Connecting by that IP (with the host name kept for
 * TLS) means a DNS answer that changes between this check and the connection cannot point us at a private address.
 */
export async function resolveSafeSmtpTarget(host: string, port: number): Promise<{ ip: string; host: string }> {
  const h = String(host ?? '').trim().toLowerCase();
  if (!isValidSmtpHostName(h)) throw new UnsafeSmtpTargetError('Enter a valid SMTP host name, for example smtp.gmail.com.');
  if (!(ALLOWED_SMTP_PORTS as readonly number[]).includes(port)) throw new UnsafeSmtpTargetError(`Use one of the mail ports: ${ALLOWED_SMTP_PORTS.join(', ')}.`);
  let addresses: string[];
  if (isIP(h)) addresses = [h];
  else {
    try { addresses = (await lookup(h, { all: true })).map(a => a.address); }
    catch { throw new UnsafeSmtpTargetError('That SMTP host could not be found. Check the spelling.'); }
  }
  if (addresses.length === 0 || addresses.some(isPrivateIp)) throw new UnsafeSmtpTargetError('That SMTP host is not allowed. Use your mail provider\'s public server.');
  return { ip: addresses[0], host: h };
}
