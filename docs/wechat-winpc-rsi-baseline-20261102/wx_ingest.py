"""Reads every WeChat message into a decoded SQLite store, incrementally and read-only.

Polls message_*.db (+WAL) of the logged-in account. Each database keeps one decrypted mirror in a private temp file;
only the WAL frames that arrived since are decrypted into it. A new message is written once to messages.db in
STORE_DIR (unique per db + conversation table + local_id), with the conversation and sender names, the text and,
for a quote reply, the quoted message. The store is also the cursor: on start the highest local_id per conversation
is read back from it, so a restart picks up what arrived while it was down (marked backfill) and never repeats a row.
Consumers read the store, for example WHERE id > <last id they handled>.

WX_POLL_INTERVAL sets the check interval in seconds (default 0.5). Between full scans (WX_RECONCILE seconds,
default 60) only the conversations the session list says moved are opened.

  python wx_ingest.py [seconds, 0 or omitted = forever]
"""
import glob
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import time
import xml.etree.ElementTree as ET
from compression import zstd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wcdb_key_tool_windows import PAGE_SZ, _decrypt_page  # noqa: E402

DB_DIR = r"C:\Users\Administrator\Documents\xwechat_files\wxid_SELF_XXXX\db_storage\message"
CONTACT = os.path.normpath(os.path.join(DB_DIR, "..", "contact", "contact.db"))
SESSION = os.path.normpath(os.path.join(DB_DIR, "..", "session", "session.db"))
MY_ID = "wxid_SELF"
STORE_DIR = r"C:\Data\chatlog\decrypted\wxid_SELF_XXXX"
RECONCILE = float(os.environ.get("WX_RECONCILE", "60"))
INTERVAL = float(os.environ.get("WX_POLL_INTERVAL", "0.5"))
FRAME = 24 + PAGE_SZ


def read_all(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return b""


def db_names():
    return sorted(os.path.basename(p) for p in glob.glob(os.path.join(DB_DIR, "message_[0-9]*.db")))


def load_session_key():
    with open(os.path.join(HERE, "keys.json"), encoding="utf-8") as f:
        return bytes.fromhex(json.load(f)["session\\session.db"]["enc_key"])


def load_keys():
    with open(os.path.join(HERE, "keys.json"), encoding="utf-8") as f:
        keys = json.load(f)
    return {name: bytes.fromhex(keys[f"message\\{name}"]["enc_key"]) for name in db_names() if f"message\\{name}" in keys}


def build_snapshot(path, key, target):
    """Decrypt the main file, then lay the WAL frames up to the last commit over it."""
    data = read_all(path)
    pages = [_decrypt_page(key, data[i:i + PAGE_SZ], i // PAGE_SZ + 1) for i in range(0, len(data) // PAGE_SZ * PAGE_SZ, PAGE_SZ)]
    wal = read_all(path + "-wal")
    applied = 0
    if len(wal) >= 32:
        salts = struct.unpack(">II", wal[16:24])
        frames, off = [], 32
        while off + FRAME <= len(wal):
            pgno, commit, s1, s2 = struct.unpack(">IIII", wal[off:off + 16])
            if (s1, s2) != salts:
                break
            frames.append((pgno, commit, off + 24))
            off += FRAME
        last = max((i for i, f in enumerate(frames) if f[1]), default=-1)
        for pgno, _, start in frames[:last + 1]:
            while len(pages) < pgno:
                pages.append(bytes(PAGE_SZ))
            pages[pgno - 1] = _decrypt_page(key, wal[start:start + PAGE_SZ], pgno)
        applied = last + 1
    with open(target, "wb") as f:
        f.write(b"".join(pages))
    return applied


class Mirror:
    """A decrypted copy of one database, kept current by decrypting only the WAL frames that arrived since.

    The copy is rebuilt in full only the first time and when the WAL starts a new generation (new salts, after a
    checkpoint), so the cost of a refresh follows the number of new frames, not the size of the database.
    """

    def __init__(self, path, key, target):
        self.path, self.key, self.target = path, key, target
        self.salts, self.applied = None, 0

    def wal_salts(self):
        try:
            with open(self.path + "-wal", "rb") as f:
                head = f.read(32)
        except OSError:
            return None
        return struct.unpack(">II", head[16:24]) if len(head) == 32 else None

    def refresh(self):
        """Bring the copy up to the last committed frame; returns (frames applied this time, 'full' or 'incremental')."""
        salts = self.wal_salts()
        if salts is None or salts != self.salts or not os.path.exists(self.target):
            self.salts = salts
            self.applied = build_snapshot(self.path, self.key, self.target)
            return self.applied, "full"
        with open(self.path + "-wal", "rb") as f:
            f.seek(32 + self.applied * FRAME)
            tail = f.read()
        frames, off = [], 0
        while off + FRAME <= len(tail):
            pgno, commit, s1, s2 = struct.unpack(">IIII", tail[off:off + 16])
            if (s1, s2) != salts:
                break
            frames.append((pgno, commit, off + 24))
            off += FRAME
        last = max((i for i, f in enumerate(frames) if f[1]), default=-1)
        if last >= 0:
            with open(self.target, "r+b") as out:
                for pgno, _, start in frames[:last + 1]:
                    out.seek((pgno - 1) * PAGE_SZ)
                    out.write(_decrypt_page(self.key, tail[start:start + PAGE_SZ], pgno))
            self.applied += last + 1
        return last + 1, "incremental"


def stamp_of(*paths):
    return tuple((os.stat(p).st_size, os.stat(p).st_mtime_ns) if os.path.exists(p) else None for p in paths)


def load_directory(snapshot):
    """Who is who: display names by username, the group usernames, and the md5 that names each Msg_ table."""
    with open(os.path.join(HERE, "keys.json"), encoding="utf-8") as f:
        key = bytes.fromhex(json.load(f)["contact\\contact.db"]["enc_key"])
    build_snapshot(CONTACT, key, snapshot)
    conn = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
    try:
        names = {u: remark or nick or alias or u for u, remark, nick, alias in conn.execute("SELECT username, remark, nick_name, alias FROM contact")}
        rooms = {r[0] for r in conn.execute("SELECT username FROM chat_room")}
    finally:
        conn.close()
    return {"names": names, "rooms": rooms, "by_md5": {hashlib.md5(u.encode()).hexdigest(): u for u in set(names) | rooms}}


COLUMNS = ("db", "msg_table", "local_id", "server_id", "create_time", "type", "subtype", "mine", "sender_id", "sender",
           "conversation_id", "conversation_name", "is_group", "text", "quote", "detected_at", "lag_s", "refresh", "scan",
           "interval_s", "backfill", "at_ids")
SCHEMA = """
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  db TEXT NOT NULL, msg_table TEXT NOT NULL, local_id INTEGER NOT NULL, server_id INTEGER,
  create_time INTEGER NOT NULL, type INTEGER, subtype INTEGER, mine INTEGER, sender_id TEXT, sender TEXT,
  conversation_id TEXT, conversation_name TEXT, is_group INTEGER, text TEXT, quote TEXT,
  detected_at REAL, lag_s REAL, refresh TEXT, scan TEXT, interval_s REAL, backfill INTEGER,
  UNIQUE(db, msg_table, local_id));
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, create_time);
"""


def open_store():
    os.makedirs(STORE_DIR, exist_ok=True)
    store = sqlite3.connect(os.path.join(STORE_DIR, "messages.db"))
    store.execute("PRAGMA journal_mode=WAL")
    store.executescript(SCHEMA)
    if "at_ids" not in {row[1] for row in store.execute("PRAGMA table_info(messages)")}:
        store.execute("ALTER TABLE messages ADD COLUMN at_ids TEXT")
    return store


def cursor_of(store):
    cursor = {}
    for db, table, last in store.execute("SELECT db, msg_table, MAX(local_id) FROM messages GROUP BY db, msg_table"):
        cursor.setdefault(db, {})[table] = last
    return cursor


def save_rows(store, rows):
    """One transaction per batch: either every row of the batch is stored or none."""
    values = []
    for r in rows:
        r = dict(r, quote=json.dumps(r["quote"], ensure_ascii=False) if r.get("quote") else None,
                 mine=int(r["mine"]), backfill=int(r["backfill"]), is_group=None if r["is_group"] is None else int(r["is_group"]))
        values.append(tuple(r.get(c) for c in COLUMNS))
    with store:
        store.executemany(f"INSERT OR IGNORE INTO messages ({','.join(COLUMNS)}) VALUES ({','.join('?' * len(COLUMNS))})", values)


def tables(conn):
    return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg\\_%' ESCAPE '\\'")]


def sender_name(conn, sender_id):
    try:
        row = conn.execute("SELECT user_name FROM Name2Id WHERE rowid = ?", (sender_id,)).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row else None


def decode_content(raw, flag):
    if isinstance(raw, bytes) and flag == 4:
        raw = zstd.decompress(raw)
    return raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw


def at_targets(source):
    """Who a message really mentions, comma separated: wxids, or notify@all for @所有人. Typed @name text is not in here."""
    found = re.search(r"<atuserlist>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</atuserlist>", source or "", re.S)
    return ",".join(part for part in found.group(1).split(",") if part) or None if found else None


def parse_appmsg(xml, directory):
    """Title of an app message and, for a quote reply (type 49, subtype 57), the message it quotes."""
    if "<!DOCTYPE" in xml or "<!ENTITY" in xml or "<" not in xml:
        return None, None
    try:
        app = ET.fromstring(xml[xml.index("<"):]).find("appmsg")
    except ET.ParseError:
        return None, None
    if app is None:
        return None, None
    title, ref, quote = (app.findtext("title") or "")[:500], app.find("refermsg"), None
    if ref is not None:
        who = ref.findtext("chatusr") or ref.findtext("fromusr")
        kind = ref.findtext("type") or ""
        quote = {"sender_id": who, "sender": directory["names"].get(who, ref.findtext("displayname") or who),
                 "mine": bool(who and who.startswith(MY_ID)), "type": int(kind) if kind.isdigit() else None,
                 "text": (ref.findtext("content") or "")[:500] if kind == "1" else None,
                 "created": int(ref.findtext("createtime") or 0) or None, "server_id": ref.findtext("svrid")}
    return title, quote


def quoted_text(conn, table, server_id, directory):
    """What a quoted message says, found by its server id in the same conversation; None when it is not here."""
    row = conn.execute(f'SELECT local_type, message_content, WCDB_CT_message_content FROM "{table}" WHERE server_id = ?', (server_id,)).fetchone()
    if not row:
        return None
    base, content = row[0] & 0xFFFFFFFF, decode_content(row[1], row[2])
    return content[:500] if base == 1 else parse_appmsg(content, directory)[0] if base == 49 else None


def describe(directory, table, sender_id, text):
    """Conversation and sender names; is_group is None when the contact is not synced, never guessed."""
    user = directory["by_md5"].get(table[4:])
    group = None if user is None else (user in directory["rooms"] or user.endswith("@chatroom"))
    if group and text and sender_id and text.startswith(sender_id + ":\n"):
        text = text[len(sender_id) + 2:]
    return {"conversation_id": user, "conversation_name": directory["names"].get(user) if user else None, "is_group": group,
            "sender_id": sender_id, "sender": directory["names"].get(sender_id, sender_id) if sender_id else None, "text": text}


def hot_tables(mirror):
    """Msg_ tables the session list says hold a newer message than we have seen: {table: last local_id}."""
    mirror.refresh()
    conn = sqlite3.connect(f"file:{mirror.target}?mode=ro", uri=True)
    try:
        return {"Msg_" + hashlib.md5(u.encode()).hexdigest(): last for u, last in conn.execute("SELECT username, last_msg_locald_id FROM SessionTable")}
    finally:
        conn.close()


def new_rows(conn, seen, directory, hot=None):
    """Rows beyond the cursor for this db; moves `seen` forward in memory, the caller stores the rows.

    With `hot` (from the session list) only tables it says moved are opened; None scans every conversation table.
    """
    found = []
    for table in tables(conn):
        if hot is not None and hot.get(table, 0) <= seen.get(table, 0):
            continue
        last = conn.execute(f'SELECT COALESCE(MAX(local_id), 0) FROM "{table}"').fetchone()[0]
        if last <= seen.get(table, 0):
            continue
        for local_id, server_id, created, kind, sender_id, raw, flag, source, source_flag in conn.execute(
                f'SELECT local_id, server_id, create_time, local_type, real_sender_id, message_content, WCDB_CT_message_content, source, WCDB_CT_source FROM "{table}" WHERE local_id > ? ORDER BY local_id',
                (seen.get(table, 0),)):
            sender = sender_name(conn, sender_id)
            base, subtype, text, quote = kind & 0xFFFFFFFF, kind >> 32, None, None
            if base in (1, 49):
                content = decode_content(raw, flag)
                if base == 1:
                    text = content[:500]
                else:
                    if sender and content.startswith(sender + ":\n"):
                        content = content[len(sender) + 2:]
                    text, quote = parse_appmsg(content, directory)
            row = {"db": None, "msg_table": table, "local_id": local_id, "server_id": server_id, "create_time": created, "type": base,
                   "subtype": subtype, "mine": bool(sender and sender.startswith(MY_ID))}
            row.update(describe(directory, table, sender, text))
            row["at_ids"] = at_targets(decode_content(source, source_flag))
            if quote:
                if quote["text"] is None and (quote["server_id"] or "").isdigit():
                    quote["text"] = quoted_text(conn, table, int(quote["server_id"]), directory)
                row["quote"] = quote
            found.append(row)
        seen[table] = last
    return found


def read_db(name, mirror, seen, directory, hot=None):
    """Refresh one db's mirror and return (rows beyond `seen`, frames applied, how, refresh ms); `seen` is advanced."""
    t0 = time.perf_counter()
    applied, how = mirror.refresh()
    conn = sqlite3.connect(f"file:{mirror.target}?mode=ro", uri=True)
    try:
        rows = new_rows(conn, seen, directory, hot)
    finally:
        conn.close()
    for row in rows:
        row["db"] = name
    return rows, applied, how, (time.perf_counter() - t0) * 1000


def mirrors_for(keys, tag):
    return {name: Mirror(os.path.join(DB_DIR, name), key, os.path.join(HERE, f"mirror_{tag}_{name}")) for name, key in keys.items()}


def sweep(tag):
    """Remove decrypted copies left by a process that was killed: this run's own names, and one-shot runs gone stale."""
    for path in glob.glob(os.path.join(HERE, "mirror_*")) + glob.glob(os.path.join(HERE, "directory_*")):
        base = os.path.basename(path)
        own = base.startswith((f"mirror_{tag}_", f"directory_{tag}."))
        stale = not base.startswith(("mirror_watch_", "directory_watch.")) and time.time() - os.path.getmtime(path) > 600
        if own or stale:
            os.remove(path)


def drop(mirrors, *extra):
    for path in [m.target for m in mirrors.values()] + list(extra):
        for suffix in ("", "-shm", "-wal"):
            if os.path.exists(path + suffix):
                os.remove(path + suffix)


def watch(seconds):
    tag = "watch"
    sweep(tag)
    keys, scratch = load_keys(), os.path.join(HERE, f"directory_{tag}.db")
    mirrors = mirrors_for(keys, tag)
    session = Mirror(SESSION, load_session_key(), os.path.join(HERE, f"mirror_{tag}_session.db"))
    store = open_store()
    cursor = cursor_of(store)
    directory, directory_stamp = load_directory(scratch), stamp_of(CONTACT, CONTACT + "-wal")
    print(f"store {os.path.join(STORE_DIR, 'messages.db')}: {store.execute('SELECT COUNT(*) FROM messages').fetchone()[0]} messages, polling every {INTERVAL}s", flush=True)
    stamps, started, polls, refreshes, errors, saved = {}, time.time(), 0, 0, 0, 0
    first = {name: True for name in keys}
    next_full = {name: 0.0 for name in keys}
    try:
        while seconds == 0 or time.time() - started < seconds:
            polls += 1
            for name, mirror in mirrors.items():
                try:
                    now = stamp_of(mirror.path, mirror.path + "-wal", SESSION, SESSION + "-wal")
                    full = first[name] or time.time() >= next_full[name]
                    if now == stamps.get(name) and not full:
                        continue
                    if full:
                        next_full[name] = time.time() + RECONCILE
                    contact_now = stamp_of(CONTACT, CONTACT + "-wal")
                    if contact_now != directory_stamp:
                        directory, directory_stamp = load_directory(scratch), contact_now
                    stamps[name] = now
                    seen = dict(cursor.get(name, {}))
                    hot = None if full else hot_tables(session)
                    rows, applied, how, cost = read_db(name, mirror, seen, directory, hot)
                    detected = time.time()
                    refreshes += 1
                    for row in rows:
                        row.update(detected_at=round(detected, 3), lag_s=round(detected - row["create_time"], 3), refresh=how,
                                   scan="full" if full else "session", interval_s=INTERVAL, backfill=first[name])
                    save_rows(store, rows)
                    saved += len(rows)
                    cursor[name] = seen
                    first[name] = False
                except (OSError, sqlite3.Error) as e:
                    errors += 1
                    stamps.pop(name, None)
                    mirror.salts = session.salts = None
                    next_full[name] = 0.0
                    print(f"{time.strftime('%H:%M:%S')} retry {name} after {type(e).__name__}: {e}", flush=True)
            time.sleep(INTERVAL)
    finally:
        store.close()
        drop(mirrors, scratch, session.target)
    print(f"done polls={polls} refreshes={refreshes} new_messages={saved} errors={errors}", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    watch(float(sys.argv[1]) if len(sys.argv) > 1 else 0)
