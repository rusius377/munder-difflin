'use strict';

// The Korean (ko) locale and the trading-desk strings.
//
// Same contract as the Arabic locale: nothing changes for a user who has not
// picked Korean (English stays the default and is never auto-detected — pinned
// in arabic-ui / i18n-god-name tests), and a partial translation must fall back
// cleanly. These tests pin coverage and shape, not translation quality.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (code) => JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));

function leaves(node, prefix = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${prefix}.${i}`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}
const pathsOf = (o) => new Map(leaves(o));

const en = locale('en');
const ko = locale('ko');

test('ko is registered everywhere a language has to be registered, left-to-right', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /import ko from '\.\/locales\/ko\.json';/);
  assert.match(src, /ko: \{ translation: ko \}/, 'ko is missing from resources');
  assert.match(src, /supportedLngs: \[[^\]]*'ko'[^\]]*\]/, 'ko is missing from supportedLngs');
  assert.match(src, /code: 'ko'[^}]*dir: 'ltr'/, 'ko must be registered left-to-right');
});

test('ko has exactly the key tree of en', () => {
  const e = pathsOf(en), k = pathsOf(ko);
  assert.deepEqual([...e.keys()].filter((x) => !k.has(x)), [], 'ko is missing keys');
  assert.deepEqual([...k.keys()].filter((x) => !e.has(x)), [], 'ko has keys en does not');
});

test('every interpolation variable and inline tag survives in ko; arrays keep their length', () => {
  const e = pathsOf(en), k = pathsOf(ko);
  const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
  const tags = (s) => [...String(s).matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1]).sort().join(',');
  const bad = [];
  for (const [p, v] of e) {
    if (vars(v) !== vars(k.get(p))) bad.push(`vars ${p}`);
    if (tags(v) !== tags(k.get(p))) bad.push(`tags ${p}`);
  }
  assert.deepEqual(bad, []);
  const at = (o, p) => p.split('.').reduce((n, s) => n?.[s], o);
  for (const p of ['office.errand.smoke', 'office.suckUp', 'office.gossip', 'office.cheer']) {
    assert.equal(at(ko, p).length, at(en, p).length, `${p} changed length`);
  }
});

test('no Korean string is left as its English source (proper nouns and formats excepted)', () => {
  const SAME_ON_PURPOSE = new Set([
    'commandBar.skill',                      // "/skill" — a literal command
    'settings.connections.slack',            // product name
    'commandCenter.logMessage',              // "{{from}} → {{to}}: {{subject}}" — pure interpolation
    'addAgent.projectPlaceholder',           // a filesystem path
    'onboarding.providerBlurb.claude',       // product names
    'onboarding.providerBlurb.codex',
    'onboarding.providerBlurb.antigravity',
    'onboarding.providerBlurb.gemini',
    'onboarding.home.placeholder',           // a filesystem path
    'mcpDefaults.toggleNote',                // pure interpolation
    'webhooksSection.summary',               // pure interpolation
    'trading.providers.anthropic',           // "Anthropic API" — product name
    'trading.providers.openai'               // "OpenAI API" — product name
  ]);
  const e = pathsOf(en), k = pathsOf(ko);
  const untranslated = [];
  for (const [p, v] of e) {
    if (typeof v !== 'string' || !/[A-Za-z]{4}/.test(v)) continue;
    if (k.get(p) === v && !SAME_ON_PURPOSE.has(p)) untranslated.push(p);
  }
  assert.deepEqual(untranslated, []);
  const stale = [...SAME_ON_PURPOSE].filter((p) => k.get(p) !== e.get(p));
  assert.deepEqual(stale, [], 'allowlisted keys that ARE translated — drop them from the list');
});

test('no ko string hardcodes the orchestrator name', () => {
  for (const [p, v] of pathsOf(ko)) {
    if (typeof v === 'string') assert.ok(!/Michael|마이클/.test(v), `${p} hardcodes the orchestrator name`);
  }
});

test('every font stack names a Korean face after the CJK and before the Arabic fallbacks', () => {
  const css = read('src/renderer/src/design/tokens.css');
  for (const v of ['--cth-font-display', '--cth-font-ui', '--cth-font-mono']) {
    const stack = css.match(new RegExp(`${v}:\\s*(.+);`))[1];
    assert.match(stack, /Apple SD Gothic Neo/, `${v} lacks a Korean face`);
    assert.ok(stack.indexOf('Apple SD Gothic Neo') > stack.indexOf('CJK SC'), `${v}: Korean face must not displace the Chinese one`);
  }
});

test('the trading desk is fully localized in every locale', () => {
  for (const code of ['en', 'zh-CN', 'ar', 'ko']) {
    const l = locale(code);
    assert.ok(l.trading && l.trading.title, `${code} has no trading section`);
    assert.ok(l.commandCenter.tabs.trading, `${code} has no trading tab label`);
    for (const role of ['technical', 'derivatives', 'news', 'sentiment', 'bull', 'bear', 'researchManager', 'trader',
      'aggressive', 'conservative', 'neutral', 'portfolioManager', 'riskEngine', 'execution', 'biasDesk', 'reflection']) {
      assert.ok(l.trading.roles[role], `${code} trading.roles.${role}`);
      assert.ok(l.trading.roleHints[role], `${code} trading.roleHints.${role}`);
    }
  }
  assert.equal(ko.trading.modes.scalping, '스캘핑');
  assert.equal(ko.trading.modes.agents, '에이전트 알고리즘');
});

test('every trading i18n key the components use exists in en', () => {
  const dir = path.join(root, 'src/renderer/src/components/trading');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const e = pathsOf(en);
  const missing = [];
  for (const m of src.matchAll(/t\('(trading\.[\w.-]+)'/g)) if (!e.has(m[1])) missing.push(m[1]);
  for (const m of src.matchAll(/f\('(\w+)'\)/g)) if (!e.has(`trading.settings.fields.${m[1]}`)) missing.push(`fields.${m[1]}`);
  assert.deepEqual([...new Set(missing)], []);
});
