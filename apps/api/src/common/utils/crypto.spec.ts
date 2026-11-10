import { decryptSecret, encryptSecret, hmacBase64Url, randomToken, safeEqual, sha256Hex } from './crypto';

describe('أدوات التشفير', () => {
  const secret = 'unit-test-key-material-0123456789abcdef';

  it('تشفير AES-256-GCM يُفك بالمفتاح والغرض نفسيهما فقط', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', secret, 'totp-secret');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc, secret, 'totp-secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(enc, secret, 'other-purpose')).toThrow();
    expect(() => decryptSecret(enc, `${secret}x`, 'totp-secret')).toThrow();
  });

  it('يكتشف العبث بالنص المشفر، ولا يكرر الناتج', () => {
    const enc = encryptSecret('value', secret, 'p');
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), secret, 'p')).toThrow();
    expect(encryptSecret('value', secret, 'p')).not.toBe(enc);
    expect(() => decryptSecret('garbage', secret, 'p')).toThrow();
  });

  it('safeEqual و sha256 و hmac و randomToken', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmacBase64Url('k', 'v')).toBe(hmacBase64Url('k', 'v'));
    expect(hmacBase64Url('k', 'v')).not.toBe(hmacBase64Url('k2', 'v'));
    const a = randomToken();
    expect(a).toHaveLength(43);
    expect(a).not.toBe(randomToken());
  });
});
