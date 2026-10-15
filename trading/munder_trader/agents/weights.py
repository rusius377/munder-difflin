"""Learned reliability weights per (mode, agent).

After every closed trade the reflector grades each analyst: an agent whose
stance matched the trade direction earns credit when the trade won and loses
it when the trade lost (the inverse for agents that argued against the trade).
The Research Manager uses the resulting weights, so analysts that keep being
right carry more of the composite over time. Weights decay slowly towards 1.0 so
a cold streak is forgiven once the regime changes.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..util import clamp


class AgentWeights:
    def __init__(self, path: str | Path | None = None, prior: float = 4.0) -> None:
        self.path = Path(path) if path else None
        self.prior = prior
        self._stats: dict[str, dict[str, float]] = {}
        if self.path and self.path.exists():
            try:
                self._stats = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                self._stats = {}

    def key(self, mode: str, agent: str) -> str:
        return f"{mode}:{agent}"

    def weight(self, mode: str, agent: str) -> float:
        s = self._stats.get(self.key(mode, agent))
        if not s:
            return 1.0
        hits, misses = s.get("hits", 0.0), s.get("misses", 0.0)
        acc = (hits + self.prior * 0.5) / (hits + misses + self.prior)
        return clamp(0.5 + acc, 0.6, 1.5)

    def weights_for(self, mode: str, agents: list[str]) -> dict[str, float]:
        return {a: self.weight(mode, a) for a in agents}

    def update(self, mode: str, agent: str, *, stance_direction: int, trade_direction: int, won: bool, r_multiple: float = 0.0) -> None:
        if stance_direction == 0 or trade_direction == 0:
            return
        k = self.key(mode, agent)
        s = self._stats.setdefault(k, {"hits": 0.0, "misses": 0.0, "n": 0})
        agreed = stance_direction == trade_direction
        correct = (agreed and won) or ((not agreed) and (not won))
        gain = 1.0 + min(1.0, abs(r_multiple)) * 0.5
        if correct:
            s["hits"] += gain
        else:
            s["misses"] += gain
        s["n"] += 1
        self.save()

    def decay(self, factor: float = 0.98) -> None:
        for s in self._stats.values():
            s["hits"] *= factor
            s["misses"] *= factor
        self.save()

    def save(self) -> None:
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self._stats, indent=2), encoding="utf-8")

    def snapshot(self) -> dict[str, float]:
        return {k: round(self.weight(*k.split(":", 1)), 3) for k in self._stats}
