import { isIP } from 'node:net';

/**
 * Tiny IPv4 CIDR matcher for the PayFast ITN webhook (PAY-002 step 1). The
 * PayFast whitelist (PAYFAST_IP_WHITELIST) is published as a mix of bare IPs
 * (e.g. `144.126.193.139`) and CIDRs (e.g. `196.33.227.224/27`). No new deps:
 * we only need IPv4 + we lean on `node:net.isIP` for the family check.
 *
 * IPv4-mapped IPv6 (`::ffff:144.126.193.139`, as Express may report behind
 * Cloud Run) is normalised to its v4 form before comparison. Pure IPv6
 * addresses fall through as not-matching — PayFast only publishes v4 ranges.
 */

interface Cidr {
  /** Network address as a 32-bit unsigned integer. */
  network: number;
  /** Bitmask (prefix length 0..32) as a 32-bit unsigned integer. */
  mask: number;
}

interface ParsedEntry {
  type: 'cidr' | 'ip';
  cidr?: Cidr;
  ip?: number;
}

function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc * 256 + n) >>> 0;
  }
  return acc >>> 0;
}

/** Strip IPv4-mapped IPv6 prefix so `req.ip` from Express behind a proxy is
 *  comparable against a v4 whitelist. */
function normaliseIp(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice('::ffff:'.length);
  return trimmed;
}

function parseEntry(raw: string): ParsedEntry | null {
  const entry = raw.trim();
  if (entry.length === 0) return null;

  const slashAt = entry.indexOf('/');
  if (slashAt === -1) {
    const ip = ipv4ToInt(entry);
    if (ip === null) return null;
    return { type: 'ip', ip };
  }

  const ipPart = entry.slice(0, slashAt);
  const prefixPart = entry.slice(slashAt + 1);
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const ip = ipv4ToInt(ipPart);
  if (ip === null) return null;

  // mask for /0 is 0; for /32 is 0xFFFFFFFF.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  return { type: 'cidr', cidr: { network, mask } };
}

/** Parse a PayFast whitelist (CSV of IPv4 and/or CIDRs). Invalid entries are
 *  silently dropped — env validation only checks for a string. */
export function parseIpWhitelist(entries: string[]): ParsedEntry[] {
  return entries.map(parseEntry).filter((e): e is ParsedEntry => e !== null);
}

/** True when `ip` matches any whitelist entry. */
export function isIpAllowed(ip: string, parsed: ParsedEntry[]): boolean {
  const normalised = normaliseIp(ip);
  const candidate = ipv4ToInt(normalised);
  if (candidate === null) return false;
  for (const entry of parsed) {
    if (entry.type === 'ip' && entry.ip === candidate) return true;
    if (entry.type === 'cidr' && entry.cidr) {
      if ((candidate & entry.cidr.mask) >>> 0 === entry.cidr.network) return true;
    }
  }
  return false;
}
