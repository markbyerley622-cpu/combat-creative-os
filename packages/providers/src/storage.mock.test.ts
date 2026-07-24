import { describe, expect, it } from 'vitest';
import { MockStorageProvider } from './storage.mock';

describe('MockStorageProvider', () => {
  it('putObject then headObject reports a matching checksum and size', async () => {
    const storage = new MockStorageProvider();
    const { checksum } = await storage.putObject({ s3Key: 'a.txt', body: 'hello world' });

    const meta = await storage.headObject('a.txt');
    expect(meta.checksum).toBe(checksum);
    expect(meta.sizeBytes).toBe(Buffer.byteLength('hello world'));
  });

  it('headObject on an unknown key throws', async () => {
    const storage = new MockStorageProvider();
    await expect(storage.headObject('missing.txt')).rejects.toThrow();
  });

  it('copyObject duplicates content under a new key', async () => {
    const storage = new MockStorageProvider();
    await storage.putObject({ s3Key: 'src.txt', body: 'payload' });
    await storage.copyObject('src.txt', 'dest.txt');

    const destMeta = await storage.headObject('dest.txt');
    const srcMeta = await storage.headObject('src.txt');
    expect(destMeta.checksum).toBe(srcMeta.checksum);
  });

  it('getObject returns the same bytes and contentType that were put', async () => {
    const storage = new MockStorageProvider();
    await storage.putObject({ s3Key: 'a.txt', body: 'hello world', contentType: 'text/plain' });

    const result = await storage.getObject('a.txt');
    expect(Buffer.from(result.body).toString()).toBe('hello world');
    expect(result.contentType).toBe('text/plain');
  });

  it('getObject on an unknown key throws', async () => {
    const storage = new MockStorageProvider();
    await expect(storage.getObject('missing.txt')).rejects.toThrow();
  });

  it('objectExists reflects presence without throwing', async () => {
    const storage = new MockStorageProvider();
    await storage.putObject({ s3Key: 'a.txt', body: 'x' });
    expect(await storage.objectExists('a.txt')).toBe(true);
    expect(await storage.objectExists('missing.txt')).toBe(false);
  });

  it('putObject is idempotent: writing the same key twice with the same bytes yields the same checksum', async () => {
    const storage = new MockStorageProvider();
    const first = await storage.putObject({ s3Key: 'a.txt', body: 'hello world' });
    const second = await storage.putObject({ s3Key: 'a.txt', body: 'hello world' });
    expect(second.checksum).toBe(first.checksum);
  });

  it('getPresignedUploadUrl embeds a future expiry and rejects a non-positive expiry', async () => {
    const storage = new MockStorageProvider();
    const before = Date.now();
    const url = await storage.getPresignedUploadUrl('a.txt', { expirySeconds: 60 });
    const expires = Number(new URL(url).searchParams.get('expires'));
    expect(expires).toBeGreaterThan(before);

    await expect(storage.getPresignedUploadUrl('a.txt', { expirySeconds: 0 })).rejects.toThrow();
    await expect(storage.getPresignedUploadUrl('a.txt', { expirySeconds: -1 })).rejects.toThrow();
  });

  it('getPresignedUrl (download) rejects a non-positive expiry', async () => {
    const storage = new MockStorageProvider();
    await storage.putObject({ s3Key: 'a.txt', body: 'x' });
    await expect(storage.getPresignedUrl('a.txt', 0)).rejects.toThrow();
  });

  it('deleteObject requires an explicit authorization and then removes the object', async () => {
    const storage = new MockStorageProvider();
    await storage.putObject({ s3Key: 'a.txt', body: 'x' });

    // @ts-expect-error -- exercising the runtime guard against a caller that bypasses the type system (e.g. plain JS)
    await expect(storage.deleteObject('a.txt', {})).rejects.toThrow(/authorizedBy/);
    expect(await storage.objectExists('a.txt')).toBe(true);

    await storage.deleteObject('a.txt', { authorizedBy: 'user-1', reason: 'test cleanup' });
    expect(await storage.objectExists('a.txt')).toBe(false);
  });

  it('deleteObject on an unknown key throws', async () => {
    const storage = new MockStorageProvider();
    await expect(
      storage.deleteObject('missing.txt', { authorizedBy: 'user-1', reason: 'test' }),
    ).rejects.toThrow();
  });
});
