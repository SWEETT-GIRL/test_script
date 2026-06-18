// scenarios/olivia/onboarding-ranking.js
//
// [담당자]       olivia
// [slug]         onboarding-ranking
// [scenarioName] onboarding_ranking
// [목적]         앱 신규 설치 후 온보딩(로그인→약관동의→빵취향 선택)을 거쳐
//               홈에서 현재 위치 기반 랭킹을 조회하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 처음 앱 설치 / 온보딩        (비-API → sleep)
//   2. 카카오/애플 로그인           (제외 → 사전 발급 토큰 사용. §6 로그인 부하 제외)
//   3. 약관 동의                    → GET /terms → POST /users/me/consent
//   4. 빵취향 선택                  → POST /users/me/favorite-bread
//   5. 홈 화면 진입                 → GET /banners
//   6. 현재 위치 기반 랭킹 보기      → GET /trend/nearby
//   7. 랜덤 아무 특정 가게 상세 진입  → GET /stores/{storeId} (6번 hotStores 중 랜덤)
//
// 단계 → 엔드포인트 매핑
// | # | 단계                | 포함/제외/mock | HTTP | name 태그                 | 인증 | 쿼리/바디 · 체이닝                         |
// |---|---------------------|---------------|------|---------------------------|------|--------------------------------------------|
// | 1 | 앱 설치/온보딩        | 제외(sleep)    | -    | -                         | -    | think()                                    |
// | 2 | 카카오/애플 로그인    | 제외           | -    | -                         | -    | pickToken() (사전 발급 토큰)                |
// | 3 | 로그인 직후 내 정보   | 포함           | GET  | GET /users/me             | Y    | "로그인 직후" 흐름 진입점(§6)               |
// | 4 | 약관 조회            | 포함           | GET  | GET /terms                | Y    | -                                          |
// | 5 | 약관 동의            | 포함(POST)     | POST | POST /users/me/consent    | Y    | body=ConsentCreateRequest. 전용 유저만      |
// | 6 | 빵취향 선택          | 포함(POST)     | POST | POST /users/me/favorite-bread | Y | body=빵종류 문자열 배열. 전용 유저만        |
// | 7 | 홈 배너             | 포함           | GET  | GET /banners              | Y    | 홈 진입                                    |
// | 8 | 위치 기반 랭킹       | 포함           | GET  | GET /trend/nearby         | Y    | params: lat,lng (CSV lon→lng), hotStores 체이닝 |
// | 9 | 랜덤 가게 상세       | 포함           | GET  | GET /stores/{storeId}     | Y    | storeId = 8번 hotStores 중 랜덤             |
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ POST 바디는 추측이 아니라 BE 소스에서 확인한 실제 스펙이다(카탈로그 §6 미기재분 보강).
//   - POST /users/me/consent  ← ConsentCreateRequest (member/dto/request/ConsentCreateRequest.java)
//       6개 boolean 필수(@NotNull) + version/agreedAt 선택(String).
//   - POST /users/me/favorite-bread  ← String[] (MemberController.java enrollLikeMenuCategory)
//       bread_category_id 가 아니라 "빵 종류 문자열 배열". 서버가 MenuKind.valueOf(name) 으로
//       검증하므로 유효한 MenuKind 값만 보낸다. Swagger 예시 값(소금빵/크루아상/베이글) 사용.
//
// ⚠ 부수효과 / 전용 유저(§0·§9):
//   두 POST 모두 "인증된 본인" 레코드를 변경한다.
//     consent → createConsent(memberId) 로 동의 레코드 저장,
//     favorite-bread → deleteByMemberId 후 재삽입(취향 덮어쓰기).
//   따라서 tokens.csv 는 반드시 loadtest 전용 유저(loadtest-user-) 토큰이어야 한다.
//   운영 유저 토큰을 넣으면 그 유저의 동의/취향이 덮어써진다 → 절대 금지.
// ─────────────────────────────────────────────────────────────────────────────

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('onboarding_ranking');

// 온보딩 약관 전체 동의(최초 동의 = 모두 true). version/agreedAt 은 선택값이라 생략.
const CONSENT_BODY = {
  termsAgreed: true,
  privacyAgreed: true,
  ageOver14Agreed: true,
  marketingAgreed: true,
  nightMarketingAgreed: true,
  locationAgreed: true,
};

// 빵 취향 후보(모두 유효한 MenuKind 값 — 서버 MenuKind.valueOf 검증 통과). Swagger 예시 셋.
const FAVORITE_BREAD = ['소금빵', '크루아상', '베이글'];

// 재현 가능한 결정적 인덱스(데이터 §0). data.js 의 시드 유틸은 비공개라 동일 방식으로 인라인 구현.
// Math.random() 과 달리 같은 (VU, iter) 면 같은 가게를 고른다.
function seededIndex(len) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

export default function onboardingRanking() {
  const { token } = pickToken();
  const loc = pickLocation();
  let storeId;

  // 1. 앱 설치/온보딩, 2. 로그인 = 비-API/제외 (think + pickToken 으로 모델링)
  think();

  group('01. 로그인 직후 — 내 정보 조회', () => {
    const res = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(res, 'GET /users/me');
  });
  think();

  group('02. 약관 조회', () => {
    const res = apiGet('/terms', { token, name: 'GET /terms' });
    checkOk(res, 'GET /terms');
  });
  think();

  group('03. 약관 동의 (loadtest 전용 유저)', () => {
    const res = apiPost('/users/me/consent', {
      token,
      body: CONSENT_BODY,
      name: 'POST /users/me/consent',
    });
    checkOk(res, 'POST /users/me/consent');
  });
  think();

  group('04. 빵취향 선택 (loadtest 전용 유저)', () => {
    const res = apiPost('/users/me/favorite-bread', {
      token,
      body: FAVORITE_BREAD, // 서버가 String[] 로 받음
      name: 'POST /users/me/favorite-bread',
    });
    checkOk(res, 'POST /users/me/favorite-bread');
  });
  think();

  group('05. 홈 화면 진입 — 배너 조회', () => {
    const res = apiGet('/banners', { token, name: 'GET /banners' });
    checkOk(res, 'GET /banners');
  });
  think();

  group('06. 현재 위치 기반 랭킹 조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');

    const data = dataOf(res);
    if (data && Array.isArray(data.hotStores) && data.hotStores.length > 0) {
      // 랜덤(재현 가능) 아무 가게 1곳 선택
      storeId = data.hotStores[seededIndex(data.hotStores.length)].storeId;
    }
  });
  think();

  group('07. 랜덤 가게 상세 진입', () => {
    if (!storeId) return; // 응답이 비면 가드 후 종료(단계 자체는 유지)
    const res = apiGet(`/stores/${storeId}`, {
      token,
      name: 'GET /stores/{storeId}',
    });
    checkOk(res, 'GET /stores/{storeId}');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/onboarding-ranking.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/onboarding-ranking.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/onboarding-ranking.js
