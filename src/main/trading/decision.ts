/**
 * Reading machine labels back out of model text.
 *
 * Models drift: a JSON block may be fenced or bare, numbers arrive as "64,250"
 * or "$64250", confidence as 72 instead of 0.72. These parsers are tolerant on
 * input and strict on output — whatever comes back is a well-typed value or a
 * safe default (HOLD), never a half-parsed order.
 */
import {
  RATINGS, TRADE_ACTIONS, type BiasDirection, type FinalDecision, type Rating, type TradeAction
} from '../../shared/trading';

/** Every JSON object in the text: fenced ```json blocks first, then bare balanced objects. */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch { /* not JSON */ }
  };
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) tryParse(m[1].trim());
  if (out.length) return out;
  // Bare objects: scan for balanced braces (strings respected).
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { tryParse(text.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out;
}

/** The last JSON object that has any of the given keys. */
export function lastJsonWith(text: string, keys: string[]): Record<string, unknown> | null {
  const objs = extractJsonObjects(text);
  for (let i = objs.length - 1; i >= 0; i--) {
    if (keys.some((k) => k in objs[i])) return objs[i];
  }
  return null;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[,\s$₩]|USDT|usdt/g, '');
  if (!cleaned || cleaned === 'null') return null;
  const n = Number(cleaned.replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

const RATING_ALIASES: Array<[RegExp, Rating]> = [
  [/^strong\s*buy$/i, 'Buy'],
  [/^buy$/i, 'Buy'],
  [/^overweight$/i, 'Overweight'],
  [/^hold$/i, 'Hold'],
  [/^neutral$/i, 'Hold'],
  [/^underweight$/i, 'Underweight'],
  [/^sell$/i, 'Sell'],
  [/^strong\s*sell$/i, 'Sell'],
  [/^(강력\s*)?매수$/, 'Buy'],
  [/^비중\s*확대$/, 'Overweight'],
  [/^(관망|보유|중립)$/, 'Hold'],
  [/^비중\s*축소$/, 'Underweight'],
  [/^(강력\s*)?매도$/, 'Sell']
];

export function normalizeRating(v: unknown): Rating | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[*_`"'.]/g, '').trim();
  if ((RATINGS as readonly string[]).includes(t)) return t as Rating;
  for (const [re, r] of RATING_ALIASES) if (re.test(t)) return r;
  return null;
}

/**
 * The rating from a "**Rating**: X" line — the FIRST such line, as the format
 * asks for it on the first line. A thesis that later quotes "not a Sell" must
 * not override it (the TradingAgents #1435 lesson).
 */
export function parseRating(text: string): Rating | null {
  const re = /^\s*[-*]*\s*\**\s*(?:Rating|등급)\s*\**\s*[:：]\s*\**\s*([A-Za-z가-힣 ]+?)\s*\**\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const r = normalizeRating(m[1]);
    if (r) return r;
  }
  return null;
}

export function normalizeAction(v: unknown): TradeAction | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[*_`"'.]/g, '').trim().toUpperCase();
  if ((TRADE_ACTIONS as readonly string[]).includes(t)) return t as TradeAction;
  if (t === 'BUY') return 'LONG';
  if (t === 'SELL') return 'SHORT';
  if (t === 'EXIT' || t === 'FLAT') return 'CLOSE';
  if (t === 'WAIT' || t === 'NONE') return 'HOLD';
  const ko: Record<string, TradeAction> = { '롱': 'LONG', '숏': 'SHORT', '관망': 'HOLD', '청산': 'CLOSE' };
  return ko[v.trim()] ?? null;
}

/** The trader's "FINAL TRANSACTION PROPOSAL: **X**" line (last one wins). */
export function parseTraderAction(text: string): TradeAction | null {
  const re = /FINAL TRANSACTION PROPOSAL\s*[:：]\s*\**\s*([A-Za-z가-힣]+)/gi;
  let m: RegExpExecArray | null;
  let found: TradeAction | null = null;
  while ((m = re.exec(text)) !== null) found = normalizeAction(m[1]) ?? found;
  if (found) return found;
  const a = /^\s*[-*]*\s*\**\s*Action\s*\**\s*[:：]\s*\**\s*([A-Za-z가-힣]+)/im.exec(text);
  return a ? normalizeAction(a[1]) : null;
}

export function ratingToAction(r: Rating): TradeAction {
  if (r === 'Buy' || r === 'Overweight') return 'LONG';
  if (r === 'Sell' || r === 'Underweight') return 'SHORT';
  return 'HOLD';
}

function firstParagraph(text: string, max = 400): string {
  const body = text.replace(/```[\s\S]*?```/g, '').trim();
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !/^\**\s*(Rating|등급)\b/i.test(l.replace(/^[-*\s]+/, '')));
  return lines.join(' ').slice(0, max);
}

/** The portfolio manager's final decision, with safe defaults for anything missing. */
export function parseFinalDecision(text: string): { decision: FinalDecision; parsedJson: boolean } {
  const j = lastJsonWith(text, ['action', 'rating', 'stopLoss']);
  const textRating = parseRating(text);
  const rating = normalizeRating(j?.rating) ?? textRating ?? 'Hold';
  const action = normalizeAction(j?.action) ?? ratingToAction(rating);
  const entryType = typeof j?.entryType === 'string' && j.entryType.toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
  let confidence = toNumber(j?.confidence);
  if (confidence !== null && confidence > 1 && confidence <= 100) confidence /= 100;
  const pos = (v: unknown) => {
    const n = toNumber(v);
    return n !== null && n > 0 ? n : null;
  };
  const summary = typeof j?.summary === 'string' && j.summary.trim() ? j.summary.trim().slice(0, 1200) : firstParagraph(text);
  return {
    parsedJson: !!j,
    decision: {
      rating,
      action,
      entryType,
      entryPrice: pos(j?.entryPrice),
      stopLoss: pos(j?.stopLoss),
      takeProfit: pos(j?.takeProfit),
      leverage: pos(j?.leverage),
      riskPct: pos(j?.riskPct),
      confidence: confidence !== null ? Math.min(1, Math.max(0, confidence)) : 0.5,
      horizonHours: pos(j?.horizonHours),
      summary
    }
  };
}

const BIASES: readonly BiasDirection[] = ['LONG_ONLY', 'SHORT_ONLY', 'BOTH', 'NO_TRADE'];

export function parseBias(text: string): { bias: BiasDirection; confidence: number; note: string } | null {
  const j = lastJsonWith(text, ['bias']);
  if (!j) return null;
  const raw = typeof j.bias === 'string' ? j.bias.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
  const bias = (BIASES as readonly string[]).includes(raw) ? (raw as BiasDirection) : null;
  if (!bias) return null;
  let confidence = toNumber(j.confidence) ?? 0.5;
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  const note = typeof j.note === 'string' ? j.note.trim().slice(0, 300) : '';
  return { bias, confidence: Math.min(1, Math.max(0, confidence)), note };
}
