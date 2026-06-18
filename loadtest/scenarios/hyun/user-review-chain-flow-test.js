// scenarios/hyun/user-review-chain-flow-test.js
//
// [담당자]       hyun
// [slug]         user-review-chain-flow-test
// [scenarioName] user_review_chain_flow
// [목적]         홈 화면 가게 진입 → 메뉴 리뷰 → 작성자 리뷰 목록 → 다른 가게 조회 체인 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 홈화면 진입           → GET /trend/nearby  (storeId 체이닝)
//   3. 가게 상세 진입        → GET /stores/{storeId}
//   4. 메뉴 리스트 조회      → GET /stores/{storeId}/menus
//   5. 메뉴 상세 조회        → GET /menus/{menuId}
//   6. 리뷰 리스트 조회      → GET /menus/{menuId}/reviews
//   7. 리뷰 상세 조회        → GET /reviews/{reviewId}  (memberId 체이닝)
//   8. 사용자 리뷰 리스트    → GET /users/{memberId}/reviews  (storeId2 체이닝)
//   9. 다른 가게 상세 진입   → GET /stores/{storeId}
//  10. 다른 가게 메뉴 조회   → GET /stores/{storeId}/menus
//  11. 다른 가게 메뉴 리뷰   → GET /menus/{menuId}/reviews
//
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                       | 인증 | 비고                                             |
// |---|-----------------------|---------------|------|---------------------------------|------|--------------------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)   | —    | —                               | —    | think()                                          |
// | 2 | 홈화면 진입           | 포함          | GET  | GET /trend/nearby               | Y    | storeId = data.hotStores[0].storeId              |
// | 3 | 가게 상세 진입        | 포함          | GET  | GET /stores/{storeId}           | Y    | 2번 체이닝                                        |
// | 4 | 메뉴 리스트 조회      | 포함          | GET  | GET /stores/{storeId}/menus     | Y    | menuId = data[0].menuId                          |
// | 5 | 메뉴 상세 조회        | 포함          | GET  | GET /menus/{menuId}             | Y    | 4번 체이닝                                        |
// | 6 | 리뷰 리스트 조회      | 포함          | GET  | GET /menus/{menuId}/reviews     | Y    | reviewId = data.content[0].id                    |
// | 7 | 리뷰 상세 조회        | 포함          | GET  | GET /reviews/{reviewId}         | Y    | memberId = data.author.id                        |
// | 8 | 사용자 리뷰 리스트    | 포함          | GET  | GET /users/{memberId}/reviews   | Y    | storeId2 = 현재 storeId와 다른 reviews[].storeId |
// | 9 | 다른 가게 상세 진입   | 포함          | GET  | GET /stores/{storeId}           | Y    | 8번 체이닝 (name 태그는 동일 엔드포인트)           |
// |10 | 다른 가게 메뉴 조회   | 포함          | GET  | GET /stores/{storeId}/menus     | Y    | menuId2 = data[0].menuId                         |
// |11 | 다른 가게 메뉴 리뷰   | 포함          | GET  | GET /menus/{menuId}/reviews     | Y    | 10번 체이닝 (name 태그는 동일 엔드포인트)          |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('user_review_chain_flow');

export default function userReviewChainFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  let storeId, menuId, reviewId, memberId, storeId2, menuId2;

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

  group('04. 메뉴 상세 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}`, { token, name: 'GET /menus/{menuId}' });
    checkOk(res, 'GET /menus/{menuId}');
  });
  think();

  group('05. 리뷰 리스트 조회', () => {
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

  group('06. 리뷰 상세 조회', () => {
    if (!reviewId) return;
    const res = apiGet(`/reviews/${reviewId}`, { token, name: 'GET /reviews/{reviewId}' });
    checkOk(res, 'GET /reviews/{reviewId}');
    const data = dataOf(res);
    if (data && data.author) {
      memberId = data.author.id; // 멤버 id는 data.author.id
    }
  });
  think();

  group('07. 사용자 리뷰 리스트 조회', () => {
    if (!memberId) return;
    const res = apiGet(`/users/${memberId}/reviews`, {
      token,
      params: { page: 0, size: 20 },
      name: 'GET /users/{memberId}/reviews',
    });
    checkOk(res, 'GET /users/{memberId}/reviews');
    const data = dataOf(res);
    const list = data && Array.isArray(data.content) ? data.content : Array.isArray(data) ? data : [];
    const other = list.find((r) => r.storeId && r.storeId !== storeId);
    if (other) storeId2 = other.storeId;
  });
  think();

  group('08. 다른 가게 상세 진입', () => {
    if (!storeId2) return;
    const res = apiGet(`/stores/${storeId2}`, { token, name: 'GET /stores/{storeId}' });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('09. 다른 가게 메뉴 조회', () => {
    if (!storeId2) return;
    const res = apiGet(`/stores/${storeId2}/menus`, { token, name: 'GET /stores/{storeId}/menus' });
    checkOk(res, 'GET /stores/{storeId}/menus');
    const data = dataOf(res);
    if (Array.isArray(data) && data.length > 0) {
      menuId2 = data[0].menuId;
    }
  });
  think();

  group('10. 다른 가게 메뉴 리뷰 조회', () => {
    if (!menuId2) return;
    const res = apiGet(`/menus/${menuId2}/reviews`, {
      token,
      params: { sort: 'recent', page: 0, size: 20 },
      name: 'GET /menus/{menuId}/reviews',
    });
    checkOk(res, 'GET /menus/{menuId}/reviews');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/user-review-chain-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/user-review-chain-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/user-review-chain-flow-test.js
