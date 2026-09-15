#!/usr/bin/env node
'use strict';
// Dependency-free checks used in release CI. Runtime behavior is covered in tests.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { frontmatter } = require('./build-codex.cjs');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist/codex'));
const plugin = path.join(out, 'plugins/sf');
const read = file => JSON.parse(fs.readFileSync(file));
const manifest = read(path.join(plugin, '.codex-plugin/plugin.json'));
const info = read(path.join(plugin, 'build-info.json'));
assert.equal(manifest.name, 'sf');
const baseVersion = manifest.version.split('+codex.')[0];
assert.equal(baseVersion, read(path.join(root, '.claude-plugin/plugin.json')).version);
assert.equal(info.upstreamVersion, baseVersion);
for (const [file, hash] of Object.entries(info.sourceHashes)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), hash, `Stale build: ${file}`);
}
const marketplace = read(path.join(out, '.agents/plugins/marketplace.json'));
assert.equal(marketplace.plugins[0].source.path, './plugins/sf');
const expected = fs.readdirSync(path.join(root, 'commands')).filter(x => x.endsWith('.md')).map(x => `sf-${x.slice(0,-3)}`).concat(['sf-testing','sf-commit','sf-srs-to-sd']);
for (const name of expected) {
  const skill = fs.readFileSync(path.join(plugin, 'skills', name, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(`name: ${name}\n`));
  const { description } = frontmatter(skill);
  assert.ok(description.length > 0 && description.length <= 1024);
  assert.ok(!/[<>]/.test(description), `Invalid description: ${name}`);
  assert.ok(!skill.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.ok(!skill.includes('$ARGUMENTS'));
  const dir = path.join(plugin, 'skills', name);
  for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (target && !/^(https?:|\$|<)/.test(target)) assert.ok(fs.existsSync(path.resolve(dir, target)), `Broken skill reference: ${name}: ${target}`);
  }
}
const hooks = read(path.join(plugin, 'hooks/hooks.json')).hooks;
for (const name of ['UserPromptSubmit','PreToolUse','PostToolUse']) assert.ok(hooks[name]?.length);
console.log(`Codex distribution valid: SF ${manifest.version}, ${expected.length} skills, 3 hooks; source hashes match.`);
