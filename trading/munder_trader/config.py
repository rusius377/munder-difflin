"""Desk settings.

Settings come from three layers, later layers win:

1. The defaults declared on the pydantic models below.
2. A YAML file (``config/settings.yaml`` by default, or ``MT_CONFIG``).
3. Environment variables prefixed with ``MT_`` (``MT_TRADING_ENV=testnet``,
   ``MT_RISK__DAILY_LOSS_LIMIT_PCT=3``) and the Binance / LLM keys.

Only one thing is fixed by the operator: the leverage ceiling (``max_leverage``,
100x by default). Everything else — leverage actually used per trade, sizing,
split entries, hold-or-take-profit, conviction weighting — is decided by the desk
at run time and tuned by the learning loop.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator

from .symbols import DEFAULT_SYMBOLS

TradingEnv = Literal["paper", "testnet", "live"]


class BinanceSettings(BaseModel):
    api_key: str = ""
    api_secret: str = ""
    recv_window_ms: int = 5000
    # Binance USDⓈ-M endpoints (production + testnet).
    rest_live: str = "https://fapi.binance.com"
    rest_testnet: str = "https://testnet.binancefuture.com"
    ws_live: str = "wss://fstream.binance.com"
    ws_testnet: str = "wss://stream.binancefuture.com"
    # When true (default) futures positions use isolated margin so a single trade
    # can never consume the whole wallet through cross-margin.
    isolated_margin: bool = True
    # Taker / maker fee assumptions for paper trading and backtests (VIP0).
    taker_fee: float = 0.0005
    maker_fee: float = 0.0002


class LLMSettings(BaseModel):
    """LLM backing for the agents. ``provider="none"`` keeps everything rule-based."""

    provider: Literal["none", "openai", "anthropic", "ollama", "openrouter", "groq", "openai_compatible"] = "none"
    api_key: str = ""
    base_url: str = ""
    quick_model: str = "gpt-4o-mini"
    deep_model: str = "gpt-4o"
    temperature: float = 0.2
    max_tokens: int = 1200
    timeout_s: float = 40.0
    # How far an LLM may move a rule-based conviction (0..1). The quant evidence is
    # always the anchor; the committee argues around it.
    max_adjustment: float = 0.35
    output_language: str = "ko"


class RiskSettings(BaseModel):
    """Guardrails. The desk chooses leverage/size itself inside these walls."""

    max_leverage: int = Field(100, ge=1, le=125)
    # Fraction of equity risked per trade at neutral conviction; conviction scales it.
    base_risk_per_trade_pct: float = 0.75
    max_risk_per_trade_pct: float = 2.5
    # Total margin (sum of isolated margins) may never exceed this share of equity.
    max_margin_fraction: float = 0.60
    max_concurrent_positions: int = 4
    daily_loss_limit_pct: float = 6.0
    max_drawdown_pause_pct: float = 15.0
    pause_minutes_after_limit: int = 240
    consecutive_loss_cut: int = 4
    # Liquidation price must be at least this many stop-distances beyond the stop.
    liquidation_buffer_multiple: float = 3.0
    # Funding above this (per 8h, absolute) discourages holding against the carry.
    funding_rate_warn: float = 0.0008
    kill_switch_file: str = "state/KILL_SWITCH"


class LearningSettings(BaseModel):
    enabled: bool = True
    relearn_interval_min: int = 180
    history_days: int = 120
    walk_forward_folds: int = 4
    train_fraction: float = 0.7
    population: int = 24
    generations: int = 8
    min_trades: int = 20
    # A candidate must beat the incumbent's out-of-sample score by this margin.
    promotion_margin: float = 0.03
    use_backtrader_confirmation: bool = True
    seed: int | None = None


class ModeSettings(BaseModel):
    enabled: bool = True
    # Share of risk budget this desk may use (both desks are normalised together).
    budget_share: float = 0.5


class ScalpSettings(ModeSettings):
    base_timeframe: str = "1m"
    context_timeframe: str = "5m"
    decision_interval_s: int = 60
    # Microstructure trigger: also re-evaluate between bars when the book moves hard.
    microstructure_trigger: bool = True
    book_depth_levels: int = 20
    tape_window_s: int = 30


class SwingSettings(ModeSettings):
    base_timeframe: str = "1h"
    context_timeframes: list[str] = Field(default_factory=lambda: ["4h", "1d"])
    decision_interval_s: int = 3600
    debate_rounds: int = 2
    risk_rounds: int = 1


class DataSettings(BaseModel):
    cache_dir: str = "data"
    use_nautilus: bool = False
    # Fallback REST polling cadence when websockets are unavailable.
    poll_interval_s: float = 2.0
    stream_depth_speed: Literal["100ms", "250ms", "500ms"] = "100ms"


class ServerSettings(BaseModel):
    enabled: bool = True
    host: str = "0.0.0.0"
    port: int = 8787


class NotifySettings(BaseModel):
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""


class Settings(BaseModel):
    trading_env: TradingEnv = "paper"
    symbols: list[str] = Field(default_factory=lambda: list(DEFAULT_SYMBOLS))
    paper_starting_balance: float = 10_000.0
    state_dir: str = "state"
    log_level: str = "INFO"
    binance: BinanceSettings = Field(default_factory=BinanceSettings)
    llm: LLMSettings = Field(default_factory=LLMSettings)
    risk: RiskSettings = Field(default_factory=RiskSettings)
    learning: LearningSettings = Field(default_factory=LearningSettings)
    swing: SwingSettings = Field(default_factory=SwingSettings)
    scalp: ScalpSettings = Field(default_factory=ScalpSettings)
    data: DataSettings = Field(default_factory=DataSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)
    notify: NotifySettings = Field(default_factory=NotifySettings)

    @field_validator("symbols")
    @classmethod
    def _upper(cls, v: list[str]) -> list[str]:
        out = []
        for s in v:
            s = s.strip().upper()
            if s and s not in out:
                out.append(s)
        if not out:
            raise ValueError("at least one symbol is required")
        return out

    # ---- helpers -----------------------------------------------------------------
    @property
    def is_live(self) -> bool:
        return self.trading_env == "live"

    @property
    def rest_base(self) -> str:
        return self.binance.rest_testnet if self.trading_env == "testnet" else self.binance.rest_live

    @property
    def ws_base(self) -> str:
        return self.binance.ws_testnet if self.trading_env == "testnet" else self.binance.ws_live

    def state_path(self, *parts: str) -> Path:
        p = Path(self.state_dir).joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p


# ----------------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------------

_ENV_PREFIX = "MT_"


def _set_nested(d: dict[str, Any], keys: list[str], value: Any) -> None:
    cur = d
    for k in keys[:-1]:
        cur = cur.setdefault(k, {})
        if not isinstance(cur, dict):
            return
    cur[keys[-1]] = value


def _coerce(value: str) -> Any:
    v = value.strip()
    low = v.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    if low in ("null", "none", ""):
        return None
    try:
        if "." in v or "e" in low:
            return float(v)
        return int(v)
    except ValueError:
        pass
    if "," in v:
        return [x.strip() for x in v.split(",") if x.strip()]
    return v


def _env_overrides(environ: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in environ.items():
        if not key.startswith(_ENV_PREFIX):
            continue
        path = key[len(_ENV_PREFIX):].lower().split("__")
        _set_nested(out, path, _coerce(value))
    # Convenience aliases that people already have in their shells.
    if environ.get("BINANCE_API_KEY"):
        _set_nested(out, ["binance", "api_key"], environ["BINANCE_API_KEY"])
    if environ.get("BINANCE_API_SECRET"):
        _set_nested(out, ["binance", "api_secret"], environ["BINANCE_API_SECRET"])
    for provider, var in (("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY"),
                          ("openrouter", "OPENROUTER_API_KEY"), ("groq", "GROQ_API_KEY")):
        if environ.get(var) and not out.get("llm", {}).get("api_key"):
            _set_nested(out, ["llm", "api_key"], environ[var])
            if not out.get("llm", {}).get("provider"):
                _set_nested(out, ["llm", "provider"], provider)
    return out


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def load_settings(config_path: str | os.PathLike | None = None, *, environ: dict[str, str] | None = None) -> Settings:
    """Build :class:`Settings` from YAML + environment."""
    environ = dict(os.environ if environ is None else environ)
    try:  # .env support is optional
        from dotenv import dotenv_values

        env_file = Path(environ.get("MT_ENV_FILE", ".env"))
        if env_file.exists():
            for k, v in dotenv_values(env_file).items():
                if v is not None and k not in environ:
                    environ[k] = v
    except Exception:  # pragma: no cover - dotenv missing or unreadable
        pass

    path = Path(config_path or environ.get("MT_CONFIG", "config/settings.yaml"))
    data: dict[str, Any] = {}
    if path.exists():
        with open(path, "r", encoding="utf-8") as fh:
            loaded = yaml.safe_load(fh) or {}
            if not isinstance(loaded, dict):
                raise ValueError(f"{path} must contain a mapping")
            data = loaded
    data = _deep_merge(data, _env_overrides(environ))
    return Settings.model_validate(data)
