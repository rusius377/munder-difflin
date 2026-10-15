"""Optional LLM client used to let the committee argue in natural language.

Supports any OpenAI-compatible chat endpoint (OpenAI, OpenRouter, Groq, Ollama,
vLLM, LM Studio…) and the Anthropic Messages API, all through ``requests`` so no
SDK is required. Failures never break the desk: callers fall back to the
rule-based report.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import requests

from ..config import LLMSettings

log = logging.getLogger(__name__)

_DEFAULT_BASE = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "ollama": "http://localhost:11434/v1",
    "anthropic": "https://api.anthropic.com",
}


class LLMClient:
    def __init__(self, settings: LLMSettings, session: Any | None = None) -> None:
        self.s = settings
        self.session = session or requests.Session()
        self.calls = 0
        self.failures = 0

    @property
    def enabled(self) -> bool:
        if self.s.provider == "none":
            return False
        if self.s.provider in ("ollama", "openai_compatible"):
            return True
        return bool(self.s.api_key)

    def _base(self) -> str:
        return (self.s.base_url or _DEFAULT_BASE.get(self.s.provider, "")).rstrip("/")

    def complete(self, system: str, user: str, *, deep: bool = False, json_mode: bool = True) -> str | None:
        if not self.enabled:
            return None
        model = self.s.deep_model if deep else self.s.quick_model
        self.calls += 1
        try:
            if self.s.provider == "anthropic":
                return self._anthropic(system, user, model)
            return self._openai_compatible(system, user, model, json_mode)
        except Exception as exc:
            self.failures += 1
            log.warning("LLM call failed (%s %s): %s", self.s.provider, model, exc)
            return None

    def _openai_compatible(self, system: str, user: str, model: str, json_mode: bool) -> str:
        headers = {"Content-Type": "application/json"}
        if self.s.api_key:
            headers["Authorization"] = f"Bearer {self.s.api_key}"
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": self.s.temperature,
            "max_tokens": self.s.max_tokens,
        }
        if json_mode and self.s.provider in ("openai", "openrouter", "groq"):
            body["response_format"] = {"type": "json_object"}
        r = self.session.post(f"{self._base()}/chat/completions", headers=headers, json=body, timeout=self.s.timeout_s)
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"]

    def _anthropic(self, system: str, user: str, model: str) -> str:
        headers = {"x-api-key": self.s.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
        body = {"model": model, "max_tokens": self.s.max_tokens, "temperature": self.s.temperature,
                "system": system, "messages": [{"role": "user", "content": user}]}
        r = self.session.post(f"{self._base()}/v1/messages", headers=headers, json=body, timeout=self.s.timeout_s)
        r.raise_for_status()
        data = r.json()
        return "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")


def extract_json(text: str | None) -> dict | None:
    """Lenient JSON extraction from an LLM answer (handles code fences and prose)."""
    if not text:
        return None
    candidates = []
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        candidates.append(fence.group(1))
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start:end + 1])
    candidates.append(text)
    for c in candidates:
        try:
            obj = json.loads(c)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None
