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

## EC2에서 실행

레포를 **통째로 클론**해서 폴더 구조를 그대로 둔 채 실행한다. 시나리오가 상대경로로
`../../lib/*` 를 import 하고 `./data/*.csv` 를 열기 때문에 구조가 깨지면 안 된다.

### 1) k6 설치

```bash
# 가장 확실한 방법: 정적 바이너리 (배포판 무관)
curl -L https://github.com/grafana/k6/releases/latest/download/k6-v0.50.0-linux-amd64.tar.gz | tar xz
sudo mv k6-*/k6 /usr/local/bin/

# Amazon Linux 2023 / RHEL 계열 (dnf)
#   sudo dnf install -y https://dl.k6.io/rpm/repo.rpm && sudo dnf install -y k6
# Ubuntu/Debian (apt)
#   sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
#     --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
#   echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
#     | sudo tee /etc/apt/sources.list.d/k6.list && sudo apt update && sudo apt install -y k6
```

### 2) 클론 + tokens.csv 올리기

```bash
git clone https://github.com/SWEETT-GIRL/test_script.git
cd test_script/loadtest          # ← 반드시 이 안에서 실행 (data/ 상대경로 때문)

# tokens.csv 는 gitignore 라 클론에 안 따라온다. 별도로 올려야 함!
#   (로컬에서) scp data/tokens.csv ec2-user@<ip>:~/test_script/loadtest/data/tokens.csv
#   형식: member_id,access_token   (data/tokens.sample.csv 참고)
```

> ⚠ 가장 자주 까먹는 두 가지: **(a) tokens.csv 따로 올리기, (b) loadtest 디렉터리 안에서 실행.**
> 다른 위치에서 돌려야 하면 CSV 경로를 절대경로 환경변수로 넘긴다:
> ```bash
> TOKENS_CSV=/home/ec2-user/test_script/loadtest/data/tokens.csv \
> LOCATIONS_CSV=/home/ec2-user/test_script/loadtest/data/locations.csv \
> QUERIES_CSV=/home/ec2-user/test_script/loadtest/data/search-queries.csv \
> k6 run /home/ec2-user/test_script/loadtest/scenarios/_example/ranking-nearby.js
> ```

### 3) 커널 튜닝 (2000 RPS 필수)

안 하면 `too many open files` / 포트 고갈로 터진다.

```bash
ulimit -n 1048576                                      # 파일 디스크립터 (세션 한정)
# 영구 적용: /etc/security/limits.conf 에 아래 추가
#   *    soft    nofile    1048576
#   *    hard    nofile    1048576
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
```

- 인스턴스: 2000 RPS면 **c5.xlarge(4 vCPU) 이상** 권장. 한 대로 부족하면 k6 분산 실행도
  있지만 일단 단일로 충분하다.

### 4) mock 서버는 k6 박스에 안 띄운다

k6 는 BE 만 호출하고, **BE 가 외부 호출을 mock 으로 향하게** 구성한다(인프라 책임).
따라서 `mock/server.js` 는 BE/인프라 쪽에서 띄우며, k6 EC2 에는 필요 없다.
([`mock/README.md`](./mock/README.md) 참고)

### 5) 실행 + Grafana 연동

```bash
# 풀 부하 + Prometheus remote-write (Grafana 대시보드)
BASE_URL=http://<BE-주소>:8080 \
K6_PROMETHEUS_RW_SERVER_URL=http://<Prometheus-주소>:9090/api/v1/write \
  k6 run -o experimental-prometheus-rw \
  --tag testid=$(date +%Y%m%d-%H%M%S) \
  scenarios/_example/ranking-nearby.js
```

`K6_PROMETHEUS_RW_SERVER_URL` 을 Prometheus 주소로 맞추면 결과가 Grafana 로 흐른다.

## Threshold (lib 고정)

- `http_req_failed: rate < 0.01` (에러율 1% 미만)
- `http_req_duration: p(95) < 800ms`
- `checks: rate > 0.99`
- `http_reqs` / 도달 RPS 로 **2000 RPS 도달 여부** 확인

## 새 시나리오 추가

1. [`CLAUDE.md`](./CLAUDE.md) 규약을 읽는다.
2. `scenarios/_example/ranking-nearby.js` 를 `scenarios/<담당자>/<slug>.js` 로 복사한다.
3. 단계 → 엔드포인트 매핑 표를 먼저 작성하고, 스켈레톤대로 채운다.
