"""WeChat reply queue. `enqueue` adds a reply from any session; `worker` runs in the desktop session and sends them.

Hard limits, counted from every Enter pressed and enforced here whatever the caller wants: one reply per conversation
and five overall in any 60 seconds. A reply is confirmed by its own row appearing in the decoded store. Anything that
cannot be confirmed pauses the queue and is never retried, because it may already have been sent.
"""
import ctypes, json, os, re, sqlite3, sys, time
from ctypes import wintypes

HOME = r"C:\Users\Administrator\wx-baseline"
OUTBOX = HOME + r"\outbox.db"
PAUSED = HOME + r"\outbox.paused"
STOP = HOME + r"\outbox.stop"
LOG = HOME + r"\outbox.log"
DIRECTORY = HOME + r"\directory_watch.db"
STORE = r"C:\Data\chatlog\decrypted\wxid_SELF_XXXX\messages.db"
WINDOW_S, PER_CONVERSATION, OVERALL = 60, 1, 5
MAX_REPLY_CHARS = 80
SEARCH_WAIT, OPEN_WAIT, PASTE_WAIT, CONFIRM_S = 0.8, 0.5, 0.1, 15

SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL, conversation_name TEXT NOT NULL, text TEXT NOT NULL, inbound_id INTEGER,
  state TEXT NOT NULL DEFAULT 'queued', enqueued_at REAL NOT NULL,
  picked_at REAL, opened_at REAL, enter_at REAL, confirmed_at REAL, store_id INTEGER, error TEXT);
"""


def pick(queued, enter_times, now):
    """The oldest queued reply the limits allow now. queued: (id, conversation) oldest first; enter_times: (conversation, time)."""
    recent = [conversation for conversation, at in enter_times if now - at < WINDOW_S]
    if len(recent) >= OVERALL:
        return None
    for row_id, conversation in queued:
        if recent.count(conversation) < PER_CONVERSATION:
            return row_id
    return None


def has_mention(text):
    """A pasted @name is plain text in WeChat, not a mention; replies name the person as "名称，内容" instead."""
    return re.search(r"(^|\s)[@＠]\S", text) is not None


def open_outbox():
    db = sqlite3.connect(OUTBOX, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    present = {row[1] for row in db.execute("PRAGMA table_info(outbox)")}
    for column in ("round_id INTEGER",):
        if column.split()[0] not in present:
            db.execute(f"ALTER TABLE outbox ADD COLUMN {column}")
    return db


def read_only(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)


def enqueue(conversation_id, inbound_id, round_id=None):
    text = sys.stdin.read().strip()
    if not text:
        raise SystemExit("empty reply")
    if has_mention(text):
        raise SystemExit("reply contains @name; write 名称，内容 instead")
    if len(text) > MAX_REPLY_CHARS:
        raise SystemExit(f"reply is {len(text)} characters, the limit is {MAX_REPLY_CHARS}; split it into several replies")
    row = read_only(DIRECTORY).execute("SELECT remark, nick_name FROM contact WHERE username=?", (conversation_id,)).fetchone()
    if not row:
        raise SystemExit(f"unknown conversation {conversation_id}")
    db = open_outbox()
    with db:
        cursor = db.execute("INSERT INTO outbox(conversation_id, conversation_name, text, inbound_id, enqueued_at, round_id) VALUES(?,?,?,?,?,?)",
                            (conversation_id, row[0] or row[1], text, inbound_id, time.time(), round_id))
    print(json.dumps({"id": cursor.lastrowid, "paused": os.path.exists(PAUSED)}))


def status():
    db = open_outbox()
    db.row_factory = sqlite3.Row
    print(json.dumps({"paused": open(PAUSED, encoding="utf-8").read() if os.path.exists(PAUSED) else None,
                      "rows": [dict(row) for row in db.execute("SELECT * FROM outbox ORDER BY id DESC LIMIT 20")]}, ensure_ascii=False))


class Desktop:
    VK = {"ctrl": 0x11, "alt": 0x12, "f": 0x46, "v": 0x56, "a": 0x41, "enter": 0x0D, "esc": 0x1B}

    def __init__(self):
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32.GlobalAlloc.restype, self.kernel32.GlobalAlloc.argtypes = wintypes.HGLOBAL, (wintypes.UINT, ctypes.c_size_t)
        self.kernel32.GlobalLock.restype, self.kernel32.GlobalLock.argtypes = wintypes.LPVOID, (wintypes.HGLOBAL,)
        self.kernel32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
        self.user32.SetClipboardData.restype, self.user32.SetClipboardData.argtypes = wintypes.HANDLE, (wintypes.UINT, wintypes.HANDLE)
        self.user32.OpenClipboard.argtypes = (wintypes.HWND,)

    def press(self, *names):
        for name in names:
            self.user32.keybd_event(self.VK[name], 0, 0, 0)
        for name in reversed(names):
            self.user32.keybd_event(self.VK[name], 0, 2, 0)

    def clipboard(self, text):
        data = text.encode("utf-16-le") + b"\0\0"
        handle = self.kernel32.GlobalAlloc(0x0002, len(data))
        ctypes.memmove(self.kernel32.GlobalLock(handle), data, len(data))
        self.kernel32.GlobalUnlock(handle)
        for _ in range(20):
            if self.user32.OpenClipboard(None):
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("clipboard busy")
        self.user32.EmptyClipboard()
        ok = self.user32.SetClipboardData(13, handle)
        self.user32.CloseClipboard()
        if not ok:
            raise RuntimeError("clipboard not set")

    def window(self):
        found = []

        def visit(hwnd, _):
            title = ctypes.create_unicode_buffer(16)
            self.user32.GetWindowTextW(hwnd, title, 16)
            if self.user32.IsWindowVisible(hwnd) and title.value == "微信":
                found.append(hwnd)
            return True

        self.user32.EnumWindows(ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(visit), 0)
        if len(found) != 1:
            raise RuntimeError(f"expected one WeChat window, found {len(found)}")
        return found[0]

    def focus(self):
        hwnd = self.window()
        if self.user32.GetForegroundWindow() != hwnd:
            self.press("alt")  # A background process may take the foreground only right after input.
            self.user32.ShowWindow(hwnd, 9)
            self.user32.SetForegroundWindow(hwnd)
            time.sleep(0.15)
        if self.user32.GetForegroundWindow() != hwnd:
            raise RuntimeError("WeChat did not take the foreground")

    def open_chat(self, name):
        self.focus()
        self.press("ctrl", "f")
        time.sleep(0.2)
        self.clipboard(name)
        self.press("ctrl", "v")
        time.sleep(SEARCH_WAIT)
        self.focus()
        self.press("enter")
        time.sleep(OPEN_WAIT)

    def paste(self, text):
        self.focus()
        self.clipboard(text)
        self.press("ctrl", "a")  # Replaces any draft left in the input box.
        self.press("ctrl", "v")
        time.sleep(PASTE_WAIT)
        self.focus()


def log(text):
    with open(LOG, "a", encoding="utf-8") as out:
        out.write(f"{time.strftime('%m-%d %H:%M:%S')} {text}\n")


def pause(reason):
    with open(PAUSED, "w", encoding="utf-8") as out:
        out.write(reason)
    log("PAUSED " + reason)


def confirm(db, row_id, conversation, text, after_id):
    deadline = time.time() + CONFIRM_S
    while time.time() < deadline:
        store = read_only(STORE)
        found = store.execute("SELECT id, conversation_id, detected_at FROM messages WHERE id>? AND mine=1 AND text=? ORDER BY id LIMIT 1", (after_id, text)).fetchone()
        store.close()
        if found:
            state = "sent" if found[1] == conversation else "wrong_conversation"
            with db:
                db.execute("UPDATE outbox SET state=?, confirmed_at=?, store_id=? WHERE id=?", (state, found[2], found[0], row_id))
            if state != "sent":
                pause(f"reply {row_id} appeared in {found[1]}, expected {conversation}")
            return
        time.sleep(0.1)
    with db:
        db.execute("UPDATE outbox SET state='unconfirmed' WHERE id=?", (row_id,))
    pause(f"reply {row_id} did not reach the store within {CONFIRM_S} s; it may have been sent, not retrying")


def send(db, desktop, row_id):
    conversation, name, text = db.execute("SELECT conversation_id, conversation_name, text FROM outbox WHERE id=?", (row_id,)).fetchone()
    with db:
        db.execute("UPDATE outbox SET state='sending', picked_at=? WHERE id=?", (time.time(), row_id))
    try:
        store = read_only(STORE)
        after_id = store.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]
        store.close()
        desktop.open_chat(name)
        opened_at = time.time()
        desktop.paste(text)
    except Exception as error:  # Enter was not pressed in the input box, so nothing was sent.
        desktop.press("esc")
        with db:
            db.execute("UPDATE outbox SET state='failed', error=? WHERE id=?", (repr(error), row_id))
        pause(f"reply {row_id} failed before sending: {error!r}")
        return
    with db:  # Recorded first: from here on this reply counts against the limits and is never retried.
        db.execute("UPDATE outbox SET opened_at=?, enter_at=? WHERE id=?", (opened_at, time.time(), row_id))
    desktop.press("enter")
    confirm(db, row_id, conversation, text, after_id)


def worker():
    mutex = ctypes.WinDLL("kernel32", use_last_error=True).CreateMutexW(None, False, "wx-outbox-worker")
    if ctypes.get_last_error() == 183:
        raise SystemExit("worker already running")
    db, desktop = open_outbox(), Desktop()
    with db:
        stale = db.execute("UPDATE outbox SET state='unconfirmed', error='worker restarted mid-send' WHERE state='sending'").rowcount
    if stale:
        pause(f"{stale} reply was being sent when the worker stopped")
    log("worker started")
    while not os.path.exists(STOP):
        if not os.path.exists(PAUSED):
            queued = db.execute("SELECT id, conversation_id FROM outbox WHERE state='queued' ORDER BY id").fetchall()
            sends = db.execute("SELECT conversation_id, enter_at FROM outbox WHERE enter_at IS NOT NULL AND enter_at>?", (time.time() - WINDOW_S,)).fetchall()
            row_id = pick(queued, sends, time.time())
            if row_id is not None:
                send(db, desktop, row_id)
                log(f"handled reply {row_id}")
        time.sleep(0.1)
    log("worker stopped")
    del mutex


if __name__ == "__main__":
    if sys.stdout:  # pythonw has none.
        sys.stdout.reconfigure(encoding="utf-8")
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "enqueue":
        enqueue(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else None)
    elif command == "status":
        status()
    elif command == "worker":
        try:
            worker()
        except Exception as error:
            log(f"worker crashed: {error!r}")
            raise
    else:
        raise SystemExit("usage: wx_outbox.py enqueue CONVERSATION [INBOUND_ID] < text | status | worker")
