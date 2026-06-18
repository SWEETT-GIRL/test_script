// scenarios/olivia/current-location-trend.js
//
// [담당자]       olivia
// [slug]         current-location-trend
// [scenarioName] current_location_trend
// [목적]         지역선택 탭에서 다른 지역을 골라 가게 상세를 본 뒤,
//               다시 "현재위치로" 버튼을 눌러 현위치 기반 트렌드로 돌아오는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입              → (자동) GET /trend/nearby
//   2. 지역선택 탭에서 다른 지역 선택        → GET /trend/select?region
//   3. 그 지역 가게 1개 상세 진입           → GET /stores/{storeId}
//   4. "현재위치로" 버튼 누름 → 현위치 트렌드  → GET /trend/nearby
//
// ─────────────────────────────────────────────────────────────────────────────
// BE/FE 확인 결과
//   - GET /trend/select?region 의 region 은 BE 에서 Region3rd.valueOf(region) 로 파싱한다
//     (TrendService.getTrendByRegion). 즉 "강남구_역삼동" 같은 정확한 Region3rd enum 값만 유효.
//   - 테스트마다 다른 지역을 탐색하도록 region 은 pickRegion() 으로 고른다.
//     data/regions.csv = Region3rd enum 전체 값(약 2,689개), VU·반복 시드로 분산(재현 가능).
//     (위치 pickLocation 과 상관되지 않게 별도 시드 사용 → 위치/지역이 독립적으로 흩어짐)
//   - 응답 체이닝: RegionTrendResponse.categories[].stores[].storeId → GET /stores/{storeId}.
//     지역에 trend 데이터가 없으면 categories 가 비어 storeId 가 없을 수 있다 → 가드 후 단계 유지.
//   - "현재위치로" = 현위치(lat,lng) 기반 → GET /trend/nearby. trend/select 와 혼동 금지.
//     (버튼 자체는 디바이스 GPS/역지오코딩만 하고 BE 호출은 /trend/nearby 로 일어남)
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그              | 인증 | 쿼리/바디 · 체이닝                         |
// |---|-----------------------|---------------|------|------------------------|------|--------------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)    | -    | -                      | -    | think()                                    |
// | 2 | JWT 인증              | 제외           | -    | -                      | -    | pickToken() (사전 발급 토큰)                |
// | 3 | 홈 진입(자동 현위치)    | 포함           | GET  | GET /trend/nearby      | Y    | params: lat,lng                            |
// | 4 | 지역선택 — 다른 지역    | 포함           | GET  | GET /trend/select      | Y    | params: region(=pickRegion()). storeId 체이닝 |
// | 5 | 가게 상세 진입         | 포함           | GET  | GET /stores/{storeId}  | Y    | storeId = 4번 응답 체이닝                   |
// | 6 | "현재위치로" 버튼       | 제외(sleep)    | -    | -                      | -    | GPS/역지오코딩=디바이스 → think()           |
// | 7 | 현위치 트렌드 재조회    | 포함           | GET  | GET /trend/nearby      | Y    | params: lat,lng                            |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickRegion } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('current_location_trend');

// 재현 가능한 결정적 인덱스(데이터 §0). 같은 (VU, iter) 면 같은 가게를 고른다.
function seededIndex(len) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

// RegionTrendResponse.categories[].stores[] 를 평탄화해 storeId 목록을 뽑는다.
function collectStoreIds(data) {
  if (!data || !Array.isArray(data.categories)) return [];
  const ids = [];
  for (const cat of data.categories) {
    if (cat && Array.isArray(cat.stores)) {
      for (const s of cat.stores) {
        if (s && s.storeId != null) ids.push(s.storeId);
      }
    }
  }
  return ids;
}

export default function currentLocationTrend() {
  const { token } = pickToken();
  const loc = pickLocation();
  const region = pickRegion(); // 테스트마다(=VU·반복마다) 다른 Region3rd 값
  let storeId; // 4번 응답에서 체이닝할 가게 id

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

  group('02. 지역선택 — 다른 지역 트렌드 조회', () => {
    const res = apiGet('/trend/select', {
      token,
      params: { region }, // pickRegion() 으로 고른 Region3rd 값. 하드코딩 금지.
      name: 'GET /trend/select',
    });
    checkOk(res, 'GET /trend/select');

    const ids = collectStoreIds(dataOf(res));
    if (ids.length > 0) {
      storeId = ids[seededIndex(ids.length)]; // 가게 1개(재현 가능 랜덤) 선택
    }
  });
  think();

  group('03. 가게 상세 진입', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}`, {
      token,
      name: 'GET /stores/{storeId}',
    });
    checkOk(res, 'GET /stores/{storeId}');
  });
  // 4. "현재위치로" 버튼 누름 = GPS/역지오코딩(디바이스, BE 호출 없음) → sleep
  think();

  group('04. "현재위치로" — 현위치 트렌드 재조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/current-location-trend.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/current-location-trend.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/current-location-trend.js
