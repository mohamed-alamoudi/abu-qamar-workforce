import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** معاملات Argon2id وفق توصية OWASP (19 MiB، دورتان، مسار واحد). */
const ARGON2_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** تحقق وهمي بنفس التكلفة عند عدم وجود المستخدم، لمنع كشف أسماء المستخدمين عبر زمن الاستجابة. */
  async dummyVerify(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-only');
    await this.verify(await this.dummyHash, password);
  }
}
