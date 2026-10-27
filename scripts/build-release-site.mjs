import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "site");
const output = path.join(root, "dist/release-site");
const { name, version } = JSON.parse(
  fs.readFileSync(path.join(root, "packages/service/package.json"), "utf8"),
);
assert.equal(name, "@1agents/acp-service");
assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
for (const entry of fs.readdirSync(output, { recursive: true })) {
  if (!/\.(html|css|js|svg|txt)$/.test(entry)) continue;
  const file = path.join(output, entry);
  const content = fs.readFileSync(file, "utf8").replaceAll("__VERSION__", version);
  assert.doesNotMatch(content, /acpx|openclaw/i, `Upstream branding in ${entry}`);
  fs.writeFileSync(file, content);
}

const html = fs.readFileSync(path.join(output, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
for (const [, value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  if (/^https?:\/\//.test(value)) continue;
  const [relative, anchor] = value.split("#");
  const file = path.resolve(output, relative || "index.html");
  assert.ok(file.startsWith(`${output}${path.sep}`), `Asset outside release site: ${value}`);
  assert.ok(fs.existsSync(file), `Missing release page asset: ${value}`);
  if (anchor && file === path.join(output, "index.html")) {
    assert.ok(ids.has(anchor), `Missing release page section: ${value}`);
  }
}
assert.doesNotMatch(html, /__[A-Z_]+__/, "Unresolved release metadata");
fs.writeFileSync(path.join(output, ".nojekyll"), "");
console.log(`Built agent-workflow v${version}: dist/release-site (links, assets and branding verified)`);
