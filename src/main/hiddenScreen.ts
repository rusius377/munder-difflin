// Pure helpers for the hidden Claude Code runner (no node-pty), so they can be tested.

/**
 * What the TUI showed that looks like a reason (an API error, a plan or usage
 * limit, a login prompt), from the raw PTY stream. Claude Code prints some of
 * these on screen without writing an answer to the transcript, so without this
 * the caller only learns "no assistant response".
 */
const REASON = /(api error|\berror:|usage limit|limit reached|limit will reset|not available (with|on|for)|invalid api key|please run \/login|not logged in|overloaded|quota|rate limit|credit balance|model\b.{0,40}(not found|not supported|does not exist|unavailable|not available))/i;

export function screenHint(raw: string): string | null {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ')        // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '\n')                 // CSI (cursor moves split lines)
    .replace(/\x1b[@-_]/g, ' ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '\n');
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.replace(/[│╭╮╰╯─┃━]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 8 || seen.has(t) || /\bTip:/i.test(t)) continue;
    if (REASON.test(t)) {
      seen.add(t);
      hits.push(t.slice(0, 200));
    }
  }
  return hits.length ? hits.slice(-3).join(' | ') : null;
}
