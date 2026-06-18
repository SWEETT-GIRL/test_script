// scenarios/hyun/menu-like-flow-test.js
//
// [담당자]       hyun
// [slug]         menu-like-flow-test
// [scenarioName] menu_like_flow
// [목적]         홈 화면 가게 진입 후 메뉴를 좋아요하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 홈화면 진입           → GET /trend/nearby  (storeId 체이닝)
//   3. 가게 상세 진입        → GET /stores/{storeId}
//   4. 메뉴 리스트 조회      → GET /stores/{storeId}/menus
//   5. 메뉴 좋아요           → POST /menus/{menuId}/like
//
// | # | 단계                | 포함/제외/mock | HTTP | name 태그                   | 인증 | 비고                               |
// |---|---------------------|---------------|------|-----------------------------|------|------------------------------------|
// | 1 | 앱 실행             | 제외(sleep)   | —    | —                           | —    | think()                            |
// | 2 | 홈화면 진입         | 포함          | GET  | GET /trend/nearby           | Y    | storeId = data.hotStores[0].storeId|
// | 3 | 가게 상세 진입      | 포함          | GET  | GET /stores/{storeId}       | Y    | 2번 체이닝                          |
// | 4 | 메뉴 리스트 조회    | 포함          | GET  | GET /stores/{storeId}/menus | Y    | menuId = data[0].menuId            |
// | 5 | 메뉴 좋아요         | 포함          | POST | POST /menus/{menuId}/like   | Y    | ⚠ 부수효과. 개발 서버 DB          |
// | 6 | 메뉴 좋아요 취소    | 포함(cleanup) | DELETE | DELETE /menus/{menuId}/like | Y  | iteration 종료 전 상태 복원        |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPost, apiDelete, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('menu_like_flow');

export default function menuLikeFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  let storeId, menuId;

  group('01. 홈화면 진입', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
    const data = dataOf(res);
    if (data && Array.isArray(data.hotStores) && data.hotStores.length > 0) {
      storeId = data.hotStores[__ITER % data.hotStores.length].storeId;
    }
  });
  think();

  group('02. 가게 상세 진입', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}`, { token, name: 'GET /stores/{storeId}' });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('03. 메뉴 리스트 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, { token, name: 'GET /stores/{storeId}/menus' });
    checkOk(res, 'GET /stores/{storeId}/menus');
    const data = dataOf(res);
    if (Array.isArray(data) && data.length > 0) {
      menuId = data[0].menuId;
    }
  });
  think();

  group('04. 메뉴 좋아요', () => {
    if (!menuId) return;
    const res = apiPost(`/menus/${menuId}/like`, {
      token,
      name: 'POST /menus/{menuId}/like',
    });
    checkOk(res, 'POST /menus/{menuId}/like');
  });

  group('05. 메뉴 좋아요 취소', () => {
    if (!menuId) return;
    apiDelete(`/menus/${menuId}/like`, { token, name: 'DELETE /menus/{menuId}/like' });
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/menu-like-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/menu-like-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/menu-like-flow-test.js
