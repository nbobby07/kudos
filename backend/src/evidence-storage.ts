import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export interface EvidenceStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class EvidenceStorage implements EvidenceStore {
  readonly directory: string;

  constructor(directory = ".data/evidence") {
    this.directory = resolve(directory);
  }

  private path(key: string): string {
    if (!z.uuid().safeParse(key).success) throw new Error("Invalid evidence storage key");
    return join(this.directory, key);
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid evidence directory");
    await chmod(this.directory, 0o700);
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const destination = this.path(key);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_EVIDENCE_BYTES) {
      throw new Error("Invalid evidence size");
    }
    await this.prepare();
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, destination);
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.path(key);
    await this.prepare();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) throw new Error("Invalid evidence file");
      // Bound reads even if another process grows the file after stat.
      const bytes = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await file.read(bytes, size, bytes.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > MAX_EVIDENCE_BYTES) throw new Error("Invalid evidence size");
      return bytes.subarray(0, size);
    } finally { await file.close(); }
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    await this.prepare();
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.syncDirectory();
  }
}
