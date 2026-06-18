// scenarios/hyun/onboarding-flow-test.js
//
// [담당자]       hyun
// [slug]         onboarding-flow-test
// [scenarioName] onboarding_flow
// [목적]         신규 가입 직후 약관 동의 → 빵 취향 선택 → 홈 진입 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 카카오/애플 로그인   (제외 → pickToken, OAuth2 리다이렉트)
//   3. 사용자 정보 조회      → GET /users/me
//   4. 약관 조회             → GET /terms
//   5. 약관 동의             → POST /users/me/consent
//   6. 메뉴 카테고리 조회    → GET /menu-categories  (취향 선택지 동적 취득)
//   7. 빵 취향 선택          → POST /users/me/favorite-bread
//   8. 홈화면 복귀           → GET /trend/nearby
//
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                        | 인증 | 비고                                    |
// |---|-----------------------|---------------|------|----------------------------------|------|-----------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)   | —    | —                                | —    | think()                                 |
// | 2 | 카카오/애플 로그인     | 제외          | —    | —                                | —    | OAuth2 리다이렉트. pickToken()으로 대체  |
// | 3 | 사용자 정보 조회       | 포함          | GET  | GET /users/me                    | Y    |                                         |
// | 4 | 약관 조회             | 포함          | GET  | GET /terms                       | N    |                                         |
// | 5 | 약관 동의             | 포함          | POST | POST /users/me/consent           | Y    | 신규 가입 상정                           |
// | 6 | 메뉴 카테고리 조회     | 포함          | GET  | GET /menu-categories             | N    | data[].{ categoryId, name }             |
// | 7 | 빵 취향 선택          | 포함          | POST | POST /users/me/favorite-bread    | Y    | body: String[] (MenuKind enum 이름)     |
// | 8 | 홈화면 복귀           | 포함          | GET  | GET /trend/nearby                | Y    | lat, lng                                |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('onboarding_flow');

export default function onboardingFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  let breadNames = [];

  group('01. 사용자 정보 조회', () => {
    const res = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(res, 'GET /users/me');
  });
  think();

  group('02. 약관 조회', () => {
    const res = apiGet('/terms', { name: 'GET /terms' });
    checkOk(res, 'GET /terms');
  });
  think();

  group('03. 약관 동의', () => {
    const res = apiPost('/users/me/consent', {
      token,
      body: {
        termsAgreed: true,
        privacyAgreed: true,
        ageOver14Agreed: true,
        marketingAgreed: false,
        nightMarketingAgreed: false,
        locationAgreed: true,
        termsVersion: '1.0',
        privacyVersion: '1.0',
        agreedAt: '2026-01-01T00:00:00Z',
      },
      name: 'POST /users/me/consent',
    });
    checkOk(res, 'POST /users/me/consent');
  });
  think();

  group('04. 메뉴 카테고리 조회', () => {
    const res = apiGet('/menu-categories', { name: 'GET /menu-categories' });
    checkOk(res, 'GET /menu-categories');
    const data = dataOf(res);
    // data: [{ categoryId, name }] — name은 MenuKind enum 이름(한글)
    if (Array.isArray(data) && data.length > 0) {
      breadNames = data.slice(0, 3).map((c) => c.name); // 앱 온보딩: 최소 2개 이상 선택
    }
  });
  think();

  group('05. 빵 취향 선택', () => {
    if (breadNames.length === 0) return;
    const res = apiPost('/users/me/favorite-bread', {
      token,
      body: breadNames, // POST body는 String[] (raw array)
      name: 'POST /users/me/favorite-bread',
    });
    checkOk(res, 'POST /users/me/favorite-bread');
  });
  think();

  group('06. 홈화면 복귀', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/onboarding-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/onboarding-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/onboarding-flow-test.js
