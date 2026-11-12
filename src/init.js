// `lake-meter init`: copy a pinned runtime to ~/.lake-meter/runtime and register hooks, a statusline,
// a /meter skill and two optional cheap-model subagents in Claude Code settings. `uninstall` reverses it.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { home, saveUserConfig, DEFAULT_CONFIG } from './state.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = 'lake-meter';

function readJson(p) {
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throw on broken JSON rather than overwrite the user's file
}

export function targets({ project, cwd = process.cwd(), claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') }) {
  const base = project ? join(cwd, '.claude') : claudeHome;
  return {
    settings: join(base, project ? 'settings.local.json' : 'settings.json'),
    skillDir: join(base, 'skills', 'meter'),
    agentsDir: join(base, 'agents'),
  };
}

function hookEntry(node, cli, event, extra = {}) {
  return { ...extra, hooks: [{ type: 'command', command: node, args: [cli, 'hook', event], timeout: event === 'stop' ? 20 : 10 }] };
}

const isOurs = (group) => (group?.hooks || []).some((h) => [h.command, ...(h.args || [])].some((x) => String(x).includes(MARK)));

export function installRuntime() {
  const rt = join(home(), 'runtime');
  rmSync(rt, { recursive: true, force: true });
  mkdirSync(rt, { recursive: true });
  for (const d of ['bin', 'src']) cpSync(join(pkgRoot, d), join(rt, d), { recursive: true });
  copyFileSync(join(pkgRoot, 'package.json'), join(rt, 'package.json'));
  return join(rt, 'bin', 'lake-meter.js');
}

export function init(opts = {}) {
  const log = opts.log || console.log;
  const node = opts.node || process.execPath;
  const cli = opts.cli || installRuntime();
  const t = targets(opts);
  const settings = readJson(t.settings);
  if (existsSync(t.settings)) copyFileSync(t.settings, `${t.settings}.lake-meter.bak`);
  settings.hooks ||= {};
  const add = (evt, group) => {
    settings.hooks[evt] = (settings.hooks[evt] || []).filter((g) => !isOurs(g));
    settings.hooks[evt].push(group);
  };
  add('UserPromptSubmit', hookEntry(node, cli, 'user-prompt-submit'));
  add('PreToolUse', hookEntry(node, cli, 'pre-tool-use', { matcher: '*' }));
  add('PostToolUse', hookEntry(node, cli, 'post-tool-use', { matcher: '*' }));
  add('Stop', hookEntry(node, cli, 'stop'));

  let statusNote = 'statusline installed';
  const ourStatus = { type: 'command', command: `"${node}" "${cli}" statusline`, padding: 0 };
  if (!settings.statusLine || isOurs({ hooks: [settings.statusLine] }) || opts.statusline) {
    if (settings.statusLine && !isOurs({ hooks: [settings.statusLine] })) writeFileSync(join(home(), 'previous-statusline.json'), JSON.stringify(settings.statusLine, null, 2));
    settings.statusLine = ourStatus;
  } else {
    statusNote = 'kept your existing statusline (run `init --statusline` to replace it; the 5-hour-window cap needs it)';
  }
  mkdirSync(dirname(t.settings), { recursive: true });
  writeFileSync(t.settings, JSON.stringify(settings, null, 2) + '\n');

  mkdirSync(t.skillDir, { recursive: true });
  writeFileSync(join(t.skillDir, 'SKILL.md'), `---
name: meter
description: Lake Meter. Show this run's spend, set the per-run cap, or estimate a plan. Usage /meter [status|cap <usd>|cap off|plan <file>|report]
disable-model-invocation: true
allowed-tools: Bash(${node} *)
argument-hint: "[status | cap <usd> | cap off | plan <file> | report]"
---
!\`"${node}" "${cli}" cmd --session \${CLAUDE_SESSION_ID} $ARGUMENTS\`

Show the Lake Meter output above to the user exactly as written, in a code block. Do not take any other action.
`);

  if (opts.agents !== false) {
    mkdirSync(t.agentsDir, { recursive: true });
    writeFileSync(join(t.agentsDir, 'lake-light.md'), `---
name: lake-light
description: Low-cost worker on Haiku for mechanical plan steps that Lake Meter rated light (renames, docs, config, boilerplate, simple tests). Not for design, security, concurrency or debugging work.
model: haiku
---
You carry out one small, well-specified step of an approved plan. Follow the step exactly, keep the change minimal, run the relevant checks, and report what you changed. If the step turns out to need design decisions, stop and say so instead of guessing.
`);
    writeFileSync(join(t.agentsDir, 'lake-standard.md'), `---
name: lake-standard
description: Mid-cost worker on Sonnet for plan steps that Lake Meter rated standard (normal feature work in a known area). Not for architecture, migrations or security-sensitive changes.
model: sonnet
---
You implement one step of an approved plan. Stay inside the step's scope, follow the codebase's conventions, run the relevant tests, and report what you changed and anything you were unsure about.
`);
  }

  if (!existsSync(join(home(), 'config.json'))) saveUserConfig({ capUsd: opts.capUsd ?? DEFAULT_CONFIG.capUsd, onCap: DEFAULT_CONFIG.onCap });
  else if (opts.capUsd != null) saveUserConfig({ capUsd: opts.capUsd });

  log(`✓ Lake Meter installed in ${t.settings}`);
  log(`  hooks: UserPromptSubmit, PreToolUse, PostToolUse, Stop · ${statusNote}`);
  log(`  /meter skill: ${t.skillDir}${opts.agents !== false ? ` · subagents lake-light (haiku), lake-standard (sonnet) in ${t.agentsDir}` : ''}`);
  log(`  per-run cap: ${'$'}${opts.capUsd ?? JSON.parse(readFileSync(join(home(), 'config.json'), 'utf8')).capUsd} (change with: npx lake-meter cap 10)`);
  log('  Restart Claude Code (or open /hooks) to load it. No data leaves your machine.');
  return t;
}

export function uninstall(opts = {}) {
  const log = opts.log || console.log;
  const t = targets(opts);
  if (existsSync(t.settings)) {
    const s = readJson(t.settings);
    for (const evt of Object.keys(s.hooks || {})) {
      s.hooks[evt] = s.hooks[evt].filter((g) => !isOurs(g));
      if (!s.hooks[evt].length) delete s.hooks[evt];
    }
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
    if (s.statusLine && isOurs({ hooks: [s.statusLine] })) {
      const prev = join(home(), 'previous-statusline.json');
      if (existsSync(prev)) s.statusLine = JSON.parse(readFileSync(prev, 'utf8')); else delete s.statusLine;
    }
    writeFileSync(t.settings, JSON.stringify(s, null, 2) + '\n');
  }
  rmSync(t.skillDir, { recursive: true, force: true });
  for (const a of ['lake-light.md', 'lake-standard.md']) rmSync(join(t.agentsDir, a), { force: true });
  log(`✓ Lake Meter removed from ${t.settings}. Local data stays in ${home()} (delete it if you like).`);
}
