import { randomBytes } from 'crypto';
import { BackupIntegrityError, decryptBackup, encryptBackup, parseManifest, signManifest } from './backup-crypto';
import { expiryFor } from './backups.service';

it('authenticates ciphertext and rejects tampering and a wrong key', () => {
  const key = randomBytes(32).toString('hex');
  const plain = Buffer.from('PGDMP archive');
  const file = encryptBackup(plain, key);
  expect(decryptBackup(file, key)).toEqual(plain);
  expect(encryptBackup(plain, key)).not.toEqual(file);
  expect(() => decryptBackup(file, 'wrong-key')).toThrow(BackupIntegrityError);
  file[file.length - 1] ^= 1;
  expect(() => decryptBackup(file, key)).toThrow(BackupIntegrityError);
});

it('authenticates manifests and calculates retention dates', () => {
  const key = randomBytes(32).toString('hex');
  const manifest = signManifest({
    formatVersion: 1, id: '0db5ea5e-c944-4fa9-82a4-26d7776084bd', type: 'MANUAL',
    storageKey: 'backups/manual.aqbk', createdAt: '2026-11-12T00:00:00.000Z',
    sizeBytes: 30, checksumSha256: 'a'.repeat(64), schemaVersion: '20261112090400_platform_totp_replay',
    tableCounts: { users: 2 },
  }, key);
  expect(parseManifest(Buffer.from(JSON.stringify(manifest)), key)).toEqual(manifest);
  expect(() => parseManifest(Buffer.from(JSON.stringify({ ...manifest, tableCounts: { users: 3 } })), key)).toThrow();
  const start = new Date('2026-11-12T00:00:00Z');
  expect(expiryFor('MANUAL', start)).toBeNull();
  expect(expiryFor('DAILY', start)?.toISOString()).toBe('2026-12-12T00:00:00.000Z');
  expect(expiryFor('PRE_RESTORE', start)?.toISOString()).toBe('2026-12-12T00:00:00.000Z');
  expect(expiryFor('WEEKLY', start)?.toISOString()).toBe('2027-02-12T00:00:00.000Z');
});
