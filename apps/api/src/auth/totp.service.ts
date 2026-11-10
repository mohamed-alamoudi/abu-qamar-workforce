import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { APP_CONFIG, AppConfig } from '../common/config/env';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../common/utils/crypto';

const ISSUER = 'Abu Qamar Workforce';
const PURPOSE = 'totp-secret';

/** المصادقة الثنائية الاختيارية (TOTP — متوافقة مع Google Authenticator وأمثاله). */
@Injectable()
export class TotpService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    // نقبل الرمز السابق والتالي (±30 ثانية) لتحمّل فرق بسيط في ساعة الهاتف
    authenticator.options = { window: 1 };
  }

  generateSecret(username: string): { secretEnc: string; secret: string; otpauthUrl: string } {
    const secret = authenticator.generateSecret();
    return {
      secret,
      secretEnc: encryptSecret(secret, this.config.dataEncryptionKey, PURPOSE),
      otpauthUrl: authenticator.keyuri(username, ISSUER, secret),
    };
  }

  verify(secretEnc: string, code: string): boolean {
    const token = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(token)) return false;
    try {
      return authenticator.verify({ token, secret: decryptSecret(secretEnc, this.config.dataEncryptionKey, PURPOSE) });
    } catch {
      return false;
    }
  }

  /** رموز استرداد أحادية الاستخدام؛ تُعرض مرة واحدة وتُحفظ بصماتها فقط. */
  generateRecoveryCodes(count = 8): { codes: string[]; hashes: string[] } {
    const codes = Array.from({ length: count }, () => {
      const raw = randomToken(8).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase().padEnd(10, '0');
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    return { codes, hashes: codes.map((c) => this.hashRecoveryCode(c)) };
  }

  hashRecoveryCode(code: string): string {
    return sha256Hex(`recovery:${code.trim().toLowerCase()}`);
  }

  looksLikeRecoveryCode(code: string): boolean {
    return /^[a-z0-9]{5}-[a-z0-9]{5}$/i.test(code.trim());
  }
}
