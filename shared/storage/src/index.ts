/**
 * SeaweedFS client for asset storage.
 * Uses the filer HTTP API for file operations.
 */

export interface StorageConfig {
  filerUrl: string;
}

export interface UploadResult {
  path: string;
  size: number;
}

export function createStorage(config: StorageConfig) {
  const { filerUrl } = config;

  return {
    /**
     * Upload a file to SeaweedFS via the filer.
     * @param path — destination path, e.g. "/assets/doc123/image.png"
     * @param data — file content as Buffer or ReadableStream
     * @param contentType — MIME type
     */
    async upload(
      path: string,
      data: Buffer | ReadableStream | Blob,
      contentType: string,
    ): Promise<UploadResult> {
      const formData = new FormData();
      const blob =
        data instanceof Blob
          ? data
          : new Blob([data as Buffer], { type: contentType });
      formData.append("file", blob, path.split("/").pop() || "file");

      const res = await fetch(`${filerUrl}${path}`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(
          `SeaweedFS upload failed: ${res.status} ${await res.text()}`,
        );
      }

      const result = await res.json();
      return { path, size: result.size ?? 0 };
    },

    /**
     * Download a file from SeaweedFS.
     */
    async download(path: string): Promise<Response> {
      const res = await fetch(`${filerUrl}${path}`);
      if (!res.ok) {
        throw new Error(`SeaweedFS download failed: ${res.status}`);
      }
      return res;
    },

    /**
     * Delete a file from SeaweedFS.
     */
    async delete(path: string): Promise<void> {
      const res = await fetch(`${filerUrl}${path}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(`SeaweedFS delete failed: ${res.status}`);
      }
    },

    /**
     * Check if a file exists.
     */
    async exists(path: string): Promise<boolean> {
      const res = await fetch(`${filerUrl}${path}`, { method: "HEAD" });
      return res.ok;
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
