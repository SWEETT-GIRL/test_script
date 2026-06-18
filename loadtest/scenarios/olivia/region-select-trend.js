// scenarios/olivia/region-select-trend.js
//
// [담당자]       olivia
// [slug]         region-select-trend
// [scenarioName] region_select_trend
// [목적]         홈에서 지역검색 탭으로 시/군/구를 하나 선택해 읍/면/동 트렌드를 2~3개
//               조회하며 가게를 탐색하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입                  → (자동) GET /trend/nearby
//   2. 지역검색 탭 진입 후 시/군/구 1개 선택      (UI → sleep, pickRegionCluster 로 시군구 결정)
//   3. 그 시군구의 읍/면/동 2~3개 각각 트렌드 조회 → GET /trend/select?region (여러 번)
//   4. 트렌드 결과에서 여러 가게 상세 탐색        → GET /stores/{storeId} (+ 1곳 /menus)
//
// ─────────────────────────────────────────────────────────────────────────────
// BE/데이터 확인 결과 (§3)
//   - GET /trend/select?region 의 region 은 Region3rd.valueOf(region) 로 파싱(TrendService).
//     즉 '강남구_역삼동' 같은 정확한 Region3rd enum 값(시군구_읍면동)만 유효.
//   - region 값 출처가 lib pick* 에 없던 문제 → data/regions.csv(Region3rd 전체) +
//     lib pickRegionCluster() 추가로 해결. pickRegionCluster(count) 는 시드 기반으로
//     시군구 1개를 고르고 그 안의 읍/면/동 최대 count 개(모두 같은 시군구)를 돌려준다.
//     → 테스트마다(VU·반복마다) 다른 시군구·동 묶음을 탐색(재현 가능).
//   - ⚠ 후보로 받은 대전·부산·제주·…는 시/도 레벨이지만 enum 은 시군구_읍면동 뿐이라
//     시도→시군구 매핑이 데이터에 없다. 그래서 "시도 단위 택1" 이 아니라 enum 의
//     "시군구 단위 택1 → 그 안 읍면동 2~3개" 로 모델링한다(step 3 와 동일 의미).
//     시도 단위로 제한하려면 시도→시군구 매핑 데이터가 별도로 필요(미보유).
//   - 가게 id 는 하드코딩 금지. 트렌드 응답 categories[].stores[].storeId 에서 체이닝하고,
//     수집한 id 중 시드 기반으로 여러 개를 골라 상세를 탐색한다(테스트마다 랜덤).
//   - 데이터 없는 지역은 categories 가 비어 storeId 가 안 나올 수 있다 → 가드(단계 유지).
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계                    | 포함/제외/mock | HTTP | name 태그                   | 인증 | 쿼리/바디 · 체이닝                    |
// |---|-------------------------|---------------|------|-----------------------------|------|---------------------------------------|
// | 1 | 앱 실행                 | 제외(sleep)    | -    | -                           | -    | think()                               |
// | 2 | JWT 인증                | 제외           | -    | -                           | -    | pickToken()                           |
// | 3 | 홈 진입(자동 현위치)      | 포함           | GET  | GET /trend/nearby           | Y    | params: lat,lng                       |
// | 4 | 지역검색 탭 + 시군구 선택  | 제외(sleep)    | -    | -                           | -    | pickRegionCluster() → think()         |
// | 5 | 읍/면/동 2~3개 트렌드     | 포함(반복)     | GET  | GET /trend/select           | Y    | params: region(cluster). storeId 수집 |
// | 6 | 여러 가게 상세 탐색       | 포함(반복)     | GET  | GET /stores/{storeId}       | Y    | storeId = 5번 수집분에서 시드 선택     |
// | 7 | (첫 가게) 메뉴 조회       | 포함           | GET  | GET /stores/{storeId}/menus | Y    | 6번 첫 storeId 동시 호출              |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickRegionCluster } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('region_select_trend');

// 재현 가능한 결정적 인덱스(데이터 §0). 같은 (VU, iter) 면 같은 선택.
function seededIndex(len, salt) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503 + (salt | 0) * 97;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

// RegionTrendResponse.categories[].stores[] 평탄화 → storeId 목록(중복 제거).
function collectStoreIds(data, into) {
  if (!data || !Array.isArray(data.categories)) return;
  for (const cat of data.categories) {
    if (cat && Array.isArray(cat.stores)) {
      for (const s of cat.stores) {
        if (s && s.storeId != null) into.add(s.storeId);
      }
    }
  }
}

export default function regionSelectTrend() {
  const { token } = pickToken();
  const loc = pickLocation();

  // 시군구 1개 + 그 안 읍/면/동 2~3개(테스트마다 다름). count 도 2/3 으로 흔든다.
  const dongCount = 2 + (seededIndex(2, 1)); // 2 또는 3
  const cluster = pickRegionCluster(dongCount); // { sigungu, regions: [...] }
  const storeIdSet = new Set();

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
  // 2. 지역검색 탭 진입 + 시군구 선택 = UI → sleep
  think();

  group('02. 읍/면/동 트렌드 조회 (2~3개)', () => {
    // 같은 시군구의 서로 다른 region 값으로 여러 번 호출(§ 여러 개 쏘기).
    for (const region of cluster.regions) {
      const res = apiGet('/trend/select', {
        token,
        params: { region }, // pickRegionCluster() 결과. 하드코딩 금지.
        name: 'GET /trend/select',
      });
      checkOk(res, 'GET /trend/select');
      collectStoreIds(dataOf(res), storeIdSet);
    }
  });
  think();

  group('03. 여러 가게 상세 탐색', () => {
    const ids = Array.from(storeIdSet);
    if (ids.length === 0) return; // 트렌드 데이터 없는 지역이면 가드 후 종료(단계 유지)

    // 수집한 id 중 최대 3곳을 시드 기반으로 골라 탐색(테스트마다 랜덤).
    const visitCount = Math.min(3, ids.length);
    const start = seededIndex(ids.length, 2);
    for (let i = 0; i < visitCount; i++) {
      const storeId = ids[(start + i) % ids.length];
      const res = apiGet(`/stores/${storeId}`, {
        token,
        name: 'GET /stores/{storeId}',
      });
      checkOk(res, 'GET /stores/{storeId}');

      // 첫 가게는 상세 진입과 동시에 메뉴도 조회(카탈로그: 가게 상세와 동시 호출).
      if (i === 0) {
        const menuRes = apiGet(`/stores/${storeId}/menus`, {
          token,
          name: 'GET /stores/{storeId}/menus',
        });
        checkOk(menuRes, 'GET /stores/{storeId}/menus');
      }
    }
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/region-select-trend.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/region-select-trend.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/region-select-trend.js
