# 설치부터 바이낸스 API 자동매매까지 — 단계별 가이드

이 문서는 포크한 저장소(`feat/trading-desk-ko` 브랜치)의 트레이딩 데스크를 **내 컴퓨터의 Munder Difflin에 적용**하고,
**바이낸스 API로 자동매매**를 켜는 전체 과정입니다. Windows 기준이며, macOS는 각 단계 끝에 따로 적었습니다.

기능 설명(에이전트 구조, 스캘핑 규칙, 리스크 엔진)은 [`TRADING.ko.md`](./TRADING.ko.md)를 보세요.

> **연구용 도구이며 투자 조언이 아닙니다.** 반드시 ① 모의투자 → ② 바이낸스 데모 → ③ 소액 실거래 순서로 진행하세요.
> 실거래 손실은 전적으로 사용자 책임이며, 거주 국가의 가상자산·파생상품 규정 확인도 사용자 몫입니다.

---

## 전체 흐름 한눈에

| 단계 | 할 일 | 걸리는 시간 |
|---|---|---|
| 0 | 공식 앱의 **자동 업데이트 끄기** | 1분 |
| 1~4 | 트레이딩 데스크가 들어간 앱 만들기 — **A. GitHub에서 빌드(권장, 설치할 도구 없음)** 또는 B. 내 PC에서 빌드 | A: 20분 / B: 1시간 |
| 5 | 한국어 설정, 트레이딩 탭 열기, LLM 연결 테스트 | 5분 |
| 6 | **백테스트**로 과거 차트 검증(경험 쌓기) → **모의투자**로 하루 이상 돌려 보기 | 1일+ |
| 7 | **바이낸스 데모** API 키 발급 → 데모 자동매매 | 1일+ |
| 8 | **실거래** API 키 발급(출금 OFF, IP 제한) → 소액 자동매매 | — |
| 9 | 24시간 운영 설정 (자동 시작, 잠자기 방지, 로그인 시 실행) | 5분 |

---

## 0. 공식 앱의 자동 업데이트 끄기 (먼저!)

지금 설치된 Munder Difflin은 공식 릴리스입니다. 직접 빌드한 버전을 설치한 뒤 공식 업데이트를 받으면
**트레이딩 데스크가 없는 버전으로 덮어써집니다.**

1. Munder Difflin 실행 → **Settings → General → Auto-update** 끄기
2. 앞으로 "Restart to update" 알림이 떠도 누르지 마세요.
   (이 앱은 사용자가 직접 재시작을 눌러야만 업데이트를 설치합니다.)

새 기능·버그 수정이 필요하면 [10. 업데이트하는 법](#10-업데이트하는-법)처럼 포크를 원본과 합친 뒤 다시 빌드합니다.

> **Pro 사용자 참고**: harnessmd.com에서 받은 빌드의 Pro 기능(Stapler, 새 사이드바 등)은 오픈소스 저장소로 만든
> 빌드에 들어 있지 않을 수 있습니다. 걱정되면 설치형 대신 **포터블 exe**로 먼저 써 보세요
> (같은 설정 폴더를 쓰며, 두 앱을 동시에 띄울 수는 없습니다).

---

## A. GitHub Actions로 설치 파일 만들기 (권장 — PC에 개발 도구 설치 불필요)

포크에는 원본 저장소의 릴리스 빌드 워크플로가 그대로 들어 있습니다. GitHub 서버가 Windows 설치 파일을 만들어 줍니다.

1. 브라우저에서 <https://github.com/rusius377/munder-difflin/actions> 열기
2. 포크는 처음에 워크플로가 꺼져 있습니다. **"I understand my workflows, go ahead and enable them"** 클릭
3. 왼쪽 목록에서 **Release** 선택 → 오른쪽 **Run workflow** 버튼
   - **Use workflow from**: `feat/trading-desk-ko` 로 바꾸기 (중요!)
   - **Run workflow** 클릭 (수동 실행은 빌드만 하고 릴리스는 만들지 않습니다)
4. 15~25분 기다립니다. `Build (windows-2022)` 가 초록색 ✓ 이 되면 완료
   (macOS 빌드가 실패해도 Windows 결과물에는 영향 없습니다)
5. 실행 화면 아래 **Artifacts** 에서 **`windows-2022-dist`** 다운로드 → 압축 해제
   - `Munder-Difflin-<버전>-win-x64-setup.exe` : 설치형
   - `Munder-Difflin-<버전>-win-x64-portable.exe` : 설치 없이 실행
6. 공식 앱을 **완전히 종료**(트레이 아이콘까지)한 뒤 setup.exe 실행
   - 서명되지 않은 빌드라 **"Windows의 PC 보호"** 창이 뜨면 **추가 정보 → 실행**
   - 같은 앱 ID라 기존 설정·에이전트·메모리(HarnessAgents)는 그대로 유지됩니다.
7. 설치 후 **Settings → General → Auto-update 가 꺼져 있는지** 다시 확인 → **5단계로**

> 이 빌드가 실패하면 Actions 로그의 빨간 단계를 그대로 복사해 알려 주세요.

---

## B. 내 PC에서 직접 빌드하기

### B-1. 빌드 도구 설치 (Windows)

Munder Difflin은 터미널 기능(`node-pty`)과 DB(`better-sqlite3`)를 C++로 빌드하므로 아래가 모두 필요합니다.
버전은 원본 저장소의 릴리스 빌드(CI)와 같게 맞췄습니다.

1. **Git for Windows** — <https://git-scm.com/download/win> (기본값으로 설치)
2. **Node.js 20 LTS** — <https://nodejs.org/en/download> 에서 20.x 설치 파일
3. **Python 3.11** — <https://www.python.org/downloads/windows/>
   - 설치 첫 화면에서 **"Add python.exe to PATH" 체크**
   - 설치 후 PowerShell에서 `python -m pip install --upgrade setuptools`
     (node-gyp가 쓰는 distutils가 3.12부터 빠져서 필요합니다)
4. **Visual Studio 2022 Build Tools** — <https://visualstudio.microsoft.com/visual-cpp-build-tools/>
   - 워크로드: **"C++를 사용한 데스크톱 개발 (Desktop development with C++)"** 체크
   - 개별 구성 요소 탭에서 검색해 추가:
     **MSVC v143 - VS 2022 C++ x64/x86 Spectre 완화 라이브러리(최신)**
     (없으면 `node-pty` 빌드가 `MSB8040` 오류로 실패할 수 있습니다)
5. 설치가 끝나면 **PowerShell을 새로 열고** 확인:

```powershell
git --version
node -v            # v20.x
npm -v
python --version   # 3.11.x
```

> **macOS**: `xcode-select --install`, Node.js 20 LTS, Python 3.11(`brew install python@3.11`) + `pip install setuptools`.

### B-2. 포크 받기

```powershell
cd $HOME\Documents
git clone https://github.com/rusius377/munder-difflin.git
cd munder-difflin
git checkout feat/trading-desk-ko
```

`git log --oneline -3` 맨 위에 트레이딩 데스크 커밋들이 보이면 됩니다.

### B-3. 의존성 설치와 개발 모드 실행

```powershell
npm ci
npm run typecheck
npm run dev
```

- `npm ci`는 Electron을 내려받고 네이티브 모듈을 빌드하느라 몇 분 걸립니다.
- `npm run typecheck`가 오류 없이 끝나야 합니다.
- `npm run dev`로 앱 창이 뜨면 성공입니다. 공식 앱은 먼저 종료하세요.
- 개발 모드는 설정 폴더가 설치본과 따로(`%APPDATA%\munder-difflin`)라서 **온보딩이 다시 나올 수 있습니다.**
  홈 폴더로 기존 `HarnessAgents`를 고르면 됩니다. B-4에서 설치본을 만들면 기존 설정을 그대로 씁니다.
- 개발 모드에서도 트레이딩 탭이 그대로 동작하므로, 여기서 5~6단계를 먼저 해 봐도 됩니다.

**자주 나는 오류**

| 메시지 | 해결 |
|---|---|
| `gyp ERR! find Python` / `No module named 'distutils'` | Python 3.11 설치·PATH 확인, `python -m pip install --upgrade setuptools`, PowerShell 재시작 |
| `MSB8040: Spectre-mitigated libraries are required` | B-1-4의 Spectre 완화 라이브러리 설치 |
| `gyp ERR! find VS` | Build Tools의 "C++를 사용한 데스크톱 개발" 워크로드 설치 |
| `node-pty` 로드 실패 | `npm ci`를 다시 실행 (postinstall이 Electron용으로 재빌드) |
| 트레이딩 테스트만 돌리기 | `node --test test/trading-*.test.cjs test/korean-ui.test.cjs` |

### B-4. 설치 파일 만들기 (상시 운영용)

24시간 자동매매는 개발 모드보다 설치된 앱이 안정적입니다.

```powershell
npm run dist:win
```

- 결과물: `dist\Munder-Difflin-<버전>-win-x64-setup.exe` (와 `-portable.exe`)
- 설치 방법은 A-6, A-7과 같습니다.

> **macOS**: `npm run dist:mac` → `dist/*.dmg`. 서명 인증서가 없으면 서명 없는 앱이 만들어지므로
> 처음 열 때 Finder에서 앱을 **우클릭 → 열기** 하세요.

### Claude Code (기본 LLM)

트레이딩 에이전트는 기본으로 **Claude 구독**(Munder Difflin이 이미 쓰는 Claude Code 로그인)을 사용합니다.
이미 Munder Difflin에서 Claude 에이전트를 쓰고 있다면 준비된 것입니다. 아니라면 Munder Difflin의
**Settings → Prerequisites** 에서 Claude Code를 설치하고 로그인하세요.
API 키를 쓰고 싶다면 5단계에서 제공자를 **Anthropic API / OpenAI API** 로 고르면 됩니다.

---

## 5. 앱에서 트레이딩 데스크 열기

1. **Settings → General → Language → 한국어**
2. 바닥(층)에서 **Michael(오케스트레이터)** 을 클릭 → 커맨드 센터가 열립니다.
3. 탭 줄 맨 끝 **트레이딩** 탭 (넓은 창이 아니면 탭 줄을 옆으로 스크롤).
4. **설정** 화면 → 언어 모델:
   - 제공자 **Claude 구독**, 빠른 모델 `sonnet`, 깊은 모델 `opus` (기본값)
   - **설정 저장** → **LLM 연결 테스트** → "연결 성공"이 나오면 OK (수십 초 걸릴 수 있음)
5. 개요 화면 상단의 **BTC 지금 분석**을 눌러 봅니다. 데스크가 정지 상태라 **분석만** 하고 주문은 하지 않습니다.
   **에이전트** 화면에서 분석가 → 토론 → 트레이더 → 리스크 → 포트폴리오 위원회 순서로 진행되는 것을 볼 수 있습니다
   (Claude 구독, 기본 "표준 위원회" 기준 한 번에 10~20분. 설정 → 에이전트 팀 구성에서 인원을 줄이면 빨라집니다).

---

## 6. 모의투자로 자동매매 (API 키 불필요)

1. 설정 → 기본 → 실행 환경 **모의투자**, 모드 **에이전트 알고리즘** 또는 **스캘핑**
2. 리스크 한도 확인 (기본: 거래당 최대 손실 1%, 데스크 최대 레버리지 75배 — 에이전트 모드는 따로 최대 10배,
   스캘핑 레버리지 75배, 일일 손실 한도 −4%, 연속 손실 4회 중단)
3. **설정 저장** → 상단 **시작**
4. 동작 방식
   - 에이전트 모드: 종목마다 `분석 간격`(기본 60분)마다 전체 파이프라인을 돌리고, 포트폴리오 매니저 결정이
     리스크 엔진을 통과하면 자동 진입. 손절·익절은 자동, 다음 분석에서 청산·반대 전환도 자동.
   - 스캘핑 모드: 5초마다 신호를 평가해 자동 진입·청산. 15분마다 에이전트 방향 필터 갱신.
5. **거래내역**, **로그**, `보고서 폴더 열기`로 결과를 확인합니다. 최소 하루 이상 돌려 보세요.
6. 스캘핑 모드의 **개요**에는 75배 기준 거래 카드(진입·손절·목표가·손익비·청산가·ROE)와 실시간 호가·체결 흐름이 나옵니다.

### 6-1. 백테스트로 먼저 검증하기 (과거 차트 리테스트)

1. 트레이딩 → **백테스트** → 모드 **스캘핑**, 엔진 **내장 리플레이**, 종목, 기간(UTC, 어제까지 — 체결 테이프·노틸러스는 최대 7일, 1분봉만 쓰면 최대 31일)
2. "체결 테이프·호가 깊이 사용"을 켜 두면 바이낸스 데이터 아카이브에서 하루 약 10~30MB를 내려받아 초 단위로 재현합니다
   (처음 한 번만 받고 이후에는 저장된 파일을 씁니다).
3. **백테스트 실행** → 진행률이 끝나면 **보기**: 승률, 순손익, 평균 R, 최대 낙폭, **낸 수수료와 수수료 빼기 전 손익**,
   자산 곡선, 거래마다 진입·손절·목표·청산가·R·ROE·청산 사유.
4. "경험으로 쌓기"가 켜져 있으면 결과가 스캘퍼 경험이 되고, 실전에서 손해 본 셋업은 진입하지 않습니다
   (설정 → 스캘핑 → 경험 필터). 같은 기간을 다시 돌리면 이전 기록을 대체합니다.
5. **에이전트 팀** 모드는 과거 시점마다 에이전트 팀 전체를 돌려 판단을 채점합니다. 시점마다 실시간 분석과 같은 LLM 사용량이 듭니다.

**노틸러스 엔진(NautilusTrader)을 쓰려면** (선택):

1. <https://www.python.org/downloads/> 에서 **Python 3.12, 3.13 또는 3.14** 설치
   (Windows 설치 첫 화면에서 **"Add python.exe to PATH"** 체크)
2. 앱을 다시 켜고 → 백테스트 화면 아래 **노틸러스 엔진** → **노틸러스 설치**
   - 앱 데이터 폴더(`%APPDATA%\Munder Difflin\trading\nautilus\venv`)에 전용 가상환경을 만들고
     `nautilus_trader==1.231.0`을 설치합니다 (수백 MB, 몇 분). 상태가 **준비됨**이 되면 끝.
3. 새 백테스트에서 엔진 **노틸러스 엔진**을 고르고 실행합니다. 결과에 노틸러스 체결 결과와 같은 신호의 내장 리플레이 결과가 함께 나옵니다.

---

## 7. 바이낸스 데모(가짜 돈, 실제 주문 경로)

데모는 실제 바이낸스 주문 API를 그대로 쓰되 가짜 잔고로 체결됩니다. 실거래 전 주문 경로를 검증하는 단계입니다.

1. <https://demo.binance.com> 에 바이낸스 계정으로 로그인
2. 우측 상단 프로필 → **API 관리(API Management)** → **API 생성** → 시스템 생성(HMAC)
3. 생성된 **API Key**와 **Secret Key**를 복사 (Secret은 이때만 보입니다)
4. 앱 → 트레이딩 → 설정 → 바이낸스 API 키
   - **데모 API 키**, **데모 API 시크릿**에 붙여 넣고 각각 **저장**
5. 실행 환경 **바이낸스 데모** → 설정 저장 → **바이낸스 연결 테스트**
   - `데모 계좌 OK — 지갑 … USDT, 가용 …, 단방향 모드` 가 나오면 성공
6. **시작** → 데모 계정의 선물 화면(demo.binance.com)에서 주문, 손절(STOP_MARKET), 익절(TAKE_PROFIT_MARKET)이
   **조건부 주문** 탭에 걸리는지 확인합니다.

> 데모 키와 실거래 키는 서로 쓸 수 없습니다. 데모 키는 반드시 "데모" 칸에 넣으세요.

---

## 8. 실거래 API 자동매매

### 8-1. 바이낸스 준비

1. 바이낸스 앱/웹에서 **USDⓈ-M 선물 계정 개설**(선물 퀴즈 포함)
2. **현물 지갑 → 선물(USDⓈ-M) 지갑으로 USDT 이체** — 처음엔 잃어도 되는 소액만
3. 선물 설정에서 포지션 모드 **단방향(One-way)** 권장 (헤지 모드도 지원)

### 8-2. 자동매매용 API 키 만들기

1. 바이낸스 → 프로필 → **API 관리** → **API 생성** → **시스템 생성(HMAC)** → 이름 예: `munder-trading`
2. 보안 인증 후 생성된 키의 **제한 편집(Edit restrictions)**:
   - ✅ **읽기 활성화**(기본)
   - ✅ **선물 활성화 (Enable Futures)**
   - ❌ **출금 활성화 (Enable Withdrawals)** — **반드시 끔**. 켜져 있으면 데스크가 실거래 시작을 거부합니다.
   - ❌ 현물·마진 거래, 유니버설 이체 — 필요 없으면 끔
   - ✅ **신뢰할 수 있는 IP만 접근 허용** → 내 공인 IP 입력
     (내 IP 확인: 브라우저에서 <https://api.ipify.org>)
3. **저장**. Secret Key는 다시 볼 수 없으니 바로 앱에 넣으세요.

> 가정용 인터넷은 공인 IP가 가끔 바뀝니다. 바뀌면 바이낸스가 `-2015 Invalid API-key, IP, or permissions`를
> 돌려주므로, 그때 API 관리에서 IP를 새로 등록하세요.

### 8-3. 앱에 넣고 검사

1. 트레이딩 → 설정 → 바이낸스 API 키 → **실거래 API 키 / 실거래 API 시크릿** 저장
2. 기본 → 실행 환경 **실거래** → 빨간 경고를 읽고 **"이해했습니다" 체크** → **설정 저장**
3. **바이낸스 연결 테스트**
   - 정상: `실거래 계좌 OK … · 키 권한 OK (선물 거래 가능 · 출금 불가)`
   - 출금 권한이 켜져 있거나 선물 권한이 없으면 빨간 글씨로 이유가 나오고, 데스크도 시작되지 않습니다.
4. 처음 실거래는 리스크를 낮춰서: **거래당 최대 손실 0.25~0.5%**, **최대 레버리지 3~5배**, 종목 하나만
5. **시작**. 헤더에 빨간 `실거래` 표시와 "실거래 중: 주문에 실제 자금이 사용됩니다" 문구가 보입니다.

### 8-4. 자동매매 중 일어나는 일

| 상황 | 데스크가 하는 일 |
|---|---|
| 진입 결정 | 레버리지 설정 → 시장가 진입 → reduce-only 손절(STOP_MARKET)·익절(TAKE_PROFIT_MARKET) 조건부 주문 (마크가격 기준) |
| 손절 주문 실패 | **즉시 시장가 청산** (보호 없는 포지션을 남기지 않음) |
| 거래소에서 손절/익절 체결 | 다음 주기에 감지 → 남은 반대쪽 주문 취소 → 체결 내역으로 손익 기록 → 알림 |
| 반대 방향 결정 | 기존 포지션 청산 후 새 방향 검토 |
| 일일 손실 한도·연속 손실 도달 | 그날 신규 진입 중단 (기존 포지션 관리는 계속) → 알림 |
| 앱 종료·데스크 정지 | 포지션은 그대로, **거래소에 걸린 손절·익절도 유지** |
| 내가 바이낸스에서 직접 연 포지션 | `수동`으로 표시만 하고 건드리지 않음 |

---

## 9. 24시간 운영 설정

트레이딩 → 설정 → **자동매매**

- ✅ **앱을 열면 데스크 자동 시작** — 앱 실행 약 8초 뒤 저장된 모드·환경·종목으로 시작
- ✅ **거래 중 컴퓨터 잠자기 방지** — 데스크가 도는 동안 시스템이 앱을 재우지 못하게 함
- ✅ **데스크톱 알림** — 진입·청산·중단·오류 알림
- ✅ **로그인하면 앱 실행** — 바로 적용됨. 자동 시작과 함께 켜 두면 재부팅 후 앱이 뜨고 데스크도 스스로 시작

그리고 Windows에서:

- Windows **전원 설정 → 화면 및 절전 → 전원 연결 시 절전 모드: 안 함** (노트북이면 덮개 닫기 동작도 "아무 것도 안 함")
- Windows Update 자동 재시작 시간 조정 (활성 시간 설정)

> 실거래 + 자동 시작 조합이면 설정 화면에 빨간 경고가 뜹니다. 앱을 켤 때마다 실제 자금으로 거래가 다시 시작된다는 뜻입니다.

---

## 10. 업데이트하는 법

원본(chaitanyagiri/munder-difflin)에 새 버전이 나오면 포크에 합친 뒤 다시 빌드합니다.

```powershell
cd $HOME\Documents\munder-difflin
git remote add upstream https://github.com/chaitanyagiri/munder-difflin.git   # 처음 한 번만
git fetch upstream
git checkout feat/trading-desk-ko
git merge upstream/main
npm install
npm run dist:win
```

충돌이 나면 대부분 `src/renderer/src/i18n/locales/*.json`(번역 파일)입니다. 양쪽 키를 모두 남기면 됩니다.
합친 뒤 `git push` 하고 **A 방법(Actions → Release → Run workflow, 브랜치 `feat/trading-desk-ko`)** 으로 다시 빌드해도 됩니다.
GitHub 웹에서는 포크 첫 화면의 **Sync fork** 버튼으로 `main`을 원본과 맞춘 뒤, 브랜치에 `main`을 합치면 됩니다.

---

## 11. 문제 해결

| 증상 / 메시지 | 원인과 해결 |
|---|---|
| `-2015 Invalid API-key, IP, or permissions` | 키 오타, IP 제한에 현재 IP 없음, 선물 권한 없음 → API 관리에서 확인 |
| `-1021 Timestamp for this request is outside of the recvWindow` | PC 시계 오차 → Windows 설정 → 시간 및 언어 → **지금 동기화** |
| `-2019 Margin is insufficient` | 선물 지갑 USDT 부족 → 현물에서 이체, 또는 리스크 % 낮추기 |
| `HTTP 451 … 이 지역(IP)에서는 …` | 바이낸스 선물 API가 막힌 지역/IP |
| `418/429 요청 한도 초과` | 잠시 뒤 자동 재시도. 스캘핑 확인 주기를 늘리세요 |
| `Claude 세션 실패` / 분석이 계속 실패 | PowerShell에서 `claude` 실행해 로그인 확인 → 앱 재시작. 안 되면 제공자를 Anthropic API로 변경 |
| `포트폴리오 매니저 JSON을 읽지 못해…` | 그 회차는 주문 없이 등급만 기록됩니다. 반복되면 깊은 모델을 `opus`로 유지 |
| `API 키 권한을 확인하지 못했습니다 (계속 진행)` | api.binance.com 조회 실패. 거래는 계속되며 선물 API가 권한을 다시 검사합니다 |
| 데스크가 시작하자마자 `신규 진입 중단` | 오늘 일일 손실 한도·연속 손실에 이미 도달. UTC 자정(한국 시간 오전 9시)에 초기화 |
| 백테스트 `과거 데이터 다운로드 실패` | `data.binance.vision` 접속 확인. 오늘·어제 파일은 아직 없을 수 있습니다 (그 날은 REST 1분봉으로 대신) |
| 노틸러스 `Python 3.12+ 없음` | Python 3.12~3.14 설치 시 "Add python.exe to PATH" 체크 → 앱 재시작 → 다시 확인 |
| 노틸러스 `설치 실패` | 인터넷·디스크 공간 확인 후 다시 설치. 계속 실패하면 `trading\nautilus` 폴더를 지우고 다시 |
| 노틸러스 `노틸러스 오류: …` | 메시지를 그대로 이슈로 남겨 주세요. 같은 기간을 내장 리플레이로는 돌릴 수 있습니다 |
| 개요에 `백테스트 경험 — … → 진입 안 함` | 그 셋업이 백테스트에서 평균 손실이었습니다. 의도대로면 그대로, 아니면 설정 → 경험 필터 끄기 |

로그와 기록 위치: `%APPDATA%\Munder Difflin\trading\` (`journal.jsonl`, `reports\`, `config.json`)

---

## 체크리스트 (실거래 전)

- [ ] 공식 앱 자동 업데이트 끔
- [ ] 백테스트(체결 테이프)로 여러 기간을 돌려 **수수료 뺀 평균 R이 플러스**인지 확인
- [ ] 모의투자로 하루 이상 돌려 거래내역 확인
- [ ] 데모에서 진입·손절·익절 주문이 바이낸스 화면에 실제로 걸리는 것 확인
- [ ] 실거래 키: 선물 ON, **출금 OFF**, IP 제한 ON
- [ ] 연결 테스트에서 "키 권한 OK"
- [ ] 거래당 손실 0.25~0.5%, 레버리지 3~5배로 시작 (스캘핑 75배는 백테스트·데모에서 충분히 확인한 뒤)
- [ ] 알림 켜고, 첫 며칠은 직접 지켜보기
