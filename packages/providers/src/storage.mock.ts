import { createHash } from 'node:crypto';
import type { ObjectMetadata, PutObjectInput, StorageProvider } from './storage';

interface InternalObject {
  body: Uint8Array;
  checksum: string;
  contentType?: string;
}

export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock-storage';
  private readonly objects = new Map<string, InternalObject>();

  async putObject(input: PutObjectInput): Promise<{ s3Key: string; checksum: string }> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body);
    const checksum = createHash('sha256').update(body).digest('hex');
    this.objects.set(input.s3Key, { body, checksum, contentType: input.contentType });
    return { s3Key: input.s3Key, checksum };
  }

  async getPresignedUrl(s3Key: string, expirySeconds: number): Promise<string> {
    this.getOrThrow(s3Key);
    const expiresAt = Date.now() + expirySeconds * 1000;
    return `https://mock-storage.local/${s3Key}?expires=${expiresAt}`;
  }

  async headObject(s3Key: string): Promise<ObjectMetadata> {
    const object = this.getOrThrow(s3Key);
    return {
      s3Key,
      sizeBytes: object.body.byteLength,
      checksum: object.checksum,
      contentType: object.contentType,
    };
  }

  async copyObject(src: string, dest: string): Promise<void> {
    const object = this.getOrThrow(src);
    this.objects.set(dest, { ...object });
  }

  private getOrThrow(s3Key: string): InternalObject {
    const object = this.objects.get(s3Key);
    if (!object) {
      throw new Error(`Unknown object: ${s3Key}`);
    }
    return object;
  }
}
