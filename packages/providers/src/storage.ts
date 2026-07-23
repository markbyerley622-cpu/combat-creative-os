/**
 * S3-compatible object storage (MinIO locally / S3 in production). No
 * hard-delete method is exposed deliberately — see docs/architecture.md §5:
 * deletion is a lifecycle-policy concern, not something application code does,
 * to preserve provenance/audit guarantees.
 */
export interface PutObjectInput {
  s3Key: string;
  body: Uint8Array | string;
  contentType?: string;
}

export interface ObjectMetadata {
  s3Key: string;
  sizeBytes: number;
  checksum: string;
  contentType?: string;
}

export interface StorageProvider {
  readonly name: string;
  putObject(input: PutObjectInput): Promise<{ s3Key: string; checksum: string }>;
  getPresignedUrl(s3Key: string, expirySeconds: number): Promise<string>;
  headObject(s3Key: string): Promise<ObjectMetadata>;
  copyObject(src: string, dest: string): Promise<void>;
}
