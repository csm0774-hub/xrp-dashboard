# XRP 실시간 기능 대시보드 (서버판)

화면을 닫아도 **15분마다 XRP 원장을 빠짐없이 기록**하고, 조건에 맞는 이벤트를 **텔레그램으로 알려주는** 대시보드입니다.
GitHub의 무료 기능 두 가지를 씁니다.

- **GitHub Actions**: 15분마다 자동 실행 → 지난 실행 이후 확정된 원장을 모두 읽어 `data/` 폴더에 기록하고 텔레그램 알림 전송
- **GitHub Pages**: `index.html`을 `https://사용자명.github.io/xrp-dashboard/` 주소로 열어 줌 → 휴대폰·PC 어디서나 같은 기록을 봄

비용: 무료 (저장소를 **Public(공개)**로 만들어야 Actions 시간이 무제한입니다)

---

## 설치 (PC에서 약 15분)

### 1. GitHub 저장소 만들기
1. https://github.com 가입 후 로그인
2. 오른쪽 위 **+** → **New repository**
3. Repository name: `xrp-dashboard` / **Public** 선택 → **Create repository**

### 2. 파일 올리기
1. 받은 zip 파일의 압축을 풉니다.
2. 새 저장소 화면에서 **uploading an existing file** 클릭
3. 압축을 푼 폴더 **안의 내용 전부**(`index.html`, `config.json`, `README.md`, `collector` 폴더, `.github` 폴더)를 끌어다 놓고 **Commit changes**
   - ⚠ `.github` 폴더는 맥에서 숨김 폴더입니다. Finder에서 `Cmd + Shift + .` 을 누르면 보입니다.
   - `.github` 폴더가 안 올라갔다면: 저장소에서 **Add file → Create new file** → 파일 이름 칸에 `.github/workflows/collect.yml` 입력 → zip 안의 같은 파일 내용을 붙여넣고 저장

### 3. 텔레그램 봇 만들기
1. 텔레그램에서 **@BotFather** 검색 → `/newbot` 입력 → 봇 이름 두 번 입력
2. 받은 **토큰**(예: `123456789:ABCdef...`)을 복사해 둡니다.
3. 방금 만든 봇과 대화방을 열고 아무 메시지나 보냅니다 (예: `안녕`).
4. 브라우저에서 아래 주소를 엽니다 (`<토큰>` 자리에 토큰 붙여넣기)
   `https://api.telegram.org/bot<토큰>/getUpdates`
5. 화면에서 `"chat":{"id":123456789` 의 **숫자**가 채팅 ID입니다.

### 4. 저장소에 비밀값 넣기
저장소 **Settings → Secrets and variables → Actions → New repository secret** 에서 두 개를 추가합니다.

| Name | Secret |
|---|---|
| `TELEGRAM_BOT_TOKEN` | 3번의 토큰 |
| `TELEGRAM_CHAT_ID` | 3번의 채팅 ID 숫자 |

(비밀값은 공개 저장소여도 다른 사람에게 보이지 않습니다.)

### 5. 첫 수집 실행
1. 저장소 **Actions** 탭 → 안내가 나오면 **I understand my workflows, go ahead and enable them**
2. 왼쪽 **XRP 데이터 수집** → 오른쪽 **Run workflow** → **Run workflow**
3. 1~3분 뒤 초록색 체크가 뜨면 성공입니다. `data` 폴더가 생기고 텔레그램에 알림이 오기 시작합니다.
   - 빨간 X가 뜨면 실행 기록을 눌러 오류를 확인하세요. `Permission denied`·`403` 이면 **Settings → Actions → General → Workflow permissions → Read and write permissions** 로 바꾼 뒤 다시 실행합니다.

이후에는 15분마다 자동으로 실행됩니다.

### 6. 대시보드 주소 열기
1. **Settings → Pages → Build and deployment**
2. Source: **Deploy from a branch** / Branch: **main**, 폴더 **/ (root)** → **Save**
3. 1~2분 뒤 `https://사용자명.github.io/xrp-dashboard/` 로 접속됩니다.
4. 휴대폰 Chrome에서 이 주소를 열고 메뉴 → **홈 화면에 추가** 하면 앱처럼 쓸 수 있습니다.

> 이전처럼 파일로 열어도 됩니다. **내 설정 → 서버 연동**에 `사용자명/xrp-dashboard` 를 입력하고 **연결**을 누르면 서버 기록을 불러옵니다.

---

## 텔레그램 알림 종류

| 알림 | 기본 기준 | `config.json` 항목 |
|---|---|---|
| 🐋 고래 송금 | 1,000만 XRP 이상 | `whaleXRP` |
| 💵 RLUSD 대량 전송 | 500만 달러 이상 | `rlusdUSD` |
| 🔒 에스크로 잠금·해제·취소 | 1억 XRP 이상 | `escrowXRP` |
| 📈📉 가격 상한·하한 돌파 | 꺼짐(0) | `priceHighKRW`, `priceLowKRW` (원) |
| 🇰🇷 김치 프리미엄 | ±3% 이상 | `kimchiPct` |
| ⬆️ 업그레이드 80% 도달·활성화 | 항상 | — |
| 👛 내 관심 주소 입출금 | 주소 등록 시 | `watch` |
| 📊 일일 요약 | 매일 오전 9시 이후 첫 실행 | `dailySummaryHourKST` (-1이면 끔) |

한 번에 알림이 너무 많으면(기본 15건 초과) 나머지는 한 메시지로 묶어 보냅니다.

### 기준 바꾸기
저장소에서 `config.json` → 연필 아이콘(Edit) → 숫자 수정 → **Commit changes**. 다음 실행부터 적용됩니다.

```json
"alerts": {
  "whaleXRP": 10000000,
  "priceHighKRW": 2000,
  "priceLowKRW": 1200
},
"watch": [
  { "addr": "r로 시작하는 주소", "label": "내 지갑" }
]
```

⚠ 공개 저장소라서 `config.json`에 적은 **관심 주소는 누구나 볼 수 있습니다.** 본인 지갑 주소를 공개하기 싫다면 비워 두세요.

---

## 알아둘 점
- **수집 간격**: 15분마다 실행되지만 GitHub 사정으로 몇 분~수십 분 늦어질 수 있습니다. 늦어져도 그 사이 원장을 모두 이어서 읽기 때문에 기록은 빠지지 않습니다. 단, 2시간 넘게 멈추면 가장 최근 1,500개 원장(약 1.6시간)만 읽고 그 이전은 건너뜁니다.
- **알림 지연**: 이벤트가 생긴 뒤 알림까지 최대 15분 이상 걸릴 수 있습니다. 즉시 알림은 대시보드 화면을 열어 둔 동안에만 옵니다.
- **기록 보관**: 최근 48시간은 1분 단위, 30일까지는 15분 단위, 1년까지는 1시간 단위로 `data/history.json`에 저장됩니다.
- **자동 실행 중단**: GitHub는 60일 동안 저장소 활동이 없으면 예약 실행을 멈출 수 있습니다. 대시보드 **서버 연동** 카드에 "멈춰 있습니다"가 뜨면 Actions 탭에서 다시 켜 주세요.
- **데이터 출처**: XRPL 공개 노드(xrplcluster.com, ripple.com), CoinGecko, 업비트. 투자 판단의 참고용이며 투자 조언이 아닙니다.

## 파일 구성
```
index.html                   대시보드 화면
config.json                  알림 기준·관심 주소·수집 설정
collector/collect.mjs        수집기 (Node 22, 외부 패키지 없음)
collector/lib.mjs            거래 분류·기록 계산
.github/workflows/collect.yml  15분마다 실행 설정
data/                        수집 결과 (첫 실행 후 자동 생성)
```
