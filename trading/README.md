# Munder Trading Desk (`trading/`)

> Munder Difflin 사무실에 **트레이딩 데스크**를 하나 더 들였습니다. [TradingAgents](https://github.com/TauricResearch/TradingAgents)의
> 멀티에이전트 구조(애널리스트 → 강세/약세 토론 → 리서치 매니저 → 트레이더 → 리스크 토론 → 포트폴리오 매니저)를 핵심으로,
> **원래 모드(스윙)** 와 **스캘핑 모드** 두 데스크가 나란히 돌면서 각각의 **판단·근거·이유**를 보여주고,
> 바이낸스 USDⓈ-M 선물 7개 종목을 24시간 자동(모의/테스트넷/실거래)으로 거래하며, 과거 차트에 전략을 수없이 돌려 손절·익절을
> 채점하고 **스스로 피드백**해서 계속 발전합니다.

```
                  ┌──────────────── Munder Trading Desk ────────────────┐
  Binance USDⓈ-M  │  data/        호가(L2) · 체결흐름(tape) · 캔들 · 펀딩/OI  │
  ws + REST ─────►│  (+ nautilus_trader 브리지: 거래소급 북 엔진/재생)       │
                  │                                                     │
                  │  strategy/    퀀트 신호(스윙·스캘프) → 사이징/레버리지 → 리스크 │
                  │  agents/      TradingAgents 위원회 ×2 데스크 (판단·근거·이유) │
                  │  backtest/    내장 엔진 + backtrader 교차검증 + 워크포워드 최적화 │
                  │  learn/       트레이드 반성 메모리 · 에이전트 신뢰도 · 상시 재학습 │
                  │  execution/   페이퍼 브로커 · 바이낸스 선물 브로커            │
                  │  live/        24/7 엔진 · SQLite 저널 · 상태 대시보드 · 알림   │
                  └─────────────────────────────────────────────────────┘
```

## 무엇이 자동인가

운영자가 고정하는 값은 **최대 레버리지 하나**(`risk.max_leverage`, 기본 100배)입니다. 나머지는 매 판단마다 데스크가 정하고 학습 루프가 조정합니다.

| 항목 | 누가 어떻게 정하나 |
|---|---|
| 진입 방향·확신도 | 두 데스크의 위원회(애널리스트 5명 → 토론 → 리서치 매니저 → 트레이더 → 리스크 3인 토론 → PM)가 5단계 등급(Buy/Overweight/Hold/Underweight/Sell)과 확신도 산출 |
| 레버리지 | `min(하드캡, 바이낸스 브래킷 한도, 청산가가 손절의 3배 밖에 있도록 하는 값)` — 손절폭이 좁으면 높게, 넓으면 낮게 **자동** |
| 비중 | 기본 리스크(자산의 0.75%) × 확신도 배수(0.5~2.0) × 부분 켈리 배수(최근 승률/손익비) × 위원회 비중 배수, 상한 2.5%/트레이드 |
| 분할매수 | 눌림목·평균회귀 셋업은 50/30/20 사다리(시장가 + 지정가 2단), 돌파·모멘텀은 시장가 일괄(스윙 돌파는 70/30 리테스트) |
| 짧게 익절 vs 길게 보유 | `HoldPolicy`: 추세 강도(ADX·EMA 기울기), 호가/체결 압력, 과열(RSI·유동성 벽)로 **continuation 점수**를 매겨 TP1 부분익절 후 러너를 트레일링으로 늘릴지, 바로 챙길지, 타이트하게 조일지 결정 (PM의 hold_bias 반영) |
| 손절/익절/시간손절 | ATR·구조(스윙 저점/고점)·호가 벽 기반, 본전 이동, ATR 트레일링, 진전 없으면 시간손절 |
| 확신 높은 구간의 큰 비중 | 위원회 합의도·셋업 강도·레짐이 맞으면 공격적 리스크 의견의 가중치가 올라가 비중↑ (반대면 보수적 의견↑). 진입 후 1R 이상 수익 + continuation ≥ 0.7 + 같은 방향의 최신 위원회 판단(확신 ≥ 0.7)이면 원래 수량의 50%를 **피라미딩**하고 손절을 새 본전으로 올림(1회) |
| 판단 횟수 | 봉 마감(스캘프 1분·스윙 1시간)마다 + 봉 사이에도 호가·체결 압력이 강하게 일치하면(45초 쿨다운) 스캘프 데스크를 즉시 재소집. 봉 셋업과 주문흐름이 충돌하면 셋업을 기각하고, 주문흐름이 충분히 강하면 그 방향으로 **주문흐름 진입**(강도 할인) |
| 파라미터 | 3시간마다(설정) 종목·데스크별 **워크포워드 진화 최적화**. 아웃오브샘플에서 현 파라미터를 이기고(마진 0.03) backtrader 교차검증까지 통과해야 승격 |
| 에이전트 신뢰도 | 트레이드가 끝날 때마다 각 애널리스트의 의견이 맞았는지 채점 → 리서치 매니저가 쓰는 가중치 갱신(천천히 감쇠) |
| 교훈 | 트레이드마다 상황·결과·교훈을 메모리에 저장, 비슷한 상황에서 BM25식 검색으로 꺼내 위원회에 전달(TradingAgents의 reflection) |

## 두 데스크

| | 스윙(원래 모드) | 스캘핑 모드 |
|---|---|---|
| 시간축 | 1h 기준, 4h/1d 맥락 | 1m 기준, 5m 맥락 + **실시간 호가/체결** |
| 애널리스트 | 시장(기술) · 파생 펀더멘털(펀딩·OI·롱숏·테이커) · 뉴스 · 심리(공포탐욕) · 변동성 | 모멘텀(1m/5m) · **호가(불균형·마이크로프라이스·벽·밀도)** · **체결(CVD·공격 매수비중·대형체결·흡수·스윕)** · 변동성 · 파생 |
| 셋업 | 추세 눌림목, 거래량 돌파, 횡보 평균회귀 | VWAP 평균회귀, 모멘텀 점화, 스퀴즈 해제, 주문흐름 시작(호가+체결 강하게 일치 시) |
| 토론 | 강세/약세 2라운드 | 1라운드(빠르게) |
| 보유 | 수시간~수일, 최대 보유봉 제한 | 수분, 시간손절 15봉(학습) |

두 데스크 모두 `munder-trader analyze ETHUSDT` 로 같은 시점의 판단을 나란히 볼 수 있고, 24시간 운영 중에는 대시보드(`http://host:8787`)와
`munder-trader explain --full` 에서 애널리스트별 근거 → 토론 → 트레이더 제안 → 리스크 토론 → PM 결정 전문을 확인합니다.

```
=== 스캘핑 모드 · ETHUSDT @ 2041.81 ===
판단: Sell (Sell), 확신도 0.83, 합의도 75%, 비중 ×1.58, 레버리지 한도 99x, 보유성향 extend
구조: 손절 2046.13 / TP1 2037.49 / TP2 2034.03 (셋업 momentum, 레짐 trend_up)
-- 애널리스트 근거 --
• orderbook_analyst: bearish (-0.87, conf 65%)  약세 근거: 20호가 불균형 -0.30 → 매도벽 우위; 매도 호가 밀도 1.9배 두터움
• tape_analyst: bearish (-0.93, conf 90%)       약세 근거: 최근 체결 매수비중 22%; 대형 체결 편향 -1.00 → 큰손 매도 …
-- 리서치 토론 -- … -- 트레이더 -- … -- 리스크 토론 -- [공격적] … [중립] … [보수적] … [포트폴리오 매니저] 등급 Sell, 승인 …
```

## 종목

`ETHUSDT BTCUSDT XAUUSDT SOLUSDT SNDKUSDT SPCXUSDT ZECUSDT` (바이낸스 USDⓈ-M 영구선물). 틱/스텝/최소명목/레버리지 브래킷은
기동 시 `exchangeInfo`·`leverageBracket`에서 읽어오므로 하드코딩이 없습니다. XAU·주식연동 퍼프(SNDK/SPCX)는 **세션 유동성**을
감안해 미국장 외 시간·주말에 비중을 자동 축소합니다.

## 설치

```bash
cd trading
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt        # numpy pandas pydantic pyyaml requests python-dotenv websockets backtrader
pip install -e .                       # `munder-trader` 명령 등록
cp .env.example .env                   # 키 입력 (모의투자는 키 없이도 동작)
munder-trader selftest                 # 네트워크 없이 전체 파이프라인 점검
munder-trader doctor                   # 바이낸스 연결/키 권한/지역 차단/종목 상태 점검
```

선택 설치: `pip install nautilus_trader` 후 `data.use_nautilus: true` → nautilus `LiveNode`가 L2 북/체결을 공급(거래소와 같은 북 관리·갭 복구·재생 가능).
`pip install openai anthropic` 은 필요 없고(순수 requests), `llm.provider`/키만 설정하면 위원회가 자연어로 토론합니다.

## 실행

```bash
munder-trader paper                         # 모의투자 24/7 (기본). 대시보드 http://localhost:8787
munder-trader run --env testnet             # 바이낸스 선물 테스트넷 (testnet.binancefuture.com 키)
munder-trader run --env live --yes          # 실거래 (확인 플래그 필수)

munder-trader analyze ETHUSDT               # 두 데스크 판단/근거/이유 1회 출력 (주문 없음)
munder-trader analyze --offline             # 합성 데이터로 오프라인 데모
munder-trader backtest --symbol BTCUSDT --mode swing --days 90 --backtrader
munder-trader optimize --symbol ETHUSDT --mode scalp         # 워크포워드 최적화 1회
munder-trader learn                         # 전 종목·전 데스크 학습 1회 (cron 용)
munder-trader explain --symbol ETHUSDT --full
munder-trader status | kill | resume
```

환경변수로 어떤 값이든 덮어쓸 수 있습니다: `MT_TRADING_ENV`, `MT_RISK__MAX_LEVERAGE`, `MT_SYMBOLS=BTCUSDT,ETHUSDT`, `MT_LLM__PROVIDER` …

## 프로그램(데스크톱 앱)을 켜지 않아도 24시간 돌리기

엔진은 Electron 앱과 무관한 **헤드리스 데몬**입니다. 바이낸스 API로 직접 주문하고, 손절/익절은 거래소에 **대기 주문**(STOP_MARKET·TAKE_PROFIT_MARKET)으로
올라가 있으므로 프로세스가 잠깐 죽어도 포지션은 보호됩니다. 재시작하면 거래소 포지션/주문을 **리컨실**해서 이어갑니다.

| 방법 | 명령 |
|---|---|
| Docker (권장) | `cd trading && cp .env.example .env && docker compose up -d --build` (`restart: always`) |
| VPS 한 줄 설치 | `curl -fsSL https://raw.githubusercontent.com/rusius377/munder-difflin/main/trading/deploy/install_vps.sh \| sudo bash` → systemd 서비스 |
| systemd 수동 | `deploy/munder-trader.service` 참고 |

> ⚠️ 바이낸스 선물은 미국 등 일부 지역 IP를 차단(HTTP 451)합니다. 싱가포르·도쿄·서울·프랑크푸르트 등 허용 지역 VPS에서 `munder-trader doctor`로 확인하세요.
> GitHub Actions 러너(미국)에서는 거래가 되지 않으므로 CI는 오프라인 테스트만 돌립니다.

대시보드는 `127.0.0.1:8787`에만 바인딩됩니다. 휴대폰에서 보려면 `ssh -L 8787:127.0.0.1:8787 user@vps` 후 `http://localhost:8787`.

## 안전장치 (자동이지만 벽은 있다)

- **격리 마진**, 원웨이 포지션 모드, 종목당 1포지션, 동시 포지션 4개, 상관 클러스터(BTC/ETH/SOL 등) 같은 방향 2개까지
- 트레이드당 리스크 ≤ 2.5%, 총 마진 ≤ 자산의 60%, 청산가는 손절의 3배 거리 밖(아니면 플랜 거부)
- 일일 손실 6% → 4시간 정지, 드로다운 15% → 8시간 정지, 연속 4패 → 비중 반감
- `state/KILL_SWITCH` 파일(또는 대시보드 버튼, `munder-trader kill`)이 있으면 **신규 진입 중단**(기존 포지션의 손절/익절은 유지)
- 펀딩비가 불리하면 스윙 비중 축소, 스프레드가 넓으면 스캘프 금지, 호가 벽 앞에서는 TP를 당김
- 실거래는 `--yes` 명시, 기본값은 모의투자

## 데이터: 호가와 체결 흐름

`data/stream.py`는 바이낸스 문서대로 `depth@100ms` 차분 스트림을 스냅샷과 동기화(`U ≤ lastUpdateId ≤ u`, `pu == 이전 u`, 어긋나면 재동기화)하고,
`aggTrade`로 체결 테이프, `kline_1m/1h`로 봉 마감, `markPrice@1s`로 마크/펀딩을 받습니다. `websockets`가 없으면 REST 폴링으로 degrade 됩니다.
`data/nautilus_bridge.py`는 같은 인터페이스를 nautilus_trader v2 `LiveNode`(`BinanceProductType.USD_M`, `BTCUSDT-PERP.BINANCE`)로 채우고,
녹화된 depth CSV를 `load_binance_order_book_deltas`로 재생해 호가 전략을 과거 데이터에 돌릴 수 있게 합니다.

## 백테스트와 학습

- `backtest/engine.py`: 다음 봉 시가 체결, 봉 내부 손절/익절(둘 다 닿으면 불리한 쪽 우선), 부분익절·본전·트레일링·시간손절, 지정가 분할 체결, 수수료·슬리피지·펀딩, 갭 청산.
- `backtest/scorer.py`: **승률 ↑, 단기 수익률(일당) ↑, 익절 포착(실현/MFE) ↑, 손절 속도(패배 보유봉) ↑, 진입 품질(승리 MAE) ↑**, 드로다운·청산·표본 부족 패널티.
- `backtest/optimizer.py`: 진화 탐색 + 워크포워드(K폴드 시계열) — 아웃오브샘플 평균 − 분산 − 과적합(훈련≫검증) 패널티로 적합도 계산.
- `backtest/bt_adapter.py`: 같은 신호를 backtrader(Stop/Limit/OCO 주문, 선물형 수수료·마진)로 재실행해 교차검증. 승률 차이 0.2 초과면 승격 보류.
- `learn/`: 반성 메모리 · 에이전트 신뢰도 · `ContinuousLearner`(백그라운드 스레드, 3시간마다). 결과는 `state/params.json`, `state/learning_reports.jsonl`, 대시보드.

## Munder Difflin 사무실과의 연결

- 사무실의 **custom command 에이전트**로 데스크를 책상에 앉힐 수 있습니다: Hire → Custom command → `cd trading && . .venv/bin/activate && munder-trader paper`.
- Claude Code 에이전트(마이클 등)가 데스크를 운영하도록 `.claude/skills/trading-desk/SKILL.md`에 명령어·저널 위치·안전 규칙을 적어 두었습니다.
- `docs/TRADING.md`에 통합 방법과 운영 시나리오가 있습니다.

## 디렉터리

```
trading/
  munder_trader/
    config.py symbols.py util.py cli.py selftest.py
    data/        binance_rest.py history.py stream.py orderbook.py tradeflow.py derivatives.py nautilus_bridge.py
    strategy/    indicators.py params.py signals.py plan.py position_sizing.py risk.py
    agents/      base.py llm.py analysts.py researchers.py trader.py risk_team.py weights.py graph.py
    backtest/    engine.py scorer.py optimizer.py bt_adapter.py
    learn/       memory.py feedback.py scheduler.py
    execution/   base.py paper.py binance_futures.py
    live/        engine.py journal.py status_server.py notify.py
  config/settings.yaml  tests/  deploy/  Dockerfile  docker-compose.yml  .env.example
```

## 테스트

```bash
cd trading && python -m unittest discover -s tests -t .     # 48 tests, 네트워크 불필요
```

## 면책

이 소프트웨어는 연구·교육 목적이며 투자 조언이 아닙니다. 레버리지 선물은 원금 전액 손실이 가능합니다. 반드시 모의투자·테스트넷에서 충분히 돌려 보고,
실거래는 잃어도 되는 금액으로, 본인 책임하에 사용하세요.
