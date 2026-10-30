"""Program checks P1-P7 for a product intro outline.

Usage: check_outline.py <outline.json> <features.json> <project-copy-dir>

The project copy is the one the host prepared from the pinned commit, with the
case's excluded paths already removed, so a source under an excluded path is
reported as missing. Prints one JSON result per checklist item and exits 1 if
any item fails.
"""
import json
import sys
from pathlib import Path

import jsonschema

ROLE = Path(__file__).resolve().parent.parent


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

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(r['pass'] for r in results) else 1


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:4]))
