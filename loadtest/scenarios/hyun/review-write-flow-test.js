// scenarios/hyun/review-write-flow-test.js
//
// [담당자]       hyun
// [slug]         review-write-flow-test
// [scenarioName] review_write_flow
// [목적]         검색으로 빵집을 찾아 메뉴 상세에서 리뷰를 작성하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. JWT 인증              (제외 → pickToken)
//   3. 검색어 자동완성       → GET /stores/autocomplete
//   4. 검색 결과 조회        → GET /stores/search
//   5. 가게 상세 진입        → GET /stores/{storeId}
//   6. 메뉴 리스트 조회      → GET /stores/{storeId}/menus
//   7. 메뉴 상세 조회        → GET /menus/{menuId}
//   8. 리뷰 요약 조회        → GET /menus/{menuId}/reviews/summary
//   9. presigned URL 발급   → POST /reviews/images/presigned-urls  (S3 mock)
//  10. 리뷰 작성             → POST /menus/{menuId}/reviews
//
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                           | 인증 | 비고                                |
// |---|-----------------------|---------------|------|-------------------------------------|------|-------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)   | —    | —                                   | —    | think()                             |
// | 2 | JWT 인증              | 제외          | —    | —                                   | —    | pickToken()                         |
// | 3 | 검색어 자동완성       | 포함          | GET  | GET /stores/autocomplete            | N    | query=pickQuery(), size=10          |
// | 4 | 검색 결과 조회        | 포함          | GET  | GET /stores/search                  | N    | ⚠ lon(search만 lon), sort=distance |
// | 5 | 가게 상세 진입        | 포함          | GET  | GET /stores/{storeId}               | Y    | storeId = 4번 data.content[0].id   |
// | 6 | 메뉴 리스트 조회      | 포함          | GET  | GET /stores/{storeId}/menus         | Y    | menuId = data[0].menuId            |
// | 7 | 메뉴 상세 조회        | 포함          | GET  | GET /menus/{menuId}                 | Y    | 6번 체이닝                          |
// | 8 | 리뷰 요약 조회        | 포함          | GET  | GET /menus/{menuId}/reviews/summary | Y    | previewSize=2                       |
// | 9 | presigned URL 발급    | mock(S3)      | POST | POST /reviews/images/presigned-urls | Y    | BE가 S3 mock 처리                   |
// |10 | 리뷰 작성             | 포함          | POST   | POST /menus/{menuId}/reviews          | Y    | ⚠ 부수효과. 개발 서버 DB. reviewId 체이닝 |
// |11 | 리뷰 삭제             | 포함(cleanup) | DELETE | DELETE /reviews/{reviewId}            | Y    | iteration 종료 전 상태 복원               |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, apiDelete, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('review_write_flow');

export default function reviewWriteFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId, menuId, reviewId;

  group('01. 검색어 자동완성', () => {
    const res = apiGet('/stores/autocomplete', {
      params: { query: q.query, size: 10 },
      name: 'GET /stores/autocomplete',
    });
    checkOk(res, 'GET /stores/autocomplete');
  });
  think();

  group('02. 검색 결과 조회', () => {
    const res = apiGet('/stores/search', {
      params: { query: q.query, lat: loc.lat, lon: loc.lon, sort: 'distance', size: 15 }, // ⚠ /stores/search 만 lon
      name: 'GET /stores/search',
    });
    checkOk(res, 'GET /stores/search');
    const data = dataOf(res);
    if (data && Array.isArray(data.content) && data.content.length > 0) {
      storeId = data.content[0].id; // search 응답의 스토어 id 필드는 'id'
    }
  });
  think();

  group('03. 가게 상세 진입', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}`, { token, name: 'GET /stores/{storeId}' });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('04. 메뉴 리스트 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, { token, name: 'GET /stores/{storeId}/menus' });
    checkOk(res, 'GET /stores/{storeId}/menus');
    const data = dataOf(res);
    if (Array.isArray(data) && data.length > 0) {
      menuId = data[0].menuId;
    }
  });
  think();

  group('05. 메뉴 상세 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}`, { token, name: 'GET /menus/{menuId}' });
    checkOk(res, 'GET /menus/{menuId}');
  });
  think();

  group('06. 리뷰 요약 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}/reviews/summary`, {
      token,
      params: { previewSize: 2 },
      name: 'GET /menus/{menuId}/reviews/summary',
    });
    checkOk(res, 'GET /menus/{menuId}/reviews/summary');
  });
  think();

  group('07. 이미지 presigned URL 발급', () => {
    if (!menuId) return;
    const res = apiPost('/reviews/images/presigned-urls', {
      token,
      body: { mimeTypes: ['image/jpeg'] },
      name: 'POST /reviews/images/presigned-urls',
    });
    checkOk(res, 'POST /reviews/images/presigned-urls');
  });
  think();

  group('08. 리뷰 작성', () => {
    if (!menuId) return;
    const res = apiPost(`/menus/${menuId}/reviews`, {
      token,
      body: {
        rating: 4,
        repurchaseIntent: 'YES',
        sweetness: '보통',
        fillingAmount: '보통',
        textureTags: ['crispy'],
        content: 'loadtest-review',
        images: [],
      },
      name: 'POST /menus/{menuId}/reviews',
    });
    checkOk(res, 'POST /menus/{menuId}/reviews');
    const data = dataOf(res);
    if (data) reviewId = data.id;
  });

  group('09. 리뷰 삭제', () => {
    if (!reviewId) return;
    apiDelete(`/reviews/${reviewId}`, { token, name: 'DELETE /reviews/{reviewId}' });
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/review-write-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/review-write-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/review-write-flow-test.js
