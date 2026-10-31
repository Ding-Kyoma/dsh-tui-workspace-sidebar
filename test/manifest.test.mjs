import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const root = new URL('../', import.meta.url);

test('the package ships a v0.15 dsh-plugin.json beside package.json', () => {
  // The host's admission loader walks from the entry module to the nearest
  // package.json and reads dsh-plugin.json *there*; a copy elsewhere is ignored.
  assert.equal(manifest.manifestVersion, '0.15');
  assert.equal(typeof manifest.$schema, 'string');
  assert.match(manifest.$schema, /^https:\/\//u);
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

test('the manifest declares /ws and its admission closure', () => {
  assert.equal(manifest.contributes.commands.length, 1);
  const command = manifest.contributes.commands[0];
  // `registerCommand` infers `workspace-sidebar.ws` from the definition name
  // `ws`; declaring the same suffix is what makes the mediated surface accept
  // it instead of falling back to the unattributed global command service.
  assert.equal(command.id, 'workspace-sidebar.ws');
  assert.match(command.id, /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u);
  assert.equal(typeof command.title, 'string');
  assert.ok(command.title.length > 0);

  // commands.dsh/v1alpha1#Command is required before the host will hand a
  // verified Component the mediated command surface.
  assert.ok(manifest.requires.contracts.some(contract => (
    contract.apiVersion === 'commands.dsh/v1alpha1' && contract.kind === 'Command'
  )));

  // The permission scope must be the declared command id, not the panel id and
  // not a wildcard.
  assert.ok(manifest.permissions.some(permission => (
    permission.name === 'commands.invoke' && permission.scope === command.id
  )));
});

test('the package metadata is publish-ready and matches the manifest', () => {
  assert.equal(pkg.name, 'dsh-tui-workspace-sidebar');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.equal(manifest.license, 'MIT');
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.engines.node, '^22.19 || >=24');
  assert.equal(manifest.source.repository, 'https://github.com/Ding-Kyoma/dsh-tui-workspace-sidebar');
  assert.equal(pkg.repository.url, 'git+https://github.com/Ding-Kyoma/dsh-tui-workspace-sidebar.git');
  assert.ok(pkg.files.includes('dsh-plugin.json'));
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(existsSync(new URL(manifest.facets.host.entry, root)));
  assert.ok(existsSync(new URL(pkg.dsh.bundle.patch, root)));
});
