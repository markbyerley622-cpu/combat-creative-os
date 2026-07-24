/**
 * S3-compatible object storage (MinIO locally / S3 in production).
 *
 * M5 note: the original interface exposed no delete method at all —
 * "deletion is a lifecycle-policy concern, not something application code
 * does, to preserve provenance/audit guarantees" (docs/architecture.md §5).
 * That principle is preserved: `deleteObject` below is additive, not a
 * general/lifecycle delete — it requires the caller to pass an explicit
 * `authorizedBy`/`reason` pair (there is no zero-argument delete), and
 * nothing in this milestone's application code calls it. It exists so a
 * future, explicitly-reviewed cleanup path (e.g. an admin action, or a
 * lifecycle job) has a typed, audit-shaped method to call rather than
 * reaching for a raw provider SDK — see docs/architecture.md's M5 entry.
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

export interface GetObjectResult {
  body: Uint8Array;
  contentType?: string;
}

export interface PresignedUploadInput {
  expirySeconds: number;
  contentType?: string;
}

export interface DeleteAuthorization {
  authorizedBy: string;
  reason: string;
}

export interface StorageProvider {
  readonly name: string;
  putObject(input: PutObjectInput): Promise<{ s3Key: string; checksum: string }>;
  getObject(s3Key: string): Promise<GetObjectResult>;
  objectExists(s3Key: string): Promise<boolean>;
  headObject(s3Key: string): Promise<ObjectMetadata>;
  /** Presigned PUT — the caller (never the browser) always chooses `s3Key`; see the ingestion service's doc comment on why the client is never trusted with it directly. */
  getPresignedUploadUrl(s3Key: string, input: PresignedUploadInput): Promise<string>;
  /** Presigned GET, unchanged from the original interface. */
  getPresignedUrl(s3Key: string, expirySeconds: number): Promise<string>;
  copyObject(src: string, dest: string): Promise<void>;
  deleteObject(s3Key: string, authorization: DeleteAuthorization): Promise<void>;
}
