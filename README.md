# url-shortner

혼자 쓰는 단축 주소 서비스. 수업·강의에서 `s.example.com/과제1` 같은 짧은 주소를 나눠주는 용도로 만들었다.

- 원하는 단어로 단축 주소 만들기 (한글 가능, 영문 대소문자 구분 없음, 비워두면 자동 생성)
- 관리자 화면: 접속 수, 오늘 접속 수, 최근 접속 시각, 일별 접속 그래프
- 목적지·단어·메모·만료일 수정, 삭제
- QR 코드 (교실 화면용 전체 화면, PNG 저장)
- 링크 미리보기 봇(카톡·디스코드·슬랙 등)의 접속은 집계에서 제외
- 디자인: Neo-Brutalism

Node 24(내장 `node:sqlite`) + Express, 데이터는 `data/links.db`(SQLite) 하나다.

## 설정

`.env.example` 을 `.env` 로 복사해서 고친다.

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `BASE_URL` | ✅ | `http://localhost:3000` | 단축 주소 앞부분. 경로·끝 `/` 없이 (예: `https://s.example.com`) |
| `ADMIN_PASSWORD` | ✅ | — | 관리자 화면(`/admin`) 비밀번호. 8자 이상 (예시값 `change-me` 는 거부). 바꾸면 기존 로그인이 모두 풀린다 |
| `SITE_NAME` | | `단축 주소` | 화면 제목·로고 |
| `TIME_ZONE` | | `Asia/Seoul` | 일별 접속 수·만료일 기준 시간대 (IANA 이름) |
| `PROXY_NETWORK` | | `proxy` | 리버스 프록시가 붙어 있는 도커 네트워크 (compose 용) |
| `PORT` | | `3000` | 컨테이너 안에서 듣는 포트 |
| `DATA_DIR` | | `./data` | DB·세션 키 저장 위치 |

## 로컬에서 실행

```sh
npm install
ADMIN_PASSWORD=test-password node server.js
# http://localhost:3000/admin
```

## 서버 배포 (Docker + nginx)

리버스 프록시(nginx)가 도커 네트워크 `PROXY_NETWORK` 에 있고, `url-shortner` 컨테이너 이름으로 접근한다고 가정한다.

1. DNS 에 단축 주소 도메인의 A 레코드를 서버 IP 로 추가한다.
2. `cp .env.example .env` 후 값을 채운다.
3. 데이터 폴더를 만들고 컨테이너 사용자(`node`, uid 1000)에게 넘긴 뒤 실행한다.
   폴더가 없으면 도커가 root 소유로 만들어서 DB 를 쓰지 못한다.
   ```sh
   mkdir -p data && sudo chown 1000:1000 data
   docker compose up -d --build
   ```
4. nginx 설정 만들기:
   ```sh
   DOMAIN=s.example.com envsubst '$DOMAIN' < nginx/shortener.conf.template > s.example.com.conf
   ```
   인증서가 아직 없으면 443 블록 때문에 nginx 가 설정을 거부한다. 처음에는 **80 블록만** 넣고 reload 한 뒤 인증서를 받는다.
   ```sh
   certbot certonly --webroot -w /var/www/acme -d s.example.com
   ```
   그다음 전체 설정으로 바꾸고 nginx 를 reload 한다.

데이터 백업은 `data/` 폴더를 복사하면 된다.

## 코드 고친 뒤

```sh
docker compose up -d --build
```
