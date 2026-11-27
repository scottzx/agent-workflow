"""Rubric structural and semantic linter (P16).

Usage: rubric_lint.py <rubric.json> [<rubric.schema.json>]

Diagnostics go to stderr only; stdout emits a single strict CheckResult JSON object:
  {"itemId": "P16", "pass": bool, "evidence": [...]}
"""
import json
import re
import sys
from pathlib import Path

CRITERION_ID = re.compile(r'^[A-Z][0-9]{1,2}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
ALLOWED_TOP = {'schemaVersion', 'roleId', 'artifacts', 'purpose', 'layers', 'criteria', 'aggregation', 'pairwise', 'calibration'}
ALLOWED_LAYERS = {'program', 'text', 'vision', 'xml'}
ALLOWED_CRIT_KEYS = {
    'id', 'title', 'question', 'layer', 'modality', 'scale', 'weight', 'severity',
    'evidence', 'gate', 'appliesTo', 'antiGaming', 'programItem', 'replaces',
}
ALLOWED_CRIT_LAYERS = {'program', 'content', 'narrative', 'visual'}
ALLOWED_MODALITIES = {'text', 'vision', 'xml'}
ALLOWED_EVIDENCE_KINDS = {'quote', 'path', 'shape', 'bbox', 'pixel', 'none'}
ALLOWED_GATE_MODES = {'block', 'advise', 'observe'}
ALLOWED_ON_LOW = {'keep', 'advise', 'demote', 'split'}
ALLOWED_AGG_METHODS = {'normalized_positive_sum', 'weighted_mean', 'per_criterion_gate'}
ALLOWED_METRICS = {'cohen_kappa', 'krippendorff_alpha', 'spearman_rho', 'raw_agreement'}


def is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def find_schema(explicit: str | None) -> Path | None:
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / '.1agents' / 'schemas' / 'rubric.schema.json'
        if candidate.is_file():
            return candidate
        direct = parent / 'schemas' / 'rubric.schema.json'
        if direct.is_file():
            return direct
    return None


def lint_rubric(rubric_path: Path, schema_path: Path | None = None) -> list[dict]:
    errors: list[dict] = []

    def err(where: str, message: str) -> None:
        errors.append({'path': where, 'message': message})

    if not rubric_path.is_file():
        err('rubric.json', f'rubric file not found: {rubric_path.name}')
        return errors

    try:
        data = json.loads(rubric_path.read_text('utf-8'))
    except Exception as exc:
        print(f'rubric_lint: failed to parse {rubric_path}: {exc}', file=sys.stderr)
        err('rubric.json', f'invalid JSON: {exc}')
        return errors

    # Optional Draft 2020-12 JSON Schema validation when both schema file and jsonschema are available.
    if schema_path and schema_path.is_file():
        try:
            from jsonschema import Draft202012Validator
            schema = json.loads(schema_path.read_text('utf-8'))
            for e in Draft202012Validator(schema).iter_errors(data):
                loc = '/'.join(map(str, e.absolute_path)) or 'rubric.json'
                err(loc, e.message)
        except ImportError:
            pass
        except Exception as exc:
            print(f'rubric_lint: schema check warning: {exc}', file=sys.stderr)

    # Pure-stdlib structural & semantic validation (runs even inside isolated temp work/ directories).
    if not isinstance(data, dict):
        err('rubric.json', 'rubric root must be a JSON object')
        return errors

    for key in sorted(set(data.keys()) - ALLOWED_TOP):
        err(key, f'unexpected top-level key: {key}')
    for req in ('schemaVersion', 'roleId', 'artifacts', 'criteria', 'aggregation', 'calibration'):
        if req not in data:
            err(req, f'missing required field: {req}')

    if data.get('schemaVersion') != 1:
        err('schemaVersion', 'schemaVersion must be 1')
    if not isinstance(data.get('roleId'), str) or not data['roleId'].strip():
        err('roleId', 'roleId must be a non-empty string')
    artifacts = data.get('artifacts')
    if not isinstance(artifacts, list) or not artifacts or not all(isinstance(a, str) and a.strip() for a in artifacts):
        err('artifacts', 'artifacts must be a non-empty list of non-empty strings')
    if 'purpose' in data and data['purpose'] not in {'formative', 'summative'}:
        err('purpose', 'purpose must be formative or summative')
    if 'layers' in data:
        layers = data['layers']
        if not isinstance(layers, list) or len(layers) != len(set(layers)) or not all(l in ALLOWED_LAYERS for l in layers):
            err('layers', 'layers must be unique items from program/text/vision/xml')

    criteria = data.get('criteria')
    seen_ids: set[str] = set()
    positive_weight_sum = 0.0
    if not isinstance(criteria, list) or not criteria:
        err('criteria', 'criteria must be a non-empty array')
    else:
        for idx, crit in enumerate(criteria):
            base = f'criteria/{idx}'
            if not isinstance(crit, dict):
                err(base, 'criterion must be an object')
                continue
            for key in sorted(set(crit.keys()) - ALLOWED_CRIT_KEYS):
                err(f'{base}/{key}', f'unexpected criterion key: {key}')
            for req in ('id', 'layer', 'modality', 'scale', 'weight', 'evidence', 'gate'):
                if req not in crit:
                    err(f'{base}/{req}', f'missing required criterion field: {req}')
            cid = crit.get('id')
            if not isinstance(cid, str) or not CRITERION_ID.fullmatch(cid):
                err(f'{base}/id', f'invalid criterion id: {cid!r}')
            elif cid in seen_ids:
                err(f'{base}/id', f'duplicate criterion id: {cid}')
            else:
                seen_ids.add(cid)
            if 'question' in crit:
                q = crit['question']
                if not isinstance(q, str) or len(q) < 8 or len(q) > 400:
                    err(f'{base}/question', 'question must be a string of length 8..400')
            if crit.get('layer') not in ALLOWED_CRIT_LAYERS:
                err(f'{base}/layer', f'invalid layer: {crit.get("layer")!r}')
            if crit.get('modality') not in ALLOWED_MODALITIES:
                err(f'{base}/modality', f'invalid modality: {crit.get("modality")!r}')
            weight = crit.get('weight')
            if not is_number(weight):
                err(f'{base}/weight', 'weight must be a number')
            elif weight > 0:
                positive_weight_sum += float(weight)

            scale = crit.get('scale')
            if not isinstance(scale, dict) or scale.get('type') not in {'binary', 'ordinal'}:
                err(f'{base}/scale', 'scale.type must be binary or ordinal')
            elif scale['type'] == 'ordinal':
                levels = scale.get('levels')
                if not isinstance(levels, list) or not (3 <= len(levels) <= 5):
                    err(f'{base}/scale/levels', 'ordinal scale requires 3..5 levels')
                else:
                    values = set()
                    for li, lvl in enumerate(levels):
                        if not isinstance(lvl, dict) or not is_int(lvl.get('value')) or lvl['value'] < 0:
                            err(f'{base}/scale/levels/{li}/value', 'level.value must be an integer >= 0')
                        elif lvl['value'] in values:
                            err(f'{base}/scale/levels/{li}/value', f'duplicate ordinal level value: {lvl["value"]}')
                        else:
                            values.add(lvl['value'])
                        anchor = lvl.get('anchor') if isinstance(lvl, dict) else None
                        if not isinstance(anchor, str) or len(anchor) < 10:
                            err(f'{base}/scale/levels/{li}/anchor', 'level.anchor must be a string with length >= 10')

            ev = crit.get('evidence')
            if not isinstance(ev, dict) or ev.get('required') is not True or ev.get('kind') not in ALLOWED_EVIDENCE_KINDS:
                err(f'{base}/evidence', 'evidence must set required=true and valid kind')
            gate = crit.get('gate')
            if not isinstance(gate, dict) or gate.get('mode') not in ALLOWED_GATE_MODES:
                err(f'{base}/gate', 'gate.mode must be block/advise/observe')
            else:
                if 'minAlpha' in gate and (not is_number(gate['minAlpha']) or not (0 <= gate['minAlpha'] <= 1)):
                    err(f'{base}/gate/minAlpha', 'gate.minAlpha must be in [0, 1]')
                if 'onLowAgreement' in gate and gate['onLowAgreement'] not in ALLOWED_ON_LOW:
                    err(f'{base}/gate/onLowAgreement', 'invalid gate.onLowAgreement')

    agg = data.get('aggregation')
    if not isinstance(agg, dict) or agg.get('method') not in ALLOWED_AGG_METHODS:
        err('aggregation/method', 'aggregation.method must be normalized_positive_sum/weighted_mean/per_criterion_gate')
    else:
        if 'passScore' in agg and (not is_number(agg['passScore']) or not (0 <= agg['passScore'] <= 1)):
            err('aggregation/passScore', 'aggregation.passScore must be in [0, 1]')
        if agg['method'] == 'normalized_positive_sum' and positive_weight_sum <= 0:
            err('aggregation/method', 'normalized_positive_sum requires positive total positive weight')
        for mid in agg.get('mustAllPass', []) if isinstance(agg.get('mustAllPass'), list) else []:
            if mid not in seen_ids:
                err('aggregation/mustAllPass', f'unknown criterion id in mustAllPass: {mid}')

    cal = data.get('calibration')
    if not isinstance(cal, dict):
        err('calibration', 'calibration must be an object')
    else:
        if not isinstance(cal.get('goldSet'), str) or not cal['goldSet'].strip():
            err('calibration/goldSet', 'calibration.goldSet must be a non-empty string')
        if not is_int(cal.get('minSamples')) or cal['minSamples'] < 5:
            err('calibration/minSamples', 'calibration.minSamples must be an integer >= 5')
        metrics = cal.get('metrics')
        if not isinstance(metrics, list) or not metrics or not all(m in ALLOWED_METRICS for m in metrics):
            err('calibration/metrics', 'calibration.metrics must be a non-empty list of valid metric names')
        bands = cal.get('bands')
        if not isinstance(bands, dict) or not all(k in bands and is_number(bands[k]) for k in ('auto', 'advise', 'split')):
            err('calibration/bands', 'calibration.bands must include numeric auto, advise, split')
        for hi, hist in enumerate(cal.get('history', []) if isinstance(cal.get('history'), list) else []):
            if not isinstance(hist, dict) or not SHA256_RE.fullmatch(str(hist.get('digest', ''))):
                err(f'calibration/history/{hi}/digest', 'calibration history digest must be 64-char hex sha256')

    # Deduplicate identical error entries while preserving order.
    deduped: list[dict] = []
    seen_err: set[tuple[str, str]] = set()
    for item in errors:
        key = (str(item.get('path', '')), str(item.get('message', '')))
        if key not in seen_err:
            seen_err.add(key)
            deduped.append(item)
    return deduped


def main(argv: list[str]) -> int:
    if len(argv) < 1:
        print('Usage: rubric_lint.py <rubric.json> [<rubric.schema.json>]', file=sys.stderr)
        result = {'itemId': 'P16', 'pass': False, 'evidence': [{'path': 'rubric.json', 'message': 'missing rubric.json argument'}]}
        print(json.dumps(result, ensure_ascii=False))
        return 1
    rubric_path = Path(argv[0])
    schema_path = find_schema(argv[1] if len(argv) > 1 else None)
    try:
        evidence = lint_rubric(rubric_path, schema_path)
    except Exception as exc:
        print(f'rubric_lint: unexpected error: {exc}', file=sys.stderr)
        evidence = [{'path': 'rubric.json', 'message': f'rubric_lint error: {exc}'}]
    result = {'itemId': 'P16', 'pass': len(evidence) == 0, 'evidence': evidence}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['pass'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
