#!/usr/bin/env node
/**
 * Offline release guard for this package.
 *
 * The authoritative validator is the Community v0.15 parser (`@dsh-std/manifest`)
 * plus the dsh-TUI admission checklist. This script is the dependency-free
 * subset that catches the mistakes those checks reject most often: a command
 * without its permission/contract closure, a manifest that drifts from
 * package.json, a tarball that would omit the declaration surface, or release
 * metadata that still points at a local link.
 *
 * It is a pre-check, not a replacement for the parser and the checklist.
 *
 * Run: node scripts/check-manifest.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const readText = (file) => readFileSync(join(root, file), 'utf8');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const normaliseRepo = (value) => String(value ?? '')
  .replace(/^git\+/u, '')
  .replace(/\.git$/u, '')
  .replace(/\/$/u, '');

const TOP_LEVEL = [
  '$schema', 'manifestVersion', 'id', 'name', 'version', 'facets', 'requires',
  'permissions', 'contributes', 'subscriptions', 'license', 'source', 'artifact',
  'compat', 'overrides',
];
const NAMESPACED_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const FACET_API_VERSION = /^v[1-9][0-9]*(?:(?:alpha|beta)[1-9][0-9]*)?$/u;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const RUNTIME_MODULES = [
  'index.js', 'model.js', 'tracker.js', 'store.js', 'panel.js', 'jump.js',
  'questions.js', 'current.js', 'strings.js',
];

const errors = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) errors.push(name);
};

let manifest;
let pkg;
try {
  manifest = readJson('dsh-plugin.json');
  pkg = readJson('package.json');
} catch (error) {
  console.error(`FAIL: cannot read the package declaration — ${error.message}`);
  process.exit(1);
}

check('manifest is an object', isObject(manifest));
check('package.json is an object', isObject(pkg));
if (!isObject(manifest) || !isObject(pkg)) {
  console.error(`FAIL: ${errors.length} check(s) failed`);
  process.exit(1);
}

const unknownTopLevel = Object.keys(manifest)
  .filter(key => !TOP_LEVEL.includes(key) && !key.startsWith('x-'));
check('no unknown manifest top-level fields', unknownTopLevel.length === 0, unknownTopLevel.join(', '));

let schemaUrl = false;
try {
  schemaUrl = isText(manifest.$schema) && new URL(manifest.$schema).protocol === 'https:';
} catch {
  schemaUrl = false;
}
check('$schema is an absolute https URL', schemaUrl);
check('manifestVersion is "0.15"', manifest.manifestVersion === '0.15', String(manifest.manifestVersion));
check('id is a namespaced identifier', isText(manifest.id) && NAMESPACED_ID.test(manifest.id), String(manifest.id));
check('name is non-empty', isText(manifest.name));
check('version is semver', isText(manifest.version) && SEMVER.test(manifest.version), String(manifest.version));
check('manifest version matches package.json', manifest.version === pkg.version, `${String(manifest.version)} != ${String(pkg.version)}`);

check('package name is public, not a local link', isText(pkg.name) && !/@local\//u.test(pkg.name), String(pkg.name));
check('package is not private', pkg.private !== true);
check('package license is MIT', pkg.license === 'MIT', String(pkg.license));
check('manifest license matches package', manifest.license === pkg.license, String(manifest.license));
check('package engines allow dsh-TUI hosts', pkg.engines?.node === '^22.19 || >=24', String(pkg.engines?.node));
check('package publishConfig is public', pkg.publishConfig?.access === 'public', String(pkg.publishConfig?.access));
check('package repository is a GitHub URL', /^git\+https:\/\/github\.com\//u.test(String(pkg.repository?.url ?? '')));
check(
  'manifest source repository matches package repository',
  normaliseRepo(manifest.source?.repository) === normaliseRepo(pkg.repository?.url),
  `${String(manifest.source?.repository)} != ${String(pkg.repository?.url)}`,
);
check('package author carries no email address', !EMAIL.test(String(pkg.author ?? '')), String(pkg.author));
check('package declares the Config dependency', isText(pkg.dependencies?.['@deepseek-ai/schemastery']));
check('package declares the bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch));

const files = Array.isArray(pkg.files) ? pkg.files : [];
for (const file of [...RUNTIME_MODULES, 'dsh-plugin.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  check(`package.files includes ${file}`, files.includes(file));
}
check('package main exists', isText(pkg.main) && existsSync(join(root, pkg.main)), String(pkg.main));
check('package root export exists', existsSync(join(root, String(pkg.exports?.['.'] ?? ''))), String(pkg.exports?.['.']));

const facets = manifest.facets;
check('facets is an object with only "host"', isObject(facets) && Object.keys(facets).every(key => key === 'host'));
const host = isObject(facets) ? facets.host : undefined;
check('facets.host is an object', isObject(host));
check(
  'facets.host.entry is package-relative',
  isObject(host) && isText(host.entry)
    && !host.entry.startsWith('/') && !host.entry.startsWith('\\')
    && !host.entry.replaceAll('\\', '/').split('/').includes('..'),
  isObject(host) ? String(host.entry) : undefined,
);
check(
  'facets.host.entry exists',
  isObject(host) && isText(host.entry) && existsSync(join(root, host.entry)),
  isObject(host) ? String(host.entry) : undefined,
);
check(
  'facets.host.apiVersion is a facet version (v1alpha1), not a protocol coordinate',
  isObject(host) && typeof host.apiVersion === 'string' && FACET_API_VERSION.test(host.apiVersion),
  isObject(host) ? String(host.apiVersion) : undefined,
);

const requires = manifest.requires;
check('requires.contracts is an array', isObject(requires) && Array.isArray(requires.contracts));
check(
  'requires.services is empty when present',
  !isObject(requires) || requires.services === undefined
    || (Array.isArray(requires.services) && requires.services.length === 0),
);

const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
check(
  'permissions is an array of { name, scope, reason? }',
  Array.isArray(manifest.permissions) && permissions.every(row => (
    isObject(row)
    && Object.keys(row).every(key => ['name', 'scope', 'reason'].includes(key))
    && isText(row.name) && isText(row.scope)
    && (row.reason === undefined || isText(row.reason))
  )),
);

const contributes = manifest.contributes;
const commands = isObject(contributes) && Array.isArray(contributes.commands)
  ? contributes.commands
  : [];
check('contributes.commands is an array', isObject(contributes) && Array.isArray(contributes.commands));
check(
  'contributes.panels is empty when present',
  !isObject(contributes) || contributes.panels === undefined
    || (Array.isArray(contributes.panels) && contributes.panels.length === 0),
);
check(
  'contributes has no unknown point outside commands/panels/x-*',
  !isObject(contributes)
    || Object.keys(contributes).every(key => ['commands', 'panels'].includes(key) || key.startsWith('x-')),
);
check('subscriptions is an array', Array.isArray(manifest.subscriptions));

let commandsOk = true;
for (const command of commands) {
  const id = isObject(command) ? command.id : undefined;
  const idOk = isText(id) && NAMESPACED_ID.test(id);
  const titleOk = isObject(command) && isText(command.title);
  check(`command ${String(id)} has an id/title`, idOk && titleOk);
  if (!idOk) {
    commandsOk = false;
    continue;
  }
  const permissionOk = permissions.some(row => row.name === 'commands.invoke' && row.scope === id);
  check(`command ${id} has a matching commands.invoke permission`, permissionOk);
  if (!permissionOk) commandsOk = false;
}
if (commands.length > 0) {
  const contractOk = isObject(requires) && Array.isArray(requires.contracts)
    && requires.contracts.some(row => row.apiVersion === 'commands.dsh/v1alpha1' && row.kind === 'Command');
  check('commands declare commands.dsh/v1alpha1#Command', contractOk);
  if (!contractOk) commandsOk = false;
}
check('every declared command is closed', commandsOk);

check('LICENSE exists and is MIT', existsSync(join(root, 'LICENSE')) && readText('LICENSE').startsWith('MIT License'));
check('README exists', existsSync(join(root, 'README.md')));
const readme = existsSync(join(root, 'README.md')) ? readText('README.md') : '';
check('README links back to dsh-TUI', /https:\/\/(?:github\.com\/ccch1mneyyy\/dsh-TUI|dshtui\.com)/u.test(readme));
check('Chinese README exists', existsSync(join(root, 'README.zh-CN.md')));
const zhReadme = existsSync(join(root, 'README.zh-CN.md')) ? readText('README.zh-CN.md') : '';
check('package.files includes README.zh-CN.md', files.includes('README.zh-CN.md'));
check('README links to the Chinese README', readme.includes('README.zh-CN.md'));
check('Chinese README links back to the English README', zhReadme.includes('README.md'));

let patch = '';
try {
  patch = readText('cordis.patch.yml');
} catch (error) {
  check('cordis.patch.yml is readable', false, error.message);
}
if (patch !== '') {
  const escapedName = String(pkg.name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedId = String(manifest.id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  check('cordis.patch.yml inserts the package name', new RegExp(`name:\\s*['"]?${escapedName}['"]?`, 'u').test(patch));
  check('cordis.patch.yml inserts the manifest id', new RegExp(`id:\\s*['"]?${escapedId}['"]?`, 'u').test(patch));
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} check(s) failed — see the dsh-TUI admission guide`);
  process.exit(1);
}
console.log('ALL PASS: package, manifest and release surface are consistent');
