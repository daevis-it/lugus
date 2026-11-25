import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BlockState } from './core/blocks';
import { checkText, commentTokenForFile, describeState, isDrift, mayContainBlocks } from './core/check';
import { entryStateWithoutSymbols, parseSidecar, SIDECAR_DIR, sourcePathFor } from './core/sidecar';
import { splitLines } from './core/text';

/**
 * `lugus check`: reports Lugus blocks whose rule and code have drifted apart.
 * Runs without VS Code, for pre-commit hooks and CI.
 *
 * Exit codes: 0 all aligned, 1 drift found, 2 usage or I/O error.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'bin',
  'obj',
  '.venv',
  'venv',
  '__pycache__',
  // Unreal / Unity / Godot build and cache folders
  'Binaries',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  'Library',
  'Temp',
  '.godot'
]);

const HELP = `Usage: lugus check [paths...] [--json] [--strict]

Reports Lugus blocks whose rule and code no longer match: inline blocks
in the sources and sidecar rules in .lugus/rules.

  paths      Files or folders to check (default: current folder).
             Inside a git repository, ignored files are skipped.
  --json     Print a JSON report instead of text.
  --strict   Also fail on blocks that are not verified (old markers).

Exit codes: 0 aligned, 1 drift found, 2 error.`;

export interface CliIO {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface Finding {
  file: string;
  line: number;
  state: BlockState;
  rule: string;
  storage: 'inline' | 'sidecar';
}

export function run(argv: string[], io: CliIO): number {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));

  if (flags.has('--help') || argv.length === 0 || args[0] === 'help') {
    io.out(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (flags.has('--version')) {
    io.out(readVersion());
    return 0;
  }
  const unknown = [...flags].filter((f) => !['--json', '--strict'].includes(f));
  if (args[0] !== 'check' || unknown.length) {
    io.err(unknown.length ? `Unknown option: ${unknown.join(', ')}` : `Unknown command: ${args[0]}`);
    io.err(HELP);
    return 2;
  }

  const targets = args.slice(1).length ? args.slice(1) : ['.'];
  const files = new Set<string>();
  for (const target of targets) {
    const absolute = path.resolve(io.cwd, target);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      io.err(`lugus: cannot read ${target}`);
      return 2;
    }
    if (stat.isDirectory()) {
      listFiles(absolute).forEach((f) => files.add(f));
    } else {
      files.add(absolute);
    }
  }

  const strict = flags.has('--strict');
  const findings: Finding[] = [];
  let checked = 0;
  for (const file of [...files].sort()) {
    const text = readText(file);
    if (text === null || !mayContainBlocks(text)) {
      continue;
    }
    const display = path.relative(io.cwd, file).split(path.sep).join('/') || path.basename(file);
    for (const report of checkText(text, commentTokenForFile(file, text))) {
      checked++;
      if (isDrift(report.state) || report.state === 'unverified') {
        findings.push({ file: display, line: report.line + 1, state: report.state, rule: report.rule.join(' '), storage: 'inline' });
      }
    }
  }

  // Sidecar rules (.lugus/rules at the repository root), for sources inside the targets.
  const root = repositoryRoot(io.cwd);
  const absoluteTargets = targets.map((t) => path.resolve(io.cwd, t));
  const inTargets = (file: string) =>
    absoluteTargets.some((t) => file === t || file.startsWith(t.endsWith(path.sep) ? t : t + path.sep));
  let unreadable = 0;
  for (const json of walk(path.join(root, ...SIDECAR_DIR.split('/'))).filter((f) => f.endsWith('.json')).sort()) {
    const sourceRel = sourcePathFor(path.relative(root, json).split(path.sep).join('/'));
    if (!sourceRel) {
      continue;
    }
    const source = path.join(root, ...sourceRel.split('/'));
    if (!inTargets(source) && !inTargets(json)) {
      continue;
    }
    const display = path.relative(io.cwd, source).split(path.sep).join('/');
    let entries;
    try {
      entries = parseSidecar(fs.readFileSync(json, 'utf8')).blocks;
    } catch (err) {
      unreadable++;
      io.err(`lugus: cannot read ${path.relative(io.cwd, json).split(path.sep).join('/')}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const text = readText(source);
    const lines = text === null ? null : splitLines(text);
    for (const entry of entries) {
      checked++;
      const { state, line } = entryStateWithoutSymbols(entry, lines);
      if (isDrift(state)) {
        findings.push({ file: display, line: line + 1, state, rule: entry.rule.join(' '), storage: 'sidecar' });
      }
    }
  }

  const failing = findings.filter((f) => isDrift(f.state) || (strict && f.state === 'unverified'));

  if (flags.has('--json')) {
    io.out(JSON.stringify({ checked, findings, ok: failing.length === 0 }, null, 2));
  } else {
    for (const f of findings) {
      const rule = f.rule.length > 72 ? `${f.rule.slice(0, 71)}…` : f.rule;
      io.out(`${f.file}:${f.line}  ${describeState(f.state)}  "${rule}"${f.storage === 'sidecar' ? '  (sidecar)' : ''}`);
    }
    const drifted = findings.filter((f) => isDrift(f.state)).length;
    const unverified = findings.length - drifted;
    const parts = [`${checked} linked block${checked === 1 ? '' : 's'} checked`, `${drifted} drifted`];
    if (unverified) {
      parts.push(`${unverified} not verified`);
    }
    io.out(`lugus: ${parts.join(', ')}.`);
  }
  return failing.length || unreadable ? 1 : 0;
}

/** Top of the git repository containing `cwd`, or `cwd` itself. */
function repositoryRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return cwd;
  }
}

/** Files under `dir`: git-tracked and untracked-but-not-ignored when possible, else a filtered walk. */
function listFiles(dir: string): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    });
    return output
      .split('\0')
      .filter(Boolean)
      .map((rel) => path.join(dir, rel));
  } catch {
    return walk(dir);
  }
}

function walk(dir: string): string[] {
  const result: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        result.push(...walk(full));
      }
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

/** Version from the package.json next to the bundle (dist/cli.js -> ../package.json). */
function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function readText(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) {
      return null;
    }
    const buffer = fs.readFileSync(file);
    if (buffer.subarray(0, 8000).includes(0)) {
      return null; // binary
    }
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n')
  });
}
