import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the package ships a v0.15 dsh-plugin.json beside package.json', () => {
  // The host's admission loader walks from the entry module to the nearest
  // package.json and reads dsh-plugin.json *there*; a copy elsewhere is ignored.
  assert.equal(manifest.manifestVersion, '0.15');
  assert.equal(typeof manifest.$schema, 'string');
  assert.equal(manifest.facets.host.apiVersion, 'v1alpha1');
  assert.ok(Array.isArray(manifest.requires.contracts));
  assert.ok(Array.isArray(manifest.permissions));
  assert.ok(Array.isArray(manifest.contributes.commands));
  assert.ok(Array.isArray(manifest.subscriptions));
  // `files` is what keeps the manifest in a packed/linked install.
  assert.ok(pkg.files.includes('dsh-plugin.json'));
});

test('the manifest id is a durable panel prefix, not an anonymous activation', () => {
  // tuiPanels.register() prefixes the panel with the verified Component id only
  // when that id matches this grammar. Otherwise the host falls back to
  // `session:actN` and the settings picker refuses to persist the panel, which
  // is exactly the "临时面板 · 仅本次运行" row this package must never show.
  assert.equal(manifest.id, 'workspace-sidebar');
  assert.match(manifest.id, /^[a-z][a-z0-9_-]*$/u);
  assert.doesNotMatch(manifest.id, /^session:act/u);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.facets.host.entry, 'index.js');
});
