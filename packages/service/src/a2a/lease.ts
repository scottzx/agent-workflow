/** Single-writer directory lease shared by A2A records and plugin diagnostics. */
export function isStorageBusy(error: unknown): boolean {
  return error instanceof Error && error.message === 'A2A storage directory is already in use by another instance';
}
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
interface Lock { pid: number; token: string }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
/** Reject a live owner; reclaim only uniquely named markers whose process is demonstrably absent. */
export class DirectoryLease {
  private readonly directory: string;
  private readonly lock: Lock = { pid: process.pid, token: randomUUID() };
  private closed = false;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Storage directory must be a real directory');
    this.acquireLock();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // The owner filename is unique to this instance. Never unlink a shared
    // lock path: another process may have acquired it since our last check.
    const path = this.ownerPath();
    try {
      const lock = this.readJson(path) as Lock;
      if (lock.token === this.lock.token && lock.pid === this.lock.pid) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.removeEmptyLockDirectory();
  }
  private acquireLock(): void {
    const path = join(this.directory, '.lock');
    for (let attempt = 0; attempt < 32; attempt++) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = lstatSync(path);
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Legacy or invalid A2A .lock file; verify no instance is running before removing it');
          }
          const names = readdirSync(path);
          for (const name of names) {
            const lock = record(this.readJson(join(path, name)), 'storage lock');
            if (!Number.isInteger(lock.pid) || (lock.pid as number) <= 0 ||
              typeof lock.token !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(lock.token) ||
              name !== `owner-${lock.pid}-${lock.token}.json`) {
              throw new Error('Invalid A2A storage lock; inspect the storage directory before removing it');
            }
            let dead = false;
            try { process.kill(lock.pid as number, 0); } catch (cause) {
              dead = (cause as NodeJS.ErrnoException).code === 'ESRCH';
            }
            if (!dead) throw new Error('A2A storage directory is already in use by another instance');
          }
          // Only remove the unique filenames observed above. A new live owner
          // can never share them, so a delayed contender cannot delete its lock.
          for (const name of names) {
            try { unlinkSync(join(path, name)); } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
            }
          }
          this.removeEmptyLockDirectory();
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
        continue;
      }

      try {
        const fd = openSync(this.ownerPath(), 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(this.lock)); fsyncSync(fd); } finally { closeSync(fd); }
        // A competing recovery can replace an empty directory between mkdir
        // and marker creation. If both contenders wrote into that replacement,
        // only the sole remaining owner may return a successfully held lock.
        const names = readdirSync(path);
        if (names.length !== 1 || names[0] !== this.ownerName()) {
          throw new Error('A2A storage directory is already in use by another instance');
        }
        return;
      } catch (error) {
        try { unlinkSync(this.ownerPath()); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
        this.removeEmptyLockDirectory();
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Could not acquire A2A storage lock');
  }

  private ownerName(): string { return `owner-${this.lock.pid}-${this.lock.token}.json`; }
  private ownerPath(): string { return join(this.directory, '.lock', this.ownerName()); }

  private removeEmptyLockDirectory(): void {
    try { rmdirSync(join(this.directory, '.lock')); } catch (error) {
      // A live marker makes rmdir fail; never recursively remove a lock directory.
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }

  private readJson(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid A2A storage file');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }
}
