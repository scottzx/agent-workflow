import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { checkResultSchema, qualityReviewSchema } from '../src/execution/ticket.js';
import { loadChecklist } from '../src/rsi/checklist.js';
import { defaultOutlineWorkflow, loadWorkflow } from '../src/rsi/engine.js';

const REPO = resolve(import.meta.dirname, '../../..');
const SCHEMA = join(REPO, '.1agents', 'schemas', 'rubric.schema.json');
const OUTLINE_ROLE = join(REPO, '.1agents', 'roles', 'product-intro-outline');
const PPT_ROLE = join(REPO, '.1agents', 'roles', 'ppt-beautifier');
const PYTHON = process.env.RSI_PYTHON ?? 'python3';

interface ShapeSpec {
  name: string;
  xPt: number;
  yPt: number;
  wPt: number;
  hPt: number;
  text: string;
  fontPt: number;
}

const ptToEmu = (pt: number) => Math.round(pt * 12700);

function buildPptx(outputPath: string, shapes: ShapeSpec[], slideWidthPt = 960, slideHeightPt = 540): void {
  const shapesXml = shapes.map((sh, index) => `
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${index + 2}" name="${sh.name}"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="${ptToEmu(sh.xPt)}" y="${ptToEmu(sh.yPt)}"/>
            <a:ext cx="${ptToEmu(sh.wPt)}" cy="${ptToEmu(sh.hPt)}"/>
          </a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:r>
              <a:rPr sz="${Math.round(sh.fontPt * 100)}"/>
              <a:t>${sh.text}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>`).join('\n');

  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="${ptToEmu(slideWidthPt)}" cy="${ptToEmu(slideHeightPt)}"/>
</p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    'ppt/slides/slide1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapesXml}</p:spTree></p:cSld>
</p:sld>`,
  };

  execFileSync(PYTHON, [
    '-I', '-c',
    'import json, sys, zipfile; data = json.loads(sys.argv[2]); zf = zipfile.ZipFile(sys.argv[1], "w"); [zf.writestr(k, v) for k, v in data.items()]; zf.close()',
    outputPath,
    JSON.stringify(files),
  ]);
}

test('both product-intro-outline and ppt-beautifier rubric.json pass rubric_lint and Draft 2020-12 rubric.schema.json', async () => {
  const linter = join(OUTLINE_ROLE, 'checks', 'rubric_lint.py');
  for (const roleDir of [OUTLINE_ROLE, PPT_ROLE]) {
    const proc = spawnSync(PYTHON, ['-I', linter, join(roleDir, 'rubric.json'), SCHEMA], { encoding: 'utf8' });
    assert.equal(proc.status, 0, `${roleDir} rubric_lint failed: ${proc.stdout}\n${proc.stderr}`);
    const parsed = checkResultSchema.parse(JSON.parse(proc.stdout));
    assert.equal(parsed.itemId, 'P16');
    assert.equal(parsed.pass, true);
    assert.deepEqual(parsed.evidence, []);
  }

  // QualityReviewSchema passthrough stays intact without schema changes.
  const review = qualityReviewSchema.parse({
    verdict: 'pass',
    summary: '结构清晰',
    scores: { 吸引力: 4, 具体: 4, 受众: 4, 结构: 4, 可信: 5, 行动: 4 },
    issues: [],
    rubric: { roleId: 'product-intro-outline', items: [{ id: 'R1', met: true, evidence: 'README.md:1-5' }] },
  }) as Record<string, unknown>;
  assert.deepEqual((review.rubric as { roleId: string }).roleId, 'product-intro-outline');
});

test('ppt-beautifier loadWorkflow loads real check_pptx node (never silently falls back to defaultOutlineWorkflow)', async () => {
  const wf = await loadWorkflow(PPT_ROLE);
  const fallback = defaultOutlineWorkflow();
  assert.notDeepEqual(wf.nodes.map(n => n.id), fallback.nodes.map(n => n.id));
  const pptxNode = wf.nodes.find(n => n.id === 'check_pptx');
  assert.ok(pptxNode, 'ppt-beautifier workflow must declare check_pptx node');
  assert.equal(pptxNode.type, 'program_check');
  assert.deepEqual(pptxNode.checks, ['V1..V4']);

  const cl = await loadChecklist(PPT_ROLE);
  assert.equal(cl.roleId, 'ppt-beautifier');
  assert.deepEqual(cl.items.map(i => i.id), ['V1', 'V2', 'V3', 'V4']);
  for (const item of cl.items) {
    assert.equal(item.runner?.id, 'check_pptx');
    assert.ok(item.runner?.cmd.includes('checks/check_pptx.py'));
  }
});

test('check_pptx.py passes on a clean deck and catches 4/4 synthetic PPTX defects with strict CheckResult output', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'pptx-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(PPT_ROLE, 'checks', 'check_pptx.py');

  const runCheck = (file: string) => {
    const proc = spawnSync(PYTHON, ['-I', script, file], { encoding: 'utf8' });
    const parsed = (JSON.parse(proc.stdout) as unknown[]).map(row => checkResultSchema.parse(row));
    return { status: proc.status, results: parsed };
  };

  // Clean deck
  const cleanFile = join(dir, 'clean.pptx');
  buildPptx(cleanFile, [
    { name: 'Title', xPt: 40, yPt: 30, wPt: 880, hPt: 60, text: 'Product Architecture Overview', fontPt: 28 },
    { name: 'Body', xPt: 40, yPt: 120, wPt: 880, hPt: 240, text: 'Clear bullet with readable font and plenty of space.', fontPt: 18 },
  ]);
  const clean = runCheck(cleanFile);
  assert.equal(clean.status, 0);
  assert.deepEqual(clean.results.map(r => [r.itemId, r.pass]), [['V1', true], ['V2', true], ['V3', true], ['V4', true]]);

  // Defect 1: V1 out-of-canvas
  const oobFile = join(dir, 'defect-oob.pptx');
  buildPptx(oobFile, [
    { name: 'SpillBox', xPt: 860, yPt: 100, wPt: 200, hPt: 80, text: 'Spills beyond 960pt right edge', fontPt: 16 },
  ]);
  const oob = runCheck(oobFile);
  assert.equal(oob.status, 1);
  assert.equal(oob.results.find(r => r.itemId === 'V1')?.pass, false);

  // Defect 2: V2 text overflow
  const overflowFile = join(dir, 'defect-overflow.pptx');
  buildPptx(overflowFile, [
    { name: 'CrampedBox', xPt: 40, yPt: 100, wPt: 200, hPt: 30, text: '这是一段非常长而且不断换行的中文正文内容，必然会远远超出高度只有三十磅的狭小文本框区域从而发生严重溢出截断。', fontPt: 16 },
  ]);
  const overflow = runCheck(overflowFile);
  assert.equal(overflow.status, 1);
  assert.equal(overflow.results.find(r => r.itemId === 'V2')?.pass, false);

  // Defect 3: V3 small body font (7pt)
  const tinyFile = join(dir, 'defect-tiny.pptx');
  buildPptx(tinyFile, [
    { name: 'TinyBody', xPt: 40, yPt: 100, wPt: 600, hPt: 100, text: 'Unreadable 7pt body text', fontPt: 7 },
  ]);
  const tiny = runCheck(tinyFile);
  assert.equal(tiny.status, 1);
  assert.equal(tiny.results.find(r => r.itemId === 'V3')?.pass, false);

  // Defect 4: V4 overlapping text boxes (IoU > 0.15)
  const overlapFile = join(dir, 'defect-overlap.pptx');
  buildPptx(overlapFile, [
    { name: 'BoxA', xPt: 100, yPt: 100, wPt: 300, hPt: 120, text: 'First overlapping text block', fontPt: 16 },
    { name: 'BoxB', xPt: 150, yPt: 120, wPt: 300, hPt: 120, text: 'Second overlapping text block', fontPt: 16 },
  ]);
  const overlap = runCheck(overlapFile);
  assert.equal(overlap.status, 1);
  assert.equal(overlap.results.find(r => r.itemId === 'V4')?.pass, false);

  // Verify rubric.schema.json itself is valid JSON and documented in .1agents/README.md.
  const schemaDoc = JSON.parse(await readFile(SCHEMA, 'utf8')) as { $schema?: string };
  assert.match(schemaDoc.$schema ?? '', /2020-12/);
  const readme = await readFile(join(REPO, '.1agents', 'README.md'), 'utf8');
  assert.match(readme, /schemas\/rubric\.schema\.json/);
  assert.match(readme, /schemas\//);
});
