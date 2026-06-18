// scenarios/olivia/subscribed-stores.js
//
// [담당자]       olivia
// [slug]         subscribed-stores
// [scenarioName] subscribed_stores
// [목적]         MY 탭에서 내가 구독한 빵알람(구독 가게) 목록을 조회하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입   → (자동) GET /trend/nearby
//   2. MY 탭 진입             → GET /users/me (+ GET /users/me/store-count)
//   3. 구독한 빵알람 목록 조회   → GET /stores/subscribed?page&size
//
// ─────────────────────────────────────────────────────────────────────────────
// 확인 결과
//   - MY 탭 진입 = GET /users/me (+ 필요시 GET /users/me/store-count = 구독 빵집 수 뱃지).
//   - "빵알람 목록 조회" = GET /stores/subscribed?page&size (인증). FE 기본값 page=0, size=50.
//   - 목록에서 가게 상세로 더 들어가는 단계는 시나리오에 없으므로 추가하지 않음
//     (필요하면 content[].storeId → GET /stores/{storeId} 로 체이닝 가능).
//   - 모든 호출 인증 필요. 읽기 전용(부수효과 없음).
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계            | 포함/제외 | HTTP | name 태그                 | 인증 | 비고                        |
// |---|-----------------|-----------|------|---------------------------|------|-----------------------------|
// | 1 | 앱 실행         | 제외(sleep)| -    | -                         | -    | think()                     |
// | 2 | JWT 인증        | 제외      | -    | -                         | -    | pickToken()                 |
// | 3 | 홈 진입         | 포함      | GET  | GET /trend/nearby         | Y    | params: lat,lng             |
// | 4 | MY 탭 진입      | 포함      | GET  | GET /users/me             | Y    | + GET /users/me/store-count |
// | 5 | 빵알람 목록 조회 | 포함      | GET  | GET /stores/subscribed    | Y    | params: page=0, size=50     |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('subscribed_stores');

export default function subscribedStores() {
  const { token } = pickToken();
  const loc = pickLocation();

  // 1. 앱 실행 = 비-API/제외 (think + pickToken 으로 모델링)
  think();

  group('01. 홈 진입 — 현위치 자동 피드', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. MY 탭 진입', () => {
    const me = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(me, 'GET /users/me');

    const count = apiGet('/users/me/store-count', {
      token,
      name: 'GET /users/me/store-count',
    });
    checkOk(count, 'GET /users/me/store-count');
  });
  think();

  group('03. 구독한 빵알람 목록 조회', () => {
    const res = apiGet('/stores/subscribed', {
      token,
      params: { page: 0, size: 50 },
      name: 'GET /stores/subscribed',
    });
    checkOk(res, 'GET /stores/subscribed');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/subscribed-stores.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/subscribed-stores.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/subscribed-stores.js
