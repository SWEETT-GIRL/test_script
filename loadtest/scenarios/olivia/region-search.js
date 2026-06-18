// scenarios/olivia/region-search.js
//
// [담당자]       olivia
// [slug]         region-search
// [scenarioName] region_search
// [목적]         홈에서 검색창에 특정 지역을 입력해 검색하고, 결과 가게들의 상세와 리뷰까지
//               확인하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입        → (자동) GET /trend/nearby
//   2. 검색창에 특정 지역 입력(자동완성) → GET /stores/autocomplete (+ 검색화면 진입 시 GET /stores/popular)
//   3. 지역 검색 실행               → GET /stores/search
//   4. 검색된 가게들 상세 탐색        → GET /stores/{storeId} (+ /menus) ×여러 곳
//   5. 가게/메뉴 리뷰 확인           → GET /menus/{menuId}/reviews/summary, GET /menus/{menuId}/reviews
//
// ─────────────────────────────────────────────────────────────────────────────
// FE/BE 확인 결과 (§3)
//   - "지역 검색" 본 호출 = GET /stores/search (FE 일반 검색 searchBakeries).
//     ⚠ 이 엔드포인트만 lon (params: query, lat, lon, page, size, sort). 나머지 trend/* 는 lng.
//     /stores/district 는 FE region-mode(다른 진입점)용 → 이 시나리오에선 미사용.
//   - "지역으로 검색" 이 되려면 query 가 지역명이어야 한다(소금빵 같은 메뉴명이면 메뉴 검색이 됨).
//     → pickRegionQuery() 사용: data/region-search-queries.csv 의 한 단어 지역명(강남·제주·대전 …).
//   - 자동완성 = GET /stores/autocomplete?query&size (size=10, 입력 디바운스 180ms 후).
//   - 검색화면 진입 시 추천 검색어용으로 GET /stores/popular?lat&lng 가 1회 발생(usePopularBakeriesQuery).
//   - 체이닝(하드코딩 금지):
//       /stores/search → content[].storeId(=id) → GET /stores/{storeId}, /stores/{storeId}/menus
//       → menus[].menuId → GET /menus/{menuId}/reviews/summary, /menus/{menuId}/reviews
//   - 리뷰 파라미터는 FE 가 매핑 없이 그대로 전송하는 값을 사용:
//       summary { sort:'recommended', photoOnly:false, previewSize:2 }
//       list    { sort:'recent', photoOnly:false, page:0, size:20 }
//   - 여러 가게/리뷰는 직전 응답에서 시드 기반(재현 가능)으로 골라 탐색 → 테스트마다 다른 가게.
//   - 결과/메뉴가 비면 가드 후 종료(단계 유지, skip 금지).
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                          | 인증 | 쿼리/바디 · 체이닝                  |
// |---|-----------------------|---------------|------|------------------------------------|------|-------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)    | -    | -                                  | -    | think()                             |
// | 2 | JWT 인증              | 제외           | -    | -                                  | -    | pickToken()                         |
// | 3 | 홈 진입(자동 현위치)    | 포함           | GET  | GET /trend/nearby                  | Y    | params: lat,lng                     |
// | 4 | 검색화면 진입(추천)     | 포함           | GET  | GET /stores/popular                | Y    | params: lat,lng                     |
// | 5 | 검색어 입력(자동완성)   | 포함           | GET  | GET /stores/autocomplete           | Y    | params: query(지역),size=10         |
// | 6 | 지역 검색 실행         | 포함           | GET  | GET /stores/search                 | Y    | ⚠lon. query(지역),lat,lon,page,size,sort. content[].id 체이닝 |
// | 7 | 가게 상세 탐색(여러)    | 포함(반복)     | GET  | GET /stores/{storeId}              | Y    | storeId = 6번 수집분 시드 선택       |
// | 8 | 가게 메뉴 조회         | 포함(반복)     | GET  | GET /stores/{storeId}/menus        | Y    | menus[].menuId 체이닝               |
// | 9 | 메뉴 리뷰 요약         | 포함           | GET  | GET /menus/{menuId}/reviews/summary| Y    | menuId 시드 선택                    |
// |10 | 메뉴 리뷰 목록         | 포함           | GET  | GET /menus/{menuId}/reviews        | Y    | 같은 menuId                         |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickRegionQuery } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('region_search');

// 재현 가능한 결정적 인덱스(데이터 §0). 같은 (VU, iter, salt) 면 같은 선택.
function seededIndex(len, salt) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503 + (salt | 0) * 97;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

// /stores/search 응답(SliceResponse) 의 content[] 에서 storeId 목록 추출.
function collectStoreIds(data) {
  if (!data || !Array.isArray(data.content)) return [];
  const ids = [];
  for (const s of data.content) {
    const id = s && (s.storeId != null ? s.storeId : s.id); // BE/매핑 필드 모두 방어
    if (id != null) ids.push(id);
  }
  return ids;
}

// /stores/{storeId}/menus 응답(StoreMenuResponse[]) 에서 menuId 목록 추출.
function collectMenuIds(data) {
  if (!Array.isArray(data)) return [];
  const ids = [];
  for (const m of data) {
    if (m && m.menuId != null) ids.push(m.menuId);
  }
  return ids;
}

export default function regionSearch() {
  const { token } = pickToken();
  const loc = pickLocation();
  const { query } = pickRegionQuery(); // 검색할 한 단어 지역명(강남·제주·대전 …)
  const storeIds = [];
  const menuIds = [];

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

  group('02. 검색화면 진입 — 추천 검색어', () => {
    const res = apiGet('/stores/popular', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ popular 도 lng
      name: 'GET /stores/popular',
    });
    checkOk(res, 'GET /stores/popular');
  });
  think();

  group('03. 검색어 입력 — 자동완성', () => {
    const res = apiGet('/stores/autocomplete', {
      token,
      params: { query, size: 10 }, // 입력 디바운스 후 자동완성(지역명)
      name: 'GET /stores/autocomplete',
    });
    checkOk(res, 'GET /stores/autocomplete');
  });
  think();

  group('04. 지역 검색 실행', () => {
    const res = apiGet('/stores/search', {
      token,
      // ⚠ /stores/search 만 lon (다른 엔드포인트는 lng). CSV 컬럼이 lon 이라 그대로 사용.
      params: { query, lat: loc.lat, lon: loc.lon, page: 0, size: 15, sort: 'distance' },
      name: 'GET /stores/search',
    });
    checkOk(res, 'GET /stores/search');

    const ids = collectStoreIds(dataOf(res));
    // 검색 결과 맨 위(첫 번째) 가게로만 진입.
    if (ids.length > 0) storeIds.push(ids[0]);
  });
  think();

  group('05. 검색된 가게들 상세 탐색', () => {
    if (storeIds.length === 0) return; // 검색 결과 없으면 가드 후 종료(단계 유지)
    for (const storeId of storeIds) {
      const detail = apiGet(`/stores/${storeId}`, {
        token,
        name: 'GET /stores/{storeId}',
      });
      checkOk(detail, 'GET /stores/{storeId}');

      // 가게 상세와 함께 메뉴 조회(카탈로그: 동시 호출).
      const menus = apiGet(`/stores/${storeId}/menus`, {
        token,
        name: 'GET /stores/{storeId}/menus',
      });
      checkOk(menus, 'GET /stores/{storeId}/menus');

      for (const menuId of collectMenuIds(dataOf(menus))) {
        menuIds.push(menuId);
      }
    }
  });
  think();

  group('06. 가게/메뉴 리뷰 확인', () => {
    if (menuIds.length === 0) return; // 메뉴 없으면 가드 후 종료(단계 유지)
    const menuId = menuIds[seededIndex(menuIds.length, 2)]; // 메뉴 1개(재현 가능 랜덤)

    const summary = apiGet(`/menus/${menuId}/reviews/summary`, {
      token,
      params: { sort: 'recommended', photoOnly: false, previewSize: 2 },
      name: 'GET /menus/{menuId}/reviews/summary',
    });
    checkOk(summary, 'GET /menus/{menuId}/reviews/summary');

    const list = apiGet(`/menus/${menuId}/reviews`, {
      token,
      params: { sort: 'recent', photoOnly: false, page: 0, size: 20 },
      name: 'GET /menus/{menuId}/reviews',
    });
    checkOk(list, 'GET /menus/{menuId}/reviews');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/region-search.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/region-search.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/region-search.js
