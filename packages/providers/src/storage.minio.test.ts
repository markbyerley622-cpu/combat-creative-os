import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
// vitest hoists vi.mock calls above every import in this file, so this
// static import already resolves against the mocked S3Client below.
import { createMinioStorageProvider } from './storage.minio';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  };
});

const getSignedUrlMock = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...args),
}));

function buildConfig() {
  return {
    endpoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    bucket: 'combat-creative-assets',
    region: 'us-east-1',
    forcePathStyle: true,
  };
}

describe('createMinioStorageProvider', () => {
  beforeEach(() => {
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
  });

  it('putObject computes a SHA-256 checksum and sends it as object metadata (S3 ETag is not a reliable hash)', async () => {
    sendMock.mockResolvedValueOnce({});
    const storage = createMinioStorageProvider(buildConfig());

    const result = await storage.putObject({ s3Key: 'a.txt', body: 'hello world' });

    const expectedChecksum = createHash('sha256').update('hello world').digest('hex');
    expect(result.checksum).toBe(expectedChecksum);
    const sentCommand = sendMock.mock.calls[0]?.[0];
    expect(sentCommand).toBeInstanceOf(PutObjectCommand);
    expect(sentCommand.input.Metadata).toEqual({ sha256: expectedChecksum });
    expect(sentCommand.input.Bucket).toBe('combat-creative-assets');
    expect(sentCommand.input.Key).toBe('a.txt');
  });

  it('headObject reads the checksum back from object metadata', async () => {
    sendMock.mockResolvedValueOnce({
      ContentLength: 11,
      ContentType: 'text/plain',
      Metadata: { sha256: 'abc123' },
    });
    const storage = createMinioStorageProvider(buildConfig());

    const meta = await storage.headObject('a.txt');

    expect(meta).toEqual({
      s3Key: 'a.txt',
      sizeBytes: 11,
      checksum: 'abc123',
      contentType: 'text/plain',
    });
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('headObject throws if the object has no sha256 metadata (not written by this adapter)', async () => {
    sendMock.mockResolvedValueOnce({ ContentLength: 11, Metadata: {} });
    const storage = createMinioStorageProvider(buildConfig());

    await expect(storage.headObject('a.txt')).rejects.toThrow(/sha256/);
  });

  it('objectExists returns false on a NotFound error and rethrows any other error', async () => {
    const storage = createMinioStorageProvider(buildConfig());

    sendMock.mockRejectedValueOnce(new NotFound({ message: 'not found', $metadata: {} }));
    expect(await storage.objectExists('missing.txt')).toBe(false);

    sendMock.mockRejectedValueOnce(new Error('network blip'));
    await expect(storage.objectExists('a.txt')).rejects.toThrow('network blip');
  });

  it('getObject converts the SDK response body into bytes', async () => {
    const transformToByteArray = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray },
      ContentType: 'application/octet-stream',
    });
    const storage = createMinioStorageProvider(buildConfig());

    const result = await storage.getObject('a.bin');

    expect(Array.from(result.body)).toEqual([1, 2, 3]);
    expect(result.contentType).toBe('application/octet-stream');
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('getPresignedUploadUrl and getPresignedUrl delegate to the SDK presigner with the right command and expiry', async () => {
    getSignedUrlMock.mockResolvedValueOnce('https://minio.local/upload-url');
    const storage = createMinioStorageProvider(buildConfig());

    const uploadUrl = await storage.getPresignedUploadUrl('a.txt', {
      expirySeconds: 300,
      contentType: 'image/png',
    });

    expect(uploadUrl).toBe('https://minio.local/upload-url');
    const [, uploadCommand, uploadOptions] = getSignedUrlMock.mock.calls[0]!;
    expect(uploadCommand).toBeInstanceOf(PutObjectCommand);
    expect(uploadCommand.input.ContentType).toBe('image/png');
    expect(uploadOptions).toEqual({ expiresIn: 300 });

    await expect(storage.getPresignedUploadUrl('a.txt', { expirySeconds: 0 })).rejects.toThrow();
    await expect(storage.getPresignedUrl('a.txt', -5)).rejects.toThrow();
  });

  it('copyObject preserves the bucket-qualified CopySource', async () => {
    sendMock.mockResolvedValueOnce({});
    const storage = createMinioStorageProvider(buildConfig());

    await storage.copyObject('src.txt', 'dest.txt');

    const sentCommand = sendMock.mock.calls[0]?.[0];
    expect(sentCommand).toBeInstanceOf(CopyObjectCommand);
    expect(sentCommand.input.CopySource).toBe('combat-creative-assets/src.txt');
    expect(sentCommand.input.Key).toBe('dest.txt');
  });

  it('deleteObject requires an explicit authorization before sending the delete command', async () => {
    const storage = createMinioStorageProvider(buildConfig());

    await expect(storage.deleteObject('a.txt', { authorizedBy: '', reason: '' })).rejects.toThrow(
      /authorizedBy/,
    );
    expect(sendMock).not.toHaveBeenCalled();

    sendMock.mockResolvedValueOnce({});
    await storage.deleteObject('a.txt', { authorizedBy: 'user-1', reason: 'test cleanup' });
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });
});
