// scenarios/_example/ranking-nearby.js
// 레퍼런스 시나리오 — 새 시나리오를 쓸 때 이 파일을 복사해서 시작한다.
//
// [담당자]      _example
// [slug]        ranking-nearby
// [scenarioName] ranking_nearby
// [목적]        앱 실행 후 홈에서 현재 위치 기반 랭킹을 조회하고, 핫 빵집 상세로 진입하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행            (비-API → sleep)
//   2. JWT로 인증          (제외 → 사전 발급 토큰 사용)
//   3. 현재 위치 권한 허용  (비-API → sleep)
//   4. 홈 진입: 위치 기반 랭킹 조회 → GET /trend/nearby
//   5. 홈 배너 조회         → GET /banners
//   6. 핫 빵집 상세 진입     → GET /stores/{storeId}  (4번 응답에서 storeId 체이닝)
//   7. 해당 가게 메뉴 조회   → GET /stores/{storeId}/menus
//
// 단계 → 엔드포인트 매핑
// | # | 단계            | 포함/제외 | HTTP | name 태그                    | 인증 | 비고                         |
// |---|-----------------|-----------|------|------------------------------|------|------------------------------|
// | 1 | 앱 실행/권한 허용 | 제외(sleep)| -    | -                            | -    | think()                      |
// | 2 | JWT 인증         | 제외       | -    | -                            | -    | pickToken()                  |
// | 3 | 위치 기반 랭킹    | 포함       | GET  | GET /trend/nearby            | Y    | params: lat,lng (CSV lon→lng)|
// | 4 | 홈 배너          | 포함       | GET  | GET /banners                 | Y    | -                            |
// | 5 | 가게 상세        | 포함       | GET  | GET /stores/{storeId}        | Y    | storeId = 3번 응답 체이닝     |
// | 6 | 가게 메뉴        | 포함       | GET  | GET /stores/{storeId}/menus  | Y    | 5번과 동일 storeId           |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('ranking_nearby');

export default function rankingNearby() {
  const { token } = pickToken();
  const loc = pickLocation();
  let storeId;

  group('01. 홈 진입 — 위치 기반 랭킹 조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');

    const data = dataOf(res);
    if (data && Array.isArray(data.hotStores) && data.hotStores.length > 0) {
      storeId = data.hotStores[0].storeId;
    }
  });
  think();

  group('02. 홈 배너 조회', () => {
    const res = apiGet('/banners', { token, name: 'GET /banners' });
    checkOk(res, 'GET /banners');
  });
  think();

  group('03. 핫 빵집 상세 진입', () => {
    if (!storeId) return; // 응답이 비면 가드 후 종료(단계 자체는 유지)
    const res = apiGet(`/stores/${storeId}`, {
      token,
      name: 'GET /stores/{storeId}',
    });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('04. 가게 메뉴 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, {
      token,
      name: 'GET /stores/{storeId}/menus',
    });
    checkOk(res, 'GET /stores/{storeId}/menus');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/_example/ranking-nearby.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/_example/ranking-nearby.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/_example/ranking-nearby.js
