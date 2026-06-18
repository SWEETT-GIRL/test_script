// scenarios/hyun/menu-add-report-flow-test.js
//
// [담당자]       hyun
// [slug]         menu-add-report-flow-test
// [scenarioName] menu_add_report_flow
// [목적]         가게 상세에서 누락된 메뉴를 추가 제보하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 홈화면 진입           → GET /trend/nearby
//   3. 가게 검색 자동완성    → GET /stores/autocomplete
//   4. 가게 검색 결과        → GET /stores/search
//   5. 가게 상세 진입        → GET /stores/{storeId}
//   6. 메뉴 리스트 조회      → GET /stores/{storeId}/menus
//   7. 메뉴 카테고리 조회    → GET /menu-categories  (제보 폼 진입 시 카테고리 목록 로드)
//   8. 메뉴 추가 제보        → POST /stores/{storeId}/menu-add-reports
//
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                                  | 인증 | 비고                                       |
// |---|-----------------------|---------------|------|------------------------------------------|----- |--------------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)   | —    | —                                          | —    | think()                                    |
// | 2 | 홈화면 진입           | 포함          | GET  | GET /trend/nearby                          | Y    | lat, lng                                   |
// | 3 | 가게 검색 자동완성    | 포함          | GET  | GET /stores/autocomplete                   | N    | query=pickQuery(), size=10                 |
// | 4 | 가게 검색 결과        | 포함          | GET  | GET /stores/search                         | N    | ⚠ lon, sort=distance                      |
// | 5 | 가게 상세 진입        | 포함          | GET  | GET /stores/{storeId}                      | Y    | storeId = data.content[0].id              |
// | 6 | 메뉴 리스트 조회      | 포함          | GET  | GET /stores/{storeId}/menus                | Y    |                                            |
// | 7 | 메뉴 카테고리 조회    | 포함          | GET  | GET /menu-categories                       | N    | categoryId = data[0].categoryId           |
// | 8 | 메뉴 추가 제보        | 포함          | POST | POST /stores/{storeId}/menu-add-reports    | Y    | ⚠ 부수효과. 개발 서버 DB                  |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('menu_add_report_flow');

export default function menuAddReportFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId, categoryId;

  group('01. 홈화면 진입', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. 가게 검색 자동완성', () => {
    const res = apiGet('/stores/autocomplete', {
      params: { query: q.query, size: 10 },
      name: 'GET /stores/autocomplete',
    });
    checkOk(res, 'GET /stores/autocomplete');
  });
  think();

  group('03. 가게 검색 결과', () => {
    const res = apiGet('/stores/search', {
      params: { query: q.query, lat: loc.lat, lon: loc.lon, sort: 'distance', size: 15 }, // ⚠ /stores/search 만 lon
      name: 'GET /stores/search',
    });
    checkOk(res, 'GET /stores/search');
    const data = dataOf(res);
    if (data && Array.isArray(data.content) && data.content.length > 0) {
      storeId = data.content[0].id;
    }
  });
  think();

  group('04. 가게 상세 진입', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}`, { token, name: 'GET /stores/{storeId}' });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('05. 메뉴 리스트 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, { token, name: 'GET /stores/{storeId}/menus' });
    checkOk(res, 'GET /stores/{storeId}/menus');
  });
  think();

  group('06. 메뉴 카테고리 조회', () => {
    const res = apiGet('/menu-categories', { name: 'GET /menu-categories' });
    checkOk(res, 'GET /menu-categories');
    const data = dataOf(res);
    if (Array.isArray(data) && data.length > 0) {
      categoryId = data[0].categoryId;
    }
  });
  think();

  group('07. 메뉴 추가 제보', () => {
    if (!storeId || !categoryId) return;
    const res = apiPost(`/stores/${storeId}/menu-add-reports`, {
      token,
      body: {
        menuCategoryId: categoryId,
        name: 'loadtest-menu-제보',
        price: 3000,
        description: 'loadtest-description',
        images: [],
      },
      name: 'POST /stores/{storeId}/menu-add-reports',
    });
    checkOk(res, 'POST /stores/{storeId}/menu-add-reports');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/menu-add-report-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/menu-add-report-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/menu-add-report-flow-test.js
