/**
 * LLM backends for the trading desk.
 *
 *   claude-subscription — the user's Claude Code login, through the app's
 *                         existing hidden-session helper (an ephemeral
 *                         interactive PTY, so calls draw on the normal plan
 *                         quota exactly like Munder Difflin's other background
 *                         checks). No API key needed.
 *   anthropic / openai  — direct HTTPS calls with a stored API key.
 *   openai-compatible   — any /v1/chat/completions server (Ollama, LM Studio,
 *                         vLLM, OpenRouter …).
 *
 * The agents never call tools: every number they need is already in the prompt
 * (see marketData.ts), so a plain text-in/text-out completion is all a backend
 * has to provide.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { FetchLike } from './binance';
import type { LlmSettings, TradingSecretKey } from '../../shared/trading';

export type LlmTier = 'quick' | 'deep';

export interface LlmCall {
  /** Role key — also names the hidden session's working folder. */
  role: string;
  tier: LlmTier;
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmClient {
  readonly label: string;
  complete(call: LlmCall): Promise<string>;
}

export interface HiddenRunner {
  (prompt: string, opts: {
    model: string; cwd: string; command?: string; disallowedTools?: string[];
    timeoutMs?: number; idleMs?: number;
  }): Promise<{ ok: boolean; text?: string; error?: string }>;
}

export interface LlmDeps {
  fetch: FetchLike;
  getSecret: (key: TradingSecretKey) => string | undefined;
  /** Folder under which each role gets its own hidden-session cwd. */
  sessionRoot: string;
  claudeCommand: string;
  runHidden?: HiddenRunner;
  /** Called before a hidden session spawns (accept trust dialog for the cwd). */
  prepareCwd?: (cwd: string) => void;
  /** Transcript folder for a cwd, so old hidden-session transcripts can be pruned. */
  transcriptDirFor?: (cwd: string) => string;
}

/** Every Claude Code tool a desk role could reach for. They get none. */
export const DESK_DISALLOWED_TOOLS = [
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'KillShell', 'BashOutput', 'SlashCommand', 'Skill'
];

const NO_TOOLS_KO =
  '너는 Munder Difflin 트레이딩 데스크의 한 구성원이다. 어떤 도구도 사용하지 마라(파일·셸·웹 검색 금지). ' +
  '아래에 주어진 자료만 근거로 지금 바로 최종 답변을 작성하라. 질문을 되묻지 말고, 주어지지 않은 수치를 지어내지 마라.';

export function composeHiddenPrompt(call: LlmCall): string {
  return `[시스템 지시]\n${NO_TOOLS_KO}\n\n${call.system.trim()}\n\n[작업]\n${call.prompt.trim()}`;
}

function safeDirName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'desk';
}

/** Keep only the newest `keep` transcripts in a desk session's project folder. */
export function pruneTranscripts(dir: string, keep = 12): void {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) {
      try { unlinkSync(path.join(dir, f)); } catch { /* in use or gone */ }
    }
  } catch { /* best-effort */ }
}

class ClaudeSubscriptionClient implements LlmClient {
  readonly label: string;
  constructor(private readonly s: LlmSettings, private readonly deps: LlmDeps) {
    this.label = `Claude 구독 (${s.quickModel} / ${s.deepModel})`;
  }

  async complete(call: LlmCall): Promise<string> {
    const run = this.deps.runHidden;
    if (!run) throw new Error('Claude 숨은 세션을 사용할 수 없습니다');
    // One folder per role: concurrent sessions must not share a transcript dir,
    // because the hidden runner reads the newest transcript in its cwd.
    const cwd = path.join(this.deps.sessionRoot, safeDirName(call.role));
    mkdirSync(cwd, { recursive: true });
    try { this.deps.prepareCwd?.(cwd); } catch { /* never block */ }
    const model = call.tier === 'deep' ? this.s.deepModel : this.s.quickModel;
    const res = await run(composeHiddenPrompt(call), {
      model,
      cwd,
      command: this.deps.claudeCommand,
      disallowedTools: DESK_DISALLOWED_TOOLS,
      timeoutMs: this.s.timeoutSec * 1000,
      // Long reports stream in bursts; give the TUI a little longer to go quiet.
      idleMs: 6000
    });
    if (this.deps.transcriptDirFor) pruneTranscripts(this.deps.transcriptDirFor(cwd));
    if (!res.ok || !res.text) throw new Error(`Claude 세션 실패: ${res.error ?? '응답 없음'}`);
    return res.text;
  }
}

async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (!retryable) break;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

class AnthropicClient implements LlmClient {
  readonly label: string;
  constructor(private readonly s: LlmSettings, private readonly deps: LlmDeps) {
    this.label = `Anthropic API (${s.quickModel} / ${s.deepModel})`;
  }
  async complete(call: LlmCall): Promise<string> {
    const key = this.deps.getSecret('anthropic.key');
    if (!key) throw new Error('Anthropic API 키가 설정되지 않았습니다');
    const j = await postJson(this.deps.fetch, 'https://api.anthropic.com/v1/messages', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    }, {
      model: call.tier === 'deep' ? this.s.deepModel : this.s.quickModel,
      max_tokens: call.maxTokens ?? (call.tier === 'deep' ? 6000 : 4000),
      system: call.system,
      messages: [{ role: 'user', content: call.prompt }]
    }, this.s.timeoutSec * 1000) as { content?: Array<{ type: string; text?: string }> };
    const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    if (!text) throw new Error('Anthropic 응답이 비어 있습니다');
    return text;
  }
}

class OpenAiChatClient implements LlmClient {
  readonly label: string;
  constructor(
    private readonly s: LlmSettings,
    private readonly deps: LlmDeps,
    private readonly url: string,
    private readonly secret: TradingSecretKey,
    private readonly keyRequired: boolean,
    labelPrefix: string
  ) {
    this.label = `${labelPrefix} (${s.quickModel} / ${s.deepModel})`;
  }
  async complete(call: LlmCall): Promise<string> {
    const key = this.deps.getSecret(this.secret);
    if (this.keyRequired && !key) throw new Error('OpenAI API 키가 설정되지 않았습니다');
    const j = await postJson(this.deps.fetch, this.url, key ? { authorization: `Bearer ${key}` } : {}, {
      model: call.tier === 'deep' ? this.s.deepModel : this.s.quickModel,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.prompt }
      ],
      max_completion_tokens: call.maxTokens ?? (call.tier === 'deep' ? 6000 : 4000)
    }, this.s.timeoutSec * 1000) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (j.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('LLM 응답이 비어 있습니다');
    return text;
  }
}

export function createLlmClient(s: LlmSettings, deps: LlmDeps): LlmClient {
  switch (s.provider) {
    case 'anthropic':
      return new AnthropicClient(s, deps);
    case 'openai':
      return new OpenAiChatClient(s, deps, 'https://api.openai.com/v1/chat/completions', 'openai.key', true, 'OpenAI API');
    case 'openai-compatible':
      return new OpenAiChatClient(s, deps, `${s.baseUrl.replace(/\/+$/, '')}/chat/completions`, 'compat.key', false, `호환 서버 ${s.baseUrl}`);
    case 'claude-subscription':
    default:
      return new ClaudeSubscriptionClient(s, deps);
  }
}
