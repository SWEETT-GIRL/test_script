# 빵긋 k6 부하테스트

빵긋 BE 를 1,000 → 1,500 → 2,000 RPS 로 점진 증가시키며 성능을 확인하는 k6 부하테스트 모음.

- 시나리오 작성 규약은 [`CLAUDE.md`](./CLAUDE.md) 를 따른다(담당자 공통 프롬프트).
- 부하 프로파일·threshold·태그는 [`lib/config.js`](./lib/config.js) 가 고정한다. 시나리오는 직접 stages/executor 를 쓰지 않는다.

## 디렉터리 구조

```
loadtest/
├── README.md          # (이 파일) 셋업 / 실행 가이드
├── CLAUDE.md          # 시나리오 작성 공통 프롬프트 (담당자 사용)
├── lib/               # 공유 인프라 (수정 금지, import 만)
│   ├── config.js      # BASE_URL, LOAD_LEVEL→stages, thresholds, getOptions()
│   ├── auth.js        # tokens.csv → SharedArray, pickToken()
│   ├── data.js        # locations/search-queries → pickLocation()/pickQuery()
│   ├── http.js        # apiGet/apiPost/... 래퍼 (Bearer·name 태그·ApiResponse 파싱)
│   ├── checks.js      # checkOk(res): http 200 && body.success === true
│   └── think.js       # think(): 단계 사이 랜덤 sleep
├── data/
│   ├── tokens.csv         # member_id,access_token (사전 발급, gitignore — 커밋 금지)
│   ├── tokens.sample.csv  # 예시 토큰 (커밋됨)
│   ├── locations.csv      # name,lat,lon
│   └── search-queries.csv # query
├── scenarios/
│   ├── _example/ranking-nearby.js  # 레퍼런스 시나리오
│   └── <담당자>/<시나리오-slug>.js
└── mock/              # 외부 API(카카오/FCM/S3 등) 대체 서버
```

## 사전 준비

### 1. k6 설치

```bash
# macOS
brew install k6
# 그 외: https://grafana.com/docs/k6/latest/set-up/install-k6/
```

### 2. mock 서버 기동 (외부 API 대체)

```bash
node mock/server.js   # 기본 포트 9900
```

> k6 는 mock 을 직접 호출하지 않는다. **BE 가 외부 호출을 mock 으로 향하게** 구성한다(인프라 책임). 자세한 내용은 [`mock/README.md`](./mock/README.md).

### 3. 테스트 멤버 시딩 + 토큰 발급

loadtest 전용 유저(prefix `loadtest-user-`)를 수만 명 시딩하고, 각 멤버의 accessToken 을 사전 발급해
`data/tokens.csv` 로 저장한다. (BE 시딩 스크립트/배치 책임 — 인프라)

```csv
member_id,access_token
loadtest-user-00001,<JWT...>
loadtest-user-00002,<JWT...>
```

> `data/tokens.csv` 는 **gitignore** 되어 있다. 실토큰을 커밋하지 않는다.
> 형식은 [`data/tokens.sample.csv`](./data/tokens.sample.csv) 참고.

## 실행

```bash
# 기본 실행 (loadtest 디렉터리에서)
BASE_URL=http://localhost:8080 k6 run scenarios/_example/ranking-nearby.js

# 저강도 스모크 (RPS 낮춤 — 로컬 동작 확인)
LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/_example/ranking-nearby.js

# Prometheus remote write (Grafana 연동, 풀 부하)
BASE_URL=http://localhost:8080 \
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  k6 run -o experimental-prometheus-rw \
  --tag testid=$(date +%Y%m%d-%H%M%S) \
  scenarios/_example/ranking-nearby.js
```

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `BASE_URL` | `http://localhost:8080` | BE 주소 |
| `LOAD_LEVEL` | `full` | `full`(1000→2000 RPS) / `smoke`(저강도) |
| `TOKENS_CSV` | `./data/tokens.csv` | 토큰 CSV 경로 |
| `LOCATIONS_CSV` | `./data/locations.csv` | 위치 CSV 경로 |
| `QUERIES_CSV` | `./data/search-queries.csv` | 검색어 CSV 경로 |
| `THINK_MIN` / `THINK_MAX` | `0.5` / `2.0` | 단계 사이 sleep 범위(초) |

## Threshold (lib 고정)

- `http_req_failed: rate < 0.01` (에러율 1% 미만)
- `http_req_duration: p(95) < 800ms`
- `checks: rate > 0.99`
- `http_reqs` / 도달 RPS 로 **2000 RPS 도달 여부** 확인

## 새 시나리오 추가

1. [`CLAUDE.md`](./CLAUDE.md) 규약을 읽는다.
2. `scenarios/_example/ranking-nearby.js` 를 `scenarios/<담당자>/<slug>.js` 로 복사한다.
3. 단계 → 엔드포인트 매핑 표를 먼저 작성하고, 스켈레톤대로 채운다.
