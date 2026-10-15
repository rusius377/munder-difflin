"""Lesson memory — the desk's version of TradingAgents' ``FinancialSituationMemory``.

Every closed trade leaves a reflection: the situation (mode, symbol, setup,
regime, key evidence), what the committee expected, what actually happened and
the lesson. Before a new decision the graph retrieves the most similar past
situations (token-overlap similarity with a small BM25-style weighting; no
embedding service needed) and hands the lessons to the analysts, researchers
and risk team as context.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

_TOKEN = re.compile(r"[a-zA-Z가-힣0-9_]+")


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN.findall(text or "") if len(t) > 1]


@dataclass
class Lesson:
    ts: int
    mode: str
    symbol: str
    situation: str
    outcome: str
    lesson: str
    r_multiple: float = 0.0
    won: bool = False
    tags: dict = field(default_factory=dict)


class LessonMemory:
    def __init__(self, path: str | Path | None = None, max_items: int = 5000) -> None:
        self.path = Path(path) if path else None
        self.max_items = max_items
        self.items: list[Lesson] = []
        if self.path and self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    self.items.append(Lesson(**json.loads(line)))
                except Exception:
                    continue
        self._df: Counter[str] = Counter()
        for it in self.items:
            self._df.update(set(tokenize(it.situation + " " + it.lesson)))

    def add(self, lesson: Lesson) -> None:
        self.items.append(lesson)
        self._df.update(set(tokenize(lesson.situation + " " + lesson.lesson)))
        if len(self.items) > self.max_items:
            self.items = self.items[-self.max_items:]
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(asdict(lesson), ensure_ascii=False) + "\n")

    def retrieve(self, situation: str, *, mode: str | None = None, symbol: str | None = None, k: int = 3) -> list[Lesson]:
        if not self.items:
            return []
        q = Counter(tokenize(situation))
        n = len(self.items)
        scored: list[tuple[float, Lesson]] = []
        now = time.time() * 1000
        for it in self.items:
            if mode and it.mode != mode:
                continue
            doc = Counter(tokenize(it.situation + " " + it.lesson))
            s = 0.0
            for tok, qf in q.items():
                if tok in doc:
                    idf = math.log(1 + n / (1 + self._df.get(tok, 0)))
                    s += idf * (1 + math.log(1 + doc[tok]))
            if s <= 0:
                continue
            if symbol and it.symbol == symbol:
                s *= 1.3
            age_days = max(0.0, (now - it.ts) / 86_400_000)
            s *= 1.0 / (1.0 + age_days / 60.0)        # slow recency decay
            s *= 1.0 + 0.3 * min(2.0, abs(it.r_multiple))   # bigger outcomes teach more
            scored.append((s, it))
        scored.sort(key=lambda x: -x[0])
        return [it for _, it in scored[:k]]

    def lessons_for(self, situation: str, **kw) -> list[str]:
        return [f"{'승' if it.won else '패'}({it.r_multiple:+.1f}R) {it.lesson}" for it in self.retrieve(situation, **kw)]

    def stats(self) -> dict:
        wins = sum(1 for it in self.items if it.won)
        return {"lessons": len(self.items), "wins": wins, "losses": len(self.items) - wins}
