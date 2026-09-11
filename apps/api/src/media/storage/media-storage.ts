// Milestone 8F — a small, bounded storage abstraction so no controller or
// service ever calls an AWS SDK (or touches process memory) directly.
// `MediaAsset.objectKey` is the ONLY thing persisted for an upload; the
// public URL is always resolved from configuration through this
// interface, never stored. `remove` is best-effort cleanup for an upload
// whose DB write failed — it is NOT part of the deactivate flow (8F never
// deletes a storage object through Admin action).
export interface MediaStorage {
  put(input: {
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;

  resolvePublicUrl(objectKey: string): string;

  // Best-effort. Implementations should log and swallow their own errors —
  // callers treat this as fire-and-forget cleanup, never a source of a
  // user-facing failure.
  remove(objectKey: string): Promise<void>;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
