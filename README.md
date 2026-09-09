# Paper League

디스코드에서 하루 한 편을 함께 읽고, 제한 시간 안에 작성한 요약을 Codex가 평가하는 봇입니다. 같은 날에는 모든 참가자에게 같은 무작위 논문을 제공합니다. **웹은 논문 열람만 담당하며, 정리 제출·평가 결과·순위는 모두 디스코드에서 확인합니다.**

## 참가 흐름

1. 봇이 지정 채널에 매일 공지합니다. 참가자는 **내 전용 링크 받기** 버튼이나 `/paper`를 사용합니다.
2. 봇이 디스코드 사용자 ID와 서버·역할을 확인하고 본인에게만 보이는 일회용 링크를 발급합니다. 웹에서 디스코드 OAuth 로그인은 하지 않습니다.
3. 링크는 15분 동안 유효합니다. 웹의 **이 링크로 참여하기**를 누를 때 원자적으로 사용 처리하고 HttpOnly 세션 쿠키로 전환합니다. 링크 미리보기나 단순 GET 요청은 토큰을 소비하지 않습니다.
4. **읽기 시작하기**를 누르면 기본 30분의 열람 시간이 시작됩니다. 논문은 서버에서 변환한 PNG를 한 페이지씩 받으며 디스코드 ID·날짜·만료 시각이 이미지 픽셀에 찍힙니다. **다른 창·탭으로 이동하거나 열람 페이지를 떠나면 남은 열람 시간도 즉시 종료됩니다.** 시작 전에 화면에서 이 조건을 안내합니다.
5. 시간이 끝나거나, 포커스를 잃거나, **읽기 종료하기**를 누르면 원문 접근을 차단하고 기본 20분의 작성 시간이 시작됩니다. 종료는 되돌릴 수 없습니다. 다시 돌아오거나 링크를 재발급해도 해당 논문을 재열람할 수 없습니다. 웹은 남은 제출 시간과 디스코드 복귀 안내만 보여 줍니다.
6. 디스코드에서 **`/submit`**을 실행하여 작성 창을 엽니다. 문제·기여, 방법론, 결과·근거, 한계, 자신의 종합을 각 30~2,300자로 작성하고 한 번 제출합니다. 작성 창에는 제출 마감과 Codex 채점 안내가 표시됩니다. 작성 창을 다시 열어도 마감은 연장되지 않으며, 전날 작성 창이나 마감 후 제출은 거부합니다.
7. 접수 확인은 본인에게만 보입니다. **`/my-score`**로 현재 상태·100점 만점 결과·항목별 피드백을 확인합니다. 긴 피드백은 전체 내용을 텍스트 파일로 함께 제공합니다. **`/ranking`**은 오늘 순위, **`/ranking period:최근 7일`**은 주간 누적 순위입니다. 웹에는 작성 폼, 제출 API, 점수·피드백·순위가 없습니다.

**링크 재발급, 새로고침, 재로그인, 서버 재시작으로 이미 시작한 열람 시간이 초기화되지 않습니다.** 링크를 발급받기만 해서는 읽기 타이머가 시작되지 않습니다. 사용 전 링크를 다시 발급하면 이전 미사용 링크는 폐기됩니다. 세션은 해당 라운드가 끝날 때 만료됩니다. 이 방식에서 링크는 소지자가 사용할 수 있는 인증 수단이므로, 봇은 공개 채널에 개인 링크를 올리지 않습니다.

## 바로 체험하기

Node.js 22.13 이상이 필요합니다. 이 작업에서는 Windows의 Node 22.17로 확인했습니다.

```powershell
cd D:\project\paper_discord_bot
npm install
npm run demo
```

[로컬 데모](http://localhost:3000)를 열어 **데모로 열람하기**를 누르세요. 데모는 별도 `data/demo` 데이터베이스에 직접 만든 3쪽 연습용 글을 사용하며, 시간 제한 열람과 종료 안내를 체험할 수 있습니다. 웹에서 정리를 제출하거나 점수를 표시하지 않습니다. 실제 제출·평가는 디스코드 운영 설정 후 사용합니다. 종료는 실행 터미널에서 Ctrl+C입니다.

## 디스코드에서 운영하기

**Docker Compose + 기존 Nginx 컨테이너로 배포하려면 [컨테이너 배포 안내](deploy/README.md)를 사용해 주세요.** 루트 `compose.yaml`에 앱과 영구 볼륨을 정의하고, 기존 Nginx의 외부 Docker 네트워크에 연결합니다. 아래 명령은 Docker를 사용하지 않고 직접 실행할 때의 절차입니다.

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 애플리케이션과 Bot을 만드세요.
2. Bot 설치 스코프는 `bot`, `applications.commands`입니다. 지정 채널에서 **View Channel**, **Send Messages**, **Embed Links**, **Attach Files**, **Read Message History** 권한을 허용하세요. Message Content 같은 privileged intent는 사용하지 않습니다. 일반 메시지를 읽는 대신 `/submit`의 작성 창 제출 이벤트를 처리합니다.
3. `.env.example`을 `.env`로 복사하고 `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`를 로컬에서 입력하세요. 필요하면 `DISCORD_ALLOWED_ROLE_ID`로 참가 역할을 제한합니다. **사용자 OAuth용 Client Secret/redirect URI는 필요 없습니다.**
4. 참가자가 접속할 HTTPS 주소를 `PUBLIC_URL`에 입력하세요. 실제 공개 주소와 정확히 일치해야 합니다. HTTPS reverse proxy 뒤에서는 `HOST=127.0.0.1`, `TRUST_PROXY_HOPS=1`, `NODE_ENV=production`을 사용하고 Node 포트를 직접 공개하지 마세요. 프록시가 여러 단계일 때만 홉 수를 맞춥니다.
5. 봇을 실행할 운영체제 계정으로 `codex login status`를 확인하세요. 필요한 경우 `codex login`으로 ChatGPT 로그인을 완료합니다. OAuth 토큰을 앱 코드나 `.env`에 복사하지 않습니다.
6. 아래 arXiv 동기화로 후보를 준비하고 명령어를 등록한 뒤 실행하세요. 자동 수집을 켜면 실행 중에도 후보를 보충합니다.

```powershell
Copy-Item .env.example .env
# .env 편집 후 실행
npm run bot:register
npm run build
npm start
```

`Copy-Item`은 최초 설정 때 한 번만 실행해 주세요. 설정한 `.env`를 덮어쓰지 마세요. 개발 중에는 `npm run dev`를 사용할 수 있습니다. 실제 운영에는 프로세스가 계속 실행되어야 하며 컴퓨터가 꺼져 있는 동안에는 공지나 채점이 실행되지 않습니다. 별도 Windows 예약 작업이나 Codex 예약 자동화는 만들지 않습니다.

이전 버전에서 업데이트했다면 `npm run bot:register`를 다시 실행하여 새 `/submit` 명령어를 등록하고 봇을 재시작하세요. 기존 열람 시간·제출 기록·점수는 보존됩니다. 등록되는 명령어는 `/paper`, `/submit`, `/my-score`, `/ranking` 네 개입니다.

## 분야 제한 없는 arXiv 수집

기본 소스는 arXiv입니다. `ARXIV_ENABLED=true`이면 시작 직후와 이후 매시간 미사용 후보 수를 확인하고, 기본 7편보다 적으면 최대 2편씩 보충합니다. 분야 필터를 두지 않고 최근 365일의 최신 결과 일부를 무작위로 섞어 후보를 찾습니다. 전 논문 전체에 대한 균등 추출이나 학회 채택 논문만의 목록은 아닙니다. 날짜별 실제 출제는 하루 한 번 고정됩니다.

```powershell
npm.cmd run paper:sync -- --count 2
npm.cmd run admin -- status
```

Windows PowerShell에서 옵션이 있는 명령은 `npm.cmd`를 사용하면 `--count`, `--file` 등이 npm 옵션으로 잘못 해석되지 않습니다. `ARXIV_ENABLED=false`로 자동 수집을 끄고 직접 등록한 PDF만 사용할 수도 있습니다. 소스 요청은 3초 이상의 간격으로 직렬 실행하며, 403·429 응답을 받으면 중단하고 다음 동기화 때 다시 확인합니다. 한 번에 라이선스 페이지를 최대 12개까지만 확인합니다.

서버에서 페이지 이미지를 재제공하므로 **실제 라이선스 링크에서 CC BY 또는 CC0가 확인되는 논문만** 자동 등록합니다. 라이선스·저자·출처와 arXiv 버전을 저장하고, 원문을 PNG로 바꿨다는 표시와 출처·라이선스를 이미지 아래에 남깁니다. 지원 길이를 넘거나 텍스트 변환이 불가능한 자료는 건너뜁니다.

NeurIPS 같은 학회 논문도 저자가 arXiv에 함께 게시할 수 있습니다. 예를 들어 Attention Is All You Need는 [NIPS 2017 논문집](https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html)과 [arXiv](https://arxiv.org/abs/1706.03762)에 모두 있습니다. 그러나 arXiv는 직접 동료심사를 하지 않으며, 등록만으로 학회 채택 여부가 확인되지는 않습니다. 저자의 comment·journal reference는 별도로 저장하되 채택 인증으로 취급하지 않습니다.

수집 기준: [arXiv 소개](https://info.arxiv.org/about/index.html), [API 이용 안내](https://info.arxiv.org/help/api/tou.html), [라이선스 안내](https://info.arxiv.org/help/license/index.html).

## PDF 직접 등록

운영자가 등록한 PDF도 후보에 넣을 수 있습니다. 원문·변환 이미지는 공개 정적 폴더에 놓지 않습니다. 참가자에게 사용·제공할 수 있는 자료를 등록하세요.

```powershell
npm.cmd run paper:import -- --file "D:\papers\example.pdf" --title "논문 제목" --authors "저자 이름" --source "https://example.org/paper" --license "CC BY 4.0"
npm.cmd run admin -- papers
```

가져오기는 최대 40MB·40쪽·추출 본문 120,000자를 지원합니다. 채점할 본문이 없는 스캔 PDF는 거부합니다. 수식·그림은 원래 페이지의 이미지로 보이지만 **채점은 추출 텍스트를 기준으로 하므로 복잡한 그림·수식 중심 논문은 별도 검토가 필요합니다.** 원본 파일은 원래 위치에 그대로 두며, 앱의 `data/production/papers`에는 페이지 이미지만 만듭니다. 이미지 파일만으로는 채점할 수 없어 본문은 비공개 SQLite에 저장합니다.

이미 선정된 오늘의 논문은 중간에 바뀌지 않습니다. 논문을 여러 편 등록하면 최근 사용한 논문을 피하여 한 바퀴를 돌도록 선정합니다. 후보가 적은 경우 순환하여 재사용됩니다.

## 시간·평가·순위

| 설정      | 기본값                      |
| --------- | --------------------------- |
| 날짜 기준 | `TIME_ZONE=Asia/Seoul`      |
| 하루 시작 | `DAILY_RELEASE_HOUR=9`      |
| 열람      | `READING_MINUTES=30`        |
| 작성      | `WRITING_MINUTES=20`        |
| 채점 모델 | `CODEX_MODEL=gpt-5.6-terra` |
| 평가 제한 | `CODEX_TIMEOUT_SECONDS=180` |

다음 날 09시가 라운드 마감입니다. 전체 열람·작성 시간을 보장할 수 없으면 새 참여를 받지 않습니다. 라운드를 만들 때 시간과 모델·평가 기준 버전을 저장하므로 설정을 바꿔도 진행 중인 라운드에는 적용되지 않습니다.

채점 기준은 문제와 핵심 기여 25, 방법론 25, 결과와 근거 25, 한계와 비판적 사고 15, 정리의 명료성 10입니다. 모델의 JSON을 검사하고 합계는 서버가 계산합니다. 동일한 합계는 공동 순위입니다. 오늘 순위와 최근 7일 **합산 점수**를 별도로 표시하고 참여 횟수도 함께 보여 줍니다. 하루 한 번만 점수에 반영됩니다.

Codex SDK는 운영자의 기존 ChatGPT 로그인으로 서버에서 실행됩니다. 브라우저에는 OpenAI 자격 증명을 보내지 않습니다. 원문과 제출문을 평가 자료로 전달하며 도구·웹 검색·MCP·플러그인 사용을 끄고 읽기 전용 실행을 요청합니다. 실패하면 점수를 만들어 넣지 않고 최대 3회 재시도합니다. AI 평가 결과는 동일한 기준을 적용해도 변동할 수 있습니다.

```powershell
npm.cmd run admin -- status
npm.cmd run admin -- retry <실패한 제출 ID>
```

재시도는 실패한 제출만 같은 내용으로 다시 처리합니다. 이미 확정된 점수나 제출 시간을 바꾸는 명령은 없습니다.

## 열람 제한의 범위

텍스트 선택·복사와 원본 PDF 다운로드 UI를 제공하지 않으며, 이미지 응답마다 계정·서버 시간을 검사합니다. 응답은 `Cache-Control: private, no-store`이고 만료 후 요청은 410입니다. 웹 화면도 만료되면 캔버스를 지웁니다. 원문을 공개 URL로 제공하지 않습니다.

포커스 이탈·탭 숨김·페이지 이탈 시 캔버스를 즉시 지우고, 요청 중인 이미지도 중단합니다. 동시에 해당 열람 기록을 지정하여 서버에 영구 종료를 요청합니다. 종료 확인이 지연되어도 이미지가 다시 그려지지 않으며, 연결이 끊겼으면 종료 시각만 로컬에 보관했다가 재전송합니다. 재접속 시점이 아니라 기록한 종료 시각을 기준으로 작성 마감을 계산하므로 재접속으로 시간이 추가되지 않습니다. 서버는 제출자의 현재 열람 기록을 확인하고 마감 시간이 연장되지 않도록 제한합니다. 브라우저가 이벤트를 전달하는 방식이므로 클라이언트를 고의로 변조하는 행위까지 막는 보호는 아닙니다.

이미 받은 이미지를 외부에 저장하거나 화면을 촬영하는 것, OCR, 공개된 논문의 제목을 검색하는 것까지 막는 DRM은 아닙니다. 연결이 끊겨도 일반 브라우저의 타이머는 열람 화면을 정리하지만, 이미 수신한 데이터 자체를 원격 삭제할 수는 없습니다.

## 검증

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:browser
# 실제 ChatGPT/Codex 사용량을 사용하는 단일 평가 확인
npm run grade:smoke
```

핵심 API·DB·Discord SDK 검사 6개와 실제 Chromium 사용자 흐름 1개를 사용합니다. 웹 제출 경로 제거와 점수·본문 미노출, 실제 discord.js 객체를 통한 작성 창 생성·제출·전체 피드백 직렬화, 제출자의 역할·계정·라운드·마감, PDF 전체 본문 보존, 일회용 토큰, 시간 유지, 평가 재시도·동점 순위, 지연 수신된 포커스 이탈의 영구 종료를 확인합니다. Discord 네트워크 응답은 테스트 안에서 대체하며 외부 메시지는 보내지 않습니다. 브라우저 검사는 12초 열람·30초 작성의 별도 환경에서 포커스 이탈 이벤트에 따른 즉시 화면 제거, 오프라인 종료 기록 보존과 재전송, 재열람 차단, 디스코드 복귀 안내와 모바일 화면을 확인합니다.

이 작업에서 실제 Codex SDK가 테스트 요약을 평가하여 항목 5개·합계 39점을 반환한 것을 확인했습니다. 자동 검사에서 사용하는 69점은 이 실제 평가와 무관한 고정 예시입니다. 디스코드 봇 토큰이 없어 실제 서버의 공지 발송·명령어·작성 창 실행은 아직 확인하지 않았습니다.

arXiv에서도 CC BY 4.0의 실제 수학 논문 한 편을 API → 라이선스 확인 → PDF 다운로드 → 26쪽 이미지와 전체 본문 추출까지 확인했습니다. 테스트 자료는 `work/arxiv-live-import`에 있습니다.

## 구성 및 데이터

- `src/bot.ts`: 개인 링크, 디스코드 작성 창과 제출·평가 피드백·순위, 일일 공지
- `src/auth.ts`: 일회용 토큰 소비, 라운드 세션, CSRF
- `src/league.ts`, `src/store.ts`: 일일 무작위 배정, 시간·제출·대기열·순위와 SQLite
- `src/papers.ts`: 비공개 PDF 이미지 변환과 개인 워터마크
- `src/arxiv.ts`: 분야 제한 없는 arXiv 후보 수집과 라이선스 확인
- `src/grader.ts`: Codex SDK와 구조화된 평가
- `src/server.ts`, `public/`: 웹 API와 제한 시간 뷰어
- `data/production`: 운영 DB·논문 이미지. 백업할 때 앱을 종료한 후 폴더 전체를 복사하세요.
- `data/demo`: 로컬 체험 기록. `work/`: 테스트 자료와 중간 결과. 둘 다 운영과 분리됩니다.

이 버전은 단일 디스코드 서버와 단일 상시 실행 프로세스를 대상으로 합니다. 다중 인스턴스/대규모 서비스 배포는 별도 작업이 필요합니다.

연동 근거: [공식 Codex SDK 문서](https://learn.chatgpt.com/docs/codex-sdk), [Codex 인증 문서](https://learn.chatgpt.com/docs/auth), [Discord 봇 인증 문서](https://docs.discord.com/developers/topics/oauth2#bot-users), [Discord 상호작용 응답](https://docs.discord.com/developers/interactions/receiving-and-responding), [Discord 작성 창 구성](https://docs.discord.com/developers/components/reference#text-input).
