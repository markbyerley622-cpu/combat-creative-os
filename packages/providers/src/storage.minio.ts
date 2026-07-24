import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  DeleteAuthorization,
  GetObjectResult,
  ObjectMetadata,
  PresignedUploadInput,
  PutObjectInput,
  StorageProvider,
} from './storage';

/**
 * Explicit, caller-supplied configuration — this module never reads
 * `process.env` itself (CLAUDE.md provider-adapter rule: "Provider
 * credentials are read only via packages/config's validated env schema —
 * never read process.env directly in adapter code"). The caller (apps/api,
 * apps/worker) maps `@combat/config`'s validated `minioEnvSchema` output
 * into this shape.
 */
export interface MinioStorageConfig {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  /** MinIO (and most self-hosted S3-compatible stores) requires path-style addressing; real AWS S3 defaults to virtual-hosted-style. */
  forcePathStyle: boolean;
}

const SHA256_METADATA_KEY = 'sha256';

/**
 * MinIO-locally / S3-compatible-in-production adapter (docs/architecture.md
 * §5's `StorageProvider`, extended for M5). S3's own `ETag` is not a
 * reliable SHA-256 (it's MD5 for non-multipart uploads and something else
 * entirely for multipart) — this adapter computes SHA-256 itself at
 * `putObject` time and round-trips it through S3 object metadata
 * (`x-amz-meta-sha256`), which `copyObject`'s default `COPY` metadata
 * directive carries forward automatically.
 */
export function createMinioStorageProvider(config: MinioStorageConfig): StorageProvider {
  const client = new S3Client({
    endpoint: `${config.useSSL ? 'https' : 'http'}://${config.endpoint}:${config.port}`,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  async function objectExists(s3Key: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: s3Key }));
      return true;
    } catch (error) {
      if (error instanceof NotFound) return false;
      throw error;
    }
  }

  return {
    name: 'minio-storage',

    async putObject(input: PutObjectInput) {
      const body =
        typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body);
      const checksum = createHash('sha256').update(body).digest('hex');
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.s3Key,
          Body: body,
          ContentType: input.contentType,
          Metadata: { [SHA256_METADATA_KEY]: checksum },
        }),
      );
      return { s3Key: input.s3Key, checksum };
    },

    async getObject(s3Key: string): Promise<GetObjectResult> {
      const response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: s3Key }),
      );
      if (!response.Body) {
        throw new Error(`Object ${s3Key} returned no body`);
      }
      const body = await response.Body.transformToByteArray();
      return { body, contentType: response.ContentType };
    },

    objectExists,

    async headObject(s3Key: string): Promise<ObjectMetadata> {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: s3Key }),
      );
      const checksum = response.Metadata?.[SHA256_METADATA_KEY];
      if (!checksum) {
        throw new Error(
          `Object ${s3Key} is missing its ${SHA256_METADATA_KEY} metadata — it was not written by this adapter's putObject`,
        );
      }
      return {
        s3Key,
        sizeBytes: response.ContentLength ?? 0,
        checksum,
        contentType: response.ContentType,
      };
    },

    async getPresignedUploadUrl(s3Key: string, input: PresignedUploadInput): Promise<string> {
      if (input.expirySeconds <= 0) {
        throw new Error('expirySeconds must be positive');
      }
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: s3Key,
        ContentType: input.contentType,
      });
      return getSignedUrl(client, command, { expiresIn: input.expirySeconds });
    },

    async getPresignedUrl(s3Key: string, expirySeconds: number): Promise<string> {
      if (expirySeconds <= 0) {
        throw new Error('expirySeconds must be positive');
      }
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: s3Key });
      return getSignedUrl(client, command, { expiresIn: expirySeconds });
    },

    async copyObject(src: string, dest: string): Promise<void> {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          CopySource: `${config.bucket}/${src}`,
          Key: dest,
        }),
      );
    },

    async deleteObject(s3Key: string, authorization: DeleteAuthorization): Promise<void> {
      if (!authorization.authorizedBy || !authorization.reason) {
        throw new Error('deleteObject requires an explicit authorizedBy and reason');
      }
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: s3Key }));
    },
  };
}
