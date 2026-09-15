'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { build } = require('../scripts/build-codex.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf codex compatibility '));
const distribution = build(path.join(temp, 'distribution'));
const plugin = distribution.plugin;
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let serial = 0;
function project() { const p = path.join(temp, `project ${serial++}`); fs.mkdirSync(p); return p; }
function write(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); }
function cli(cwd, bin, args) {
  return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', SPEC_FLOW_HOST_AGENT: '' } }).trim();
}
function flow(cwd, args, original = false) {
  return JSON.parse(cli(cwd, path.join(original ? root : plugin, original ? 'bin/flow-tools.cjs' : 'scripts/flow-tools.cjs'), args));
}
function hook(cwd, event) {
  const out = cliHook(cwd, event);
  return out ? JSON.parse(out) : null;
}
function cliHook(cwd, event) {
  return execFileSync(process.execPath, [path.join(plugin, 'scripts/hook.cjs')], { cwd: temp, encoding: 'utf8', input: JSON.stringify({ cwd, ...event }) }).trim();
}
function bytes(dir) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) for (const [key, val] of Object.entries(bytes(p))) result[`${e.name}/${key}`] = val;
    else result[e.name] = fs.readFileSync(p).toString('base64');
  }
  return result;
}
test('distribution is reproducible, self contained and includes every source command/skill', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json')));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'))).version);
  for (const dir of ['bin', 'lib', 'templates']) assert.deepEqual(bytes(path.join(plugin, dir)), bytes(path.join(root, dir)));
  const count = fs.readdirSync(path.join(root, 'commands')).filter(x => x.endsWith('.md')).length + fs.readdirSync(path.join(root, 'skills')).length;
  assert.equal(fs.readdirSync(path.join(plugin, 'skills')).filter(name => fs.existsSync(path.join(plugin, 'skills', name, 'SKILL.md'))).length, count);
  const before = bytes(distribution.out);
  build(distribution.out);
  assert.deepEqual(bytes(distribution.out), before);
  const info = JSON.parse(fs.readFileSync(path.join(plugin, 'build-info.json')));
  assert.ok(info.sourceCommit); assert.ok(info.sourceHashes['commands/phase.md']);
  const unsafe = project(); write(path.join(unsafe, 'keep'), 'user data');
  assert.throws(() => build(unsafe), /not an SF build/);
  assert.equal(fs.readFileSync(path.join(unsafe, 'keep'), 'utf8'), 'user data');
});
test('Claude task and checkpoint resume through Codex, then original engine reads Codex changes', () => {
  const cwd = project();
  assert.equal(flow(cwd, ['init-project', '--stack', 'node'], true).ok, true);
  write(path.join(cwd, '.taskmaster/state.json'), { currentTag: 'demo' });
  write(path.join(cwd, '.claude/docs/manual-tests/PROJECT_CONTEXT.yaml'), 'stack: node\n');
  const config = fs.readFileSync(path.join(cwd, '.spec-flow/config.json'));
  const old = flow(cwd, ['task-add', '--tag', 'demo', '--title', 'Keep task identity'], true);
  assert.equal(old.ok, true);
  assert.equal(flow(cwd, ['task-set-status', '--tag', 'demo', '--id', old.data.id, '--status', 'in-progress'], true).ok, true);
  assert.equal(flow(cwd, ['checkpoint-write', '--feature', 'demo', '--task', old.data.id, '--phase', 'GREEN', '--next', 'Finish existing implementation'], true).ok, true);
  const checkpoint = fs.readFileSync(path.join(cwd, '.spec-flow/specs/demo/checkpoint.md'));
  const before = bytes(cwd);
  const status = flow(cwd, ['status-report', '--feature', 'demo']);
  assert.equal(status.ok, true);
  assert.deepEqual(bytes(cwd), before, 'status must not migrate or rewrite artifacts');
  assert.equal(flow(cwd, ['task-get', '--tag', 'demo', '--id', old.data.id]).data.status, 'in-progress');
  assert.equal(flow(cwd, ['task-set-status', '--tag', 'demo', '--id', old.data.id, '--status', 'review']).ok, true);
  const reread = flow(cwd, ['task-get', '--tag', 'demo', '--id', old.data.id], true);
  assert.equal(reread.data.status, 'review'); assert.equal(reread.data.title, 'Keep task identity');
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.spec-flow/config.json')), config);
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.spec-flow/specs/demo/checkpoint.md')), checkpoint);
});
test('Codex host emits GenerationSpec without Claude and imports tasks readable by original engine', () => {
  const cwd = project();
  flow(cwd, ['init-project', '--stack', 'node']);
  write(path.join(cwd, 'SD.md'), '# Design\nImplement a greeting endpoint.');
  const tm = path.join(plugin, 'scripts/task-master.cjs');
  const spec = JSON.parse(cli(cwd, tm, ['parse-prd', '--input', 'SD.md', '--tag', 'demo']));
  assert.equal(spec.operation, 'parse-prd'); assert.equal(spec.tag, 'demo'); assert.ok(spec.taskSchema);
  assert.equal(fs.existsSync(path.join(cwd, '.taskmaster/tasks/tasks.json')), false);
  write(path.join(cwd, 'generated.json'), [{ id:'1', title:'Greeting', description:'Add endpoint', status:'pending', priority:'medium', dependencies:[], subtasks:[], updatedAt:'2026-09-15T00:00:00.000Z' }]);
  const imported = JSON.parse(cli(cwd, tm, ['tasks-import', '--tag', 'demo', '--file', 'generated.json']));
  assert.equal(imported.imported, 1);
  assert.equal(flow(cwd, ['task-get', '--tag', 'demo', '--id', '1'], true).data.title, 'Greeting');
  const before = bytes(path.join(cwd, '.taskmaster'));
  write(path.join(cwd, 'invalid.json'), [{ id:'2' }]);
  const bad = spawnSync(process.execPath, [tm, 'tasks-import', '--tag', 'demo', '--file', 'invalid.json'], { cwd, encoding:'utf8' });
  assert.notEqual(bad.status, 0); assert.deepEqual(bytes(path.join(cwd, '.taskmaster')), before);
});
test('Codex prompt and multi-file patch produce model-visible SF context', () => {
  const cwd = project();
  write(path.join(cwd, '.spec-flow/config.json'), { language: 'vi' });
  write(path.join(cwd, '.spec-flow/STATE.md'), '# STATE\n- Feature: demo\n- Progress: 1/2\n## Next Step\n- Resume task 2\n');
  const anchor = hook(cwd, { hook_event_name:'UserPromptSubmit', prompt:'Use $sf-status' });
  assert.match(anchor.hookSpecificOutput.additionalContext, /Resume task 2/);
  write(path.join(cwd, '.spec-flow/specs/demo/trace.json'), { nodes:{fr:[{id:'FR-1',text:'Greeting'}],tasks:[]}, links:[{type:'fr-file',from:'FR-1',to:'src/a.js'},{type:'fr-file',from:'FR-1',to:'src/b.js'}] });
  const drift = hook(cwd, { hook_event_name:'PreToolUse',tool_name:'apply_patch',tool_input:{command:'*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** Move to: src/b.js\n*** End Patch'} });
  assert.match(drift.hookSpecificOutput.additionalContext, /src\/a.js/);
  assert.match(drift.hookSpecificOutput.additionalContext, /src\/b.js/);
  assert.match(drift.hookSpecificOutput.additionalContext, /no linked test cases/);
});
test('regression output records the explicit feature, preserves other features and never invents a pass', () => {
  const cwd = project(); flow(cwd, ['init-project', '--stack', 'node']);
  const other = path.join(cwd, '.spec-flow/specs/other/VERIFICATION.md'); write(other, 'status: failed\n');
  const base = { hook_event_name:'PostToolUse', tool_name:'Bash', tool_input:{command:'bash /plugin/run-checklist.sh .spec-flow/specs/demo/CHECKLIST.yaml --tag regression --json'} };
  const result = hook(cwd, { ...base,tool_response:{output:'{"passed":["TC-001"],"failed":[]}',exit_code:0} });
  assert.match(result.hookSpecificOutput.additionalContext, /recorded for demo/);
  const file = path.join(cwd, '.spec-flow/specs/demo/VERIFICATION.md');
  assert.match(fs.readFileSync(file,'utf8'), /status: passed/);
  assert.equal(fs.readFileSync(other,'utf8'), 'status: failed\n');
  const before = bytes(cwd);
  hook(cwd, {...base,tool_response:{output:'',exit_code:0}});
  assert.deepEqual(bytes(cwd), before);
  hook(cwd, {...base,tool_response:'{"passed":[],"failed":[{"id":"TC-001","reason":"HTTP 500"}]}'});
  assert.match(fs.readFileSync(file,'utf8'), /status: failed/);
});

test('Codex doctor checks its package without requiring a Claude installation', () => {
  const cwd = project(); flow(cwd, ['init-project', '--stack', 'node']);
  const report = flow(cwd, ['doctor']);
  assert.equal(report.ok, true);
  assert.equal(report.data.host.name, 'codex');
  assert.equal(report.data.checks.some(c => c.name.startsWith('install:')), false);
  for (const name of ['plugin-file:run-checklist.sh','version-sync','codex-package:.codex-plugin/plugin.json']) {
    assert.equal(report.data.checks.find(c => c.name === name)?.status, 'ok', name);
  }
});
