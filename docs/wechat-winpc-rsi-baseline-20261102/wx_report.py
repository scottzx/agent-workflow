import sqlite3, sys, time
sys.stdout.reconfigure(encoding="utf-8")
H = r"C:\Users\Administrator\wx-baseline"
db = sqlite3.connect(H + r"\outbox.db")
db.row_factory = sqlite3.Row
store = sqlite3.connect(r"file:C:\Data\chatlog\decrypted\wxid_SELF_XXXX\messages.db?mode=ro", uri=True)
start = db.execute("SELECT value FROM meta WHERE key='run_start'").fetchone()[0]
f = lambda a, b: round(a - b, 2) if a and b else None
clock = lambda t: time.strftime("%H:%M:%S", time.localtime(t))
print("now", clock(time.time()), "run_start", start)
print("--- messages")
for m in db.execute("SELECT * FROM inbox WHERE id>? ORDER BY id", (start,)):
    print(m["id"], clock(m["detected_at"]), m["conversation_name"], m["sender"], f"lag={m['lag_s']}", f"trigger={m['trigger']}", f"at={m['at_ids']}", m["state"], f"round={m['round_id']}", f"to_round={f(m['delivered_at'], m['detected_at'])}", repr((m["text"] or "")[:50]))
print("--- rounds")
for r in db.execute("SELECT * FROM rounds WHERE id IN (SELECT round_id FROM inbox WHERE id>?) ORDER BY id", (start,)).fetchall():
    print(f"round {r['id']} {r['outcome']} open={clock(r['opened_at'])}")
    oldest = db.execute("SELECT MIN(detected_at) FROM inbox WHERE round_id=?", (r["id"],)).fetchone()[0]
    previous = r["opened_at"]
    for o in db.execute("SELECT * FROM outbox WHERE round_id=? ORDER BY id", (r["id"],)):
        print(f"    reply #{o['id']} {o['state']} model={f(o['enqueued_at'], previous)} queue={f(o['picked_at'], o['enqueued_at'])} send={f(o['enter_at'], o['picked_at'])} enter_to_store={f(o['confirmed_at'], o['enter_at'])} from_oldest={f(o['confirmed_at'], oldest)} text={o['text']!r} err={o['error']}")
        previous = o["enqueued_at"]
print("--- own rows outside test conversations", store.execute("SELECT count(*) FROM messages WHERE id>? AND mine=1 AND conversation_id NOT IN ('wxid_PEER','GROUP@chatroom')", (start,)).fetchone())
