// scenarios/danajlim/store-detail-bread-test.js
//
// [담당자]      danajlim
// [slug]        store-detail-bread-test
// [scenarioName] store_detail_bread
// [목적]        홈에서 특정 가게를 검색해 가게 상세·메뉴 리스트를 보고,
//               인기 메뉴들의 리뷰까지 확인하는 흐름("이 가게 무슨 빵이 유명한지")의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행                       (비-API → sleep)
//   2. JWT로 인증                    (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입                   → GET /trend/nearby
//   4. 특정 가게 검색                → GET /stores/search        (storeId 체이닝)
//   5. 가게 상세 조회                → GET /stores/{storeId}
//   6. 메뉴 리스트 조회              → GET /stores/{storeId}/menus (인기 menuId 체이닝)
//   7. 인기 메뉴들 메뉴 화면 진입 → GET /menus/{menuId} (상세)
//                                  + GET /menus/{menuId}/reviews/summary
//                                  + GET /menus/{menuId}/reviews (size 20)
// [주의사항]    전부 GET(읽기 전용) — 부수효과 없음.
//               FE 메뉴 화면(app/menu/[id].tsx)은 메뉴 상세 + 리뷰 요약 + 리뷰 리스트를 함께 호출한다.
//
// 단계 → 엔드포인트 매핑
// | # | 단계                  | 포함/제외   | HTTP | name 태그                            | 인증 | 비고                                   |
// |---|-----------------------|-------------|------|--------------------------------------|------|----------------------------------------|
// | 1 | 앱 실행               | 제외(sleep) | -    | -                                    | -    | think()                                |
// | 2 | JWT 인증              | 제외        | -    | -                                    | -    | pickToken()                            |
// | 3 | 홈화면 진입           | 포함        | GET  | GET /trend/nearby                    | Y    | params: lat,lng (CSV lon→lng)          |
// | 4 | 특정 가게 검색        | 포함        | GET  | GET /stores/search                   | Y    | query=pickQuery(), lat,lon, sort=인기  |
// | 5 | 가게 상세 조회        | 포함        | GET  | GET /stores/{storeId}                | Y    | storeId = 4번 응답 체이닝              |
// | 6 | 메뉴 리스트 조회      | 포함        | GET  | GET /stores/{storeId}/menus          | Y    | 5번 storeId, 인기 menuId 목록 체이닝   |
// | 7 | 인기 메뉴 상세        | 포함        | GET  | GET /menus/{menuId}                  | Y    | 6번 상위 N개 menuId 루프 (메뉴 화면)   |
// | 7 | 인기 메뉴 리뷰 요약   | 포함        | GET  | GET /menus/{menuId}/reviews/summary  | Y    | previewSize=2                          |
// | 7 | 인기 메뉴 리뷰 리스트 | 포함        | GET  | GET /menus/{menuId}/reviews          | Y    | sort=recommended, page=0, size=20     |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_detail_bread');

// "인기 메뉴들" = 메뉴 리스트 상위 N개.
// /stores/{storeId}/menus 는 BE 에서 likeCount(추천수) 내림차순으로 이미 정렬돼 오므로
// 앞에서부터 N개를 인기 메뉴로 본다. (BE 주석: 인기메뉴 top5 는 클라이언트 처리)
const POPULAR_MENU_COUNT = 3;

export default function storeDetailBread() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;
  let menuIds = [];

  group('01. 홈화면 진입 — 위치 기반 트렌드 조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. 특정 가게 검색', () => {
    const res = apiGet('/stores/search', {
      token,
      // ⚠ /stores/search 만 lon (나머지는 lng)
      params: {
        query: q.query,
        lat: loc.lat,
        lon: loc.lon,
        page: 0,
        size: 15,
        sort: 'popularity', // SearchSort: distance|popularity|relevance — "유명한 가게" → popularity
      },
      name: 'GET /stores/search',
    });
    checkOk(res, 'GET /stores/search');

    // 응답: ApiResponse<SliceResponse<StoreSearchResponse>> → data.content[].id
    const data = dataOf(res);
    if (data && Array.isArray(data.content) && data.content.length > 0) {
      storeId = data.content[__ITER % data.content.length].id;
    }
  });
  think();

  group('03. 가게 상세 조회', () => {
    if (!storeId) return; // 검색 결과가 비면 가드 후 종료(단계 자체는 유지)
    const res = apiGet(`/stores/${storeId}`, {
      token,
      name: 'GET /stores/{storeId}',
    });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('04. 메뉴 리스트 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, {
      token,
      name: 'GET /stores/{storeId}/menus',
    });
    checkOk(res, 'GET /stores/{storeId}/menus');

    // 응답: ApiResponse<List<StoreMenuResponse>> → data 가 곧 배열 (likeCount desc 정렬됨)
    const menus = dataOf(res);
    if (Array.isArray(menus)) {
      menuIds = menus
        .slice(0, POPULAR_MENU_COUNT) // 앞에서부터 = 인기 메뉴
        .map((m) => m.menuId)
        .filter((id) => id !== undefined && id !== null);
    }
  });
  think();

  group('05. 인기 메뉴들 메뉴 화면 진입 (상세 + 리뷰 미리보기)', () => {
    if (menuIds.length === 0) return; // 메뉴가 비면 가드 후 종료
    for (const menuId of menuIds) {
      // FE 대조(app/menu/[id].tsx): 메뉴 화면은 진입 시 메뉴 상세 + 리뷰 요약 + 리뷰 미리보기(size 2)를
      // 함께 호출한다. "무슨 빵이 유명한지" 글랜스 흐름이므로 전체 리스트(size 20)가 아니라 미리보기.
      // (전체 리뷰 화면 size 20 흐름은 store-menu-review.js 가 모델링)

      // 5-1. 메뉴 상세 (메뉴 화면 진입 — FE 가 항상 호출)
      const detailRes = apiGet(`/menus/${menuId}`, {
        token,
        name: 'GET /menus/{menuId}',
      });
      checkOk(detailRes, 'GET /menus/{menuId}');

      // 5-2. 리뷰 요약(미리보기)
      const summaryRes = apiGet(`/menus/${menuId}/reviews/summary`, {
        token,
        params: { sort: 'recommended', photoOnly: false, previewSize: 2 },
        name: 'GET /menus/{menuId}/reviews/summary',
      });
      checkOk(summaryRes, 'GET /menus/{menuId}/reviews/summary');

      // 5-3. 리뷰 리스트
      const listRes = apiGet(`/menus/${menuId}/reviews`, {
        token,
        params: { sort: 'recommended', photoOnly: false, page: 0, size: 20 },
        name: 'GET /menus/{menuId}/reviews',
      });
      checkOk(listRes, 'GET /menus/{menuId}/reviews');
    }
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-detail-bread-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-detail-bread-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-detail-bread-test.js
