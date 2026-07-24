import { createHash } from 'node:crypto';
import type {
  DeleteAuthorization,
  GetObjectResult,
  ObjectMetadata,
  PresignedUploadInput,
  PutObjectInput,
  StorageProvider,
} from './storage';

interface InternalObject {
  body: Uint8Array;
  checksum: string;
  contentType?: string;
}

/**
 * Deterministic, in-memory — no network I/O, matching CLAUDE.md's
 * provider-adapter rule ("mocks perform no real network I/O and must be
 * deterministic"). Idempotent `putObject`: writing the same `s3Key` twice
 * with the same bytes is a no-op re-write (last write wins on content, but
 * the checksum is stable since it's a pure hash of the body either way).
 */
export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock-storage';
  private readonly objects = new Map<string, InternalObject>();

  async putObject(input: PutObjectInput): Promise<{ s3Key: string; checksum: string }> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body);
    const checksum = createHash('sha256').update(body).digest('hex');
    this.objects.set(input.s3Key, { body, checksum, contentType: input.contentType });
    return { s3Key: input.s3Key, checksum };
  }

  async getObject(s3Key: string): Promise<GetObjectResult> {
    const object = this.getOrThrow(s3Key);
    return { body: object.body, contentType: object.contentType };
  }

  async objectExists(s3Key: string): Promise<boolean> {
    return this.objects.has(s3Key);
  }

  async getPresignedUploadUrl(s3Key: string, input: PresignedUploadInput): Promise<string> {
    if (input.expirySeconds <= 0) {
      throw new Error('expirySeconds must be positive');
    }
    const expiresAt = Date.now() + input.expirySeconds * 1000;
    return `https://mock-storage.local/${s3Key}?upload=1&expires=${expiresAt}`;
  }

  async getPresignedUrl(s3Key: string, expirySeconds: number): Promise<string> {
    if (expirySeconds <= 0) {
      throw new Error('expirySeconds must be positive');
    }
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

  async deleteObject(s3Key: string, authorization: DeleteAuthorization): Promise<void> {
    if (!authorization.authorizedBy || !authorization.reason) {
      throw new Error('deleteObject requires an explicit authorizedBy and reason');
    }
    this.getOrThrow(s3Key);
    this.objects.delete(s3Key);
  }

  private getOrThrow(s3Key: string): InternalObject {
    const object = this.objects.get(s3Key);
    if (!object) {
      throw new Error(`Unknown object: ${s3Key}`);
    }
    return object;
  }
}
