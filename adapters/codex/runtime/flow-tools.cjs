#!/usr/bin/env node
'use strict';
process.env.SPEC_FLOW_HOST_AGENT = '1';
if (process.argv[2] !== 'doctor') {
  require('../bin/flow-tools.cjs');
} else {
  // Keep project/engine checks, replace only the Claude installation checks.
  const path = require('node:path');
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/flow-tools.cjs'), ...process.argv.slice(2)], { encoding:'utf8', env:process.env });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.error?.message || result.stderr || 'SF doctor failed');
    process.exit(result.status || 1);
  }
  const report = JSON.parse(result.stdout.trim());
  if (report.ok && Array.isArray(report.data?.checks)) {
    report.data.checks = report.data.checks.filter(check => !check.name.startsWith('install:'));
    for (const file of ['.codex-plugin/plugin.json', 'hooks/hooks.json', 'build-info.json']) {
      const exists = fs.existsSync(path.join(root, file));
      report.data.checks.push({ name:`codex-package:${file}`, status:exists ? 'ok' : 'fail', detail:exists ? 'Bundled file present' : 'Bundled file missing', fix:exists ? null : 'Rebuild/reinstall the Codex distribution' });
    }
    const harness = report.data.checks.find(check => check.name === 'plugin-file:run-checklist.sh');
    if (harness) {
      const harnessPath = path.join(root, 'skills/sf-testing/scripts/run-checklist.sh');
      harness.status = fs.existsSync(harnessPath) ? 'ok' : 'fail';
      harness.detail = harnessPath;
      harness.fix = harness.status === 'ok' ? null : 'Rebuild/reinstall the Codex distribution';
    }
    report.data.host = { name:'codex', hookTrust:'not inspected; review /hooks in Codex', installation:'package files checked; registration not inspected' };
    report.data.summary = { ok:0, warn:0, fail:0 };
    for (const check of report.data.checks) report.data.summary[check.status]++;
  }
  console.log(JSON.stringify(report));
}
