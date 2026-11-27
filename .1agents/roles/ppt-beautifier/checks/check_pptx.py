"""Pure-stdlib OOXML geometry and typography checks for PPTX decks (V1..V4).

Usage: check_pptx.py <deck.pptx>

Emits a JSON array of strict CheckResult items ({itemId, pass, evidence}) on stdout
and diagnostics on stderr. Works under `python3 -I` with zero third-party packages.
"""
import json
import math
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

EMU_PER_PT = 12700.0
MIN_BODY_PT = 12.0
OVERFLOW_SLACK = 0.10
MAX_OVERLAP_IOU = 0.15
BOUNDS_TOLERANCE_PT = 1.0
DEFAULT_FONT_PT = 18.0

NS = {
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
}
IGNORED_PLACEHOLDERS = {'ftr', 'sldNum', 'dt'}
SLIDE_NUM_RE = re.compile(r'slide(\d+)\.xml$')


def emu_to_pt(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        return int(raw) / EMU_PER_PT
    except ValueError:
        return None


def parse_font_pt(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        return int(raw) / 100.0
    except ValueError:
        return None


def resolve_slide_paths(zf: zipfile.ZipFile) -> tuple[float, float, list[str]]:
    pres_xml = ET.fromstring(zf.read('ppt/presentation.xml'))
    sld_sz = pres_xml.find('p:sldSz', NS)
    width_pt = emu_to_pt(sld_sz.attrib.get('cx')) if sld_sz is not None else 960.0
    height_pt = emu_to_pt(sld_sz.attrib.get('cy')) if sld_sz is not None else 540.0
    if width_pt is None or height_pt is None:
        raise ValueError('ppt/presentation.xml missing valid p:sldSz dimensions')

    rel_map: dict[str, str] = {}
    if 'ppt/_rels/presentation.xml.rels' in zf.namelist():
        rels_xml = ET.fromstring(zf.read('ppt/_rels/presentation.xml.rels'))
        for rel in rels_xml.findall('rel:Relationship', NS):
            rid = rel.attrib.get('Id')
            target = rel.attrib.get('Target')
            if rid and target:
                rel_map[rid] = posixpath.normpath(posixpath.join('ppt', target.lstrip('/')))

    ordered: list[str] = []
    sld_id_lst = pres_xml.find('p:sldIdLst', NS)
    if sld_id_lst is not None:
        r_id_attr = f'{{{NS["r"]}}}id'
        for sld_id in sld_id_lst.findall('p:sldId', NS):
            rid = sld_id.attrib.get(r_id_attr)
            target = rel_map.get(rid or '')
            if target and target in zf.namelist():
                ordered.append(target)

    if not ordered:
        ordered = sorted(
            [name for name in zf.namelist() if name.startswith('ppt/slides/slide') and name.endswith('.xml')],
            key=lambda name: int(SLIDE_NUM_RE.search(name).group(1)) if SLIDE_NUM_RE.search(name) else 0,
        )
    return width_pt, height_pt, ordered


def estimate_text_height_pt(tx_body: ET.Element, box_width_pt: float) -> tuple[float, list[tuple[float, str]]]:
    """Estimate needed height (pt) using a CJK-aware width model and collect (font_pt, text) runs."""
    usable_w = max(box_width_pt - 14.4, 1.0)
    needed_pt = 0.0
    runs_info: list[tuple[float, str]] = []
    for para in tx_body.findall('a:p', NS):
        p_def_rpr = para.find('a:pPr/a:defRPr', NS)
        para_default_pt = parse_font_pt(p_def_rpr.attrib.get('sz')) if p_def_rpr is not None else None
        para_text_parts: list[str] = []
        para_sizes: list[float] = []
        for run in para.findall('a:r', NS):
            t_el = run.find('a:t', NS)
            txt = t_el.text if t_el is not None and t_el.text else ''
            r_pr = run.find('a:rPr', NS)
            r_pt = parse_font_pt(r_pr.attrib.get('sz')) if r_pr is not None else None
            eff_pt = r_pt if r_pt is not None else (para_default_pt if para_default_pt is not None else DEFAULT_FONT_PT)
            if txt.strip():
                runs_info.append((eff_pt, txt))
            para_text_parts.append(txt)
            para_sizes.append(eff_pt)
        text = ''.join(para_text_parts)
        size = max(para_sizes) if para_sizes else (para_default_pt or DEFAULT_FONT_PT)
        if text:
            width_em = sum(1.0 if ord(ch) > 0x2E80 else 0.55 for ch in text) * size
            lines = max(1, math.ceil(width_em / usable_w))
            needed_pt += lines * size * 1.25
        else:
            needed_pt += size * 0.5
    return needed_pt, runs_info


def inspect_pptx(pptx_path: Path) -> list[dict]:
    out_of_bounds: list[dict] = []
    overflow: list[dict] = []
    tiny_font: list[dict] = []
    overlap: list[dict] = []

    with zipfile.ZipFile(pptx_path, 'r') as zf:
        slide_w, slide_h, slide_paths = resolve_slide_paths(zf)
        for slide_idx, slide_path in enumerate(slide_paths, start=1):
            slide_xml = ET.fromstring(zf.read(slide_path))
            text_boxes: list[tuple[str, float, float, float, float]] = []
            for sp in slide_xml.findall('.//p:sp', NS):
                c_nv_pr = sp.find('p:nvSpPr/p:cNvPr', NS)
                shape_name = (c_nv_pr.attrib.get('name') if c_nv_pr is not None else None) or 'unnamed-shape'
                ph = sp.find('p:nvSpPr/p:nvPr/p:ph', NS)
                ph_type = ph.attrib.get('type') if ph is not None else None

                xfrm = sp.find('p:spPr/a:xfrm', NS)
                if xfrm is None:
                    continue
                off = xfrm.find('a:off', NS)
                ext = xfrm.find('a:ext', NS)
                if off is None or ext is None:
                    continue
                x = emu_to_pt(off.attrib.get('x'))
                y = emu_to_pt(off.attrib.get('y'))
                w = emu_to_pt(ext.attrib.get('cx'))
                h = emu_to_pt(ext.attrib.get('cy'))
                if x is None or y is None or w is None or h is None:
                    continue

                if x < -BOUNDS_TOLERANCE_PT or y < -BOUNDS_TOLERANCE_PT or x + w > slide_w + BOUNDS_TOLERANCE_PT or y + h > slide_h + BOUNDS_TOLERANCE_PT:
                    spill = max(0.0, -x, -y, (x + w) - slide_w, (y + h) - slide_h)
                    out_of_bounds.append({
                        'slide': slide_idx,
                        'shape': shape_name,
                        'box_pt': [round(x, 1), round(y, 1), round(w, 1), round(h, 1)],
                        'slide_pt': [round(slide_w, 1), round(slide_h, 1)],
                        'spill_pt': round(spill, 1),
                    })

                tx_body = sp.find('p:txBody', NS)
                if tx_body is None:
                    continue
                needed_pt, runs_info = estimate_text_height_pt(tx_body, w)
                full_text = ''.join(txt for _, txt in runs_info).strip()
                if not full_text:
                    continue

                if ph_type not in IGNORED_PLACEHOLDERS:
                    for font_pt, txt in runs_info:
                        if font_pt < MIN_BODY_PT:
                            tiny_font.append({
                                'slide': slide_idx,
                                'shape': shape_name,
                                'pt': round(font_pt, 1),
                                'min_pt': MIN_BODY_PT,
                                'text': txt[:24],
                            })

                if h > 0 and needed_pt > h * (1.0 + OVERFLOW_SLACK):
                    overflow.append({
                        'slide': slide_idx,
                        'shape': shape_name,
                        'box_height_pt': round(h, 1),
                        'needed_pt': round(needed_pt, 1),
                        'ratio': round(needed_pt / h, 2),
                        'text': full_text[:24],
                    })

                text_boxes.append((shape_name, x, y, x + w, y + h))

            for i in range(len(text_boxes)):
                n1, ax1, ay1, ax2, ay2 = text_boxes[i]
                for j in range(i + 1, len(text_boxes)):
                    n2, bx1, by1, bx2, by2 = text_boxes[j]
                    ox = max(0.0, min(ax2, bx2) - max(ax1, bx1))
                    oy = max(0.0, min(ay2, by2) - max(ay1, by1))
                    inter = ox * oy
                    if inter <= 0:
                        continue
                    area1 = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
                    area2 = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
                    union = area1 + area2 - inter
                    if union > 0:
                        iou = inter / union
                        if iou > MAX_OVERLAP_IOU:
                            overlap.append({
                                'slide': slide_idx,
                                'pair': [n1, n2],
                                'iou': round(iou, 3),
                            })

    return [
        {'itemId': 'V1', 'pass': len(out_of_bounds) == 0, 'evidence': out_of_bounds[:10]},
        {'itemId': 'V2', 'pass': len(overflow) == 0, 'evidence': overflow[:10]},
        {'itemId': 'V3', 'pass': len(tiny_font) == 0, 'evidence': tiny_font[:10]},
        {'itemId': 'V4', 'pass': len(overlap) == 0, 'evidence': overlap[:10]},
    ]


def main(argv: list[str]) -> int:
    if len(argv) < 1:
        print('Usage: check_pptx.py <deck.pptx>', file=sys.stderr)
        failure = [{'itemId': item_id, 'pass': False, 'evidence': [{'message': 'missing deck.pptx argument'}]} for item_id in ('V1', 'V2', 'V3', 'V4')]
        print(json.dumps(failure, ensure_ascii=False, indent=2))
        return 1
    pptx_path = Path(argv[0])
    try:
        results = inspect_pptx(pptx_path)
    except Exception as exc:
        print(f'check_pptx: failed to inspect {pptx_path}: {exc}', file=sys.stderr)
        results = [{'itemId': item_id, 'pass': False, 'evidence': [{'path': pptx_path.name, 'message': f'check_pptx error: {exc}'}]} for item_id in ('V1', 'V2', 'V3', 'V4')]
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(item['pass'] for item in results) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
