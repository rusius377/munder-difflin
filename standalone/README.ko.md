# 트레이딩 데스크 (독립 실행 앱)

Munder Difflin 없이 **트레이딩 데스크만** 실행하는 Windows 앱입니다. 기능은 Munder Difflin의 트레이딩 탭과 같습니다.

- 에이전트 알고리즘 모드 (TradingAgents 팀, 팀별 여러 명, 에이전트별 프로젝트 폴더와 성적표)
- 스캘핑 모드 (75배 거래 카드, 실시간 호가·체결 흐름, 에이전트 방향 필터, 경험 필터)
- 백테스트 (과거 차트 리테스트, 노틸러스 엔진, 에이전트 리플레이 훈련)
- 모의투자 · 바이낸스 데모 · 실거래 API 자동매매, 코드가 강제하는 리스크 엔진

기능 설명은 [`docs/TRADING.ko.md`](../docs/TRADING.ko.md), 바이낸스 API 키 만들기와 실거래 체크리스트는
[`docs/TRADING-SETUP.ko.md`](../docs/TRADING-SETUP.ko.md)에 있습니다 (트레이딩 탭 = 이 앱의 화면).

> **연구용 도구이며 투자 조언이 아닙니다.** 레버리지 선물은 예상보다 큰 손실이 날 수 있습니다.
> 모의투자 → 바이낸스 데모 → 소액 실거래 순서로 검증하세요.

## 설치 파일 만들기 (GitHub Actions, PC에 개발 도구 불필요)

1. 포크(`rusius377/munder-difflin`) → **Actions** 탭 → 왼쪽에서 **Desk Release** 선택
2. **Run workflow** → 브랜치 `feat/trading-desk-ko` → **Run workflow**
3. 10분쯤 뒤 실행이 초록색으로 끝나면 실행을 열고, 아래 **Artifacts**의 `trading-desk-windows-2022`를 내려받아 압축을 풉니다.
   - `TradingDesk-1.0.0-win-x64-setup.exe` — 설치형
   - `TradingDesk-1.0.0-win-x64-portable.exe` — 설치 없이 바로 실행
4. 서명되지 않은 앱이라 Windows가 "PC 보호" 창을 띄우면 **추가 정보 → 실행**을 누릅니다.

> 태그를 `desk-v1.0.0`처럼 붙여 푸시하면 같은 파일이 GitHub 릴리스로도 올라갑니다.
> Munder Difflin 앱을 만드는 기존 Release 워크플로와는 따로 돕니다.

## 처음 실행

1. **Munder Difflin 데이터 가져오기**: 이 PC에 Munder Difflin 트레이딩 데이터가 있으면 처음 한 번 물어봅니다.
   설정·에이전트 폴더와 성적표·교훈·거래 기록·보고서·백테스트·스캘퍼 경험·과거 데이터를 복사합니다.
   **API 키는 보안상 옮길 수 없으니** 설정에서 다시 입력하세요. 나중에 메뉴 **파일 → Munder Difflin 데이터 가져오기**로도 할 수 있습니다.
2. **LLM 연결**: 설정 → 언어 모델
   - **Claude 구독**(기본): 이 PC에 Claude Code가 설치·로그인되어 있어야 합니다 (터미널에서 `claude`가 실행되는지 확인).
     앱이 `claude`를 찾지 못하면 아래 바의 **Claude 명령**에 전체 경로를 넣고 저장하세요
     (예: `C:\Users\<이름>\AppData\Roaming\npm\claude.cmd`).
   - 또는 Anthropic API / OpenAI API / OpenAI 호환 서버 키를 넣어도 됩니다.
   - **LLM 연결 테스트**는 빠른 모델과 깊은 모델(리서치·포트폴리오 매니저용)을 둘 다 검사합니다.
3. 바이낸스 키(데모/실거래)와 리스크 한도를 확인하고 **시작**.

## 화면

- 위: 트레이딩 데스크 (개요 · 에이전트 · 에이전트 폴더 · 백테스트 · 거래내역 · 로그 · 설정)
- 아래 바: 버전, **언어**(기본 한국어), **Claude 명령**, **데이터 폴더** 열기
- 메뉴: 파일(데이터 폴더, Munder Difflin 데이터 가져오기, 종료) · 편집 · 보기 · 도움말

## 알아둘 점

- **창을 닫으면 자동매매가 멈춥니다.** 데스크가 실행 중이면 닫기 전에 확인을 묻습니다.
  데모·실거래는 거래소에 걸린 손절·익절이 유지되지만, 모의투자 포지션은 다시 시작할 때까지 감시되지 않습니다.
- 24시간 운영: 설정 → 자동매매에서 "앱을 열면 데스크 자동 시작", "잠자기 방지", "로그인하면 앱 실행"을 켭니다.
- 앱은 하나만 실행됩니다 (두 번째 실행은 기존 창을 앞으로 가져옵니다).
- 자동 업데이트는 없습니다. 새 버전은 위 방법으로 다시 만들어 설치하면 되고, 데이터는 그대로 남습니다.
- Munder Difflin의 "사무실 프로젝트로 등록" 버튼은 이 앱에는 없습니다.

## 저장 위치

`%APPDATA%\TradingDesk\`

| 경로 | 내용 |
|---|---|
| `trading\config.json` | 트레이딩 설정 |
| `trading\agents\` | 에이전트별 프로젝트 폴더 (지침 `CLAUDE.md`, 성적표, 교훈) |
| `trading\journal.jsonl`, `reports\`, `lessons\` | 결정·거래 기록, 보고서, 교훈 |
| `trading\backtests\`, `experience\`, `history\` | 백테스트 결과, 스캘퍼 경험, 내려받은 과거 데이터 |
| `trading\nautilus\venv\` | 노틸러스 엔진 전용 Python 환경 |
| `secrets.json` | API 키 (Windows DPAPI로 암호화, 화면에 다시 표시되지 않음) |
| `desk.json` | 이 앱의 설정 (Claude 명령) |

## 직접 빌드 (선택)

Node.js 20과 Python 3.11, Visual Studio Build Tools(“C++를 사용한 데스크톱 개발”)가 있으면:

```powershell
cd standalone
npm ci
npm run dev        # 개발 모드로 실행
npm run dist:win   # dist\ 에 설치 파일
```

## 구조

코드를 복사하지 않고 저장소의 트레이딩 코드를 그대로 씁니다.

| 이 폴더 | 하는 일 |
|---|---|
| `src/main/index.ts` | 창, 메뉴, 단일 실행, 종료 확인, 앱 설정 IPC |
| `src/main/secrets.ts` | 키 저장소 (OS 암호화) |
| `src/main/importLegacy.ts` | Munder Difflin 데이터 가져오기 |
| `src/preload/index.ts` | 화면에 주는 API (`src/preload/tradingApi.ts` 공유) |
| `src/renderer/` | 트레이딩 탭 + 아래 바 |

엔진·에이전트·스캘퍼·백테스트는 `../src/main/trading/`, 화면은 `../src/renderer/src/components/trading/`,
번역은 `../src/renderer/src/i18n/locales/`, 노틸러스 스크립트는 `../resources/nautilus/`에 있습니다.
