/** macOS banner for a new workbench request. terminal-notifier opens the page on click; osascript only shows the banner. Failures are ignored. */
import { execFile } from 'node:child_process';

export function notifyDesktop(title: string, message: string, url?: string): void {
  if (process.platform !== 'darwin') return;
  execFile('terminal-notifier', ['-title', title, '-message', message, ...(url ? ['-open', url] : [])], error => {
    if (!error) return;
    // argv keeps the text out of the AppleScript source.
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message], () => {});
  });
}
