#!/usr/bin/env node
// Security 4B — "no new lint findings" for a pull request.
//
// The repository carries pre-existing ESLint/Prettier findings, so linting
// whole files would fail on code a PR never touched. Instead, for every
// changed .ts/.tsx/.mjs/.js file in an app with an ESLint config, this
// compares the findings per rule at the merge base with the findings at
// HEAD, and fails if any rule's count increased in any file (new files
// start from zero). Prettier formatting is enforced through the apps'
// `prettier/prettier` ESLint rule.
//
// Usage: node scripts/ci/lint-changed.mjs <base-ref>   (e.g. origin/main)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const baseRef = process.argv[2] ?? 'origin/main';
const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const mergeBase = git('merge-base', baseRef, 'HEAD').trim();
const changed = git('diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD')
  .split('\n')
  .filter((file) => /\.(ts|tsx|mts|js|mjs)$/.test(file));

const APPS = ['apps/api', 'apps/worker', 'apps/web'].filter((app) =>
  existsSync(join(repoRoot, app, 'eslint.config.mjs')),
);

function eslint(appDir, args, input) {
  const result = spawnSync('pnpm', ['exec', 'eslint', '--format', 'json', ...args], {
    cwd: join(repoRoot, appDir),
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout.trim().startsWith('[')) {
    throw new Error(`eslint failed in ${appDir}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

const countByRule = (messages) =>
  messages.reduce((acc, m) => {
    const rule = m.ruleId ?? (m.fatal ? 'parse-error' : 'unknown');
    acc[rule] = (acc[rule] ?? 0) + 1;
    return acc;
  }, {});

const regressions = [];
let checked = 0;
for (const app of APPS) {
  const files = changed.filter((file) => file.startsWith(`${app}/`));
  if (files.length === 0) continue;
  const relFiles = files.map((file) => relative(join(repoRoot, app), join(repoRoot, file)));
  const head = eslint(app, relFiles);
  for (const result of head) {
    const rel = relative(join(repoRoot, app), result.filePath);
    const file = `${app}/${rel}`;
    checked += 1;
    let baseCounts = {};
    const existedAtBase =
      spawnSync('git', ['cat-file', '-e', `${mergeBase}:${file}`], { cwd: repoRoot }).status === 0;
    if (existedAtBase) {
      const source = git('show', `${mergeBase}:${file}`);
      const [baseResult] = eslint(app, ['--stdin', '--stdin-filename', rel], source);
      baseCounts = countByRule(baseResult?.messages ?? []);
    }
    const headCounts = countByRule(result.messages);
    for (const [rule, count] of Object.entries(headCounts)) {
      const before = baseCounts[rule] ?? 0;
      if (count > before) {
        const lines = result.messages
          .filter((m) => (m.ruleId ?? (m.fatal ? 'parse-error' : 'unknown')) === rule)
          .map((m) => `${m.line}:${m.column} ${m.message}`)
          .slice(0, 5);
        regressions.push({ file, rule, before, after: count, lines });
      }
    }
  }
}

console.log(`Checked ${checked} changed file(s) against ${baseRef} (${mergeBase.slice(0, 7)}).`);
if (regressions.length > 0) {
  console.error(`\nNew lint findings (${regressions.length}):`);
  for (const r of regressions) {
    console.error(`\n  ${r.file} — ${r.rule}: ${r.before} → ${r.after}`);
    for (const line of r.lines) console.error(`    ${line}`);
  }
  process.exit(1);
}
console.log('No new lint findings.');
