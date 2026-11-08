"""Reply rounds for one executor. Each person in each test conversation has a queue of unanswered messages.

A direct message always joins its sender's queue. A group message joins only if it really mentions this account (by ID)
or quotes one of its messages; every other group message waits as context for the group's next round.
`next` opens a round only when that conversation may send now, and hands over everything that person has waiting, plus
the group's messages new since its last round. `reply` (any number of times) and `skip` settle it. Messages that arrive
during a round wait for the next one.
"""
import json, os, sqlite3, sys, time

from wx_outbox import PAUSED, STORE, WINDOW_S, enqueue, open_outbox, pick, read_only

TEST_CONVERSATIONS = ("wxid_PEER", "GROUP@chatroom")
SELF_ID = "wxid_SELF"
COLUMNS = ("id", "conversation_id", "conversation_name", "is_group", "sender_id", "sender", "type", "subtype", "text", "quote", "detected_at", "lag_s", "at_ids")
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, sender_id TEXT, opened_at REAL NOT NULL, closed_at REAL, outcome TEXT);
CREATE TABLE IF NOT EXISTS inbox(
  id INTEGER PRIMARY KEY, conversation_id TEXT, conversation_name TEXT, is_group INTEGER, sender_id TEXT, sender TEXT, type INTEGER, subtype INTEGER,
  text TEXT, quote TEXT, detected_at REAL, lag_s REAL, state TEXT NOT NULL DEFAULT 'pending', round_id INTEGER, delivered_at REAL);
"""


def trigger_of(is_group, at_ids, quote):
    """Why a message needs handling, or None when it is only context. @所有人 (notify@all) does not count."""
    if not is_group:
        return "direct"
    if SELF_ID in (at_ids or "").split(","):
        return "at"
    if quote and json.loads(quote).get("mine"):
        return "quote"
    return None


def choose(pending, outstanding, enter_times, now):
    """Whose round is next. pending: (conversation, sender) per message, oldest first; outstanding: conversation of each unsent reply."""
    people = list(dict.fromkeys(pending))
    slots = list(enter_times) + [(conversation, now) for conversation in outstanding]
    index = pick([(i, person[0]) for i, person in enumerate(people)], slots, now)
    return None if index is None else people[index]


def connect():
    db = open_outbox()
    db.executescript(SCHEMA)
    present = {row[1] for row in db.execute("PRAGMA table_info(inbox)")}
    for column in ("at_ids TEXT", "trigger TEXT"):
        if column.split()[0] not in present:
            db.execute(f"ALTER TABLE inbox ADD COLUMN {column}")
    db.row_factory = sqlite3.Row
    return db


def store_top():
    store = read_only(STORE)
    try:
        return store.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]
    finally:
        store.close()


def start(cursor):
    """Begin a run: earlier messages are not this run's, and nothing left over carries into it."""
    db = connect()
    with db:
        db.execute("UPDATE inbox SET state='expired' WHERE state IN ('pending','delivered','context')")
        db.execute("UPDATE rounds SET closed_at=?, outcome=COALESCE(outcome,'expired') WHERE closed_at IS NULL", (time.time(),))
        db.executemany("INSERT OR REPLACE INTO meta VALUES(?,?)", (("cursor", cursor), ("run_start", cursor)))
    print(json.dumps({"run_start": cursor}))


def sync(db):
    cursor = db.execute("SELECT value FROM meta WHERE key='cursor'").fetchone()
    if not cursor:
        raise SystemExit("no run started")
    top = store_top()
    store = read_only(STORE)
    marks = ",".join("?" * len(TEST_CONVERSATIONS))
    rows = store.execute(f"SELECT {','.join(COLUMNS)} FROM messages WHERE id>? AND id<=? AND mine=0 AND conversation_id IN ({marks}) ORDER BY id", (cursor[0], top, *TEST_CONVERSATIONS)).fetchall()
    store.close()
    position = {name: i for i, name in enumerate(COLUMNS)}
    def triggered(row):
        return trigger_of(row[position["is_group"]], row[position["at_ids"]], row[position["quote"]])
    with db:
        db.executemany(f"INSERT OR IGNORE INTO inbox({','.join(COLUMNS)}, trigger, state) VALUES({','.join('?' * len(COLUMNS))},?,?)",
                       [(*row, triggered(row), "pending" if triggered(row) else "context") for row in rows])
        db.execute("UPDATE meta SET value=? WHERE key='cursor'", (top,))


def open_round(db):
    row = db.execute("SELECT id, conversation_id FROM rounds WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        raise SystemExit("no open round; run next first")
    return row


def close_rounds(db):
    """The executor asked for more, so its last round is over. Messages it left unsettled go back in the queue."""
    with db:
        for row in db.execute("SELECT id FROM rounds WHERE closed_at IS NULL").fetchall():
            returned = db.execute("UPDATE inbox SET state='pending', round_id=NULL, delivered_at=NULL WHERE state='delivered' AND round_id=?", (row["id"],)).rowcount
            if returned:
                db.execute("UPDATE inbox SET state='context', round_id=NULL, delivered_at=NULL WHERE state='seen' AND round_id=?", (row["id"],))
            db.execute("UPDATE rounds SET closed_at=?, outcome=COALESCE(outcome,?) WHERE id=?", (time.time(), "abandoned" if returned else "settled", row["id"]))


def next_round(seconds):
    db = connect()
    close_rounds(db)
    deadline = time.time() + seconds
    while True:
        sync(db)
        now = time.time()
        pending = [(row[0], row[1]) for row in db.execute("SELECT conversation_id, sender_id FROM inbox WHERE state='pending' ORDER BY id")]
        outstanding = [row[0] for row in db.execute("SELECT conversation_id FROM outbox WHERE state IN ('queued','sending')")]
        enters = [(row[0], row[1]) for row in db.execute("SELECT conversation_id, enter_at FROM outbox WHERE enter_at>?", (now - WINDOW_S,))]
        person = None if os.path.exists(PAUSED) else choose(pending, outstanding, enters, now)
        if person:
            break
        if now > deadline:
            print(json.dumps({"round": None}))
            return
        time.sleep(0.2)
    with db:
        round_id = db.execute("INSERT INTO rounds(conversation_id, sender_id, opened_at) VALUES(?,?,?)", (*person, now)).lastrowid
        db.execute("UPDATE inbox SET state='delivered', round_id=?, delivered_at=? WHERE state='pending' AND conversation_id=? AND sender_id IS ?", (round_id, now, *person))
        # Everything new in this conversation; another person's unanswered message also comes back in their own round.
        context = db.execute("SELECT * FROM inbox WHERE conversation_id=? AND state IN ('context','pending') ORDER BY id", (person[0],)).fetchall()
        db.execute("UPDATE inbox SET state='seen', round_id=?, delivered_at=? WHERE state='context' AND conversation_id=?", (round_id, now, person[0]))
    rows = db.execute("SELECT * FROM inbox WHERE round_id=? AND state='delivered' ORDER BY id", (round_id,)).fetchall()
    first = rows[0]
    print(json.dumps({"round": {"conversation": first["conversation_name"], "is_group": first["is_group"], "sender": first["sender"],
                                "messages": [{"id": row["id"], "trigger": row["trigger"], "type": row["type"], "subtype": row["subtype"], "text": row["text"], "quote": row["quote"]} for row in rows],
                                "context": [{"id": row["id"], "sender": row["sender"], "type": row["type"], "text": row["text"], "quote": row["quote"]} for row in context]}}, ensure_ascii=False))


def settle(db, round_id, state):
    with db:
        db.execute("UPDATE inbox SET state=? WHERE state='delivered' AND round_id=?", (state, round_id))
        db.execute("UPDATE rounds SET outcome=? WHERE id=?", (state, round_id))


def reply():
    db = connect()
    current = open_round(db)
    first = db.execute("SELECT MIN(id) FROM inbox WHERE round_id=?", (current["id"],)).fetchone()[0]
    enqueue(current["conversation_id"], first, current["id"])
    settle(db, current["id"], "replied")


def skip():
    db = connect()
    current = open_round(db)
    if db.execute("SELECT 1 FROM outbox WHERE round_id=?", (current["id"],)).fetchone():
        raise SystemExit("this round already has a reply")
    settle(db, current["id"], "skipped")
    print(json.dumps({"skipped": True}))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "start":
        start(int(sys.argv[2]) if len(sys.argv) > 2 else store_top())
    elif command == "next":
        next_round(float(sys.argv[2]))
    elif command == "reply":
        reply()
    elif command == "skip":
        skip()
    else:
        raise SystemExit("usage: wx_rounds.py start [CURSOR] | next SECONDS | reply < text | skip")
