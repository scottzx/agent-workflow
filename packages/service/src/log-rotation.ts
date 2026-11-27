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
  fs.renameSync(fullPath, targetPath);
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

function writeToStream(
  getStream: () => fs.WriteStream | null,
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
): boolean {
  const stream = getStream();
  if (!stream) return true;
  if (typeof encodingOrCallback === 'function') {
    return stream.write(chunk, encodingOrCallback);
  }
  if (encodingOrCallback !== undefined) {
    return stream.write(chunk, encodingOrCallback, callback);
  }
  return stream.write(chunk, callback);
}

/**
 * Redirect process.stdout and process.stderr into daily rotated files under logDir,
 * maintaining `<prefix>.log` / `<prefix>.err.log` symlinks and pruning files >= retainDays old.
 */
export function installDailyLogRotation(options: DailyLogRotationOptions): DailyLogRotationHandle {
  const logDir = path.resolve(options.logDir);
  const prefix = options.prefix?.trim() || 'acp-service';
  const retainDays =
    typeof options.retainDays === 'number' && Number.isFinite(options.retainDays) && options.retainDays > 0
      ? Math.floor(options.retainDays)
      : DEFAULT_RETAIN_DAYS;
  const now = options.now ?? (() => new Date());

  fs.mkdirSync(logDir, { recursive: true });
  const initialDate = now();
  archiveRegularFileIfExists(logDir, `${prefix}.log`, prefix, '.log', initialDate);
  archiveRegularFileIfExists(logDir, `${prefix}.err.log`, prefix, '.err.log', initialDate);

  let activeDate = '';
  let outStream: fs.WriteStream | null = null;
  let errStream: fs.WriteStream | null = null;
  let closed = false;

  const openForDate = (dateStr: string) => {
    const prevOut = outStream;
    const prevErr = errStream;

    const outFile = `${prefix}-${dateStr}.log`;
    const errFile = `${prefix}-${dateStr}.err.log`;
    outStream = fs.createWriteStream(path.join(logDir, outFile), { flags: 'a' });
    errStream = fs.createWriteStream(path.join(logDir, errFile), { flags: 'a' });
    activeDate = dateStr;

    updateSymlink(logDir, `${prefix}.log`, outFile);
    updateSymlink(logDir, `${prefix}.err.log`, errFile);

    prevOut?.end();
    prevErr?.end();

    pruneExpiredLogs(logDir, prefix, retainDays, dateStr);
  };

  const rotateIfNeeded = () => {
    if (closed) return;
    const todayStr = formatLocalDate(now());
    if (todayStr !== activeDate) {
      openForDate(todayStr);
    }
  };

  openForDate(formatLocalDate(initialDate));

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    if (closed) {
      return originalStdoutWrite(chunk, encodingOrCallback as never, callback as never);
    }
    rotateIfNeeded();
    return writeToStream(() => outStream, chunk, encodingOrCallback, callback);
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
    return writeToStream(() => errStream, chunk, encodingOrCallback, callback);
  }) as typeof process.stderr.write;

  const closeStream = (stream: fs.WriteStream | null): Promise<void> =>
    new Promise((resolve) => {
      if (!stream) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stream.once('close', done);
      stream.once('error', done);
      stream.end();
    });

  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    const prevOut = outStream;
    const prevErr = errStream;
    outStream = null;
    errStream = null;
    return Promise.all([closeStream(prevOut), closeStream(prevErr)]).then(() => undefined);
  };

  return {
    currentDate: () => activeDate,
    rotateIfNeeded,
    close,
  };
}
