"""Tiny status HTTP server (stdlib only) — JSON endpoints plus a one-page dashboard.

Endpoints: ``/`` dashboard, ``/status``, ``/decisions?symbol=&mode=&limit=``,
``/trades``, ``/learning``, ``/events``, ``/equity``, ``/health``, ``/kill`` (POST,
creates the kill-switch file), ``/resume`` (POST, removes it).
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from ..util import to_json

log = logging.getLogger(__name__)

DASHBOARD = """<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Munder Trading Desk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--txt:#e6e6e6;--mut:#9aa3b2;--up:#3ddc84;--dn:#ff5c5c;--gold:#F4D35E;--maroon:#6E1423}
body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,"Noto Sans KR",sans-serif;background:var(--bg);color:var(--txt)}
header{padding:14px 20px;background:var(--maroon);color:var(--gold);display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
header h1{margin:0;font-size:18px} header span{color:#f4f1ea;font-size:13px}
main{padding:16px 20px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card h2{margin:0 0 8px;font-size:13px;color:var(--gold);text-transform:uppercase;letter-spacing:.06em}
.kv{display:grid;grid-template-columns:1fr auto;gap:4px 12px}.mut{color:var(--mut)}.up{color:var(--up)}.dn{color:var(--dn)}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:600}pre{white-space:pre-wrap;font-size:11.5px;background:#0b0d11;padding:8px;border-radius:6px;max-height:420px;overflow:auto}
details summary{cursor:pointer;color:var(--gold)}.wide{grid-column:1/-1}.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
button{background:var(--maroon);color:#fff;border:0;padding:6px 10px;border-radius:6px;cursor:pointer}
</style></head><body>
<header><h1>Munder Trading Desk</h1><span id="hdr">loading…</span><span style="margin-left:auto"><button onclick="act('kill')">KILL SWITCH</button> <button onclick="act('resume')">RESUME</button></span></header>
<main>
<div class="card"><h2>계좌</h2><div class="kv" id="acct"></div></div>
<div class="card"><h2>피드 / 학습 / 리스크</h2><div class="kv" id="sys"></div></div>
<div class="card wide"><h2>포지션</h2><table id="pos"></table></div>
<div class="card wide"><h2>데스크별 최근 판단 (스윙 = 원래 모드 · 스캘핑)</h2><div id="dec"></div></div>
<div class="card wide"><h2>최근 체결 트레이드</h2><table id="trades"></table></div>
<div class="card wide"><h2>학습 이벤트</h2><table id="learn"></table></div>
</main>
<script>
const f=(n,d=2)=>n==null?'-':Number(n).toLocaleString(undefined,{maximumFractionDigits:d});
const cls=v=>v>0?'up':v<0?'dn':'';
async function act(a){await fetch('/'+a,{method:'POST'});load();}
async function load(){
 try{
 const s=await (await fetch('/status')).json();
 document.getElementById('hdr').textContent=`${s.env} · ${s.broker} · cap ${s.max_leverage}x · llm ${s.llm} · ${s.ts}`;
 document.getElementById('acct').innerHTML=[['자산',f(s.equity)],['가용',f(s.available)],['사용 마진',f(s.used_margin)],['일일 손익',`<span class="${cls(s.daily_pnl)}">${f(s.daily_pnl)}</span>`],['고점 자산',f(s.peak_equity)],['총 트레이드',s.journal.trades],['승률',f(100*s.journal.win_rate,1)+'%'],['누적 손익',`<span class="${cls(s.journal.pnl)}">${f(s.journal.pnl)}</span>`]].map(([k,v])=>`<span class="mut">${k}</span><span>${v}</span>`).join('');
 const fe=s.feed||{},le=s.learning||{},rk=s.risk||{};
 document.getElementById('sys').innerHTML=[['피드',`${fe.mode||'-'} ${fe.connected?'🟢':'🔴'} msgs ${fe.messages||0}`],['북 동기화',fe.books_synced?Object.entries(fe.books_synced).filter(e=>e[1]).length+'/'+Object.keys(fe.books_synced).length:'-'],['학습',`${le.enabled?'on':'off'} ${le.running?'(실행중)':''} ${le.last_run||''}`],['교훈 메모리',`${(s.memory||{}).lessons||0}`],['리스크',rk.kill_switch?'<span class="dn">KILL SWITCH</span>':rk.paused?`<span class="dn">일시정지: ${rk.pause_reason}</span>`:'<span class="up">정상</span>'],['에러',s.errors]].map(([k,v])=>`<span class="mut">${k}</span><span>${v}</span>`).join('');
 const P=Object.values(s.positions||{});
 document.getElementById('pos').innerHTML='<tr><th>심볼</th><th>데스크</th><th>방향</th><th>수량</th><th>진입</th><th>현재</th><th>손절</th><th>레버</th><th>미실현</th><th>R</th></tr>'+(P.length?P.map(p=>`<tr><td>${p.symbol}</td><td>${p.mode}</td><td>${p.side}</td><td>${f(p.qty,4)}</td><td>${f(p.entry_price,6)}</td><td>${f(p.mark,6)}</td><td>${f(p.stop,6)}</td><td>${p.leverage}x</td><td class="${cls(p.unrealized)}">${f(p.unrealized)}</td><td class="${cls(p.r_multiple)}">${f(p.r_multiple,2)}</td></tr>`).join(''):'<tr><td colspan=10 class="mut">포지션 없음</td></tr>');
 const D=s.last_decisions||{};
 document.getElementById('dec').innerHTML=Object.keys(D).sort().map(sym=>`<div style="margin:6px 0"><b>${sym}</b> `+['swing','scalp'].map(m=>{const d=D[sym][m];if(!d)return `<span class="pill mut">${m}: -</span>`;const c=d.action==='Buy'?'up':d.action==='Sell'?'dn':'';return `<span class="pill"><span class="${c}">${m==='swing'?'스윙':'스캘핑'}: ${d.action}</span> (${d.rating}, 확신 ${f(d.conviction,2)}, 합의 ${f(100*d.agreement,0)}%${d.executed?', 실행':''}) ${d.ts}</span>`;}).join(' ')+['swing','scalp'].map(m=>{const d=D[sym][m];return d?`<details><summary>${m==='swing'?'스윙 근거/이유':'스캘핑 근거/이유'}</summary><pre>${d.explain.replace(/</g,'&lt;')}\n\n[실행 판단]\n${(d.reasons||[]).join('\n')}</pre></details>`:'';}).join('')+`</div>`).join('')||'<span class="mut">아직 판단 없음</span>';
 const T=await (await fetch('/trades?limit=30')).json();
 document.getElementById('trades').innerHTML='<tr><th>종료</th><th>심볼</th><th>데스크</th><th>방향</th><th>진입</th><th>청산</th><th>레버</th><th>손익</th><th>R</th><th>사유</th></tr>'+(T.length?T.map(t=>`<tr><td>${new Date(t.ts_close).toLocaleString()}</td><td>${t.symbol}</td><td>${t.mode}</td><td>${t.side}</td><td>${f(t.entry,6)}</td><td>${f(t.exit,6)}</td><td>${t.leverage}x</td><td class="${cls(t.pnl)}">${f(t.pnl)}</td><td class="${cls(t.r)}">${f(t.r,2)}</td><td>${t.reason}</td></tr>`).join(''):'<tr><td colspan=10 class="mut">아직 없음</td></tr>');
 const L=await (await fetch('/learning?limit=15')).json();
 document.getElementById('learn').innerHTML='<tr><th>시각</th><th>데스크</th><th>심볼</th><th>승격</th><th>사유</th></tr>'+(L.length?L.map(e=>`<tr><td>${new Date(e.ts).toLocaleString()}</td><td>${e.mode}</td><td>${e.symbol}</td><td>${e.promoted?'<span class="up">예</span>':'아니오'}</td><td>${e.reason}</td></tr>`).join(''):'<tr><td colspan=5 class="mut">아직 없음</td></tr>');
 }catch(e){document.getElementById('hdr').textContent='status unavailable: '+e;}
}
load();setInterval(load,5000);
</script></body></html>"""


class StatusServer:
    def __init__(self, engine: Any, host: str = "0.0.0.0", port: int = 8787) -> None:
        self.engine = engine
        self.host = host
        self.port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        engine = self.engine

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):  # quiet
                return

            def _send(self, code: int, body: str, ctype: str = "application/json; charset=utf-8") -> None:
                data = body.encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                try:
                    u = urlparse(self.path)
                    q = {k: v[0] for k, v in parse_qs(u.query).items()}
                    limit = int(q.get("limit", 20))
                    if u.path in ("/", "/index.html"):
                        return self._send(200, DASHBOARD, "text/html; charset=utf-8")
                    if u.path == "/status":
                        return self._send(200, to_json(engine.status()))
                    if u.path == "/health":
                        return self._send(200, to_json({"ok": True, "ts": engine.status()["ts"]}))
                    if u.path == "/decisions":
                        return self._send(200, to_json(engine.journal.recent_decisions(limit, q.get("symbol"), q.get("mode"), full=q.get("full") == "1")))
                    if u.path == "/trades":
                        return self._send(200, to_json(engine.journal.recent_trades(limit, q.get("symbol"))))
                    if u.path == "/learning":
                        return self._send(200, to_json(engine.journal.recent_learning(limit)))
                    if u.path == "/events":
                        return self._send(200, to_json(engine.journal.recent_events(limit)))
                    if u.path == "/equity":
                        return self._send(200, to_json(engine.journal.equity_curve(limit if limit > 20 else 2000)))
                    return self._send(404, json.dumps({"error": "not found"}))
                except Exception as exc:  # pragma: no cover
                    return self._send(500, json.dumps({"error": str(exc)}))

            def do_POST(self):
                u = urlparse(self.path)
                ks: Path = engine.risk.kill_switch
                if u.path == "/kill":
                    ks.parent.mkdir(parents=True, exist_ok=True)
                    ks.write_text("manual kill via status server\n")
                    engine.journal.event("kill_switch", "*", "activated via status server")
                    return self._send(200, json.dumps({"kill_switch": True}))
                if u.path == "/resume":
                    if ks.exists():
                        ks.unlink()
                    engine.journal.event("kill_switch", "*", "cleared via status server")
                    return self._send(200, json.dumps({"kill_switch": False}))
                return self._send(404, json.dumps({"error": "not found"}))

        self._server = ThreadingHTTPServer((self.host, self.port), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, name="status-server", daemon=True)
        self._thread.start()
        log.info("status server on http://%s:%d", self.host, self.port)

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
