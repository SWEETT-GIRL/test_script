// scenarios/hyun/menu-taste-check-flow-test.js
//
// [담당자]       hyun
// [slug]         menu-taste-check-flow-test
// [scenarioName] menu_taste_check_flow
// [목적]         홈에서 빵집을 검색해 메뉴 리뷰를 확인하고 도움돼요를 누르는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 홈화면 진입           → GET /trend/nearby
//   3. 빵집 검색 자동완성    → GET /stores/autocomplete
//   4. 빵집 검색 결과        → GET /stores/search
//   5. 가게 상세 진입        → GET /stores/{storeId}
//   6. 메뉴 리스트 조회      → GET /stores/{storeId}/menus
//   7. 메뉴 상세 조회        → GET /menus/{menuId}
//   8. 리뷰 요약 조회        → GET /menus/{menuId}/reviews/summary
//   9. 리뷰 리스트 스크롤    → GET /menus/{menuId}/reviews
//  10. 도움돼요 버튼 클릭    → POST /reviews/{reviewId}/recommend
//
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                           | 인증 | 비고                                    |
// |---|-----------------------|---------------|------|-------------------------------------|----- |-----------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)   | —    | —                                   | —    | think()                                 |
// | 2 | 홈화면 진입           | 포함          | GET  | GET /trend/nearby                   | Y    | lat, lng(CSV lon)                       |
// | 3 | 검색 자동완성         | 포함          | GET  | GET /stores/autocomplete            | N    | query=pickQuery(), size=10              |
// | 4 | 검색 결과             | 포함          | GET  | GET /stores/search                  | N    | ⚠ lon, sort=popularity                 |
// | 5 | 가게 상세 진입        | 포함          | GET  | GET /stores/{storeId}               | Y    | storeId = data.content[0].id           |
// | 6 | 메뉴 리스트 조회      | 포함          | GET  | GET /stores/{storeId}/menus         | Y    | menuId = data[0].menuId                |
// | 7 | 메뉴 상세 조회        | 포함          | GET  | GET /menus/{menuId}                 | Y    | 6번 체이닝                              |
// | 8 | 리뷰 요약 조회        | 포함          | GET  | GET /menus/{menuId}/reviews/summary | Y    | previewSize=2                           |
// | 9 | 리뷰 리스트 스크롤    | 포함          | GET  | GET /menus/{menuId}/reviews         | Y    | reviewId = data.content[0].id          |
// |10 | 도움돼요              | 포함          | POST   | POST /reviews/{reviewId}/recommend    | Y    | ⚠ 부수효과. 개발 서버 DB              |
// |11 | 도움돼요 취소         | 포함(cleanup) | DELETE | DELETE /reviews/{reviewId}/recommend  | Y    | iteration 종료 전 상태 복원            |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, apiDelete, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('menu_taste_check_flow');

export default function menuTasteCheckFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId, menuId, reviewId;

  group('01. 홈화면 진입', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. 빵집 검색 자동완성', () => {
    const res = apiGet('/stores/autocomplete', {
      params: { query: q.query, size: 10 },
      name: 'GET /stores/autocomplete',
    });
    checkOk(res, 'GET /stores/autocomplete');
  });
  think();

  group('03. 빵집 검색 결과', () => {
    const res = apiGet('/stores/search', {
      params: { query: q.query, lat: loc.lat, lon: loc.lon, sort: 'popularity', size: 15 }, // ⚠ /stores/search 만 lon
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
    const data = dataOf(res);
    if (Array.isArray(data) && data.length > 0) {
      menuId = data[0].menuId;
    }
  });
  think();

  group('06. 메뉴 상세 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}`, { token, name: 'GET /menus/{menuId}' });
    checkOk(res, 'GET /menus/{menuId}');
  });
  think();

  group('07. 리뷰 요약 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}/reviews/summary`, {
      token,
      params: { previewSize: 2 },
      name: 'GET /menus/{menuId}/reviews/summary',
    });
    checkOk(res, 'GET /menus/{menuId}/reviews/summary');
  });
  think();

  group('08. 리뷰 리스트 스크롤', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}/reviews`, {
      token,
      params: { sort: 'recent', page: 0, size: 20 },
      name: 'GET /menus/{menuId}/reviews',
    });
    checkOk(res, 'GET /menus/{menuId}/reviews');
    const data = dataOf(res);
    if (data && Array.isArray(data.content) && data.content.length > 0) {
      reviewId = data.content[0].id; // 리뷰 id 필드는 'id'
    }
  });
  think();

  group('09. 도움돼요', () => {
    if (!reviewId) return;
    const res = apiPost(`/reviews/${reviewId}/recommend`, {
      token,
      name: 'POST /reviews/{reviewId}/recommend',
    });
    checkOk(res, 'POST /reviews/{reviewId}/recommend');
  });

  group('10. 도움돼요 취소', () => {
    if (!reviewId) return;
    apiDelete(`/reviews/${reviewId}/recommend`, { token, name: 'DELETE /reviews/{reviewId}/recommend' });
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/menu-taste-check-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/menu-taste-check-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/menu-taste-check-flow-test.js
