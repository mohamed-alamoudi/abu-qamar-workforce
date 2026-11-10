import { authenticator } from 'otplib';
import { redact } from '../audit/audit.service';
import type { AppConfig } from '../common/config/env';
import { PasswordService } from './password.service';
import { TotpService } from './totp.service';

describe('PasswordService (Argon2id)', () => {
  const service = new PasswordService();

  it('ينتج بصمة Argon2id بملح مختلف في كل مرة ويتحقق منها', async () => {
    const a = await service.hash('Strong-Pass-2026');
    const b = await service.hash('Strong-Pass-2026');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await service.verify(a, 'Strong-Pass-2026')).toBe(true);
    expect(await service.verify(a, 'Strong-Pass-2027')).toBe(false);
  });

  it('بصمة تالفة تعيد false ولا ترمي خطأ', async () => {
    expect(await service.verify('not-a-hash', 'anything')).toBe(false);
    await expect(service.dummyVerify('anything')).resolves.toBeUndefined();
  });
});

describe('TotpService', () => {
  const service = new TotpService({ dataEncryptionKey: 'unit-test-encryption-key-0123456789abcdef' } as AppConfig);

  it('يولّد سرًا مشفرًا ورابط otpauth ويتحقق من الرمز الصحيح فقط', () => {
    const { secret, secretEnc, otpauthUrl } = service.generateSecret('admin');
    expect(secretEnc).not.toContain(secret);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(otpauthUrl).toContain(`secret=${secret}`);

    const code = authenticator.generate(secret);
    expect(service.verify(secretEnc, code)).toBe(true);
    expect(service.verify(secretEnc, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(service.verify(secretEnc, wrong)).toBe(false);
    expect(service.verify(secretEnc, 'abcdef')).toBe(false);
    expect(service.verify('corrupted', code)).toBe(false);
  });

  it('رموز الاسترداد فريدة وبصيغة ثابتة وتُحفظ بصماتها فقط', () => {
    const { codes, hashes } = service.generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(service.looksLikeRecoveryCode(code)).toBe(true);
      expect(hashes).toContain(service.hashRecoveryCode(code.toUpperCase()));
      expect(hashes).not.toContain(code);
    }
    expect(service.looksLikeRecoveryCode('123456')).toBe(false);
  });
});

describe('حجب الحقول الحساسة في سجل التدقيق', () => {
  it('يحجب كلمات المرور والرموز والأسرار في أي عمق ويبقي الباقي', () => {
    const result = redact({
      username: 'admin',
      totpEnabled: true,
      passwordHash: '$argon2id$...',
      nested: { newPassword: 'x', sessionToken: 'y', list: [{ totpSecretEnc: 'z', name: 'ok' }] },
      when: new Date('2026-01-01T00:00:00Z'),
      size: BigInt(5),
    }) as Record<string, any>;

    expect(result.username).toBe('admin');
    expect(result.totpEnabled).toBe(true);
    expect(result.passwordHash).toBe('[محجوب]');
    expect(result.nested.newPassword).toBe('[محجوب]');
    expect(result.nested.sessionToken).toBe('[محجوب]');
    expect(result.nested.list[0]).toEqual({ totpSecretEnc: '[محجوب]', name: 'ok' });
    expect(result.when).toBe('2026-01-01T00:00:00.000Z');
    expect(result.size).toBe('5');
  });
});
