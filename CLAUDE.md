# 빵긋 k6 부하테스트 — 시나리오 스크립트 작성 공통 프롬프트

너는 빵긋 BE 부하테스트용 k6 스크립트를 작성하는 에이전트다.
아래 규약을 그대로 따른다. 다른 담당자도 같은 프롬프트로 각자 시나리오를 작성하므로,
규약을 벗어나면 스크립트들이 합쳐지지 않는다. 임의 변형 금지.

---

## 0. 목표 / 기본 원칙 (절대 전제)

- 목표 부하: **1,000 ~ 2,000 RPS**. VU 고정이 아니라 **초당 요청수를 1000 → 1500 → 2000으로
  점진 증가**시킨다. 이 부하 프로파일은 `lib/config.js`의 `getOptions()`가 고정하므로
  너는 직접 stages/executor를 작성하지 않는다.
- **k6는 우리 BE만 호출**한다. 외부 API(카카오/애플/OpenAI/지도/FCM/S3 등)는 호출하지 않는다.
  BE가 내부적으로 외부를 부르는 경우는 **loadtest 환경에서 BE가 mock 서버를 바라보도록
  구성**돼 있다(인프라 책임). 너는 BE 엔드포인트만 때린다.
- 일반 부하테스트는 **"이미 로그인된 사용자"** 기준. accessToken은 `data/tokens.csv`에서 읽어
  `Authorization: Bearer` 헤더로 사용하고, **VU별로 다른 토큰**을 쓴다(`pickToken()`).
- `BASE_URL`은 `__ENV.BASE_URL`로 받는다(기본 `http://localhost:8080`).
- 테스트 데이터 선택은 **랜덤 시드 기반(재현 가능)** 으로 한다(`lib`의 시드 유틸 사용).
- 실제 토큰·API key·개인정보 **하드코딩 금지**.
- POST/PUT/PATCH/DELETE는 **loadtest 전용 유저/데이터만** 사용한다
  (테스트 유저 prefix `loadtest-user-`, 테스트 데이터 prefix `loadtest-`).

---

## 1. 너에게 주어지는 입력 (시나리오 정의)

```
[담당자]   예: jibin
[slug]    kebab-case. 파일명에 -test.js 를 붙임. 예: ranking-flow-test
[scenarioName] snake_case. k6 scenario/태그명. 예: ranking_flow
[목적]    예: 앱 실행 후 홈에서 현재 위치 기반 랭킹을 조회하는 흐름의 성능 확인
[사용자 행동 순서]
  1. 앱 실행
  2. JWT로 인증
  3. 현재 위치 권한 허용
  4. 현재 위치 전달
  5. 홈 랭킹 조회
  6. 랭킹 중 특정 가게 상세 진입
[주의사항]  예: -
```

이 정의로 `scenarios/{{담당자}}/{{slug}}.js` 파일 **하나**를 만든다.

---

## 2. 전제 — 이미 존재하는 고정 인프라 (수정 금지, import만)

아래 공유 모듈은 이미 만들어져 있다. **새로 만들거나 내용을 바꾸지 말고 import만** 하고
시그니처 그대로 쓴다.

```js
// lib/config.js
export const BASE_URL;                 // __ENV.BASE_URL || 'http://localhost:8080'
export function getOptions(scenarioName);
//   ramping-arrival-rate executor로 1000→1500→2000 RPS 프로파일 + 공통 thresholds + tags 반환.
//   LOAD_LEVEL=smoke 면 저강도, 미지정/full 이면 1000→2000 전체.

// lib/auth.js
export function pickToken();           // 현재 VU에 매핑된 { accessToken } 반환
(data/tokens.csv 기반, VU별 상이)

// lib/data.js
export function pickLocation();        // data/locations.csv 한 행 { name, lat, lon } (시드 기반)
export function pickQuery();           // data/search-queries.csv 한 행 { query } (시드 기반)

// lib/http.js  — 모든 HTTP 요청은 반드시 이 래퍼 경유 (Bearer 헤더·name 태그·ApiResponse 파싱 일관화)
export function apiGet(path, { token, params, name });
export function apiPost(path, { token, body, params, name });
export function apiPatch(path, { token, body, params, name });
export function apiDelete(path, { token, params, name });
export function dataOf(res);           // ApiResponse 의 .data 추출(실패 시 null)

// lib/checks.js
export function checkOk(res, name);    // http 200 && body.success === true 검증, boolean 반환

// lib/think.js
export function think();               // 단계 사이 랜덤 sleep (사용자 체류시간 모사)
```

- `name`은 **고-카디널리티 URL을 묶는 정규화 태그**. 경로변수는 치환하지 않는다.
  예: `'GET /stores/{storeId}'`, `'GET /menus/{menuId}/reviews'`. 실제 id를 넣지 않는다.
- `params`는 쿼리스트링 객체. 인증 필요 요청은 `token: token`을 넘긴다.
- 위경도/검색어/위치 등 가변 데이터는 **반드시 `pickLocation()`/`pickQuery()`** 로
  뽑는다(하드코딩 금지).

---

## 3. 작성 절차 (반드시 이 순서)

### Step 1 — 단계 → 엔드포인트 매핑 표를 먼저 출력하고 확인받기
`[사용자 행동 순서]`의 각 단계를 **§6 엔드포인트 카탈로그**의 실제 API에 매핑한 표를 먼저 낸다.
**카탈로그에 없는 단계는 추측하지 말고 질문**한다. (UI 전용 단계 = 권한 허용/스크롤/필터 토글 등은
별도 API가 없으면 "API 없음 — sleep/페이지 증가로 모델링"으로 표기)

| # | 단계 | 포함/제외/mock | HTTP | name 태그 | 인증 | 쿼리/바디 · 체이닝 |
|---|------|---------------|------|-----------|------|--------------------|

- "앱 실행", "위치 권한 허용" 같은 비-API 단계는 **제외(=sleep)** 로 표기.
- "JWT로 인증"은 **제외** (사전 발급 토큰 사용, 로그인 API 부하 대상 아님 — §6 인증 주의 참고).
- 외부 의존 가능 엔드포인트는 **mock**(BE측)으로 표기하되, 스크립트는 그대로 BE를 호출한다.

### Step 2 — 스켈레톤대로 스크립트 작성 (§4)
### Step 3 — 실행 명령 제시 (§5)

---

## 4. 스크립트 스켈레톤 (이 골격을 그대로 채운다)

```js
import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, apiPatch, apiDelete, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('{{scenarioName}}');

// JS 함수명은 camelCase. (예: rankingFlow)
export default function {{camelCaseName}}() {
  const { token } = pickToken();
  const loc = pickLocation();

  group('01. 단계명', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
    // 체이닝: const storeId = dataOf(res).hotStores[0].storeId;
  });
  think();

  group('02. 단계명', () => {
    // 직전 단계에서 얻은 id 사용. 응답이 비면 group 안에서 가드 후 종료(단계 skip 금지).
  });
  think();
}
```

규칙:
- 단계 번호 `01.`,`02.` … 2자리. group 이름은 단계명을 한글로.
- 각 group: `apiXxx(...)` → `checkOk(res, name)` → 필요시 `dataOf(res)`로 체이닝.
- 단계 사이 `think()`. 마지막 뒤에는 생략 가능. **단계 생략 금지**.
- 동적 데이터(storeId/menuId/reviewId/memberId)는 **직전 응답에서 추출**. 하드코딩·CSV화 금지.
- POST/PATCH/DELETE는 loadtest 전용 데이터만. 위험한 부수효과(실제 FCM 발송, S3 업로드 등)는
  주의사항에 적고, 불확실하면 질문.

---

## 5. 실행 명령 (스크립트 하단 주석 + 답변에 포함)

```bash
# 기본 실행
BASE_URL=http://localhost:8080 k6 run scenarios/{{담당자}}/{{slug}}.js

# Prometheus remote write (Grafana 연동)
BASE_URL=http://localhost:8080 \
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  k6 run -o experimental-prometheus-rw \
  --tag testid=$(date +%Y%m%d-%H%M%S) \
  scenarios/{{담당자}}/{{slug}}.js

# 저강도 스모크 (RPS 낮춤)
LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/{{담당자}}/{{slug}}.js
```

---

## 6. 엔드포인트 카탈로그 (실제 코드 기준 · 이 목록 밖은 질문)

> ⚠ 위경도 파라미터명이 엔드포인트마다 다르다.
> **`/stores/search` 만 `lon`**, 나머지(`/trend/nearby`, `/stores/nearby`, `/stores/popular`,
> `/stores/district`)는 **`lng`**. CSV 컬럼은 `lon`이므로 매핑 시 주의.

**랭킹/트렌드**
- `GET /trend/nearby?lat&lng` — 내 위치 기반 유명 메뉴·핫 빵집 (홈 진입 시 호출)
- `GET /trend/select?region` — 지역 선택(`시군구_읍면동`, 예: 대전) 트렌드
- `GET /trend/nationwide` — 전국 트렌드
- 체이닝: 응답의 hotStores[].storeId → `GET /stores/{storeId}`

**홈 부가**
- `GET /banners` — 홈 배너 (홈 진입 시)
- `GET /alarm/history` — 알림 히스토리(벨 뱃지)

**가게**
- `GET /stores/search?query&lat&lon&page&size&sort` — 검색 (sort: distance|popularity, size=15)
- `GET /stores/autocomplete?query&size` — 자동완성 (입력 디바운스 후, size=10)
- `GET /stores/{storeId}` — 가게 상세 (인증)
- `GET /stores/district?keyword&lat&lng&page&size&sort` — 지역 키워드 목록
- `GET /stores/nearby?lat&lng&page&size` — 주변 가게
- `GET /stores/popular?lat&lng` — 인기(구독수) 가게
- `GET /stores/subscribed?page&size` — 내 구독(빵알람) 목록 (인증)
- `POST /stores/{storeId}/subscribe` · `DELETE /stores/{storeId}/subscribe` — 빵알람 구독/해제 (인증, 부수효과)
- `POST /stores/kakao` — 카카오 검색결과 가게 등록 (**외부 의존 → mock**)

**메뉴**
- `GET /stores/{storeId}/menus` — 메뉴 리스트 (가게 상세와 동시 호출)
- `GET /menu-categories` — 메뉴 카테고리(소금빵 등 필터)
- `GET /menus/{menuId}` — 메뉴 상세
- `POST /menus/{menuId}/like` · `DELETE /menus/{menuId}/like` — 메뉴 좋아요 (인증, 부수효과)

**리뷰**
- `GET /menus/{menuId}/reviews/summary?sort&photoOnly&previewSize` — 요약(미리보기, previewSize=2)
- `GET /menus/{menuId}/reviews?sort&page&size` — 리스트 (sort: recent|helpful|photo, size=20)
- `GET /reviews/{reviewId}` — 리뷰 상세
- `GET /users/{memberId}/reviews?page&size` — 특정 사용자 리뷰 (memberId = 리뷰 상세 응답에서)
- `GET /users/me/reviews` — 내가 쓴 리뷰 (인증)
- `POST /menus/{menuId}/reviews` (+`POST /reviews/images/presigned-urls` → **S3 mock**) — 리뷰 작성 (인증, 부수효과)
- `POST /reviews/{reviewId}/recommend` · `DELETE …/recommend` — 도움돼요 (인증, 부수효과)
- 체이닝: menus → menuId → reviews → reviewId → review 상세 → memberId → user reviews

**MY / 설정 (모두 인증)**
- `GET /users/me` · `GET /users/me/store-count`
- `GET/POST /users/me/consent` · `PATCH /users/me/consent` — 약관 동의
- `GET/POST /users/me/favorite-bread` — 빵 취향 (POST body: bread_category_id 배열)
- `GET/POST /users/me/notification-days`
- `GET /users/me/notification-radius` · `PATCH …`
- `GET /users/me/notification-time` · `PATCH …`

**알림 (인증)**
- `GET/PATCH /alarm/settings/notification` · `GET/PATCH /alarm/settings/marketing`
- `GET /alarm/report-notifications` · `PATCH /alarm/report-notifications/{id}/read`
- `POST /alarm/fcm-token` · `DELETE /alarm/fcm-token` (**FCM mock**)

**신고 / 차단 / 가게 정보 수정 제안 (인증)**
- `POST /blocks` · `DELETE /blocks/{blockedMemberId}` · `GET /blocks`
- `GET /address/search?...` — 주소 검색 (**외부 의존 → mock**)
- `POST /stores/{storeId}/reports/business-hours` · `.../address`
- `POST /stores/{storeId}/reports/images/presigned-urls` · `.../images` (**S3 mock**)

**약관**
- `GET /terms`

- 카카오 로그인은 OAuth2 리다이렉트, 애플은 `POST /auth/apple`(외부 검증) → **부하 대상 제외**.
- 온보딩/로그인 시나리오도 VU는 `pickToken()`의 **사전 발급 토큰**을 쓰고,
  "로그인 직후" 흐름인 `GET /users/me` → `GET /terms` → `POST /users/me/consent`
  → `POST /users/me/favorite-bread` → `GET /trend/nearby` 를 부하 대상으로 모델링한다.

---

## 7. 데이터 파일 (lib가 읽음 · 스크립트는 pick* 로만 접근)

```
data/tokens.csv          # 헤더: accessToken  (VU별 1행, 사전 발급, 실토큰은 커밋 금지)
data/tokens.sample.csv   # 예시: sample-access-token-1 ...
data/locations.csv       # 헤더: name,lat,lon   (예: seongsu,37.5446,127.0557)
data/search-queries.csv  # 헤더: query          (예: 소금빵 / 성수 소금빵 / 성심당)
```

---

## 8. Threshold (lib가 고정, 참고)

- `http_req_failed: rate < 0.01` (에러율 1% 미만)
- `http_req_duration: p(95) < 800ms` (필요시 시나리오 정의에서 조정 요청)
- `http_reqs`(혹은 도달 RPS)로 **2000 RPS 도달 여부** 확인

---

## 9. 절대 금지

- 토큰·URL·id·위경도·검색어 하드코딩
- `lib/*` 수정·재구현, `options`/executor 직접 작성 (반드시 `getOptions`)
- 외부 API 직접 호출
- `http.get` 등 k6 raw 호출 (반드시 `lib/http.js` 래퍼)
- 단계 생략, 카탈로그에 없는 엔드포인트 추측 생성 (→ 질문)
- 운영 데이터 대상 POST/DELETE (loadtest 전용 데이터만)

---

## 10. 출력 형식

1. **단계 → 엔드포인트 매핑 표** (포함/제외/mock 표시)  ← 확인 먼저
2. `scenarios/{{담당자}}/{{slug}}.js` 전체 코드
3. 실행 명령
