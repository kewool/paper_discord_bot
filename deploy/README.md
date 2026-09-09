# Paper League Docker 운영 배포

이 디렉터리는 기존 HTTPS Nginx 컨테이너 뒤에 Paper League를 붙이는 예시입니다. 앱은 `paper-league` 서비스로 실행되고 내부 `0.0.0.0:3000`에서만 HTTP를 받습니다. 호스트 포트는 공개하지 않으며, TLS와 도메인 처리는 기존 Nginx가 계속 담당합니다.

## 1. 환경값과 네트워크

프로젝트 루트에서 `deploy/.env.example`을 `.env`로 복사한 뒤 봇 토큰, 애플리케이션 ID, 디스코드 서버 ID, 채널 ID를 입력합니다. 이미 설정한 `.env`가 있다면 덮어쓰지 않고 필요한 값만 추가하세요. 특히 다음 값은 실제 공개 주소와 기존 프록시 네트워크에 맞춰 설정합니다.

```dotenv
PUBLIC_URL=https://their.domain
NGINX_NETWORK=their_existing_network
```

`compose.yaml`은 운영 모드, 내부 수신 주소, 데이터 경로와 프록시 신뢰 홉 수를 직접 지정합니다. Nginx 한 대가 HTTPS를 종료하는 구성이며 앱은 일반 사용자 `node`(UID 1000)로 실행됩니다. 호스트 디렉터리를 bind mount하도록 변경하면 이 계정의 쓰기 권한도 맞춰야 합니다.

`PUBLIC_URL`에는 경로를 붙이지 않습니다. `NGINX_NETWORK`에는 임의의 이름을 쓰지 말고, 기존 Nginx 컨테이너가 실제로 연결된 네트워크 이름을 확인해 입력하세요.

```powershell
docker inspect existing_nginx_container --format '{{json .NetworkSettings.Networks}}'
```

`existing_nginx_container`는 실제 Nginx 컨테이너 이름으로 바꿉니다. 앱과 Nginx가 같은 외부 Docker 네트워크에 있어야 하며, Nginx Compose 프로젝트를 관리하고 있다면 일회성 `docker network connect`보다 해당 Compose 파일에 이 외부 네트워크를 영구적으로 선언하는 방법을 사용하세요. 앱의 기본 네트워크는 Discord, arXiv, OpenAI로 나가는 통신에 사용됩니다.

## 2. 빌드와 Codex 로그인

운영 의존성만 사용하는 이미지이므로 먼저 이미지를 빌드합니다.

```powershell
docker compose build --pull
docker compose run --rm paper-league codex login status
```

로그인되어 있지 않다면 다음 명령으로 기기 인증을 완료합니다.

```powershell
docker compose run --rm paper-league codex login --device-auth
```

기기 인증이 계정에서 허용되어 있어야 합니다. 로그인 상태는 `codex-auth` named volume에 저장되며, 같은 운영 계정으로 실행하는 컨테이너가 이를 사용합니다. 자격 증명이나 토큰을 `.env`, 이미지, 저장소에 복사하지 마세요.

## 3. 최초 등록과 시작

명령어 등록과 arXiv 후보 동기화는 한 번 실행합니다. 반드시 빌드된 JS를 직접 실행하세요.

```powershell
docker compose run --rm paper-league node dist/scripts/register-commands.js
docker compose run --rm paper-league node dist/scripts/sync-arxiv.js --count 2
docker compose run --rm paper-league node dist/scripts/admin.js status
docker compose up -d
docker compose logs -f --tail 100 paper-league
```

`register-commands.js`는 Discord 명령어를 등록하고, `sync-arxiv.js`는 라이선스를 확인할 수 있는 후보를 준비합니다. 봇을 디스코드 서버에 초대하고 지정 채널의 보기·메시지·임베드·첨부 파일 권한을 먼저 설정하세요. 애플리케이션 명령어 스코프는 `applications.commands`, 봇 설치 스코프는 `bot`입니다.

## 4. 기존 Nginx에 연결

`deploy/nginx/paper-league.conf.example`의 내용을 기존 HTTPS `server {}` 블록에 넣습니다. `location /`은 요청 경로와 쿼리를 그대로 백엔드에 전달하며, `paper-league:3000`을 Docker embedded DNS로 조회합니다. Nginx 컨테이너 안에서 Docker DNS를 사용할 수 있어야 합니다.

정적 파일 별칭이나 PDF 파일 경로를 Nginx에 추가하지 마세요. 웹은 논문 열람만 제공하고, 원문 데이터는 앱의 비공개 데이터 디렉터리에서 처리합니다. WebSocket 업그레이드 설정은 필요하지 않습니다.

기존 Nginx 컨테이너에서 설정을 검사하고 graceful reload를 수행합니다. 아래 명령의 컨테이너 이름과 설정 경로는 기존 운영 환경의 값으로 바꾸세요.

```sh
docker exec existing_nginx_container nginx -t
docker exec existing_nginx_container nginx -s reload
```

## 5. 데이터와 업데이트

`data` named volume은 `/app/data`, `codex-auth` named volume은 `/home/node/.codex`에 마운트됩니다. 두 볼륨은 업데이트나 `docker compose down` 뒤에도 유지하세요. `docker compose down -v`는 사용하지 마세요. `name: paper-league`와 프로젝트 이름을 유지해야 기존 볼륨이 연결됩니다. 현재 앱은 하나의 프로세스로 운영하며 `--scale`로 복제하지 않습니다.

```sh
docker compose build --pull
docker compose up -d
docker compose ps
```

`restart: unless-stopped` 설정으로 재부팅 뒤 자동 시작과 비정상 종료 후 재시작을 처리합니다. `healthy`는 웹 프로세스의 응답 확인이며 Discord 연결이나 Codex 로그인 상태까지 보장하지는 않습니다.

파일 단위로 백업할 때는 `docker compose stop paper-league`로 앱을 중지한 뒤 데이터 볼륨 전체를 복사하고 `docker compose start paper-league`로 다시 시작하세요. 운영 DB·논문 이미지가 있는 `data` 볼륨과 Codex 인증이 있는 `codex-auth` 볼륨은 각각 백업합니다. Codex 인증 볼륨은 로그인 갱신을 위해 쓰기 가능해야 하며, 백업 역시 운영자만 접근할 수 있도록 보관합니다.

Windows에서 사용하던 기존 DB를 Linux named volume으로 그대로 복사해도 `papers.directory`에 저장된 절대 호스트 경로가 자동으로 바뀌지 않습니다. 기존 운영 데이터를 옮겨야 한다면 경로 매핑과 이미지 재생성을 별도로 검토해야 하며, 새 배포는 arXiv 동기화로 데이터를 시드하는 방식을 권장합니다. 이 문서는 기존 데이터의 자동 마이그레이션이나 삭제를 수행하지 않습니다.

2026-09-10에 Linux Docker 이미지 빌드, Codex CLI 실행, Nginx 설정 검사와 자체 서명 인증서를 사용한 HTTPS 프록시 연결을 확인했습니다. 별도 임시 데이터로 PDF 변환·PNG 응답, Secure/HttpOnly 쿠키, 종료 후 이미지 410 응답을 확인했고, 앱 IP가 바뀌도록 컨테이너를 재생성한 뒤에도 Nginx 재시작 없이 연결과 세션·종료 시각·Codex 볼륨이 유지됐습니다. 임시 테스트는 실제 Discord나 Codex 평가 요청을 보내지 않았습니다. 실제 운영 Nginx의 인증서·도메인과 Discord 명령어, 컨테이너의 ChatGPT 로그인·평가는 서버에서 연결한 뒤 확인해야 합니다.

참고 문서: [Docker Compose 네트워킹](https://docs.docker.com/compose/how-tos/networking/), [Nginx proxy 모듈](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [헤드리스 기기 Codex 로그인](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
