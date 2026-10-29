// The production build (bun run build -> dist/) that Vercel deploys.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname, OUT = join(ROOT, 'dist');
execFileSync('bun', ['run', 'build'], {cwd: ROOT, stdio: 'ignore'});
const walk = async (d, out = []) => { for (const e of await readdir(d, {withFileTypes: true})) { const p = join(d, e.name); e.isDirectory() ? await walk(p, out) : out.push(p); } return out; };
const files = await walk(OUT), rel = files.map(f => f.slice(OUT.length + 1));
const js = await Promise.all(files.filter(f => f.endsWith('.js')).map(async f => [f, await readFile(f, 'utf8')]));

test('the page and every worker are bundled, with relative paths', async () => {
	const html = await readFile(join(OUT, 'index.html'), 'utf8');
	for (const [, href] of html.matchAll(/(?:href|src)="(\.\/[^"]+\.(?:css|js))"/g)) assert.ok(rel.includes(href.slice(2)), 'index.html references missing ' + href);
	assert.ok(!/(?:href|src)="\/(?!\/)/.test(html), 'index.html uses an absolute path');
	for (const w of ['canopy-worker', 'provider-worker', 'stripes-worker', 'validate-worker']) assert.ok(rel.some(f => f.startsWith(`assets/${w}-`)), w + ' missing');
	for (const f of ['version.json', 'data/course-index.json', 'audio/manifest.json']) assert.ok(rel.includes(f), f + ' missing');
});

test('no source maps ship', () => {
	assert.ok(!rel.some(f => f.endsWith('.map')), 'source map shipped');
	for (const [f, code] of js) assert.ok(!/sourceMappingURL/.test(code), f + ' has a source map reference');
});

test('dev-only paths are compiled out', () => {
	for (const [f, code] of js) for (const s of ['__FA_DEV__', 'Hot reload', 'debug-tools', '__capture', 'Export for Unreal', 'fairwayExportUnreal', '__reloadAll'])
		assert.ok(!code.includes(s), `${f} contains dev-only "${s}"`);
	for (const f of ['audio-lab.html', 'audio/reviewed.json']) assert.ok(!rel.includes(f), f + ' shipped');
	assert.ok(!rel.some(f => /(^|\/)_unused\//.test(f)), 'scratch folder shipped');
});
