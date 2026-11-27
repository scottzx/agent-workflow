import fs from 'node:fs';
import path from 'node:path';

export interface DailyLogRotationOptions {
  logDir: string;
  retainDays?: number;
  prefix?: string;
  now?: () => Date;
}

export interface DailyLogRotationHandle {
  currentDate: () => string;
  rotateIfNeeded: () => void;
  closeSync: () => void;
  close: () => Promise<void>;
}

const DEFAULT_RETAIN_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDateDayMs(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueArchivePath(logDir: string, baseName: string, ext: string): string {
  const candidate = path.join(logDir, `${baseName}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  let seq = 1;
  while (true) {
    const numbered = path.join(logDir, `${baseName}.${seq}${ext}`);
    if (!fs.existsSync(numbered)) return numbered;
    seq += 1;
  }
}

function archiveRegularFileIfExists(
  logDir: string,
  linkName: string,
  prefix: string,
  ext: string,
  fallbackDate: Date,
): void {
  const fullPath = path.join(logDir, linkName);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  if (stat.size === 0) {
    try {
      fs.unlinkSync(fullPath);
    } catch {}
    return;
  }
  const mtimeDate = stat.mtimeMs > 0 ? new Date(stat.mtimeMs) : fallbackDate;
  const dateStr = formatLocalDate(mtimeDate);
  const targetPath = uniqueArchivePath(logDir, `${prefix}-${dateStr}`, ext);
  try {
    fs.renameSync(fullPath, targetPath);
  } catch {}
}

function updateSymlink(logDir: string, linkName: string, targetBasename: string): void {
  const linkPath = path.join(logDir, linkName);
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(linkPath);
    }
  } catch {}
  try {
    fs.symlinkSync(targetBasename, linkPath);
  } catch {}
}

export function pruneExpiredLogs(
  logDir: string,
  prefix: string,
  retainDays: number,
  todayStr: string,
): string[] {
  if (retainDays <= 0) return [];
  const todayDayMs = parseLocalDateDayMs(todayStr);
  if (todayDayMs === null) return [];

  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.\\d+)?(?:\\.err)?\\.log$`,
  );
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const match = pattern.exec(name);
    if (!match) continue;
    const fileDayMs = parseLocalDateDayMs(match[1]);
    if (fileDayMs === null) continue;
    const ageDays = Math.floor((todayDayMs - fileDayMs) / MS_PER_DAY);
    if (ageDays >= retainDays) {
      const target = path.join(logDir, name);
      try {
        fs.unlinkSync(target);
        removed.push(name);
      } catch {}
    }
  }
  return removed;
}

function toBuffer(chunk: string | Uint8Array, encoding?: BufferEncoding): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function closeFdQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {}
}

function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('Short write to rotated log file');
    offset += written;
  }
}

/**
 * Redirect process.stdout and process.stderr into daily rotated files under logDir,
 * maintaining `<prefix>.log` / `<prefix>.err.log` symlinks and pruning files >= retainDays old.
 *
 * Writes go through synchronous append descriptors so short-lived processes never lose
 * buffered output on `process.exit()`, and I/O failures degrade cleanly to the original
 * stdout/stderr instead of crashing the daemon with an unhandled stream error.
 */
export function installDailyLogRotation(options: DailyLogRotationOptions): DailyLogRotationHandle {
  const logDir = path.resolve(options.logDir);
  const prefix = options.prefix?.trim() || 'acp-service';
  const retainDays =
    typeof options.retainDays === 'number' && Number.isFinite(options.retainDays) && options.retainDays > 0
      ? Math.floor(options.retainDays)
      : DEFAULT_RETAIN_DAYS;
  const now = options.now ?? (() => new Date());

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  let lastWarning = '';
  const warnFallback = (context: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    const key = `${context}:${detail}`;
    if (key === lastWarning) return;
    lastWarning = key;
    try {
      originalStderrWrite(`[log-rotation] ${context} (${detail}); falling back to stdio\n`);
    } catch {}
  };

  let activeDate = '';
  let outFd: number | null = null;
  let errFd: number | null = null;
  let closed = false;

  const openAppendFd = (filePath: string, label: string): number | null => {
    try {
      return fs.openSync(filePath, 'a');
    } catch (error) {
      warnFallback(`cannot open ${label} ${filePath}`, error);
      return null;
    }
  };

  const openForDate = (dateStr: string) => {
    const prevOut = outFd;
    const prevErr = errFd;

    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (error) {
      warnFallback(`cannot prepare logDir ${logDir}`, error);
      activeDate = dateStr;
      outFd = null;
      errFd = null;
      closeFdQuietly(prevOut);
      closeFdQuietly(prevErr);
      return;
    }

    const outFile = `${prefix}-${dateStr}.log`;
    const errFile = `${prefix}-${dateStr}.err.log`;
    outFd = openAppendFd(path.join(logDir, outFile), 'stdout log');
    errFd = openAppendFd(path.join(logDir, errFile), 'stderr log');
    activeDate = dateStr;

    if (outFd !== null) updateSymlink(logDir, `${prefix}.log`, outFile);
    if (errFd !== null) updateSymlink(logDir, `${prefix}.err.log`, errFile);

    closeFdQuietly(prevOut);
    closeFdQuietly(prevErr);

    pruneExpiredLogs(logDir, prefix, retainDays, dateStr);
  };

  const initialDate = now();
  try {
    fs.mkdirSync(logDir, { recursive: true });
    archiveRegularFileIfExists(logDir, `${prefix}.log`, prefix, '.log', initialDate);
    archiveRegularFileIfExists(logDir, `${prefix}.err.log`, prefix, '.err.log', initialDate);
  } catch (error) {
    warnFallback(`cannot initialize logDir ${logDir}`, error);
  }

  const rotateIfNeeded = () => {
    if (closed) return;
    const todayStr = formatLocalDate(now());
    if (todayStr !== activeDate) {
      openForDate(todayStr);
    }
  };

  openForDate(formatLocalDate(initialDate));

  const writeChannel = (
    label: string,
    getFd: () => number | null,
    clearFd: () => void,
    fallback: typeof originalStdoutWrite,
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const fd = getFd();
    if (fd === null) {
      return fallback(chunk, encodingOrCallback as never, callback as never);
    }
    try {
      writeAllSync(fd, toBuffer(chunk, encoding));
      cb?.(null);
      return true;
    } catch (error) {
      closeFdQuietly(fd);
      clearFd();
      warnFallback(`write failed on ${label}`, error);
      return fallback(chunk, encodingOrCallback as never, callback as never);
    }
  };

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    if (closed) {
      return originalStdoutWrite(chunk, encodingOrCallback as never, callback as never);
    }
    rotateIfNeeded();
    return writeChannel(
      'stdout log',
      () => outFd,
      () => { outFd = null; },
      originalStdoutWrite,
      chunk,
      encodingOrCallback,
      callback,
    );
  }) as typeof process.stdout.write;

  process.stderr.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    if (closed) {
      return originalStderrWrite(chunk, encodingOrCallback as never, callback as never);
    }
    rotateIfNeeded();
    return writeChannel(
      'stderr log',
      () => errFd,
      () => { errFd = null; },
      originalStderrWrite,
      chunk,
      encodingOrCallback,
      callback,
    );
  }) as typeof process.stderr.write;

  const closeSync = (): void => {
    if (closed) return;
    closed = true;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    const prevOut = outFd;
    const prevErr = errFd;
    outFd = null;
    errFd = null;
    closeFdQuietly(prevOut);
    closeFdQuietly(prevErr);
  };

  const close = (): Promise<void> => {
    closeSync();
    return Promise.resolve();
  };

  return {
    currentDate: () => activeDate,
    rotateIfNeeded,
    closeSync,
    close,
  };
}
