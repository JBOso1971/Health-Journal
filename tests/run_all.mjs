#!/usr/bin/env node
// The aggregate runner (app/client half, CLAUDE.md §5). Discovers tests/test_*.mjs from the TREE and
// runs each in its own node process with the TAP reporter. An empty discovery is a failure.
// Exit 0 only if every suite passed and every suite ran at least one test.
//   node tests/run_all.mjs            run everything
//   node tests/run_all.mjs --list     print the discovery
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

export function discover() {
  return readdirSync(HERE).filter(f => /^test_.*\.mjs$/.test(f)).sort().map(f => join(HERE, f));
}

// Returns { code, out, ran, failed: [names] } — parsed from TAP so a suite that ran zero tests is visible.
export function runFile(path) {
  const proc = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], { cwd: ROOT, encoding: 'utf8' });
  const out = (proc.stdout || '') + (proc.stderr || '');
  const ran = (out.match(/^\s*(not )?ok \d+/gm) || []).length;
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1].trim());
  return { code: proc.status ?? 1, out, ran, failed };
}

function main(argv) {
  const files = discover();
  if (argv.includes('--list')) { files.forEach(f => console.log(f)); return 0; }
  if (!files.length) { console.log('run_all: no tests/test_*.mjs discovered -- that is a failure'); return 1; }
  let bad = 0;
  for (const f of files) {
    const r = runFile(f);
    const ok = r.code === 0 && r.ran > 0;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.slice(ROOT.length + 1)}  ran=${r.ran}${r.failed.length ? '  failed=' + r.failed.join(' | ') : ''}${r.ran === 0 ? '  (ran ZERO tests)' : ''}`);
    if (!ok) console.log(r.out);
  }
  console.log(`run_all: ${files.length - bad}/${files.length} suites green`);
  return bad ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
