"""Program checks P1-P15 for a product intro outline.

Usage: check_outline.py <outline.json> <features.json> <project-copy-dir>

The project copy is the one the host prepared from the pinned commit, with the
case's excluded paths already removed, so a source under an excluded path is
reported as missing. Prints one JSON result per checklist item and exits 1 if
any item fails.
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import jsonschema

ROLE = Path(__file__).resolve().parent.parent
MAX_POINTS = 5
# Unfinished text a reader must never see. A limitation the project itself states, such as 待确认, is not a placeholder.
PLACEHOLDER = re.compile(r'待补|待填|占位|TODO|TBD|FIXME|XXX')
RELEASE_FILE = re.compile(r'[\w.-]*?v?(\d+\.\d+\.\d+)[\w.-]*?\.(?:zip|tar\.gz|tgz|dmg|exe|pkg|msi|apk|deb|rpm)\b')
VERSION = re.compile(r'v?(\d+\.\d+\.\d+)')
# A title counting its own points ("四个动作", "三步"). Ordinals ("第一步", "下一步") and counts of things
# described ("六个演示场景") are not; neither is a count of one.
NUMERALS = {'二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
SELF_COUNT = re.compile(r'(?<![第下进每\d])([二两三四五六七八九十]|[2-9]|10)\s*(?:个|大)?(?:动作|步骤|步|件事|条?要点)')
# Points on different slides that cite the same files and share this many Chinese characters in a row say the
# same thing twice. Shared English words, commands and links do not count.
SHARED_RUN = 8
HAN = re.compile(r'[\u4e00-\u9fff]+')
# On the closing slide, a point that sends the reader to download something must carry the link itself.
FETCH = re.compile(r'下载|源码|附件')
LINK = re.compile(r'https?://\S+')


def reader_text(outline):
    """Every string the audience reads, with its JSON path."""
    project = outline['project']
    yield 'project/name', project['name']
    yield 'project/oneLiner', project['oneLiner']
    for sec in outline['sections']:
        base = f"sections/{sec['id']}"
        if sec['status'] != 'present':
            yield f'{base}/reason', sec['reason']
            continue
        yield f'{base}/title', sec['title']
        for i, slide in enumerate(sec['slides']):
            yield f'{base}/slides/{i}/title', slide['title']
            for j, point in enumerate(slide['points']):
                yield f'{base}/slides/{i}/points/{j}', point['text']


def version_records(root):
    """The versions a project declares: package.json, and the first heading of its release notes or changelog."""
    records = {}
    manifest = root / 'package.json'
    if manifest.is_file():
        version = json.loads(manifest.read_text('utf-8')).get('version')
        if isinstance(version, str) and VERSION.fullmatch(version.strip()):
            records['package.json'] = VERSION.fullmatch(version.strip()).group(1)
    for name in ('RELEASE_NOTES.md', 'CHANGELOG.md'):
        notes = root / name
        if not notes.is_file():
            continue
        for line in notes.read_text('utf-8', errors='replace').splitlines():
            found = VERSION.search(line) if line.startswith('#') else None
            if found:
                records[name] = found.group(1)
                break
    return records


def main(outline_path: str, features_path: str, project: str) -> int:
    checklist = json.loads((ROLE / 'checklist.json').read_text('utf-8'))
    schema = json.loads((ROLE / checklist['program']['schema']).read_text('utf-8'))
    outline = json.loads(Path(outline_path).read_text('utf-8'))
    features = json.loads(Path(features_path).read_text('utf-8'))
    root = Path(project).resolve()
    results = []

    def report(item_id: str, evidence: list) -> None:
        results.append({'itemId': item_id, 'pass': not evidence, 'evidence': evidence})

    errors = list(jsonschema.Draft202012Validator(schema).iter_errors(outline))
    report('P1', [{'path': '/'.join(map(str, e.absolute_path)), 'message': e.message} for e in errors])
    if errors:
        for item in checklist['items']:
            if item['type'] == 'program' and item['id'] != 'P1':
                results.append({'itemId': item['id'], 'pass': False, 'evidence': [{'message': 'skipped: P1 failed'}]})
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 1

    style = outline['style']
    family = style['font']['family']
    report('P2', [] if family == '微软雅黑' else [{'path': 'style/font/family', 'message': family}])
    report('P3', [{'path': f'style/font/sizes/{k}', 'message': str(v)} for k, v in style['font']['sizes'].items() if not isinstance(v, int)])

    slides = [(s, sec['id']) for sec in outline['sections'] if sec['status'] == 'present' for s in sec['slides']]
    report('P4', [{'path': f"sections/{sid}", 'message': f"{s['title']}: {s['layout']}"} for s, sid in slides if s['layout'] not in style['layouts']])

    sources = [style['colors']['source']]
    sources += [src for s, _ in slides for p in s['points'] for src in p['sources']]
    sources += [s['visual']['source'] for s, _ in slides if 'visual' in s]
    bad = []
    for src in sources:
        file = (root / src['path']).resolve()
        if root not in file.parents or not file.is_file():
            bad.append({'path': src['path'], 'message': 'not in project copy'})
        elif 'lines' in src:
            last = int(src['lines'].split('-')[-1])
            count = len(file.read_bytes().splitlines())
            if last > count:
                bad.append({'path': src['path'], 'lines': src['lines'], 'message': f'file has {count} lines'})
    report('P5', bad)

    confirmed = {f['id'] for f in features['features']}
    used = {i for s, _ in slides for p in s['points'] for i in p.get('featureIds', [])}
    report('P6', [{'message': f'missing {i}'} for i in sorted(confirmed - used)] + [{'message': f'unknown {i}'} for i in sorted(used - confirmed)])

    ids = [sec['id'] for sec in outline['sections']]
    template = checklist['outlineTemplate']['sections']
    p7 = [{'message': f'missing {i}'} for i in template if i not in ids]
    p7 += [{'message': f'unexpected or repeated {i}'} for n, i in enumerate(ids) if i not in template or i in ids[:n]]
    report('P7', p7)

    report('P8', [{'path': f"sections/{sec['id']}/slides/{i}", 'message': f'{len(slide["points"])} points, at most {MAX_POINTS}'}
                  for sec in outline['sections'] if sec['status'] == 'present' for i, slide in enumerate(sec['slides']) if len(slide['points']) > MAX_POINTS])

    texts = list(reader_text(outline))
    report('P9', [{'path': where, 'message': f'placeholder {m.group(0)}'} for where, text in texts for m in [PLACEHOLDER.search(text)] if m])

    seen, repeated = {}, []
    for where, text in texts:
        if '/points/' not in where:
            continue
        key = re.sub(r'[\s\W_]+', '', text)
        slide = where.rsplit('/points/', 1)[0]
        if len(key) < 12:
            continue
        if key in seen and seen[key].rsplit('/points/', 1)[0] != slide:
            repeated.append({'path': where, 'message': f'same text as {seen[key]}'})
        seen.setdefault(key, where)
    report('P10', repeated)

    records = version_records(root)
    p11 = []
    for where, text in texts:
        for m in RELEASE_FILE.finditer(text):
            stated = m.group(1)
            if len(set(records.values())) > 1:
                p11.append({'path': where, 'message': f'{m.group(0)} hard-codes {stated}, but the project version records disagree {records}; do not hard-code a version'})
            elif records and stated not in records.values():
                p11.append({'path': where, 'message': f'{m.group(0)} says {stated}, the project declares {records}'})
    report('P11', p11)

    order = [(f"sections/{sec['id']}/slides/{i}", slide) for sec in outline['sections'] if sec['status'] == 'present' for i, slide in enumerate(sec['slides'])]
    closing = [where for where, slide in order if slide['layout'] == 'closing']
    p12 = [] if closing == [order[-1][0]] else [{'path': where, 'message': 'a closing slide that is not the last slide'} for where in closing if where != order[-1][0]]
    if not order or order[-1][1]['layout'] != 'closing':
        p12.append({'path': order[-1][0] if order else 'sections', 'message': 'the last slide must use the closing layout'})
    report('P12', p12)

    p13 = []
    for where, slide in order:
        for m in SELF_COUNT.finditer(slide['title']):
            stated = int(m.group(1)) if m.group(1).isdigit() else NUMERALS[m.group(1)]
            if stated != len(slide['points']):
                p13.append({'path': f'{where}/title', 'message': f"title says {m.group(0)} but the slide has {len(slide['points'])} points"})
    report('P13', p13)

    points = [(f'{where}/points/{j}', where, point) for where, slide in order for j, point in enumerate(slide['points'])]
    p14 = []
    for n, (here, slide, point) in enumerate(points):
        files = {src['path'] for src in point['sources']}
        for there, other_slide, other in points[:n]:
            if other_slide == slide or files != {src['path'] for src in other['sources']}:
                continue
            # Separators differ per side so a match never spans two runs of Chinese text.
            key, other_key = '\0'.join(HAN.findall(point['text'])), '\1'.join(HAN.findall(other['text']))
            run = SequenceMatcher(None, key, other_key, autojunk=False).find_longest_match(0, len(key), 0, len(other_key))
            if run.size >= SHARED_RUN and key != other_key:
                p14.append({'path': here, 'message': f"cites the same files as {there} and repeats “{key[run.a:run.a + run.size]}”; say it once"})
                break
    report('P14', p14)

    closing_slide = order[-1] if order and order[-1][1]['layout'] == 'closing' else None
    report('P15', [] if not closing_slide else [
        {'path': f"{closing_slide[0]}/points/{j}", 'message': f"mentions {FETCH.search(point['text']).group(0)} without an http(s) link: {point['text']}"}
        for j, point in enumerate(closing_slide[1]['points']) if FETCH.search(point['text']) and not LINK.search(point['text'])])

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r['pass'] for r in results) else 1


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:4]))
