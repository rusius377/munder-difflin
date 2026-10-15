"""Optional Telegram notifications (fills, closes with lessons, parameter promotions, risk pauses)."""

from __future__ import annotations

import logging
import threading

import requests

from ..config import NotifySettings

log = logging.getLogger(__name__)


class Notifier:
    def __init__(self, settings: NotifySettings) -> None:
        self.s = settings

    @property
    def enabled(self) -> bool:
        return bool(self.s.telegram_bot_token and self.s.telegram_chat_id)

    def send(self, text: str) -> None:
        if not self.enabled:
            return

        def _go() -> None:
            try:
                requests.post(f"https://api.telegram.org/bot{self.s.telegram_bot_token}/sendMessage",
                              json={"chat_id": self.s.telegram_chat_id, "text": text[:3900]}, timeout=10)
            except Exception as exc:  # pragma: no cover - network
                log.debug("telegram send failed: %s", exc)

        threading.Thread(target=_go, daemon=True).start()
