import { S3BackupStorage } from './s3-storage';

it('signs requests and reads, lists and removes encrypted objects through a stub', async () => {
  const request = jest.fn()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response('archive'))
    .mockResolvedValueOnce(new Response('<ListBucketResult><Key>backups/test.aqbk</Key></ListBucketResult>'))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const storage = new S3BackupStorage({
    bucket: 'test', region: 'eu-central-1', accessKey: 'stub', secretKey: 'stub-secret',
    endpoint: 'http://localhost:9000', forcePathStyle: true,
  }, request, () => new Date('2026-11-12T00:00:00Z'));
  const key = 'backups/test.aqbk';
  await storage.put(key, Buffer.from('archive'));
  expect(await storage.get(key)).toEqual(Buffer.from('archive'));
  expect(await storage.list('backups/')).toEqual([key]);
  await storage.delete(key);
  expect(request.mock.calls.map(([, init]) => init.method)).toEqual(['PUT', 'GET', 'GET', 'DELETE']);
  expect(request.mock.calls[0][0]).toBe('http://localhost:9000/test/backups/test.aqbk');
  expect(request.mock.calls[0][1].headers.authorization).toMatch(/AWS4-HMAC-SHA256 Credential=stub\//);
});
