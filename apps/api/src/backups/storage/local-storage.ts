import { promises as fs } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { assertSafeKey, BackupObjectNotFoundError, BackupStorage } from './backup-storage';

/** تخزين على القرص المحلي — للتطوير والاختبار فقط (في الإنتاج يجب أن تكون النسخ خارج الخادم). */
export class LocalBackupStorage implements BackupStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.root, ...key.split('/'));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('مفتاح تخزين غير صالح');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.pathFor(key);
    await fs.mkdir(dirname(file), { recursive: true });
    // كتابة ذرّية: ملف مؤقت ثم إعادة تسمية، حتى لا يبقى ملف ناقص باسم النسخة
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, file);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BackupObjectNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !entry.name.endsWith('.tmp')) keys.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(this.root);
    return keys.filter((k) => k.startsWith(prefix)).sort();
  }
}
