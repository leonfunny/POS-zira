#!/usr/bin/env node
/**
 * CSS baseline guard for the Android POS target engine.
 *
 * The SUNMI D2s Lite runs Android System WebView 83 (Chromium 83) and cannot
 * update it: the system's provider allowlist holds only the AOSP package, the
 * bundled Chrome is 56 with targetSdk 25 (below the required 30), and
 * `com.google.android.webview` is not installed. Chromium 83 is therefore a
 * permanent floor for the shared renderer, which the Windows Electron build
 * (Chromium ~130) will happily hide: a developer sees the layout render
 * correctly on their desktop while it silently collapses on the counter.
 *
 * Measured in that WebView over CDP on 2026-08-07:
 *
 *   flex + gap        -> 0px where 40px was asked   (needs Chromium 84)
 *   grid + gap        -> 40px, correct              (works since Chromium 66)
 *   margin spacing    -> 40px, correct
 *   aspect-ratio      -> unsupported                (needs Chromium 88)
 *   :where() / :is()  -> unsupported; the WHOLE rule is discarded
 *   backdrop-filter   -> supported
 *
 * So the authoring rule is narrow and cheap: spacing goes on a CSS Grid
 * container, never on a flex one. This script is the machine that remembers it.
 *
 * Usage:
 *   node scripts/verify-css-baseline.mjs                # report, always exit 0
 *   node scripts/verify-css-baseline.mjs --strict       # exit 1 on any violation
 *   node scripts/verify-css-baseline.mjs --scope=pos    # cashier path only
 *   node scripts/verify-css-baseline.mjs --css=dist/android-web/assets
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const scopeArg = args.find((a) => a.startsWith('--scope='))?.slice('--scope='.length) ?? 'all';
const cssArg = args.find((a) => a.startsWith('--css='))?.slice('--css='.length);

/** Directories scanned for JSX class lists. */
const SCOPES = {
  // Everything the shared renderer ships.
  all: ['src/renderer'],
  // The screens the Android tablet actually mounts.
  pos: [
    'src/renderer/components/pos',
    'src/renderer/components/billiard',
    'src/renderer/android-pos',
  ],
};

/** Tailwind display utilities that put an element in flex layout. */
const FLEX_DISPLAY = new Set(['flex', 'inline-flex']);
/** …and in grid layout, where `gap` is safe on Chromium 83. */
const GRID_DISPLAY = new Set(['grid', 'inline-grid']);

/** Strip a Tailwind variant chain: `sm:hover:gap-2` -> `gap-2`. */
function baseUtility(token) {
  const clean = token.replace(/^!/, '');
  const idx = clean.lastIndexOf(':');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

function isGapUtility(base) {
  return /^gap(-x|-y)?-/.test(base);
}

function isAspectUtility(base) {
  return /^aspect-/.test(base);
}

function isInsetUtility(base) {
  return base === 'inset-0';
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Pull out every `className=` value. Handles the plain string form and the
 * braced form (template literals, conditionals, clsx-style calls) by matching
 * braces so a multi-line expression is captured whole.
 */
function extractClassValues(source) {
  const values = [];
  const re = /className\s*=\s*/g;
  let m;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) continue;
      values.push({ text: source.slice(i + 1, end), index: i });
    } else if (ch === '{') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      values.push({ text: source.slice(i + 1, j), index: i });
      re.lastIndex = j;
    }
  }
  return values;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Class tokens in a value. For braced expressions this deliberately takes every
 * string literal inside, so a conditional `cond ? 'flex gap-2' : 'grid'` is
 * examined per branch rather than as one soup — that avoids calling a grid
 * branch a flex violation.
 */
function templateParts(value) {
  const source = value.trim();
  if (!source.startsWith('`') || !source.endsWith('`')) return null;

  let staticText = '';
  const expressions = [];
  for (let i = 1; i < source.length - 1; i += 1) {
    if (source[i] !== '$' || source[i + 1] !== '{') {
      staticText += source[i];
      continue;
    }

    const start = i + 2;
    let depth = 1;
    let quote = null;
    let j = start;
    for (; j < source.length - 1; j += 1) {
      const ch = source[j];
      if (quote) {
        if (ch === '\\') j += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    expressions.push(source.slice(start, j));
    staticText += ' ';
    i = j;
  }
  return { staticText, expressions };
}

function branchesOf(value) {
  const template = templateParts(value);
  if (template) {
    // Combine the always-present template tokens with each possible literal
    // branch independently. Separate interpolations are handled conservatively
    // by templateHasCrossInterpolationAmbiguity below; their runtime correlation
    // cannot be proven from a class string.
    const branches = [template.staticText];
    for (const expression of template.expressions) {
      const literals = [...expression.matchAll(/(['"])(.*?)\1/gs)].map((m) => m[2]);
      for (const literal of literals) branches.push(`${template.staticText} ${literal}`);
    }
    return branches;
  }
  const literals = [...value.matchAll(/['"`]([^'"`]*)['"`]/g)].map((m) => m[1]);
  return literals.length ? literals : [value];
}

function templateHasCrossInterpolationAmbiguity(value) {
  const template = templateParts(value);
  if (!template || template.expressions.length < 2) return false;

  const emissions = template.expressions.map((expression) => {
    const literals = [...expression.matchAll(/(['"])(.*?)\1/gs)].map((m) => m[2]);
    return literals.flatMap((literal) => literal.split(/\s+/).filter(Boolean).map(baseUtility));
  });
  const flexExpressions = emissions
    .map((tokens, index) => tokens.some((token) => FLEX_DISPLAY.has(token)) ? index : -1)
    .filter((index) => index !== -1);
  const gapExpressions = emissions
    .map((tokens, index) => tokens.some(isGapUtility) ? index : -1)
    .filter((index) => index !== -1);

  return flexExpressions.some((flexIndex) => gapExpressions.some((gapIndex) => gapIndex !== flexIndex));
}

const violations = { flexGap: [], aspect: [], inset: [], ambiguous: [] };

// `--dir=` overrides the named scopes. Tests point it at a fixture tree; it is
// also handy for checking one component while refactoring it.
const dirArgs = args.filter((a) => a.startsWith('--dir=')).map((a) => a.slice('--dir='.length));
const dirs = dirArgs.length
  ? dirArgs.map((d) => resolve(ROOT, d))
  : (SCOPES[scopeArg] ?? SCOPES.all).map((d) => join(ROOT, d));
const files = dirs.flatMap((d) => walk(d));

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  for (const { text, index } of extractClassValues(source)) {
    const line = lineOf(source, index);
    let insetRecorded = false;
    let ambiguousRecorded = false;
    if (templateHasCrossInterpolationAmbiguity(text)) {
      violations.ambiguous.push({ rel, line, tokens: 'separate template interpolations may combine flex + gap-*' });
      ambiguousRecorded = true;
    }
    for (const branch of branchesOf(text)) {
      const tokens = branch.split(/\s+/).filter(Boolean).map(baseUtility);
      const hasFlex = tokens.some((t) => FLEX_DISPLAY.has(t));
      const hasGrid = tokens.some((t) => GRID_DISPLAY.has(t));
      const gaps = tokens.filter(isGapUtility);
      const aspects = tokens.filter(isAspectUtility);
      const insets = tokens.filter(isInsetUtility);

      if (aspects.length) {
        violations.aspect.push({ rel, line, tokens: aspects.join(' ') });
      }
      if (insets.length && !insetRecorded) {
        violations.inset.push({ rel, line, tokens: insets.join(' ') });
        insetRecorded = true;
      }
      if (gaps.length && hasFlex) {
        // A branch carrying both display utilities cannot be judged statically.
        if (hasGrid) {
          if (!ambiguousRecorded) {
            violations.ambiguous.push({ rel, line, tokens: gaps.join(' ') });
            ambiguousRecorded = true;
          }
        } else violations.flexGap.push({ rel, line, tokens: gaps.join(' ') });
      }
    }
  }
}

// ── Emitted CSS ─────────────────────────────────────────────────────────────
// Utilities are one half of the story; hand-written CSS and Tailwind's own
// output can carry constructs Chromium 83 drops outright.

const cssFindings = [];
// `--dir=` means "judge exactly this tree", so it does not drag in the
// project's built stylesheet; ask for that explicitly with `--css=`.
const scanCss = Boolean(cssArg) || dirArgs.length === 0;
const cssDir = cssArg ? resolve(ROOT, cssArg) : join(ROOT, 'dist/android-web/assets');
if (scanCss && existsSync(cssDir)) {
  for (const entry of readdirSync(cssDir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(cssDir, entry), 'utf8');
    const checks = [
      [':where(', /:where\(/g, 'the whole rule is discarded on Chromium 83'],
      [':is(', /:is\(/g, 'the whole rule is discarded on Chromium 83'],
      [':has(', /:has\(/g, 'needs Chromium 105'],
      ['aspect-ratio', /aspect-ratio\s*:/g, 'ignored; the box gets no intrinsic height'],
      ['inset:', /(?:^|[;{])\s*inset\s*:/g, 'shorthand is ignored; use explicit physical sides'],
      ['color-mix(', /color-mix\(/g, 'needs Chromium 111'],
      ['@container', /@container/g, 'needs Chromium 105'],
      ['dynamic viewport unit', /(?:^|[^\w-])(?:\d*\.?\d+)(?:dvh|dvw|svh|svw|lvh|lvw)\b/g, 'needs Chromium 108'],
      ['subgrid', /grid-template-(?:columns|rows)\s*:\s*subgrid/g, 'needs Chromium 117'],
    ];
    for (const [label, re, why] of checks) {
      const n = (css.match(re) ?? []).length;
      if (n) cssFindings.push({ file: entry, label, n, why });
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const byFile = (list) => {
  const counts = new Map();
  for (const v of list) counts.set(v.rel, (counts.get(v.rel) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`CSS baseline: Chromium 83 (Android WebView on the SUNMI counter)`);
console.log(`scope=${scopeArg}  files=${files.length}  mode=${STRICT ? 'strict' : 'report-only'}`);
console.log('');

if (violations.flexGap.length) {
  console.log(`flex + gap-*  ${violations.flexGap.length} site(s)  -> renders as ZERO spacing`);
  for (const [file, n] of byFile(violations.flexGap).slice(0, 12)) console.log(`   ${String(n).padStart(4)}  ${file}`);
  if (byFile(violations.flexGap).length > 12) console.log(`   ...and ${byFile(violations.flexGap).length - 12} more files`);
  console.log(`   fix: put the spacing on a grid container, or use space-x-*/space-y-*`);
  console.log('');
}
if (violations.aspect.length) {
  console.log(`aspect-*      ${violations.aspect.length} site(s)  -> no intrinsic height`);
  for (const [file, n] of byFile(violations.aspect).slice(0, 8)) console.log(`   ${String(n).padStart(4)}  ${file}`);
  console.log(`   fix: set an explicit height, or use the padding-top percentage trick`);
  console.log('');
}
if (violations.inset.length) {
  console.log(`inset-0      ${violations.inset.length} site(s)  -> shorthand is not in the Chrome 83 authoring contract`);
  for (const [file, n] of byFile(violations.inset).slice(0, 8)) console.log(`   ${String(n).padStart(4)}  ${file}`);
  if (byFile(violations.inset).length > 8) console.log(`   ...and ${byFile(violations.inset).length - 8} more files`);
  console.log(`   fix: use top-0 right-0 bottom-0 left-0`);
  console.log('');
}
if (violations.ambiguous.length) {
  console.log(`ambiguous     ${violations.ambiguous.length} site(s)  -> runtime classes cannot prove Chrome 83-safe flex spacing`);
  for (const [file, n] of byFile(violations.ambiguous).slice(0, 6)) console.log(`   ${String(n).padStart(4)}  ${file}`);
  console.log(`   fix: keep display and spacing in one provable branch, or use Chrome 83-safe margins`);
  console.log('');
}
if (cssFindings.length) {
  console.log(`emitted CSS (${relative(ROOT, cssDir)})`);
  for (const f of cssFindings) console.log(`   ${String(f.n).padStart(4)}  ${f.label.padEnd(14)} ${f.file}  — ${f.why}`);
  console.log('');
} else if (scanCss && !existsSync(cssDir)) {
  console.log(`emitted CSS: not scanned (${relative(ROOT, cssDir)} absent — run \`npm run build:android:web\` first)`);
  console.log('');
}

const total = violations.flexGap.length + violations.aspect.length + violations.inset.length + violations.ambiguous.length + cssFindings.reduce((s, f) => s + f.n, 0);
if (total === 0) {
  console.log('PASS css baseline: nothing that Chromium 83 would drop.');
  process.exit(0);
}
console.log(`${STRICT ? 'FAIL' : 'REPORT'} css baseline: ${total} finding(s).`);
process.exit(STRICT ? 1 : 0);
