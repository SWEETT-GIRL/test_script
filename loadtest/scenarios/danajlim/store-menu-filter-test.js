// scenarios/danajlim/store-menu-filter-test.js
//
// [담당자]      danajlim
// [slug]        store-menu-filter-test
// [scenarioName] store_menu_filter
// [목적]        홈에서 특정 가게를 검색해 상세로 들어가, 메뉴에서 '소금빵' 카테고리만
//               필터링해 보고 다시 전체 메뉴로 돌아오는 흐름("이 가게에서 소금빵만 보고싶어")의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행                    (비-API → sleep)
//   2. JWT로 인증                 (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입                → GET /trend/nearby
//   4. 특정 가게 검색             → GET /stores/search        (storeId 체이닝)
//   5. 가게 상세 조회             → GET /stores/{storeId}
//   6. 메뉴 리스트 조회           → GET /stores/{storeId}/menus
//   7. '소금빵' 카테고리 필터 선택 (비-API → sleep, 6 응답을 클라가 category 로 필터)
//   8. 다시 클릭해 전체 메뉴 보기  (비-API → sleep, 필터 해제 = 클라 동작)
// [주의사항]    전부 GET(읽기 전용) — 부수효과 없음.
//               7·8(소금빵 필터 ↔ 전체 보기)은 6에서 받은 메뉴 리스트를 클라이언트가
//               category 로 거르는 UI 토글 — 별도 BE 호출 없음(sleep 으로 모델링).
//
// 단계 → 엔드포인트 매핑
// | # | 단계                      | 포함/제외   | HTTP | name 태그                   | 인증 | 비고                                  |
// |---|---------------------------|-------------|------|-----------------------------|------|---------------------------------------|
// | 1 | 앱 실행                   | 제외(sleep) | -    | -                           | -    | think()                               |
// | 2 | JWT 인증                  | 제외        | -    | -                           | -    | pickToken()                           |
// | 3 | 홈화면 진입               | 포함        | GET  | GET /trend/nearby           | Y    | params: lat,lng (CSV lon→lng)         |
// | 4 | 특정 가게 검색            | 포함        | GET  | GET /stores/search          | Y    | query=pickQuery(), lat,lon, sort=distance |
// | 5 | 가게 상세 조회            | 포함        | GET  | GET /stores/{storeId}       | Y    | storeId = 4번 응답 체이닝             |
// | 6 | 메뉴 리스트 조회          | 포함        | GET  | GET /stores/{storeId}/menus | Y    | 5번 storeId, menus[] 보관             |
// | 7 | '소금빵' 카테고리 필터    | 제외(sleep) | -    | -                           | -    | 6 응답을 클라가 category 로 필터       |
// | 8 | 다시 전체 메뉴 보기       | 제외(sleep) | -    | -                           | -    | 필터 해제 = 클라 동작                  |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_menu_filter');

// 필터링할 카테고리(클라 UI 동작 모사용 — BE 호출 없음).
// BE MenuCategory enum 이 한글 상수라 StoreMenuResponse.category 값은 "소금빵".
// FE(useBakeryDetail)도 item.category === selectedCategory 로 클라에서만 필터한다.
// category 매칭이 안 돼도 BE 부하에는 영향 없음(어차피 추가 요청 없음).
const FILTER_CATEGORY = '소금빵';

export default function storeMenuFilter() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;
  let menus = [];

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
        sort: 'distance', // SearchSort: distance|popularity|relevance — FE 검색 기본값과 동일
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

    // 응답: ApiResponse<List<StoreMenuResponse>> → data 가 곧 배열
    const data = dataOf(res);
    if (Array.isArray(data)) {
      menus = data;
    }
  });
  think();

  // 05·06. '소금빵' 필터 ↔ 전체 보기 — BE 호출 없는 클라 UI 토글(sleep 으로 체류 모사).
  //        category 매칭은 클라에서만 일어나며 추가 요청을 만들지 않는다.
  const _filtered = menus.filter((m) => m && m.category === FILTER_CATEGORY);
  think(); // 소금빵 필터 선택 후 결과 확인
  think(); // 다시 클릭해 전체 메뉴 보기
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-menu-filter-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-menu-filter-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-menu-filter-test.js
