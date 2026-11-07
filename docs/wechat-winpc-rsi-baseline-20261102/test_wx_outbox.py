import unittest
from wx_outbox import has_mention, pick
from wx_rounds import SELF_ID, choose, trigger_of

T = 1000.0


class Limits(unittest.TestCase):
    def test_sends_when_idle(self):
        self.assertEqual(pick([(1, "a")], [], T), 1)

    def test_same_conversation_waits_a_minute(self):
        self.assertIsNone(pick([(2, "a")], [("a", T - 59.9)], T))
        self.assertEqual(pick([(2, "a")], [("a", T - 60)], T), 2)

    def test_other_conversation_overtakes_a_limited_one(self):
        self.assertEqual(pick([(2, "a"), (3, "b")], [("a", T - 5)], T), 3)

    def test_oldest_first_within_a_conversation(self):
        self.assertEqual(pick([(2, "a"), (3, "a")], [], T), 2)

    def test_five_overall_in_a_minute(self):
        sends = [(c, T - 10) for c in "abcde"]
        self.assertIsNone(pick([(9, "f")], sends, T))
        self.assertEqual(pick([(9, "f")], sends[:4], T), 9)

    def test_overall_window_rolls(self):
        sends = [("a", T - 60), ("b", T - 50), ("c", T - 40), ("d", T - 30), ("e", T - 20)]
        self.assertEqual(pick([(9, "f")], sends, T), 9)

    def test_never_exceeds_limits_over_time(self):
        queued = [(i, "abcdefgh"[i % 8]) for i in range(40)]
        sends, now, sent = [], T, []
        while queued and now < T + 600:
            row = pick(queued, sends, now)
            if row is None:
                now += 0.1
                continue
            conversation = dict(queued)[row]
            queued = [q for q in queued if q[0] != row]
            sends.append((conversation, now)); sent.append((conversation, now))
            now += 2
        for conversation, at in sent:
            window = [s for s in sent if at <= s[1] < at + 60]
            self.assertLessEqual(len(window), 5)
            self.assertLessEqual(sum(s[0] == conversation for s in window), 1)
        self.assertFalse(queued)


class Mentions(unittest.TestCase):
    def test_rejects_at_name(self):
        for text in ("@晓风 你好", "＠晓风 你好", "好的 @晓风"):
            self.assertTrue(has_mention(text), text)

    def test_allows_the_rest(self):
        for text in ("晓风，你好", "邮箱是 a@b.com", "价格 @ 10 元"):
            self.assertFalse(has_mention(text), text)


class Rounds(unittest.TestCase):
    def test_oldest_person_first_and_same_person_once(self):
        self.assertEqual(choose([("g", "x"), ("g", "x"), ("d", "y")], [], [], T), ("g", "x"))

    def test_next_person_in_a_group_waits_for_the_group_limit(self):
        self.assertIsNone(choose([("g", "y")], [], [("g", T - 30)], T))
        self.assertEqual(choose([("g", "y")], [], [("g", T - 60)], T), ("g", "y"))

    def test_unsent_reply_holds_its_conversation(self):
        self.assertIsNone(choose([("g", "y")], ["g"], [], T))

    def test_other_conversation_overtakes_a_limited_one(self):
        self.assertEqual(choose([("g", "y"), ("d", "z")], [], [("g", T - 5)], T), ("d", "z"))

    def test_direct_messages_always_count(self):
        self.assertEqual(trigger_of(0, None, None), "direct")

    def test_group_needs_a_real_mention_by_id(self):
        self.assertEqual(trigger_of(1, f"wxid_other,{SELF_ID}", None), "at")
        self.assertIsNone(trigger_of(1, "wxid_other", None))
        self.assertIsNone(trigger_of(1, None, None))

    def test_at_all_is_only_context(self):
        self.assertIsNone(trigger_of(1, "notify@all", None))

    def test_quoting_our_message_counts_like_a_mention(self):
        self.assertEqual(trigger_of(1, None, '{"mine": true}'), "quote")
        self.assertIsNone(trigger_of(1, None, '{"mine": false}'))

    def test_unsent_replies_count_towards_the_overall_limit(self):
        self.assertIsNone(choose([("f", "x")], ["e"], [(c, T - 10) for c in "abcd"], T))


unittest.main()
