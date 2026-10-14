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
  /** Role key — also names the hidden session's working folder when there is no `workdir`. */
  role: string;
  tier: LlmTier;
  system: string;
  prompt: string;
  maxTokens?: number;
  /**
   * The agent's project folder. The Claude-subscription session then runs in
   * `<workdir>/.sessions/<sessionKey>`, so Claude Code loads the agent's
   * CLAUDE.md (and the desk-wide one above it) as project memory by itself.
   */
  workdir?: string;
  /** Separates concurrent sessions of the same agent (one per symbol). */
  sessionKey?: string;
  /**
   * The user-written instructions from those CLAUDE.md files, for providers
   * that do not read files (API / OpenAI-compatible). Ignored by the Claude
   * subscription when `workdir` is set — Claude Code already read them.
   */
  instructions?: string;
}

/** System prompt plus the user's CLAUDE.md instructions, for file-less providers. */
export function systemWithInstructions(call: LlmCall): string {
  return call.instructions?.trim() ? `${call.system}\n\n${call.instructions.trim()}` : call.system;
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
  // In an agent folder Claude Code has already loaded the CLAUDE.md instructions.
  const system = call.workdir ? call.system : systemWithInstructions(call);
  return `[시스템 지시]\n${NO_TOOLS_KO}\n\n${system.trim()}\n\n[작업]\n${call.prompt.trim()}`;
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
    // One folder per role (or per agent and symbol): concurrent sessions must
    // not share a transcript dir, because the hidden runner reads the newest
    // transcript in its cwd. An agent's folder sits above its session folder,
    // so Claude Code picks up that agent's CLAUDE.md on its own.
    const cwd = call.workdir
      ? path.join(call.workdir, '.sessions', safeDirName(call.sessionKey ?? call.role))
      : path.join(this.deps.sessionRoot, safeDirName(call.role));
    mkdirSync(cwd, { recursive: true });
    try { this.deps.prepareCwd?.(cwd); } catch { /* never block */ }
    const model = call.tier === 'deep' ? this.s.deepModel : this.s.quickModel;
    // The deep model reads the whole debate and thinks longest: give it half as long again.
    const timeoutSec = Math.round(this.s.timeoutSec * (call.tier === 'deep' ? 1.5 : 1));
    const res = await run(composeHiddenPrompt(call), {
      model,
      cwd,
      command: this.deps.claudeCommand,
      disallowedTools: DESK_DISALLOWED_TOOLS,
      timeoutMs: timeoutSec * 1000,
      // Long reports stream in bursts; give the TUI a little longer to go quiet.
      idleMs: 6000
    });
    if (this.deps.transcriptDirFor) pruneTranscripts(this.deps.transcriptDirFor(cwd));
    if (!res.ok || !res.text) throw new Error(hiddenSessionError(res.error, model, timeoutSec));
    const refusal = cliErrorReply(res.text);
    if (refusal) throw new Error(`Claude 세션 실패 (모델 ${model}): ${refusal}`);
    return res.text;
  }
}

/** A Claude Code session failure, in words the user can act on. */
export function hiddenSessionError(raw: string | undefined, model: string, timeoutSec: number): string {
  const e = raw ?? '응답 없음';
  if (/timed out/i.test(e)) {
    return `Claude 세션 실패 (모델 ${model}): ${timeoutSec}초 안에 답이 끝나지 않았습니다 — 설정 → 언어 모델 → 응답 제한 시간을 늘리거나, 깊은 모델을 sonnet으로 바꾸세요`;
  }
  if (/no assistant response/i.test(e)) {
    return `Claude 세션 실패 (모델 ${model}): 답을 받지 못했습니다 — 지금 요금제에서 이 모델을 쓸 수 없거나 사용량 한도에 닿았을 수 있습니다. ` +
      `터미널에서 "claude --model ${model}"을 실행해 확인하거나, 설정에서 이 모델을 sonnet으로 바꾸세요`;
  }
  if (/ENOENT|not recognized|cannot find|spawn/i.test(e)) {
    return `Claude 세션 실패: Claude Code를 실행하지 못했습니다 (${e}) — 터미널에서 "claude"가 실행되는지 확인하세요`;
  }
  return `Claude 세션 실패 (모델 ${model}): ${e}`;
}

/**
 * Claude Code writes some failures into the conversation as if they were the
 * answer ("API Error: …", "… is not available with the … plan", usage limits).
 * Those are short; a real desk report is not. Returns the message, or null.
 */
export function cliErrorReply(text: string): string | null {
  const t = text.trim();
  if (t.length > 600) return null;
  const pattern = /^(API Error|Error:)|not available (with|on|for) (your|the|this)|usage limit|limit reached|rate[ _-]?limit|overloaded_error|Please run \/login|Invalid API key|credit balance|\/upgrade|model.*(not found|does not exist|not supported)/i;
  return pattern.test(t) ? t.slice(0, 300) : null;
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
      system: systemWithInstructions(call),
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
        { role: 'system', content: systemWithInstructions(call) },
        { role: 'user', content: call.prompt }
      ],
      max_completion_tokens: call.maxTokens ?? (call.tier === 'deep' ? 6000 : 4000)
    }, this.s.timeoutSec * 1000) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (j.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('LLM 응답이 비어 있습니다');
    return text;
  }
}

/**
 * At most `max` calls in flight; the rest wait their turn (FIFO). A staffed
 * desk can ask for a dozen analyst reports at once, and with the Claude
 * subscription each call is a whole hidden Claude Code session.
 */
export function limitConcurrency(client: LlmClient, max: number): LlmClient {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => new Promise<void>((resolve) => {
    if (active < limit) { active++; resolve(); } else waiting.push(() => { active++; resolve(); });
  });
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return {
    label: client.label,
    async complete(call: LlmCall): Promise<string> {
      await acquire();
      try { return await client.complete(call); } finally { release(); }
    }
  };
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
