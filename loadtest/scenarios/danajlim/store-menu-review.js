// scenarios/danajlim/store-menu-review.js
//
// [담당자]      danajlim
// [slug]        store-menu-review
// [scenarioName] store_menu_review
// [목적]        홈에서 특정 가게를 검색해 상세·메뉴 리스트를 보고, '명란마요소금빵' 같은
//               특정 메뉴 1개를 골라 메뉴 상세와 그 메뉴의 리뷰까지 확인하는 흐름
//               ("이 가게 이 빵 어때?")의 성능 확인
//               ※ store-detail-bread(인기 메뉴 top-N 루프)와 달리 특정 메뉴 1개만 본다.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입              → GET /trend/nearby
//   4. 특정 가게 검색           → GET /stores/search          (storeId 체이닝)
//   5. 가게 상세 조회           → GET /stores/{storeId}
//   6. 메뉴 리스트 조회         → GET /stores/{storeId}/menus  (특정 menuId 체이닝)
//   7. 특정 메뉴 선택(상세)     → GET /menus/{menuId}
//   8. 리뷰 보기 (요약+리스트)  → GET /menus/{menuId}/reviews/summary
//                                  + GET /menus/{menuId}/reviews
// [주의사항]    전부 GET(읽기 전용) — 부수효과 없음.
//               "특정 메뉴 선택"은 메뉴 리스트에서 이름 키워드로 1개를 고르는 클라 동작.
//               매칭 실패 시 첫 메뉴로 폴백한다(menuId 는 항상 직전 응답에서 체이닝, 하드코딩 X).
//
// 단계 → 엔드포인트 매핑
// | # | 단계                | 포함/제외   | HTTP | name 태그                            | 인증 | 비고                                  |
// |---|---------------------|-------------|------|--------------------------------------|------|---------------------------------------|
// | 1 | 앱 실행             | 제외(sleep) | -    | -                                    | -    | think()                               |
// | 2 | JWT 인증            | 제외        | -    | -                                    | -    | pickToken()                           |
// | 3 | 홈화면 진입         | 포함        | GET  | GET /trend/nearby                    | Y    | params: lat,lng (CSV lon→lng)         |
// | 4 | 특정 가게 검색      | 포함        | GET  | GET /stores/search                   | Y    | query=pickQuery(), lat,lon, sort=인기 |
// | 5 | 가게 상세 조회      | 포함        | GET  | GET /stores/{storeId}                | Y    | storeId = 4번 응답 체이닝             |
// | 6 | 메뉴 리스트 조회    | 포함        | GET  | GET /stores/{storeId}/menus          | Y    | 특정 메뉴 1개 menuId 체이닝           |
// | 7 | 특정 메뉴 선택(상세)| 포함        | GET  | GET /menus/{menuId}                  | Y    | 6번에서 고른 menuId                   |
// | 8 | 리뷰 요약           | 포함        | GET  | GET /menus/{menuId}/reviews/summary  | Y    | previewSize=2                         |
// | 8 | 리뷰 리스트         | 포함        | GET  | GET /menus/{menuId}/reviews          | Y    | sort=recommended, page=0, size=20     |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_menu_review');

// "특정 메뉴" 선택 키워드(클라 UI 동작 모사 — BE 호출 없음).
// 메뉴 이름에 이 키워드가 들어간 첫 메뉴를 고르고, 없으면 첫 메뉴로 폴백한다.
// StoreMenuResponse 의 이름 필드는 name(menuId/name/category...). 매칭만 클라에서 한다.
const TARGET_MENU_KEYWORD = '소금빵';

function pickTargetMenuId(menus) {
  if (!Array.isArray(menus) || menus.length === 0) return undefined;
  const matched = menus.find((m) =>
    String((m && m.name) || '').includes(TARGET_MENU_KEYWORD),
  );
  const target = matched || menus[0]; // 키워드 매칭 실패 시 첫 메뉴 폴백
  return target ? target.menuId : undefined;
}

export default function storeMenuReview() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;
  let menuId;

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
      storeId = data.content[0].id;
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

  group('04. 메뉴 리스트 조회 — 특정 메뉴 선택', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, {
      token,
      name: 'GET /stores/{storeId}/menus',
    });
    checkOk(res, 'GET /stores/{storeId}/menus');

    // 응답: ApiResponse<List<StoreMenuResponse>> → data 가 곧 배열
    menuId = pickTargetMenuId(dataOf(res));
  });
  think();

  group('05. 특정 메뉴 선택 — 메뉴 상세 조회', () => {
    if (!menuId) return; // 메뉴가 비면 가드 후 종료
    const res = apiGet(`/menus/${menuId}`, {
      token,
      name: 'GET /menus/{menuId}',
    });
    checkOk(res, 'GET /menus/{menuId}');
  });
  think();

  group('06. 리뷰 보기 (요약 + 리스트)', () => {
    if (!menuId) return;

    // 6-1. 리뷰 요약(미리보기)
    const summaryRes = apiGet(`/menus/${menuId}/reviews/summary`, {
      token,
      params: { sort: 'recommended', photoOnly: false, previewSize: 2 },
      name: 'GET /menus/{menuId}/reviews/summary',
    });
    checkOk(summaryRes, 'GET /menus/{menuId}/reviews/summary');

    // 6-2. 리뷰 리스트 (sort: recent|recommended — 인기 흐름이므로 recommended)
    const listRes = apiGet(`/menus/${menuId}/reviews`, {
      token,
      params: { sort: 'recommended', photoOnly: false, page: 0, size: 20 },
      name: 'GET /menus/{menuId}/reviews',
    });
    checkOk(listRes, 'GET /menus/{menuId}/reviews');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-menu-review.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-menu-review.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-menu-review.js
