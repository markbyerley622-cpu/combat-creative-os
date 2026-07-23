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
});
