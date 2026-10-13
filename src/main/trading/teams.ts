/**
 * Staffed teams: several agents per role, and how their opinions become one.
 *
 * TradingAgents has one agent per role. Here every team can seat several
 * agents, each with a different specialty (a "persona"), and the desk merges
 * their opinions in one of two ways:
 *
 *   - a LEAD merges free text — the analyst team lead per analyst role and the
 *     head trader read every member's report plus the code's vote tally and
 *     write the one report the next stage reads;
 *   - CODE tallies votes — the portfolio committee and the scalping bias panel
 *     vote independently (no member sees another's vote), and the tally below
 *     decides under the configured consensus rule. An order never depends on a
 *     model's reading of other models' votes.
 *
 * Debates (bull/bear researchers, risk debaters) simply seat more speakers:
 * each speaks in turn and sees the whole transcript; the research manager and
 * the portfolio committee judge it as before.
 */
import { instrumentContext, LANGUAGE_RULE, NO_EXTERNAL_TOOLS, TRADER_OUTPUT_SPEC, traderConstraints, type DeskContext } from './prompts';
import { toNumber } from './decision';
import {
  TEAM_PERSONA_KEYS, type AnalystKey, type BiasDirection, type CommitteeView, type ConsensusRule,
  type FinalDecision, type Rating, type TeamRole, type TradeAction
} from '../../shared/trading';

export interface Persona {
  /** Korean title the agent is addressed by. */
  name: string;
  /** Korean: what this seat looks at first. */
  focus: string;
}

export const PERSONAS: Record<TeamRole, Record<string, Persona>> = {
  technical: {
    trend: { name: '추세추종 차티스트', focus: '상위 시간대(4시간·일봉) 추세 정렬, 이동평균 배열과 기울기, MACD로 본 추세의 지속·전환 신호를 가장 중시한다.' },
    reversion: { name: '오실레이터·평균회귀 전문가', focus: 'RSI·볼린저 밴드·이동평균 괴리로 본 과열과 과매도, 되돌림 가능성, 다이버전스를 가장 중시한다.' },
    structure: { name: '가격구조·변동성 전문가', focus: '스윙 고점·저점, 지지/저항, ATR과 밴드폭으로 본 변동성 수축·확장, 돌파·이탈 구간과 무효화 가격을 가장 중시한다.' }
  },
  derivatives: {
    funding: { name: '펀딩·베이시스 분석가', focus: '펀딩비의 수준과 추세, 연환산 보유 비용(캐리), 베이시스로 본 레버리지 수요를 가장 중시한다.' },
    positioning: { name: '포지셔닝·청산 분석가', focus: '미결제약정과 가격의 조합, 전체 계정과 상위 트레이더의 롱/숏 비율 차이, 스퀴즈·청산 연쇄 위험을 가장 중시한다.' },
    flow: { name: '오더플로우 분석가', focus: '테이커 매수/매도 비율, 호가 잔량 불균형, 스프레드로 본 단기 체결 흐름과 지금 공격적인 쪽이 누구인지를 가장 중시한다.' }
  },
  news: {
    crypto: { name: '크립토 전문 기자', focus: '해당 코인 고유 이슈(ETF 자금 흐름, 네트워크 업그레이드, 거래소·해킹 사고, 대형 보유자 움직임)를 가장 중시한다.' },
    macro: { name: '거시 이코노미스트', focus: '연준·금리·물가, 달러, 주식 등 위험자산 심리, 지정학처럼 시장 전반을 움직이는 거시 이슈를 가장 중시한다.' },
    event: { name: '규제·이벤트 리스크 분석가', focus: '규제·소송·정책 발표와 예정된 이벤트가 만드는 변동성 위험, 그리고 헤드라인의 사실과 추측 구분을 가장 중시한다.' }
  },
  sentiment: {
    contrarian: { name: '역발상 심리 분석가', focus: '공포·탐욕이 극단일 때 군중 반대편에 설 근거가 있는지, 역발상 신호가 지금 유효한지를 가장 중시한다.' },
    momentum: { name: '모멘텀 심리 분석가', focus: '심리가 개선되는 중인지 악화되는 중인지, 그 변화의 방향과 속도가 가격 추세를 뒷받침하는지를 가장 중시한다.' },
    crowd: { name: '군중 포지셔닝 분석가', focus: '롱/숏 비율과 펀딩비로 드러난 실제 포지셔닝과 헤드라인 논조 사이의 괴리를 가장 중시한다.' }
  },
  bull: {
    momentum: { name: '모멘텀 강세론자', focus: '추세·모멘텀·돌파 가능성 같은 가격 근거로 롱을 옹호한다.' },
    structural: { name: '수급·포지셔닝 강세론자', focus: '숏 과밀에 따른 숏 스퀴즈 가능성, 현물·ETF 수요, 우호적인 파생 데이터로 롱을 옹호한다.' },
    catalyst: { name: '촉매·거시 강세론자', focus: '긍정적 뉴스 촉매, 거시 순풍, 심리 회복으로 롱을 옹호한다.' }
  },
  bear: {
    momentum: { name: '추세 약화 약세론자', focus: '저항 구간, 모멘텀 둔화, 다이버전스 같은 가격 근거로 숏 또는 롱 회피를 옹호한다.' },
    structural: { name: '레버리지·청산 약세론자', focus: '롱 과밀, 높은 펀딩비, 레버리지 과열에 따른 롱 스퀴즈(청산 연쇄) 위험으로 숏 또는 롱 회피를 옹호한다.' },
    catalyst: { name: '이벤트·거시 약세론자', focus: '거시 역풍, 규제·이벤트 위험, 부정적 헤드라인으로 숏 또는 롱 회피를 옹호한다.' }
  },
  trader: {
    swing: { name: '스윙 트레이더', focus: '수 시간~수 일의 추세를 따라가며, 구조적 무효화 수준 바깥에 손절을 두고 큰 목표를 노린다.' },
    breakout: { name: '돌파 트레이더', focus: '변동성 수축 뒤의 돌파·이탈을 노리며, 돌파가 확인되기 전에는 서두르지 않는다.' },
    reversion: { name: '되돌림 트레이더', focus: '지지·저항 근처의 지정가 진입을 선호하고, 짧은 손절과 현실적인 목표를 둔다.' },
    quant: { name: '퀀트 트레이더', focus: 'ATR 기반 손절 거리, 손익비, 승률을 가정한 기대값 계산을 최우선으로 방향과 규모를 정한다.' },
    flow: { name: '파생 흐름 트레이더', focus: '펀딩비·미결제약정·테이커 흐름이 가리키는 단기 쏠림과 청산 구간으로 진입 타이밍을 잡는다.' }
  },
  aggressive: {
    opportunity: { name: '기회 포착형', focus: '놓치는 기회의 비용과 기대 수익의 크기를 강조한다.' },
    momentum: { name: '추세 추격형', focus: '추세와 모멘텀이 강할 때 규모와 레버리지를 키우는 쪽을 옹호한다.' }
  },
  conservative: {
    preservation: { name: '자본 보존형', focus: '최대 손실, 청산가와 손절의 거리, 일일 손실 한도를 최우선으로 본다.' },
    tail: { name: '꼬리 위험형', focus: '갭·급변동·이벤트·펀딩 비용처럼 드물지만 큰 손실을 내는 위험을 파고든다.' }
  },
  neutral: {
    balance: { name: '균형 조정형', focus: '규모·레버리지·진입 방식에서 양측의 절충안을 찾는다.' },
    scenario: { name: '시나리오 분석형', focus: '기본·강세·약세 시나리오와 각각의 대략적 확률로 기대값을 따진다.' }
  },
  portfolioManager: {
    cio: { name: '최고투자책임자(CIO)', focus: '모든 팀의 논거를 균형 있게 저울질해 가장 설득력 있는 큰 그림을 고른다.' },
    risk: { name: '리스크 책임자', focus: '손절 거리, 청산 위험, 일일 손실 한도, 기존 포지션과의 겹침을 가장 엄격하게 본다.' },
    quant: { name: '퀀트 포트폴리오 매니저', focus: '손익비, 확률, 기대값처럼 숫자로 확인되는 우위만 인정한다.' },
    macro: { name: '매크로 포트폴리오 매니저', focus: '거시 환경과 이벤트 일정, 시장 레짐(추세장/횡보장)에 결정이 맞는지를 본다.' },
    execution: { name: '실행 담당 포트폴리오 매니저', focus: '진입 방식과 가격 수준이 실제로 체결 가능한지, 슬리피지·펀딩 비용을 고려한 실행 품질을 본다.' }
  },
  biasDesk: {
    trend: { name: '추세 판정관', focus: '진입·추세 시간대의 이동평균 정렬과 모멘텀을 가장 중시한다.' },
    flow: { name: '흐름 판정관', focus: '테이커 흐름, 호가 불균형, 미결제약정 변화를 가장 중시한다.' },
    risk: { name: '리스크 판정관', focus: '스퀴즈·급변동·이벤트 위험을 가장 중시하며, 위험이 크면 진입 금지를 주저하지 않는다.' },
    sentiment: { name: '심리 판정관', focus: '펀딩비·롱숏 비율·공포탐욕으로 본 군중 쏠림과 그 반대 방향의 위험을 가장 중시한다.' },
    structure: { name: '구조 판정관', focus: '가까운 지지·저항과 변동성 구간을 가장 중시하며, 벽 바로 앞에서 그 벽 쪽으로 들어가는 진입을 경계한다.' }
  }
};

const TEAM_LABEL: Record<TeamRole, string> = {
  technical: '기술적 분석 팀',
  derivatives: '파생상품 분석 팀',
  news: '뉴스 분석 팀',
  sentiment: '심리 분석 팀',
  bull: '강세 연구원 진영',
  bear: '약세 연구원 진영',
  trader: '트레이딩 팀',
  aggressive: '공격적 리스크 분석가 그룹',
  conservative: '보수적 리스크 분석가 그룹',
  neutral: '중립 리스크 분석가 그룹',
  portfolioManager: '포트폴리오 위원회',
  biasDesk: '방향 필터 패널'
};

export const ROLE_KO: Record<TeamRole, string> = {
  technical: '기술적 분석가',
  derivatives: '파생상품 분석가',
  news: '뉴스 분석가',
  sentiment: '심리 분석가',
  bull: '강세 연구원',
  bear: '약세 연구원',
  trader: '트레이더',
  aggressive: '공격적 리스크 분석가',
  conservative: '보수적 리스크 분석가',
  neutral: '중립 리스크 분석가',
  portfolioManager: '포트폴리오 위원',
  biasDesk: '방향 판정관'
};

export const CONSENSUS_KO: Record<ConsensusRule, string> = {
  majority: '과반',
  supermajority: '3분의 2 이상',
  unanimous: '만장일치'
};

export function personaKey(role: TeamRole, member: number): string {
  const keys = TEAM_PERSONA_KEYS[role];
  return keys[(member - 1) % keys.length];
}

export function personaOf(role: TeamRole, member: number): Persona {
  return PERSONAS[role][personaKey(role, member)];
}

/** "강세 연구원 2(수급·포지셔닝 강세론자)" — how a seat is named in transcripts and reports. */
export function speakerName(role: TeamRole, member: number): string {
  return `${ROLE_KO[role]} ${member}(${personaOf(role, member).name})`;
}

/**
 * The paragraph that turns a role prompt into seat `member` of `n`.
 * `closing` is the role-specific part (what happens to the member's output).
 */
export function memberRule(role: TeamRole, member: number, n: number, closing: string): string {
  const p = personaOf(role, member);
  return [
    `[팀 구성] ${TEAM_LABEL[role]}에는 ${n}명이 있고, 너는 그중 ${member}번 "${p.name}"이다.`,
    `너의 전문 관점: ${p.focus}`,
    '다른 구성원들은 다른 관점을 맡고 있으니 너의 관점에서 가장 잘 보이는 근거를 깊게 파고들어라. 단, 자료 전체와 모순되는 결론을 억지로 내지는 마라.',
    closing
  ].join(' ');
}

export function withMember(p: { system: string; prompt: string }, rule: string): { system: string; prompt: string } {
  return { system: `${p.system}\n\n${rule}`, prompt: p.prompt };
}

export const STANCE_SPEC = `**Stance**: Bullish | Bearish | Neutral 중 하나
**Confidence**: 0.0~1.0 사이 소수`;

export const ANALYST_MEMBER_CLOSING =
  `너의 보고서는 팀장이 다른 팀원 보고서와 종합한다. 보고서 맨 끝에 너의 결론을 다음 두 줄로 붙여라(라벨과 값은 영어 그대로):\n${STANCE_SPEC}`;

export const DEBATE_MEMBER_CLOSING =
  '토론 기록에는 같은 진영의 다른 구성원 발언도 있다. 같은 편의 논거를 되풀이하지 말고 너의 관점에서 새로운 근거를 더하며, 상대 진영의 가장 강한 주장에 직접 대응하라.';

export const TRADER_MEMBER_CLOSING =
  '너의 제안은 헤드 트레이더가 다른 트레이더들의 제안·투표와 종합한다. 다른 트레이더와 같아 보이려 하지 말고 너의 스타일대로 독립적으로 판단하라.';

export function committeeClosing(rule: ConsensusRule): string {
  return `위원들은 서로의 결정을 보지 않고 독립적으로 투표하며, 최종 결정은 코드가 합의 규칙(${CONSENSUS_KO[rule]})으로 집계한다. 응답한 위원 가운데 같은 행동을 고른 비율이 기준에 못 미치면 관망(HOLD)이 되고, 합의되면 진입가·손절가·목표가는 찬성 위원들의 중앙값을 쓰며 포지션 규모는 찬성 비율만큼 줄어든다. 그러니 다른 위원을 예상해 맞추지 말고 너 자신의 독립적인 판단을 정직하게 제시하라.`;
}

export function biasPanelClosing(rule: ConsensusRule): string {
  return `패널의 최종 방향은 코드가 집계한다: 롱과 숏 각각, 응답한 판정관 가운데 그 방향을 허용한 비율(롱만·양방향은 롱 허용, 숏만·양방향은 숏 허용)이 합의 기준(${CONSENSUS_KO[rule]})을 넘을 때만 그 방향이 열리고, 둘 다 닫히면 진입 금지가 된다. 너 자신의 독립적인 판단을 제시하라.`;
}

// ─── member outputs & tallies ────────────────────────────────────────────────

export type Stance = 'Bullish' | 'Bearish' | 'Neutral';

export interface MemberOutput {
  member: number;
  persona: string;
  name: string;
  text: string;
  /** Machine-read vote (Stance for analysts, TradeAction for traders); null when absent/failed. */
  vote: string | null;
  confidence: number | null;
  error?: string;
}

const STANCE_ALIASES: Record<string, Stance> = {
  bullish: 'Bullish', bearish: 'Bearish', neutral: 'Neutral', mixed: 'Neutral',
  '강세': 'Bullish', '약세': 'Bearish', '중립': 'Neutral', '혼조': 'Neutral'
};

/** The member's "**Stance**: X" / "**Confidence**: y" lines (the last ones win). */
export function parseStance(text: string): { stance: Stance | null; confidence: number | null } {
  let stance: Stance | null = null;
  const re = /\**\s*(?:Stance|입장)\s*\**\s*[:：]\s*\**\s*([A-Za-z가-힣]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) stance = STANCE_ALIASES[m[1].toLowerCase()] ?? stance;
  let confidence: number | null = null;
  const cre = /\**\s*(?:Confidence|확신도)\s*\**\s*[:：]\s*\**\s*([0-9]+(?:\.[0-9]+)?\s*%?)/gi;
  while ((m = cre.exec(text)) !== null) {
    let c = toNumber(m[1].replace(/\s/g, ''));
    if (c !== null && /%$/.test(m[1].trim())) c /= 100;
    else if (c !== null && c > 1 && c <= 100) c /= 100;
    if (c !== null && c >= 0 && c <= 1) confidence = c;
  }
  return { stance, confidence };
}

const STANCE_KO: Record<Stance, string> = { Bullish: '강세', Bearish: '약세', Neutral: '중립' };
const ACTION_KO: Record<TradeAction, string> = { LONG: '롱', SHORT: '숏', HOLD: '관망', CLOSE: '청산' };
const BIAS_KO: Record<BiasDirection, string> = { LONG_ONLY: '롱만', SHORT_ONLY: '숏만', BOTH: '양방향', NO_TRADE: '진입 금지' };

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** "강세 2 · 약세 0 · 중립 1 · 미응답 0 (평균 확신도 0.63)" */
export function stanceTally(members: MemberOutput[]): string {
  const c: Record<Stance, number> = { Bullish: 0, Bearish: 0, Neutral: 0 };
  let missing = 0;
  for (const m of members) {
    if (m.vote && m.vote in c) c[m.vote as Stance]++;
    else missing++;
  }
  const a = avg(members.map((m) => m.confidence).filter((x): x is number => x !== null));
  return `${(Object.keys(c) as Stance[]).map((k) => `${STANCE_KO[k]} ${c[k]}`).join(' · ')} · 미응답·형식 누락 ${missing}${a !== null ? ` (평균 확신도 ${a.toFixed(2)})` : ''}`;
}

export function actionTally(members: MemberOutput[]): string {
  const c: Record<TradeAction, number> = { LONG: 0, SHORT: 0, HOLD: 0, CLOSE: 0 };
  let missing = 0;
  for (const m of members) {
    if (m.vote && m.vote in c) c[m.vote as TradeAction]++;
    else missing++;
  }
  return `${(Object.keys(c) as TradeAction[]).map((k) => `${ACTION_KO[k]} ${c[k]}`).join(' · ')} · 미응답·형식 누락 ${missing}`;
}

/** The action most traders chose; null on a tie for first place or no votes. */
export function pluralityAction(members: MemberOutput[]): TradeAction | null {
  const c = new Map<string, number>();
  for (const m of members) if (m.vote) c.set(m.vote, (c.get(m.vote) ?? 0) + 1);
  const sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted[1] && sorted[1][1] === sorted[0][1])) return null;
  return sorted[0][0] as TradeAction;
}

function membersBlock(members: MemberOutput[], voteLabel: (m: MemberOutput) => string): string {
  return members.map((m) => {
    const head = `### ${m.member}번 — ${m.name} (${voteLabel(m)})`;
    return m.error ? `${head}\n(응답 실패: ${m.error})` : `${head}\n${m.text}`;
  }).join('\n\n---\n\n');
}

export function stanceLabel(m: MemberOutput): string {
  const s = m.vote && m.vote in STANCE_KO ? STANCE_KO[m.vote as Stance] : '결론 표기 없음';
  return m.confidence !== null ? `${s}, 확신도 ${m.confidence.toFixed(2)}` : s;
}

export function actionLabel(m: MemberOutput): string {
  return m.vote && m.vote in ACTION_KO ? ACTION_KO[m.vote as TradeAction] : '행동 표기 없음';
}

// ─── lead prompts ────────────────────────────────────────────────────────────

/** The data an analyst role works from (the lead re-reads it to check the members). */
export function analystData(ctx: DeskContext, key: AnalystKey): string {
  const s = ctx.snapshot;
  switch (key) {
    case 'technical': return `${s.verified}\n\n${s.technical}`;
    case 'derivatives': return `${s.verified}\n\n${s.derivatives}`;
    case 'news': return s.news;
    case 'sentiment': return s.sentiment;
  }
}

const LEAD_FORMAT: Partial<Record<AnalystKey, string>> = {
  sentiment: '보고서 첫 줄은 정확히 "**Sentiment**: <구간> (<점수>/10, 확신도 <높음|보통|낮음>)" 형식으로 써라. 구간은 강한 강세 / 약한 강세 / 중립 / 혼조 / 약한 약세 / 강한 약세 중 하나다.'
};

export function analystLeadPrompt(ctx: DeskContext, key: AnalystKey, members: MemberOutput[]): { system: string; prompt: string } {
  const n = members.length;
  return {
    system: [
      `너는 암호화폐 선물 트레이딩 회사의 ${TEAM_LABEL[key]} 팀장이다. 팀원 ${n}명이 서로 다른 전문 관점에서 같은 자료를 분석했다. 너는 이들의 보고서를 하나의 팀 보고서로 종합해 리서치 팀(강세/약세 연구원)에 넘긴다. 거래 결정은 다른 에이전트가 내린다.`,
      NO_EXTERNAL_TOOLS,
      LANGUAGE_RULE
    ].join('\n\n'),
    prompt: [
      instrumentContext(ctx),
      `원자료(수치 확인용):\n${analystData(ctx, key)}`,
      `팀원 보고서:\n\n${membersBlock(members, stanceLabel)}`,
      `팀 투표(코드 집계): ${stanceTally(members)}`,
      [
        '종합 방법:',
        '1. 팀원들이 공통으로 확인한 사실과 결론을 먼저 정리하라.',
        '2. 의견이 갈린 지점은 관점별 근거를 나란히 놓고, 원자료에 비춰 어느 쪽 근거가 더 강한지 판정하라.',
        '3. 원자료와 어긋나는 수치나 주장은 바로잡거나 버려라.',
        '4. 투표 결과는 참고하되 머릿수가 아니라 근거의 질로 판단하라. 팀 결론이 다수 의견과 다르면 그 이유를 밝혀라.',
        '5. 소수 의견 가운데 위험 신호는 버리지 말고 "주의할 점"으로 남겨라.',
        LEAD_FORMAT[key] ?? '',
        '보고서는 상세하되 트레이더가 바로 쓸 수 있게 쓰고, 마지막에 핵심 내용을 정리한 마크다운 표를 붙여라.',
        `맨 끝에는 팀의 결론을 다음 두 줄로 붙여라(라벨과 값은 영어 그대로):\n${STANCE_SPEC}`
      ].filter(Boolean).join('\n')
    ].join('\n\n')
  };
}

/** Used when the lead call fails: the members' reports, unmerged, under the tally. */
export function fallbackAnalystMerge(key: AnalystKey, members: MemberOutput[]): string {
  const ok = members.filter((m) => !m.error && m.text.trim());
  return [
    `**${TEAM_LABEL[key]} 종합 실패 — 팀원 보고서를 그대로 이어 붙였습니다.** 팀 투표: ${stanceTally(members)}`,
    membersBlock(ok, stanceLabel)
  ].join('\n\n');
}

export function headTraderPrompt(ctx: DeskContext, investmentPlan: string, technicalReport: string, members: MemberOutput[]): { system: string; prompt: string } {
  const n = members.length;
  return {
    system: `너는 선물 트레이딩 데스크의 헤드 트레이더다. 서로 다른 스타일의 트레이더 ${n}명이 같은 투자 계획에 대해 낸 거래 제안을 하나의 실행 계획으로 종합한다. 진입가·손절가·목표가는 퍼센트나 범위가 아니라 USDT 기준의 절대 가격(예: 64250.5)으로 써라. ${NO_EXTERNAL_TOOLS} ${LANGUAGE_RULE}`,
    prompt: [
      `${ctx.symbol}에 대한 리서치 팀의 투자 계획과 트레이더들의 제안이다. ${instrumentContext(ctx)}`,
      ctx.snapshot.verified,
      technicalReport.trim() ? `기술적 분석 보고서:\n${technicalReport}` : '',
      `현재 포트폴리오:\n${ctx.portfolio}`,
      traderConstraints(ctx.constraints),
      `투자 계획:\n${investmentPlan}`,
      `트레이더 제안:\n\n${membersBlock(members, actionLabel)}`,
      `트레이더 투표(코드 집계): ${actionTally(members)}`,
      [
        '종합 방법:',
        '1. 방향은 투표 결과를 기본으로 하되, 다수 의견의 근거가 투자 계획이나 가격 구조와 맞지 않으면 이유를 밝히고 조정하라. 의견이 팽팽하면 규모를 줄이거나 HOLD를 고려하라.',
        '2. 가격 수준은 같은 방향 제안들 가운데 근거가 가장 탄탄한 것을 고르거나 절충하라. 손절은 무효화 수준 바깥에 둬라.',
        '3. 소수 의견의 리스크 지적은 손절·규모·레버리지에 반영하라.',
        '4. 어느 제안을 채택했고 어느 제안을 왜 기각했는지 근거 섹션에 짧게 밝혀라.'
      ].join('\n'),
      TRADER_OUTPUT_SPEC
    ].filter(Boolean).join('\n\n')
  };
}

/** Used when the head trader fails: the plurality's first proposal, or HOLD on a split. */
export function fallbackTraderMerge(members: MemberOutput[]): string {
  const ok = members.filter((m) => !m.error && m.text.trim());
  const top = pluralityAction(ok);
  const pick = top ? ok.find((m) => m.vote === top) : undefined;
  const head = `(헤드 트레이더 종합 실패 — 트레이더 투표: ${actionTally(members)})`;
  if (pick) return `${pick.text}\n\n${head} 다수 의견인 ${pick.member}번 ${pick.name}의 제안을 그대로 사용합니다.`;
  return `**Action**: HOLD\n\n${head} 트레이더 의견이 갈려 관망을 제안합니다.\n\nFINAL TRANSACTION PROPOSAL: **HOLD**`;
}

// ─── code tallies ────────────────────────────────────────────────────────────

/** Does `k` of `m` answering members satisfy the rule? */
export function meetsConsensus(rule: ConsensusRule, k: number, m: number): boolean {
  if (m <= 0 || k <= 0) return false;
  if (rule === 'unanimous') return k === m;
  if (rule === 'supermajority') return k * 3 >= m * 2;
  return k * 2 > m;
}

export function quorumOf(seats: number): number {
  return Math.floor(seats / 2) + 1;
}

const RATING_SCORE: Record<Rating, number> = { Buy: 2, Overweight: 1, Hold: 0, Underweight: -1, Sell: -2 };

export interface CommitteeSeat {
  member: number;
  persona: string;
  /** Null when the member failed to answer. */
  decision: FinalDecision | null;
}

/**
 * The portfolio committee's call, from independent votes.
 *
 *   1. A quorum (more than half the seats) must have answered.
 *   2. The action with the most votes (LONG/SHORT/CLOSE/HOLD) wins; a tie for
 *      first place is HOLD.
 *   3. LONG/SHORT/CLOSE stands only if its voters meet the consensus rule among
 *      the members who answered; otherwise HOLD.
 *   4. For an entry, prices come from the agreeing members: median stop,
 *      median target, LIMIT only if most of them asked for it (median limit
 *      price), floor of the median leverage, median confidence. Risk is the
 *      median risk (or the desk's per-trade cap), capped at that cap FIRST and
 *      then scaled by the agreeing share, so a 2-of-3 call always trades two
 *      thirds of the size a unanimous one would.
 *
 * Everything the risk engine checks afterwards (stop side, R:R, confidence,
 * leverage caps) still applies to the result.
 */
export function aggregateCommittee(seats: CommitteeSeat[], rule: ConsensusRule, maxRiskPct: number): { decision: FinalDecision; view: CommitteeView } {
  const n = seats.length;
  const responded = seats.filter((s): s is CommitteeSeat & { decision: FinalDecision } => s.decision !== null);
  const m = responded.length;
  const quorum = quorumOf(n);
  if (m < quorum) throw new Error(`포트폴리오 위원회 정족수 미달 — ${n}명 중 ${m}명 응답 (최소 ${quorum}명)`);

  const counts: Record<TradeAction, number> = { LONG: 0, SHORT: 0, CLOSE: 0, HOLD: 0 };
  for (const s of responded) counts[s.decision.action]++;
  const ranked = (Object.entries(counts) as Array<[TradeAction, number]>).sort((a, b) => b[1] - a[1]);
  const tie = ranked[1][1] === ranked[0][1];
  const top: TradeAction = tie ? 'HOLD' : ranked[0][0];
  const topVotes = tie ? counts.HOLD : ranked[0][1];
  const directional = top !== 'HOLD';
  const reached = directional && meetsConsensus(rule, topVotes, m);
  const outcome: TradeAction = reached ? top : 'HOLD';
  const tally = (Object.keys(ACTION_KO) as TradeAction[]).map((k) => `${ACTION_KO[k]} ${counts[k]}`).join(' · ');

  const votes = seats.map((s) => ({
    member: s.member,
    persona: s.persona,
    vote: s.decision?.action ?? null,
    rating: s.decision?.rating ?? null,
    confidence: s.decision?.confidence ?? null,
    stopLoss: s.decision?.stopLoss ?? null,
    takeProfit: s.decision?.takeProfit ?? null
  }));
  const head = `위원회 ${n}명(응답 ${m}명) · ${tally}`;
  const nums = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null && Number.isFinite(x));

  if (outcome === 'LONG' || outcome === 'SHORT') {
    const agreeing = responded.filter((s) => s.decision.action === outcome);
    const k = agreeing.length;
    const scale = k / m;
    const sign = outcome === 'LONG' ? 1 : -1;
    const strength = avg(agreeing.map((s) => {
      const sc = RATING_SCORE[s.decision.rating] * sign;
      return sc > 0 ? sc : 1; // an action that disagrees with its own rating counts as the weak form
    })) ?? 1;
    const rating: Rating = strength > 1.5 ? (sign > 0 ? 'Buy' : 'Sell') : (sign > 0 ? 'Overweight' : 'Underweight');
    const planners = agreeing.filter((s) => s.decision.stopLoss !== null);
    const limits = planners.filter((s) => s.decision.entryType === 'LIMIT' && s.decision.entryPrice !== null);
    const useLimit = limits.length * 2 > planners.length;
    const stopLoss = median(nums(planners.map((s) => s.decision.stopLoss)));
    const lev = median(nums(agreeing.map((s) => s.decision.leverage)));
    // Cap before scaling: the risk engine's own cap would otherwise swallow the scale-down.
    const baseRisk = Math.min(median(nums(agreeing.map((s) => s.decision.riskPct))) ?? maxRiskPct, maxRiskPct);
    const rep = stopLoss === null
      ? agreeing[0]
      : [...planners].sort((a, b) => Math.abs((a.decision.stopLoss ?? 0) - stopLoss) - Math.abs((b.decision.stopLoss ?? 0) - stopLoss))[0];
    const note = `${head} → ${ACTION_KO[outcome]} 합의 ${k}/${m}, ${CONSENSUS_KO[rule]} 충족 · 규모 ${(scale * 100).toFixed(0)}%`;
    return {
      decision: {
        rating,
        action: outcome,
        entryType: useLimit ? 'LIMIT' : 'MARKET',
        entryPrice: useLimit ? median(nums(limits.map((s) => s.decision.entryPrice))) : null,
        stopLoss,
        takeProfit: median(nums(agreeing.map((s) => s.decision.takeProfit))),
        leverage: lev !== null ? Math.max(1, Math.floor(lev)) : null,
        riskPct: Math.round(baseRisk * scale * 1000) / 1000,
        confidence: median(agreeing.map((s) => s.decision.confidence)) ?? 0.5,
        horizonHours: median(nums(agreeing.map((s) => s.decision.horizonHours))),
        summary: `${note}. 대표 의견 — ${rep.member}번 ${personaOf('portfolioManager', rep.member).name}: ${rep.decision.summary}`.slice(0, 1200)
      },
      view: { kind: 'portfolio', rule, seats: n, responded: m, votes, outcome, agree: k, reached: true, sizeScale: scale, note }
    };
  }

  if (outcome === 'CLOSE') {
    const agreeing = responded.filter((s) => s.decision.action === 'CLOSE');
    const k = agreeing.length;
    const score = avg(agreeing.map((s) => RATING_SCORE[s.decision.rating])) ?? 0;
    const rating: Rating = score >= 1.5 ? 'Buy' : score >= 0.5 ? 'Overweight' : score > -0.5 ? 'Hold' : score > -1.5 ? 'Underweight' : 'Sell';
    const note = `${head} → 청산 합의 ${k}/${m}, ${CONSENSUS_KO[rule]} 충족`;
    return {
      decision: {
        rating, action: 'CLOSE', entryType: 'MARKET', entryPrice: null, stopLoss: null, takeProfit: null, leverage: null, riskPct: null,
        confidence: median(agreeing.map((s) => s.decision.confidence)) ?? 0.5,
        horizonHours: null,
        summary: `${note}. 대표 의견 — ${agreeing[0].member}번 ${personaOf('portfolioManager', agreeing[0].member).name}: ${agreeing[0].decision.summary}`.slice(0, 1200)
      },
      view: { kind: 'portfolio', rule, seats: n, responded: m, votes, outcome, agree: k, reached: true, note }
    };
  }

  // HOLD — either the committee chose it outright, or no action reached the rule.
  const holders = responded.filter((s) => s.decision.action === 'HOLD');
  const holdChosen = !tie && !directional;
  const why = tie
    ? '최다 득표가 동률이라 관망'
    : holdChosen
      ? '관망이 최다 득표'
      : `${ACTION_KO[top]} ${topVotes}/${m}표로 합의 기준(${CONSENSUS_KO[rule]})에 못 미쳐 관망`;
  const note = `${head} → ${why}`;
  const rep = holders[0];
  return {
    decision: {
      rating: 'Hold', action: 'HOLD', entryType: 'MARKET', entryPrice: null, stopLoss: null, takeProfit: null, leverage: null, riskPct: null,
      confidence: median((holders.length ? holders : responded).map((s) => s.decision.confidence)) ?? 0.5,
      horizonHours: null,
      summary: (rep ? `${note}. 관망 의견 — ${rep.member}번 ${personaOf('portfolioManager', rep.member).name}: ${rep.decision.summary}` : note).slice(0, 1200)
    },
    view: { kind: 'portfolio', rule, seats: n, responded: m, votes, outcome: 'HOLD', agree: holders.length, reached: holdChosen, note }
  };
}

export interface BiasSeat {
  member: number;
  persona: string;
  result: { bias: BiasDirection; confidence: number; note: string } | null;
}

/**
 * The bias panel's direction by approval voting: long is open when enough
 * answering judges allow it (LONG_ONLY or BOTH), short likewise (SHORT_ONLY or
 * BOTH). Both open → BOTH, one → that side only, none → NO_TRADE.
 */
export function aggregateBias(seats: BiasSeat[], rule: ConsensusRule): { bias: { bias: BiasDirection; confidence: number; note: string }; view: CommitteeView } {
  const n = seats.length;
  const responded = seats.filter((s): s is BiasSeat & { result: NonNullable<BiasSeat['result']> } => s.result !== null);
  const m = responded.length;
  const quorum = quorumOf(n);
  if (m < quorum) throw new Error(`방향 필터 패널 정족수 미달 — ${n}명 중 ${m}명 응답 (최소 ${quorum}명)`);
  const allowsLong = responded.filter((s) => s.result.bias === 'LONG_ONLY' || s.result.bias === 'BOTH').length;
  const allowsShort = responded.filter((s) => s.result.bias === 'SHORT_ONLY' || s.result.bias === 'BOTH').length;
  const longOpen = meetsConsensus(rule, allowsLong, m);
  const shortOpen = meetsConsensus(rule, allowsShort, m);
  const outcome: BiasDirection = longOpen && shortOpen ? 'BOTH' : longOpen ? 'LONG_ONLY' : shortOpen ? 'SHORT_ONLY' : 'NO_TRADE';
  const same = responded.filter((s) => s.result.bias === outcome);
  const noTrade = responded.filter((s) => s.result.bias === 'NO_TRADE').length;
  const reached = outcome !== 'NO_TRADE' || meetsConsensus(rule, noTrade, m);
  const counts = (Object.keys(BIAS_KO) as BiasDirection[]).map((b) => `${BIAS_KO[b]} ${responded.filter((s) => s.result.bias === b).length}`).join(' · ');
  const why = reached ? '' : ' (어느 방향도 합의 기준에 못 미침)';
  const note = `패널 ${n}명(응답 ${m}명) · ${counts} · 롱 허용 ${allowsLong} · 숏 허용 ${allowsShort} → ${BIAS_KO[outcome]}${why}`;
  const rep = same[0];
  return {
    bias: {
      bias: outcome,
      confidence: avg((same.length ? same : responded).map((s) => s.result.confidence)) ?? 0.5,
      note: (rep && rep.result.note ? `${BIAS_KO[outcome]}${why} — ${rep.result.note}` : `${BIAS_KO[outcome]}${why} — ${counts}`).slice(0, 300)
    },
    view: {
      kind: 'bias', rule, seats: n, responded: m,
      votes: seats.map((s) => ({ member: s.member, persona: s.persona, vote: s.result?.bias ?? null, confidence: s.result?.confidence ?? null })),
      outcome, agree: same.length, reached, note
    }
  };
}

/** Committee minutes for the report (Korean markdown). */
export function committeeMinutes(view: CommitteeView, texts: Array<{ member: number; text: string; error?: string }>): string {
  const rows = view.votes.map((v) => {
    const p = personaOf(view.kind === 'portfolio' ? 'portfolioManager' : 'biasDesk', v.member).name;
    const vote = v.vote === null ? '미응답' : view.kind === 'portfolio' ? ACTION_KO[v.vote as TradeAction] ?? v.vote : BIAS_KO[v.vote as BiasDirection] ?? v.vote;
    const conf = v.confidence !== null ? v.confidence.toFixed(2) : '-';
    return view.kind === 'portfolio'
      ? `| ${v.member} | ${p} | ${v.rating ?? '-'} | ${vote} | ${conf} | ${v.stopLoss ?? '-'} | ${v.takeProfit ?? '-'} |`
      : `| ${v.member} | ${p} | ${vote} | ${conf} |`;
  });
  const table = view.kind === 'portfolio'
    ? ['| # | 위원 | 등급 | 행동 | 확신도 | 손절 | 익절 |', '|---|---|---|---|---|---|---|', ...rows]
    : ['| # | 판정관 | 방향 | 확신도 |', '|---|---|---|---|', ...rows];
  const parts = [
    `**합의 규칙**: ${CONSENSUS_KO[view.rule]} · 정족수 ${quorumOf(view.seats)}명`,
    `**집계 결과**: ${view.note}`,
    '',
    table.join('\n')
  ];
  for (const t of texts) {
    const p = personaOf(view.kind === 'portfolio' ? 'portfolioManager' : 'biasDesk', t.member).name;
    parts.push('', `#### ${t.member}번 — ${p}`, t.error ? `(응답 실패: ${t.error})` : t.text);
  }
  return parts.join('\n');
}
