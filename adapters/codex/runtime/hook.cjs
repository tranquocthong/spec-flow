#!/usr/bin/env node
'use strict';
// Adapt documented Codex events to the unchanged SF hook scripts.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const os = require('node:os');
function outputText(response) {
  if (typeof response === 'string') return response;
  if (!response) return '';
  if (typeof response.output === 'string') return response.output;
  if (typeof response.stdout === 'string') return response.stdout;
  if (Array.isArray(response.content)) return response.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  return '';
}
function patchPaths(input) {
  if (input && typeof input.file_path === 'string') return [input.file_path];
  const patch = typeof input === 'string' ? input : input?.command || input?.input || '';
  return [...new Set([...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map(m => m[1].trim()))];
}
function handle(event) {
  const eventName = event.hook_event_name;
  const cwd = event.cwd || process.cwd();
  const run = (script, payload) => {
    const result = spawnSync('bash', [path.join(root, 'upstream-hooks', script)], {
      cwd, env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024
    });
    if (result.error || result.status !== 0) return `SF hook failed: ${script}; perform the corresponding SF check explicitly.`;
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  };
  let context = '';
  if (eventName === 'UserPromptSubmit') {
    // The upstream anchor recognizes /sf: rather than the Codex skill spelling.
    context = run('spec-flow-anchor.sh', { ...event, prompt: (event.prompt || '').replace(/\$sf-/g, '/sf:') });
    context = context.replace(/\/sf:([a-z-]+)/g, '$sf-$1');
  } else if (eventName === 'PreToolUse') {
    context = patchPaths(event.tool_input).map(file_path => run('sd-drift-detect.sh', {
      ...event, tool_input: { file_path }
    })).filter(Boolean).join('\n');
  } else if (eventName === 'PostToolUse') {
    const command = event.tool_input?.command || event.tool_input?.cmd || '';
    const output = outputText(event.tool_response);
    if (command.includes('run-checklist.sh') && /--tag(?:=|\s+)regression\b/.test(command)) {
      if (!output.trim()) context = 'SF: no checklist output available; run verify-collect explicitly. Verification was not recorded by the hook.';
      else {
        // Require an explicit feature: global state can belong to another concurrent task.
        const feature = command.match(/\.spec-flow\/specs\/([^/\s"']+)\/CHECKLIST\.yaml/)?.[1];
        if (!feature || feature === '.' || feature === '..') context = 'SF: cannot identify the checklist feature; run verify-collect --feature explicitly. No verification was recorded.';
        else if (event.tool_response?.exit_code && event.tool_response.exit_code !== 0) context = 'SF: checklist command failed; inspect its output and record the failed result explicitly.';
        else {
          const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-codex-results-'));
          try {
            const results = path.join(temp, 'results.txt');
            fs.writeFileSync(results, output);
            const result = spawnSync(process.execPath, [path.join(root, 'bin/flow-tools.cjs'), 'verify-collect', '--feature', feature, '--results', results], {
              cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024
            });
            context = result.status === 0 ? `SF verification recorded for ${feature}: ${result.stdout.trim()}` : 'SF: verify-collect failed; inspect the checklist JSON and record verification explicitly. Do not mark the feature passed.';
          } finally { fs.rmSync(temp, { recursive: true, force: true }); }
        }
      }
    }
  }
  return context ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } } : null;
}
module.exports = { handle, patchPaths, outputText };
if (require.main === module) {
  try {
    const result = handle(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (result) console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify({ systemMessage: `SF hook could not process the event: ${err.message}` }));
  }
}
