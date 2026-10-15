"""Minimal, dependency-light Binance USDⓈ-M futures REST client.

Only ``requests`` is needed. Public market-data endpoints work without keys; the
signed account/trade endpoints need an API key + secret with *Futures* permission.
Everything the broker, the history cache and the analysts need is here:

* market data: exchange info, klines, depth, aggregated trades, mark/funding,
  open interest (+ history), long/short ratios, taker buy/sell ratio
* account: balances, positions, leverage brackets, leverage/margin changes
* trading: new/cancel orders, batch orders, open orders, user trades, income
* user data stream listen keys

The client never raises on Binance "business" errors silently: every non-2xx
answer becomes :class:`BinanceAPIError` carrying Binance's ``code``/``msg`` so
the engine can react (e.g. ``-2019`` margin insufficient, ``-4164`` min notional).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any
from urllib.parse import urlencode

import requests

from ..util import RateLimiter

log = logging.getLogger(__name__)


class BinanceAPIError(RuntimeError):
    def __init__(self, status: int, code: int | None, msg: str, path: str = "") -> None:
        super().__init__(f"HTTP {status} code={code} {msg} ({path})")
        self.status = status
        self.code = code
        self.msg = msg
        self.path = path


class BinanceFuturesREST:
    """Thin REST wrapper. ``session`` may be any object with ``.request(method, url, **kw)``."""

    def __init__(
        self,
        base_url: str = "https://fapi.binance.com",
        api_key: str = "",
        api_secret: str = "",
        *,
        recv_window_ms: int = 5000,
        timeout_s: float = 10.0,
        session: Any | None = None,
        max_retries: int = 3,
        time_sync: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.api_secret = api_secret
        self.recv_window_ms = recv_window_ms
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self._session = session or requests.Session()
        self._limiter = RateLimiter(capacity=2400, refill_per_min=2400)
        self._time_offset_ms = 0
        self._time_sync = time_sync
        self._synced = False

    # ------------------------------------------------------------------ plumbing
    @property
    def has_keys(self) -> bool:
        return bool(self.api_key and self.api_secret)

    def _sign(self, params: dict[str, Any]) -> str:
        query = urlencode(params, doseq=True)
        return hmac.new(self.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()

    def _timestamp(self) -> int:
        return int(time.time() * 1000) + self._time_offset_ms

    def sync_time(self) -> int:
        try:
            server = int(self.server_time()["serverTime"])
            self._time_offset_ms = server - int(time.time() * 1000)
        except Exception as exc:  # pragma: no cover - network
            log.warning("time sync failed: %s", exc)
        self._synced = True
        return self._time_offset_ms

    def _request(self, method: str, path: str, params: dict[str, Any] | None = None, *,
                 signed: bool = False, weight: int = 1, futures_data: bool = False) -> Any:
        params = {k: v for k, v in (params or {}).items() if v is not None}
        if signed:
            if not self.has_keys:
                raise BinanceAPIError(0, None, "API key/secret required for signed endpoint", path)
            if self._time_sync and not self._synced:
                self.sync_time()
            params["timestamp"] = self._timestamp()
            params["recvWindow"] = self.recv_window_ms
            params["signature"] = self._sign(params)
        headers = {"X-MBX-APIKEY": self.api_key} if self.api_key else {}
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            self._limiter.acquire(weight)
            try:
                if method in ("GET", "DELETE"):
                    resp = self._session.request(method, url, params=params, headers=headers, timeout=self.timeout_s)
                else:
                    resp = self._session.request(method, url, params=params, headers=headers, timeout=self.timeout_s)
            except requests.RequestException as exc:
                last_exc = exc
                time.sleep(min(8.0, 0.5 * (2 ** attempt)))
                continue
            status = getattr(resp, "status_code", 200)
            if status == 429 or status == 418:
                retry_after = float(getattr(resp, "headers", {}).get("Retry-After", 2.0) or 2.0)
                log.warning("rate limited (%s) on %s; sleeping %.1fs", status, path, retry_after)
                time.sleep(retry_after)
                continue
            try:
                payload = resp.json()
            except ValueError:
                payload = {"code": None, "msg": getattr(resp, "text", "")[:200]}
            if 200 <= status < 300:
                return payload
            code = payload.get("code") if isinstance(payload, dict) else None
            msg = payload.get("msg", "") if isinstance(payload, dict) else str(payload)
            if code == -1021 and attempt < self.max_retries:  # timestamp outside recvWindow
                self.sync_time()
                params["timestamp"] = self._timestamp()
                params.pop("signature", None)
                params["signature"] = self._sign(params)
                continue
            if status >= 500 and attempt < self.max_retries:
                time.sleep(min(8.0, 0.5 * (2 ** attempt)))
                continue
            raise BinanceAPIError(status, code, msg, path)
        raise BinanceAPIError(0, None, f"request failed after retries: {last_exc}", path)

    # ------------------------------------------------------------------ public market data
    def ping(self) -> bool:
        self._request("GET", "/fapi/v1/ping")
        return True

    def server_time(self) -> dict:
        return self._request("GET", "/fapi/v1/time")

    def exchange_info(self) -> dict:
        return self._request("GET", "/fapi/v1/exchangeInfo", weight=1)

    def klines(self, symbol: str, interval: str, start_ms: int | None = None, end_ms: int | None = None,
               limit: int = 1500) -> list[list]:
        params = {"symbol": symbol, "interval": interval, "limit": min(int(limit), 1500),
                  "startTime": start_ms, "endTime": end_ms}
        return self._request("GET", "/fapi/v1/klines", params, weight=5 if limit > 500 else 2)

    def depth(self, symbol: str, limit: int = 1000) -> dict:
        return self._request("GET", "/fapi/v1/depth", {"symbol": symbol, "limit": limit}, weight=20 if limit >= 1000 else 5)

    def agg_trades(self, symbol: str, limit: int = 1000, from_id: int | None = None,
                   start_ms: int | None = None, end_ms: int | None = None) -> list[dict]:
        return self._request("GET", "/fapi/v1/aggTrades",
                             {"symbol": symbol, "limit": min(limit, 1000), "fromId": from_id,
                              "startTime": start_ms, "endTime": end_ms}, weight=20)

    def premium_index(self, symbol: str | None = None) -> Any:
        """Mark price, index price, last funding rate, next funding time."""
        return self._request("GET", "/fapi/v1/premiumIndex", {"symbol": symbol})

    def funding_rate(self, symbol: str, limit: int = 100) -> list[dict]:
        return self._request("GET", "/fapi/v1/fundingRate", {"symbol": symbol, "limit": limit})

    def open_interest(self, symbol: str) -> dict:
        return self._request("GET", "/fapi/v1/openInterest", {"symbol": symbol})

    def open_interest_hist(self, symbol: str, period: str = "5m", limit: int = 30) -> list[dict]:
        return self._request("GET", "/futures/data/openInterestHist",
                             {"symbol": symbol, "period": period, "limit": limit})

    def long_short_ratio(self, symbol: str, period: str = "5m", limit: int = 30) -> list[dict]:
        return self._request("GET", "/futures/data/globalLongShortAccountRatio",
                             {"symbol": symbol, "period": period, "limit": limit})

    def top_trader_ls_ratio(self, symbol: str, period: str = "5m", limit: int = 30) -> list[dict]:
        return self._request("GET", "/futures/data/topLongShortPositionRatio",
                             {"symbol": symbol, "period": period, "limit": limit})

    def taker_ratio(self, symbol: str, period: str = "5m", limit: int = 30) -> list[dict]:
        return self._request("GET", "/futures/data/takerlongshortRatio",
                             {"symbol": symbol, "period": period, "limit": limit})

    def ticker_24h(self, symbol: str) -> dict:
        return self._request("GET", "/fapi/v1/ticker/24hr", {"symbol": symbol})

    def book_ticker(self, symbol: str) -> dict:
        return self._request("GET", "/fapi/v1/ticker/bookTicker", {"symbol": symbol})

    # ------------------------------------------------------------------ account (signed)
    def leverage_bracket(self, symbol: str | None = None) -> Any:
        return self._request("GET", "/fapi/v1/leverageBracket", {"symbol": symbol}, signed=True)

    def account(self) -> dict:
        return self._request("GET", "/fapi/v2/account", signed=True, weight=5)

    def balance(self) -> list[dict]:
        return self._request("GET", "/fapi/v2/balance", signed=True, weight=5)

    def position_risk(self, symbol: str | None = None) -> list[dict]:
        return self._request("GET", "/fapi/v2/positionRisk", {"symbol": symbol}, signed=True, weight=5)

    def position_mode(self) -> dict:
        return self._request("GET", "/fapi/v1/positionSide/dual", signed=True, weight=30)

    def set_position_mode(self, hedge: bool) -> dict:
        return self._request("POST", "/fapi/v1/positionSide/dual", {"dualSidePosition": "true" if hedge else "false"}, signed=True)

    def change_leverage(self, symbol: str, leverage: int) -> dict:
        return self._request("POST", "/fapi/v1/leverage", {"symbol": symbol, "leverage": int(leverage)}, signed=True)

    def change_margin_type(self, symbol: str, isolated: bool = True) -> dict:
        try:
            return self._request("POST", "/fapi/v1/marginType",
                                 {"symbol": symbol, "marginType": "ISOLATED" if isolated else "CROSSED"}, signed=True)
        except BinanceAPIError as exc:
            if exc.code == -4046:  # "No need to change margin type."
                return {"code": -4046, "msg": exc.msg}
            raise

    def commission_rate(self, symbol: str) -> dict:
        return self._request("GET", "/fapi/v1/commissionRate", {"symbol": symbol}, signed=True, weight=20)

    # ------------------------------------------------------------------ trading (signed)
    def new_order(self, **params: Any) -> dict:
        """Place an order. Pass Binance parameter names (``symbol``, ``side``, ``type`` ...)."""
        return self._request("POST", "/fapi/v1/order", params, signed=True)

    def batch_orders(self, orders: list[dict]) -> list[dict]:
        import json as _json

        return self._request("POST", "/fapi/v1/batchOrders", {"batchOrders": _json.dumps(orders)}, signed=True, weight=5)

    def cancel_order(self, symbol: str, order_id: int | None = None, client_order_id: str | None = None) -> dict:
        return self._request("DELETE", "/fapi/v1/order",
                             {"symbol": symbol, "orderId": order_id, "origClientOrderId": client_order_id}, signed=True)

    def cancel_all(self, symbol: str) -> dict:
        return self._request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": symbol}, signed=True)

    def open_orders(self, symbol: str | None = None) -> list[dict]:
        return self._request("GET", "/fapi/v1/openOrders", {"symbol": symbol}, signed=True, weight=1 if symbol else 40)

    def get_order(self, symbol: str, order_id: int | None = None, client_order_id: str | None = None) -> dict:
        return self._request("GET", "/fapi/v1/order",
                             {"symbol": symbol, "orderId": order_id, "origClientOrderId": client_order_id}, signed=True)

    def user_trades(self, symbol: str, limit: int = 100, start_ms: int | None = None) -> list[dict]:
        return self._request("GET", "/fapi/v1/userTrades",
                             {"symbol": symbol, "limit": limit, "startTime": start_ms}, signed=True, weight=5)

    def income(self, symbol: str | None = None, income_type: str | None = None, limit: int = 100,
               start_ms: int | None = None) -> list[dict]:
        return self._request("GET", "/fapi/v1/income",
                             {"symbol": symbol, "incomeType": income_type, "limit": limit, "startTime": start_ms},
                             signed=True, weight=30)

    # ------------------------------------------------------------------ user data stream
    def start_listen_key(self) -> str:
        # USER_STREAM security: API key header only, no signature.
        return self._request("POST", "/fapi/v1/listenKey")["listenKey"]

    def keepalive_listen_key(self) -> dict:
        return self._request("PUT", "/fapi/v1/listenKey")

    def close_listen_key(self) -> dict:
        return self._request("DELETE", "/fapi/v1/listenKey")
