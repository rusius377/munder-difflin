# Trading Desk — Munder Difflin 사무실에 붙은 자동매매 데스크

`trading/` 디렉터리에 TradingAgents 구조의 멀티에이전트 **바이낸스 USDⓈ-M 선물 데스크**가 들어 있습니다.
자세한 사용법은 [`trading/README.md`](../trading/README.md)를 보세요. 이 문서는 사무실(Electron 앱, 하이브, 에이전트)과
어떻게 맞물리는지만 다룹니다.

## 1. 역할 분담

| 층 | 무엇을 하나 |
|---|---|
| **Munder Difflin 사무실** | 마이클(당신의 클론)과 직원 에이전트들이 데스크를 *운영*합니다: 상태 확인, 판단 근거 설명, 백테스트/학습 실행, 설정 변경 제안, 코드 수정. |
| **Trading Desk (`trading/`)** | 실제 판단·주문·학습을 하는 헤드리스 파이썬 데몬. 앱이 꺼져 있어도 VPS/Docker/systemd에서 24시간 돕니다. |

둘은 파일과 HTTP로만 통신합니다 — `trading/state/*.json|sqlite|jsonl` 과 `http://127.0.0.1:8787/{status,decisions,trades,learning}`.
사무실 쪽에서 데스크를 망가뜨릴 수 있는 공유 상태(락, DB 쓰기)는 없습니다.

## 2. 책상 하나를 데스크에 내주기 (custom command 에이전트)

1. 앱에서 **Hire** → provider **Custom command**.
2. 명령: `cd trading && . .venv/bin/activate && munder-trader paper` (테스트넷은 `run --env testnet`).
3. 그 터미널이 곧 데스크의 로그입니다. 캐릭터는 책상에서 계속 "일"하고, 마이클은 그 창에 메시지를 보내지 않습니다(데스크는 stdin을 읽지 않음).
4. 다른 직원(Claude Code)에게 `.claude/skills/trading-desk/SKILL.md`가 자동으로 로드되므로 "ETHUSDT 왜 숏 쳤어?" 같은 질문에
   `munder-trader explain --full` 결과를 읽어 답하게 할 수 있습니다.

## 3. 마이클이 할 수 있는 일 (예시 프롬프트)

- "데스크 상태 알려줘" → `munder-trader status` 또는 `/status` 읽기.
- "오늘 스캘핑 데스크가 BTC에서 뭘 봤는지 근거까지" → `munder-trader explain --symbol BTCUSDT --mode scalp --full`.
- "지난 90일 스윙 백테스트 돌리고 backtrader로 교차검증해" → `munder-trader backtest --symbol ETHUSDT --mode swing --days 90 --backtrader`.
- "학습 한 번 돌려" → `munder-trader learn` (결과는 `state/learning_reports.jsonl` + 대시보드).
- "지금 당장 신규 진입 멈춰" → `munder-trader kill` (기존 포지션의 손절/익절은 거래소에 그대로 남음).

## 4. 안전 규칙 (사무실 에이전트에게도 적용)

- 기본은 **모의투자**. 실거래(`--env live --yes`)는 사람이 명시적으로 요청했을 때만.
- `risk.max_leverage`(하드캡)를 올리거나 가드레일을 끄는 변경은 사람이 시키지 않는 한 제안만.
- 키는 `trading/.env`에만. 커밋 금지(`.gitignore` 처리됨).

## 5. 24시간 운영 요약

| 환경 | 방법 |
|---|---|
| 집 PC | 앱의 custom command 책상 또는 터미널에서 `munder-trader paper` — PC가 꺼지면 멈춤 |
| VPS (권장) | `trading/deploy/install_vps.sh` 한 줄 → systemd `munder-trader` 서비스가 재부팅·크래시 후 자동 재시작 |
| Docker | `cd trading && docker compose up -d --build` (`restart: always`) |

바이낸스 선물은 일부 지역(미국 등)을 차단하므로 허용 지역 VPS에서 `munder-trader doctor`로 확인한 뒤 올리세요.
