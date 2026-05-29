import { isIpAllowed, parseIpWhitelist } from './ip-whitelist';

/**
 * Unit tests for the PayFast ITN IP-whitelist matcher (PAY-002 step 1). The
 * whitelist published in the PayFast developer docs is a mix of CIDRs and
 * bare IPs — covered by the fixtures here. The .env.example default is the
 * source of truth and is exercised end-to-end.
 */
describe('PayFast IP whitelist', () => {
  describe('parseIpWhitelist', () => {
    it('parses bare IPs and CIDRs; drops invalid entries silently', () => {
      const parsed = parseIpWhitelist([
        '196.33.227.224/27',
        '144.126.193.139',
        '',
        'not-an-ip',
        '10.0.0.0/40', // invalid prefix
        '300.300.300.300', // invalid octet
      ]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].type).toBe('cidr');
      expect(parsed[1].type).toBe('ip');
    });

    it('parses /0 (matches everything) and /32 (matches one IP) correctly', () => {
      const parsedZero = parseIpWhitelist(['0.0.0.0/0']);
      expect(isIpAllowed('10.20.30.40', parsedZero)).toBe(true);
      expect(isIpAllowed('1.2.3.4', parsedZero)).toBe(true);

      const parsed32 = parseIpWhitelist(['1.2.3.4/32']);
      expect(isIpAllowed('1.2.3.4', parsed32)).toBe(true);
      expect(isIpAllowed('1.2.3.5', parsed32)).toBe(false);
    });
  });

  describe('isIpAllowed', () => {
    const whitelist = parseIpWhitelist([
      '197.97.145.144/28',
      '196.33.227.224/27',
      '144.126.193.139',
    ]);

    it('matches a bare IP exactly', () => {
      expect(isIpAllowed('144.126.193.139', whitelist)).toBe(true);
      expect(isIpAllowed('144.126.193.140', whitelist)).toBe(false);
    });

    it('matches /27 boundaries: 196.33.227.224..255 inclusive', () => {
      // /27 = 32 addresses (.224..255).
      expect(isIpAllowed('196.33.227.224', whitelist)).toBe(true);
      expect(isIpAllowed('196.33.227.240', whitelist)).toBe(true);
      expect(isIpAllowed('196.33.227.255', whitelist)).toBe(true);
      expect(isIpAllowed('196.33.227.223', whitelist)).toBe(false);
      expect(isIpAllowed('196.33.228.0', whitelist)).toBe(false);
    });

    it('matches /28 boundaries: 197.97.145.144..159 inclusive', () => {
      expect(isIpAllowed('197.97.145.144', whitelist)).toBe(true);
      expect(isIpAllowed('197.97.145.159', whitelist)).toBe(true);
      expect(isIpAllowed('197.97.145.160', whitelist)).toBe(false);
      expect(isIpAllowed('197.97.145.143', whitelist)).toBe(false);
    });

    it('normalises IPv4-mapped IPv6 form (::ffff:…) before matching', () => {
      expect(isIpAllowed('::ffff:144.126.193.139', whitelist)).toBe(true);
      expect(isIpAllowed('::ffff:196.33.227.230', whitelist)).toBe(true);
    });

    it('rejects pure IPv6', () => {
      expect(isIpAllowed('2001:db8::1', whitelist)).toBe(false);
    });

    it('rejects garbage input', () => {
      expect(isIpAllowed('', whitelist)).toBe(false);
      expect(isIpAllowed('not-an-ip', whitelist)).toBe(false);
    });

    it('empty whitelist matches nothing', () => {
      expect(isIpAllowed('1.2.3.4', [])).toBe(false);
    });
  });
});
