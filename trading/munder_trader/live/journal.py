"""SQLite journal: every decision with its full reasoning, every plan, trade, equity point and learning event."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from ..util import now_ms, to_json

SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, symbol TEXT, mode TEXT, action TEXT, rating TEXT, direction INTEGER,
  conviction REAL, agreement REAL, approve INTEGER, price REAL, executed INTEGER DEFAULT 0, summary TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS ix_dec_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, symbol TEXT, mode TEXT, side TEXT, leverage INTEGER, qty REAL,
  notional REAL, margin REAL, risk_pct REAL, allowed INTEGER, verdict TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_open INTEGER, ts_close INTEGER, symbol TEXT, mode TEXT, side TEXT, qty REAL,
  entry REAL, exit REAL, leverage INTEGER, pnl REAL, r REAL, bars INTEGER, reason TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS ix_trades_close ON trades(ts_close);
CREATE TABLE IF NOT EXISTS equity (ts INTEGER PRIMARY KEY, equity REAL, balance REAL, used_margin REAL, positions INTEGER);
CREATE TABLE IF NOT EXISTS learning (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, mode TEXT, symbol TEXT, promoted INTEGER, reason TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, symbol TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
"""


class Journal:
    def __init__(self, path: str | Path = "state/journal.sqlite") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        with self._lock:
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    # ------------------------------------------------------------------ writes
    def decision(self, dec: dict[str, Any], *, executed: bool = False) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO decisions(ts,symbol,mode,action,rating,direction,conviction,agreement,approve,price,executed,summary,payload)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (dec.get("ts", now_ms()), dec["symbol"], dec["mode"], dec["action"], dec["rating"], dec["direction"],
                 dec["conviction"], dec["agreement"], int(bool(dec["approve"])), dec["price"], int(executed), dec.get("summary", ""),
                 to_json(dec)))
            self.conn.commit()
            return int(cur.lastrowid)

    def mark_executed(self, decision_id: int) -> None:
        with self._lock:
            self.conn.execute("UPDATE decisions SET executed=1 WHERE id=?", (decision_id,))
            self.conn.commit()

    def plan(self, plan: dict[str, Any], *, allowed: bool, verdict: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO plans(ts,symbol,mode,side,leverage,qty,notional,margin,risk_pct,allowed,verdict,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (now_ms(), plan["symbol"], plan["mode"], plan["side"], plan["leverage"], plan["total_qty"], plan["notional"],
                 plan["margin"], plan["risk_pct"], int(allowed), verdict, to_json(plan)))
            self.conn.commit()

    def trade(self, ct: Any) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO trades(ts_open,ts_close,symbol,mode,side,qty,entry,exit,leverage,pnl,r,bars,reason,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (ct.opened_ts, ct.closed_ts, ct.symbol, ct.mode, ct.side, ct.qty, ct.entry_price, ct.exit_price, ct.leverage,
                 ct.pnl, ct.r_multiple, ct.bars_held, ct.exit_reason, to_json({k: v for k, v in ct.__dict__.items() if k != "decision"})))
            self.conn.commit()

    def equity(self, equity: float, balance: float, used_margin: float, positions: int) -> None:
        with self._lock:
            self.conn.execute("INSERT OR REPLACE INTO equity(ts,equity,balance,used_margin,positions) VALUES(?,?,?,?,?)",
                              (now_ms(), equity, balance, used_margin, positions))
            self.conn.commit()

    def learning(self, ev: dict[str, Any]) -> None:
        with self._lock:
            self.conn.execute("INSERT INTO learning(ts,mode,symbol,promoted,reason,payload) VALUES(?,?,?,?,?,?)",
                              (ev["ts"], ev["mode"], ev["symbol"], int(bool(ev["promoted"])), ev["reason"], to_json(ev)))
            self.conn.commit()

    def event(self, kind: str, symbol: str, detail: str) -> None:
        with self._lock:
            self.conn.execute("INSERT INTO events(ts,kind,symbol,detail) VALUES(?,?,?,?)", (now_ms(), kind, symbol, detail))
            self.conn.commit()

    def set_kv(self, key: str, value: Any) -> None:
        with self._lock:
            self.conn.execute("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)", (key, to_json(value)))
            self.conn.commit()

    def get_kv(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    # ------------------------------------------------------------------ reads
    def recent_decisions(self, limit: int = 20, symbol: str | None = None, mode: str | None = None, full: bool = False) -> list[dict]:
        q = "SELECT id,ts,symbol,mode,action,rating,direction,conviction,agreement,approve,price,executed,summary,payload FROM decisions"
        cond, args = [], []
        if symbol:
            cond.append("symbol=?"); args.append(symbol.upper())
        if mode:
            cond.append("mode=?"); args.append(mode)
        if cond:
            q += " WHERE " + " AND ".join(cond)
        q += " ORDER BY ts DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self.conn.execute(q, args).fetchall()
        out = []
        for r in rows:
            d = {"id": r[0], "ts": r[1], "symbol": r[2], "mode": r[3], "action": r[4], "rating": r[5], "direction": r[6],
                 "conviction": r[7], "agreement": r[8], "approve": bool(r[9]), "price": r[10], "executed": bool(r[11]), "summary": r[12]}
            if full:
                try:
                    d["payload"] = json.loads(r[13])
                except Exception:
                    d["payload"] = None
            out.append(d)
        return out

    def recent_trades(self, limit: int = 50, symbol: str | None = None) -> list[dict]:
        q = "SELECT ts_open,ts_close,symbol,mode,side,qty,entry,exit,leverage,pnl,r,bars,reason FROM trades"
        args: list[Any] = []
        if symbol:
            q += " WHERE symbol=?"; args.append(symbol.upper())
        q += " ORDER BY ts_close DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self.conn.execute(q, args).fetchall()
        keys = ["ts_open", "ts_close", "symbol", "mode", "side", "qty", "entry", "exit", "leverage", "pnl", "r", "bars", "reason"]
        return [dict(zip(keys, r)) for r in rows]

    def trade_stats(self, mode: str | None = None, symbol: str | None = None, limit: int = 60) -> list[tuple[bool, float]]:
        q = "SELECT pnl, r FROM trades"
        cond, args = [], []
        if mode:
            cond.append("mode=?"); args.append(mode)
        if symbol:
            cond.append("symbol=?"); args.append(symbol.upper())
        if cond:
            q += " WHERE " + " AND ".join(cond)
        q += " ORDER BY ts_close DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self.conn.execute(q, args).fetchall()
        return [(pnl > 0, r) for pnl, r in reversed(rows)]

    def equity_curve(self, limit: int = 2000) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT ts,equity,balance,used_margin,positions FROM equity ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [{"ts": r[0], "equity": r[1], "balance": r[2], "used_margin": r[3], "positions": r[4]} for r in reversed(rows)]

    def recent_events(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT ts,kind,symbol,detail FROM events ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [{"ts": r[0], "kind": r[1], "symbol": r[2], "detail": r[3]} for r in rows]

    def recent_learning(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self.conn.execute("SELECT ts,mode,symbol,promoted,reason FROM learning ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [{"ts": r[0], "mode": r[1], "symbol": r[2], "promoted": bool(r[3]), "reason": r[4]} for r in rows]

    def summary(self) -> dict:
        with self._lock:
            n, pnl, wins = self.conn.execute("SELECT COUNT(*), COALESCE(SUM(pnl),0), COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) FROM trades").fetchone()
            by_mode = self.conn.execute("SELECT mode, COUNT(*), COALESCE(SUM(pnl),0), COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) FROM trades GROUP BY mode").fetchall()
        return {"trades": n, "pnl": pnl, "win_rate": (wins / n) if n else 0.0,
                "by_mode": {m: {"trades": c, "pnl": p, "win_rate": (w / c) if c else 0.0} for m, c, p, w in by_mode}}

    def close(self) -> None:
        with self._lock:
            self.conn.close()
