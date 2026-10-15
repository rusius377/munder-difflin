# Munder Trading Desk — headless 24/7 container
#   docker compose up -d --build        (see docker-compose.yml)
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TZ=UTC
WORKDIR /app

# build deps only for optional wheels (nautilus_trader has prebuilt wheels; backtrader is pure Python)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata curl && rm -rf /var/lib/apt/lists/*

COPY requirements.txt pyproject.toml README.md ./
COPY munder_trader ./munder_trader
COPY config ./config
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir -e .

# state (journal, params, lessons, kill switch) and data cache live on volumes
VOLUME ["/app/state", "/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

# default: paper trading. Override with MT_TRADING_ENV=testnet|live (+ keys) in docker-compose / .env.
CMD ["munder-trader", "run", "--yes"]
