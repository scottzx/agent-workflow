"""Program checks P1-P11 for a product intro outline.

Usage: check_outline.py <outline.json> <features.json> <project-copy-dir>

The project copy is the one the host prepared from the pinned commit, with the
case's excluded paths already removed, so a source under an excluded path is
reported as missing. Prints one JSON result per checklist item and exits 1 if
any item fails.
"""
import json
import re
import sys
from pathlib import Path

import jsonschema

ROLE = Path(__file__).resolve().parent.parent
MAX_POINTS = 5
# Unfinished text a reader must never see. A limitation the project itself states, such as 待确认, is not a placeholder.
PLACEHOLDER = re.compile(r'待补|待填|占位|TODO|TBD|FIXME|XXX')
RELEASE_FILE = re.compile(r'[\w.-]*?v?(\d+\.\d+\.\d+)[\w.-]*?\.(?:zip|tar\.gz|tgz|dmg|exe|pkg|msi|apk|deb|rpm)\b')
VERSION = re.compile(r'v?(\d+\.\d+\.\d+)')


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

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r['pass'] for r in results) else 1


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:4]))
