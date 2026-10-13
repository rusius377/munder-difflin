/**
 * One project folder per desk agent, under <userData>/trading/agents/:
 *
 *   agents/
 *     CLAUDE.md                     desk-wide instructions every agent reads
 *     technical-trend/              one agent (role + seat specialty)
 *       CLAUDE.md                   who it is + "## 내 지침" the user may edit
 *       scorecard.md                its track record, regenerated
 *       record.json                 its opinions and how each one scored
 *       lessons.md                  trades it voted on and how they ended
 *       outputs/<SYMBOL>/*.md       what it wrote, newest 30 per symbol
 *       .sessions/<SYMBOL>/         its hidden Claude Code session runs here
 *
 * With the Claude subscription the agent's session runs inside its folder, so
 * Claude Code itself loads agents/CLAUDE.md and agents/<id>/CLAUDE.md as
 * project memory. API providers get the same user-written sections injected
 * into the system prompt (see instructionsForApi).
 *
 * The track record is checked against the market, not against the model's
 * opinion of itself: a directional call (bullish / long / long-only, or the
 * bearish counterparts) is scored by the price `horizonMs` later. Neutral
 * calls are kept but not scored.
 *
 * Everything here is best-effort — a failed write never stops trading.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PERSONAS, ROLE_KO, TEAM_LABEL } from './teams';
import {
  voteDirection, type AgentProjectView, type AgentRef, type AgentRole, type TeamRole, type TradingSymbol
} from '../../shared/trading';

/** How long after a call its direction is checked. */
export const OPINION_HORIZON_MS = { pipeline: 4 * 3_600_000, bias: 3_600_000 } as const;

const MAX_OPINIONS = 500;
const MAX_OUTPUTS_PER_SYMBOL = 30;
const MAX_LESSON_LINES = 200;
const ID_RE = /^[A-Za-z]+(?:-[a-z]+)?$/;
export const AGENT_MARKER = '## 내 지침';
export const COMMON_MARKER = '## 공통 지침';

export interface Opinion {
  /** Unique within the agent. */
  id: string;
  ts: number;
  symbol: TradingSymbol;
  runId: string;
  kind: 'pipeline' | 'bias';
  /** Machine-read vote (Bullish, LONG, Overweight, LONG_ONLY …); null when the role has none. */
  vote: string | null;
  confidence: number | null;
  /** Price when the call was made. */
  price: number;
  horizonMs: number;
  /** First lines of what the agent wrote. */
  summary: string;
  scoredAt?: number;
  priceAfter?: number;
  /** Signed % change from price to priceAfter. */
  movePct?: number;
  hit?: boolean;
  /** Made in a historical replay (training), not live. `ts` is the replayed moment. */
  replay?: boolean;
}

interface AgentRecord {
  version: 1;
  id: string;
  opinions: Opinion[];
}

const ROLE_TITLE: Partial<Record<AgentRole, string>> = {
  researchManager: '리서치 매니저',
  portfolioManager: '포트폴리오 매니저',
  biasDesk: '방향 필터 데스크',
  reflection: '회고 담당'
};

const ROLE_DUTY: Record<string, string> = {
  technical: '다중 시간대 추세·모멘텀·변동성·지지저항을 분석해 리서치 팀에 보고한다.',
  derivatives: '펀딩비·미결제약정·롱숏 비율·테이커 흐름·호가로 포지셔닝을 분석해 보고한다.',
  news: '최근 48시간 암호화폐·거시 헤드라인을 분석해 보고한다.',
  sentiment: '공포·탐욕 지수, 군중 포지셔닝, 헤드라인 논조로 시장 심리를 판단해 보고한다.',
  bull: '토론에서 롱 포지션을 옹호한다.',
  bear: '토론에서 숏 또는 롱 회피를 옹호한다.',
  researchManager: '강세/약세 토론을 판정하고 투자 계획과 등급을 정한다.',
  trader: '투자 계획을 진입가·손절가·목표가·규모로 구체화한다.',
  aggressive: '리스크 토론에서 수익 기회를 밀어붙인다.',
  conservative: '리스크 토론에서 자본 보호를 우선한다.',
  neutral: '리스크 토론에서 양쪽을 저울질한다.',
  portfolioManager: '최종 등급과 주문용 JSON을 낸다.',
  biasDesk: '스캘핑이 15~60분 동안 진입할 방향(롱만/숏만/양방향/진입 금지)을 정한다.',
  reflection: '종료된 거래를 돌아보고 다음 결정에 쓸 교훈을 쓴다.'
};

const VOTE_KO: Record<string, string> = {
  Bullish: '강세', Bearish: '약세', Neutral: '중립',
  LONG: '롱', SHORT: '숏', HOLD: '관망', CLOSE: '청산',
  LONG_ONLY: '롱만', SHORT_ONLY: '숏만', BOTH: '양방향', NO_TRADE: '진입 금지'
};

export function voteKo(v: string | null | undefined): string {
  if (!v) return '표기 없음';
  return VOTE_KO[v] ?? v;
}

function isTeamRole(r: string): r is TeamRole {
  return r in PERSONAS;
}

/** Korean name of an agent: "기술적 분석가 — 추세추종 차티스트", "기술적 분석 팀 팀장", "리서치 매니저". */
export function agentTitle(ref: Pick<AgentRef, 'role' | 'persona' | 'lead'>): string {
  const { role, persona, lead } = ref;
  if (lead) return role === 'trader' ? '헤드 트레이더' : isTeamRole(role) ? `${TEAM_LABEL[role]} 팀장` : `${role} 팀장`;
  if (persona && isTeamRole(role) && PERSONAS[role][persona]) return `${ROLE_KO[role]} — ${PERSONAS[role][persona].name}`;
  return ROLE_TITLE[role] ?? (isTeamRole(role) ? ROLE_KO[role] : role);
}

/** Back from a folder name to the agent. */
export function parseAgentId(id: string): AgentRef | null {
  if (!ID_RE.test(id)) return null;
  const [role, suffix] = id.split('-') as [AgentRole, string | undefined];
  if (!suffix) return { id, role };
  if (suffix === 'lead') return { id, role, lead: true };
  return { id, role, persona: suffix };
}

function kst(ts: number): string {
  const d = new Date(ts + 9 * 3_600_000).toISOString();
  return `${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)}`;
}

function stampOf(ts: number): string {
  return new Date(ts + 9 * 3_600_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
}

/** The text under a "## …" marker, without HTML comments. */
export function userSection(markdown: string, marker: string): string {
  const i = markdown.indexOf(marker);
  if (i < 0) return '';
  return markdown.slice(i + marker.length).replace(/<!--[\s\S]*?-->/g, '').trim();
}

function firstLines(text: string, max = 220): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*|`>-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function pct(x: number, dp = 2): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(dp)}%`;
}

export class AgentProjects {
  private readonly cache = new Map<string, AgentRecord>();

  constructor(readonly root: string, private readonly now: () => number = Date.now) {
    mkdirSync(root, { recursive: true });
    this.ensureCommon();
  }

  folder(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`잘못된 에이전트 id: ${id}`);
    return path.join(this.root, id);
  }

  /** Where the agent's hidden session runs for one symbol (inside its folder, so its CLAUDE.md applies). */
  static sessionDir(workdir: string, key: string): string {
    return path.join(workdir, '.sessions', key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'default');
  }

  private ensureCommon(): void {
    const f = path.join(this.root, 'CLAUDE.md');
    if (existsSync(f)) return;
    writeFileSync(f, [
      '# 트레이딩 데스크 — 에이전트 공통 지침',
      '',
      '이 폴더에는 Munder Difflin 트레이딩 데스크의 에이전트마다 하나씩 프로젝트 폴더가 있습니다.',
      '모든 에이전트는 호출될 때마다 이 파일과 자기 폴더의 CLAUDE.md를 지침으로 읽습니다.',
      '',
      '- 리스크 한도, 손절 의무, 주문 형식 같은 데스크의 규칙은 코드가 강제하므로 이 파일로 바꿀 수 없습니다.',
      '- 각 에이전트의 성적은 그 폴더의 `scorecard.md`에 있습니다.',
      '',
      COMMON_MARKER,
      '',
      '<!-- 모든 에이전트에게 적용할 지침을 이 아래에 쓰세요. 예: "FOMC 발표 전후 6시간은 확신도를 낮춰라" -->',
      ''
    ].join('\n'), 'utf8');
  }

  /** Create the agent's folder and CLAUDE.md if missing. Never overwrites what the user wrote. */
  ensure(ref: AgentRef): string {
    const dir = this.folder(ref.id);
    mkdirSync(path.join(dir, 'outputs'), { recursive: true });
    const f = path.join(dir, 'CLAUDE.md');
    if (!existsSync(f)) {
      const title = agentTitle(ref);
      const persona = ref.persona && isTeamRole(ref.role) ? PERSONAS[ref.role][ref.persona] : undefined;
      const team = isTeamRole(ref.role) ? TEAM_LABEL[ref.role] : ref.role === 'researchManager' ? '리서치 팀' : '트레이딩 데스크';
      writeFileSync(f, [
        `# ${title}`,
        '',
        `Munder Difflin 트레이딩 데스크의 에이전트 "${title}"의 프로젝트 폴더입니다.`,
        '',
        `- 소속: ${team}`,
        `- 임무: ${ref.lead ? (ref.role === 'trader' ? '트레이더들의 제안과 투표를 하나의 실행 계획으로 종합한다.' : '팀원 보고서와 투표를 하나의 팀 보고서로 종합한다.') : ROLE_DUTY[ref.role] ?? ''}`,
        ...(persona ? [`- 전문 관점: ${persona.focus}`] : []),
        '',
        '데스크가 이 에이전트를 부를 때마다 이 파일(과 상위 폴더의 공통 지침)을 읽습니다.',
        '아래 "내 지침"에 쓴 내용은 다음 호출부터 반영됩니다. 리스크 한도·손절 의무·주문 형식은 코드가 강제하므로 바뀌지 않습니다.',
        '',
        '폴더 구성: `scorecard.md` 성적표 · `record.json` 판단 기록 · `lessons.md` 참여한 거래의 결과 · `outputs/` 최근 보고서',
        '',
        AGENT_MARKER,
        '',
        '<!-- 이 에이전트만의 지침을 이 아래에 쓰세요. 예: "펀딩비가 0.05%를 넘으면 롱 확신도를 낮춰라" -->',
        ''
      ].join('\n'), 'utf8');
    }
    return dir;
  }

  private read(file: string): string {
    try { return existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
  }

  /** The user-written parts (desk-wide + this agent), for providers that do not read CLAUDE.md themselves. */
  instructionsForApi(id: string): string {
    const common = userSection(this.read(path.join(this.root, 'CLAUDE.md')), COMMON_MARKER);
    const own = userSection(this.read(path.join(this.folder(id), 'CLAUDE.md')), AGENT_MARKER);
    const parts: string[] = [];
    if (common) parts.push(`[데스크 공통 지침 — 사용자 작성]\n${common.slice(0, 3000)}`);
    if (own) parts.push(`[이 에이전트의 지침 — 사용자 작성]\n${own.slice(0, 3000)}`);
    return parts.join('\n\n');
  }

  customized(id: string): boolean {
    return !!userSection(this.read(path.join(this.folder(id), 'CLAUDE.md')), AGENT_MARKER);
  }

  // ─── record ────────────────────────────────────────────────────────────

  private load(id: string): AgentRecord {
    const hit = this.cache.get(id);
    if (hit) return hit;
    let rec: AgentRecord = { version: 1, id, opinions: [] };
    try {
      const raw = this.read(path.join(this.folder(id), 'record.json'));
      if (raw) {
        const j = JSON.parse(raw) as Partial<AgentRecord>;
        if (Array.isArray(j.opinions)) rec = { version: 1, id, opinions: j.opinions.filter((o) => o && typeof o.ts === 'number') };
      }
    } catch { /* corrupt file: start a fresh record */ }
    this.cache.set(id, rec);
    return rec;
  }

  private save(ref: Pick<AgentRef, 'id' | 'role' | 'persona' | 'lead'>, rec: AgentRecord): void {
    const dir = this.folder(rec.id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'record.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 1), 'utf8');
    renameSync(`${file}.tmp`, file);
    writeFileSync(path.join(dir, 'scorecard.md'), this.scorecard(ref, rec), 'utf8');
  }

  recordOpinion(ref: AgentRef, o: Omit<Opinion, 'id'>): Opinion {
    this.ensure(ref);
    const rec = this.load(ref.id);
    const op: Opinion = { ...o, id: `${o.ts.toString(36)}-${o.symbol}-${rec.opinions.length.toString(36)}` };
    rec.opinions.push(op);
    if (rec.opinions.length > MAX_OPINIONS) rec.opinions.splice(0, rec.opinions.length - MAX_OPINIONS);
    this.save(ref, rec);
    return op;
  }

  /** Directional calls whose horizon has passed and that were not checked yet. */
  due(now = this.now()): Array<{ id: string; opinion: Opinion }> {
    const out: Array<{ id: string; opinion: Opinion }> = [];
    for (const id of this.ids()) {
      for (const o of this.load(id).opinions) {
        if (o.scoredAt === undefined && voteDirection(o.vote) !== 0 && o.price > 0 && o.ts + o.horizonMs <= now) out.push({ id, opinion: o });
      }
    }
    return out.sort((a, b) => a.opinion.ts - b.opinion.ts);
  }

  score(id: string, opinionId: string, priceAfter: number): Opinion | null {
    const rec = this.load(id);
    const o = rec.opinions.find((x) => x.id === opinionId);
    if (!o || !(priceAfter > 0)) return null;
    const dir = voteDirection(o.vote);
    o.scoredAt = this.now();
    o.priceAfter = priceAfter;
    o.movePct = ((priceAfter - o.price) / o.price) * 100;
    o.hit = dir !== 0 && Math.sign(o.movePct) === dir;
    const ref = parseAgentId(id) ?? { id, role: 'technical' as AgentRole };
    this.save(ref, rec);
    return o;
  }

  stats(id: string, before?: number): { opinions: number; scored: number; hits: number; hitRate: number | null; avgEdgeBps: number | null; pending: number; last?: Opinion } {
    // `before`: only calls whose outcome was known by then (a replay must not see later results).
    const ops = this.load(id).opinions.filter((o) => before === undefined || o.ts + o.horizonMs <= before);
    const scored = ops.filter((o) => o.scoredAt !== undefined && o.movePct !== undefined && voteDirection(o.vote) !== 0);
    const hits = scored.filter((o) => o.hit).length;
    const edges = scored.map((o) => (o.movePct ?? 0) * voteDirection(o.vote) * 100);
    return {
      opinions: ops.length,
      scored: scored.length,
      hits,
      hitRate: scored.length ? hits / scored.length : null,
      avgEdgeBps: edges.length ? edges.reduce((a, b) => a + b, 0) / edges.length : null,
      pending: ops.filter((o) => o.scoredAt === undefined && voteDirection(o.vote) !== 0).length,
      last: ops[ops.length - 1]
    };
  }

  private outcome(o: Opinion): string {
    if (voteDirection(o.vote) === 0) return '채점 안 함(방향 없음)';
    if (o.scoredAt === undefined || o.movePct === undefined) return '채점 대기';
    return `${Math.round(o.horizonMs / 3_600_000)}시간 뒤 ${pct(o.movePct)} ${o.hit ? '✓' : '✗'}`;
  }

  private scorecard(ref: Pick<AgentRef, 'role' | 'persona' | 'lead'>, rec: AgentRecord): string {
    const s = this.stats(rec.id);
    const rows = rec.opinions.slice(-30).reverse().map((o) =>
      `| ${kst(o.ts)}${o.replay ? ' (리플레이)' : ''} | ${o.symbol} | ${voteKo(o.vote)} | ${o.confidence !== null ? o.confidence.toFixed(2) : '-'} | ${o.price} | ${this.outcome(o)} |`);
    const replays = rec.opinions.filter((o) => o.replay).length;
    return [
      `# ${agentTitle(ref)} — 성적표`,
      '',
      `- 기록된 판단: ${s.opinions}건(과거 리플레이 훈련 ${replays}건 포함) · 채점된 방향 판단: ${s.scored}건 · 채점 대기: ${s.pending}건`,
      `- 적중률: ${s.hitRate !== null ? `${(s.hitRate * 100).toFixed(0)}% (${s.hits}/${s.scored})` : '아직 없음'}`,
      `- 판단 방향 평균 변동: ${s.avgEdgeBps !== null ? pct(s.avgEdgeBps / 100) : '아직 없음'}`,
      '',
      '채점 방법: 강세·롱·롱만 판단은 가격이 올랐으면, 약세·숏·숏만 판단은 내렸으면 적중입니다.',
      '에이전트 알고리즘 판단은 4시간 뒤, 스캘핑 방향 필터 판단은 1시간 뒤 가격으로 봅니다. 중립·관망은 채점하지 않습니다.',
      '',
      '## 최근 판단 (KST)',
      '',
      '| 시각 | 종목 | 판단 | 확신도 | 당시 가격 | 결과 |',
      '|---|---|---|---|---|---|',
      ...rows,
      ''
    ].join('\n');
  }

  // ─── outputs & lessons ─────────────────────────────────────────────────

  writeOutput(ref: AgentRef, symbol: TradingSymbol, ts: number, runId: string, text: string, vote: string | null): void {
    const dir = path.join(this.ensure(ref), 'outputs', symbol);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${stampOf(ts)}_${runId}.md`), [
      `# ${agentTitle(ref)} — ${symbol} ${kst(ts)} KST`,
      ...(vote ? [`판단: **${voteKo(vote)}**`, ''] : ['']),
      text,
      ''
    ].join('\n'), 'utf8');
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - MAX_OUTPUTS_PER_SYMBOL))) unlinkSync(path.join(dir, f));
    } catch { /* best-effort */ }
  }

  addLesson(ref: AgentRef, line: string): void {
    const f = path.join(this.ensure(ref), 'lessons.md');
    if (!existsSync(f)) writeFileSync(f, `# ${agentTitle(ref)} — 참여한 거래의 결과\n\n`, 'utf8');
    appendFileSync(f, `- ${line.replace(/\s+/g, ' ').trim()}\n`, 'utf8');
    try {
      const lines = readFileSync(f, 'utf8').split('\n');
      const items = lines.filter((l) => l.startsWith('- '));
      if (items.length > MAX_LESSON_LINES * 1.25) {
        writeFileSync(f, [...lines.filter((l) => !l.startsWith('- ')).filter(Boolean), '', ...items.slice(-MAX_LESSON_LINES), ''].join('\n'), 'utf8');
      }
    } catch { /* best-effort */ }
  }

  private lessons(id: string, n: number): string[] {
    return this.read(path.join(this.folder(id), 'lessons.md')).split('\n').filter((l) => l.startsWith('- ')).slice(-n);
  }

  /**
   * What the agent is reminded of before it answers: its own hit rate, its
   * last calls on this symbol and how they turned out, and the trades it voted
   * on. Empty until it has a record.
   */
  memoryBlock(id: string, symbol: TradingSymbol, opts: { before?: number; relative?: boolean } = {}): string {
    const s = this.stats(id, opts.before);
    // A replay must not see calls (or trade lessons) from after the moment it replays.
    const recent = this.load(id).opinions
      .filter((o) => o.symbol === symbol && o.vote && (opts.before === undefined || o.ts + o.horizonMs <= opts.before))
      .slice(-5);
    const lessons = opts.before === undefined ? this.lessons(id, 3) : [];
    if (!recent.length && !lessons.length) return '';
    const lines = ['[너의 지난 판단 기록 — 너의 프로젝트 폴더에서]'];
    if (s.scored) {
      lines.push(`- 채점된 방향 판단 ${s.scored}건 중 ${s.hits}건 적중(${((s.hitRate ?? 0) * 100).toFixed(0)}%), 판단 방향 평균 변동 ${pct((s.avgEdgeBps ?? 0) / 100)}`);
    }
    if (recent.length) {
      lines.push(`- 최근 ${symbol} 판단:`);
      for (const o of recent) {
        const when = opts.relative && opts.before !== undefined ? `${Math.max(1, Math.round((opts.before - o.ts) / 3_600_000))}시간 전` : `${kst(o.ts)} KST`;
        lines.push(`  - ${when} ${voteKo(o.vote)}${o.confidence !== null ? `(${o.confidence.toFixed(2)})` : ''} → ${this.outcome(o)}`);
      }
    }
    if (lessons.length) {
      lines.push('- 네가 투표한 거래의 결과:');
      for (const l of lessons) lines.push(`  ${l}`);
    }
    lines.push('이 기록으로 과신이나 같은 실수의 반복을 경계하라. 단, 판단의 근거는 지금 주어진 자료다.');
    return lines.join('\n');
  }

  // ─── listing ───────────────────────────────────────────────────────────

  ids(): string[] {
    try {
      return readdirSync(this.root).filter((d) => ID_RE.test(d) && statSync(path.join(this.root, d)).isDirectory());
    } catch { return []; }
  }

  private outputCount(id: string): number {
    const dir = path.join(this.folder(id), 'outputs');
    try {
      return readdirSync(dir).reduce((n, sym) => {
        try { return n + readdirSync(path.join(dir, sym)).filter((f) => f.endsWith('.md')).length; } catch { return n; }
      }, 0);
    } catch { return 0; }
  }

  list(active: ReadonlySet<string>): AgentProjectView[] {
    const ids = new Set([...this.ids(), ...active]);
    const out: AgentProjectView[] = [];
    for (const id of ids) {
      const ref = parseAgentId(id);
      if (!ref) continue;
      const s = this.stats(id);
      out.push({
        id, role: ref.role, ...(ref.persona ? { persona: ref.persona } : {}), ...(ref.lead ? { lead: true } : {}),
        folder: this.folder(id),
        opinions: s.opinions, outputs: this.outputCount(id), scored: s.scored, hits: s.hits, hitRate: s.hitRate, avgEdgeBps: s.avgEdgeBps, pending: s.pending,
        ...(s.last ? { lastAt: s.last.ts, lastVote: s.last.vote ?? undefined, lastSymbol: s.last.symbol } : {}),
        customized: this.customized(id),
        active: active.has(id)
      });
    }
    return out;
  }
}

export { firstLines as opinionSummary };
