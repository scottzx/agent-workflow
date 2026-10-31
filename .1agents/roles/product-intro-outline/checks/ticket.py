"""The executor's handle on the task ticket the host keeps in the work directory.

Usage:
  ticket.py <ticket.json> show
  ticket.py <ticket.json> mark <id> done|disputed --note TEXT
  ticket.py <ticket.json> submit

Only items that are open or reopened can be marked, every mark needs a note,
and the ticket can be submitted for review once nothing is left pending. The
host compares the ticket with its own copy afterwards and undoes any other change.
"""
import argparse
import json
import os
import sys
from pathlib import Path

PENDING = ('open', 'reopened')


def pending(ticket):
    return [item for item in ticket['items'] if item['state'] in PENDING]


def save(path: Path, ticket) -> None:
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(ticket, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    os.replace(temporary, path)


def main(argv) -> int:
    parser = argparse.ArgumentParser(prog='ticket.py', description='查看和处理任务单上的意见')
    parser.add_argument('ticket', type=Path)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('show', help='列出待处理的意见')
    mark = commands.add_parser('mark', help='把一条意见标为已改或不同意')
    mark.add_argument('id')
    mark.add_argument('state', choices=('done', 'disputed'))
    mark.add_argument('--note', required=True, help='怎么改的，或者不同意的理由')
    commands.add_parser('submit', help='全部处理完，交给质检')
    args = parser.parse_args(argv)
    ticket = json.loads(args.ticket.read_text('utf-8'))

    if args.command == 'show':
        for item in pending(ticket):
            print(f"{item['id']} [{'必须改' if item['severity'] == 'must' else '建议改'}] {item['where']}：{item['problem']}")
            if item.get('suggestion'):
                print(f"  建议：{item['suggestion']}")
            if item.get('evidence'):
                print(f"  证据：{json.dumps(item['evidence'], ensure_ascii=False)}")
            notes = [entry for entry in item['log'] if entry.get('note')]
            if item['state'] == 'reopened' and notes:
                print(f"  上一次：{notes[-1]['by']} {notes[-1]['action']}：{notes[-1]['note']}")
        print(f"待处理 {len(pending(ticket))} 条，任务单状态 {ticket['status']}，第 {ticket['round']} 轮")
        return 0

    if ticket['status'] != 'in_revision':
        print(f"任务单状态是 {ticket['status']}，现在不能修改", file=sys.stderr)
        return 1
    if args.command == 'mark':
        item = next((item for item in ticket['items'] if item['id'] == args.id), None)
        note = args.note.strip()
        if item is None:
            print(f'任务单上没有 {args.id}', file=sys.stderr)
            return 1
        if item['state'] not in PENDING:
            print(f"{args.id} 已经是 {item['state']}，只能处理 open 或 reopened 的意见", file=sys.stderr)
            return 1
        if not note:
            print('--note 不能为空', file=sys.stderr)
            return 1
        item['state'] = args.state
        item['log'].append({'round': ticket['round'], 'by': 'executor', 'action': args.state, 'note': note})
        save(args.ticket, ticket)
        print(f"{args.id} 已标为 {args.state}，还剩 {len(pending(ticket))} 条待处理")
        return 0

    left = pending(ticket)
    if left:
        print(f"还有 {len(left)} 条没处理：{'、'.join(item['id'] for item in left)}", file=sys.stderr)
        return 1
    ticket['status'] = 'ready_for_review'
    ticket['history'].append({'round': ticket['round'], 'by': 'executor', 'action': 'submitted'})
    save(args.ticket, ticket)
    print('已提交，等待检查')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
