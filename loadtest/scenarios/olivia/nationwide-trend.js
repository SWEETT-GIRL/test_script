// scenarios/olivia/nationwide-trend.js
//
// [담당자]       olivia
// [slug]         nationwide-trend
// [scenarioName] nationwide_trend
// [목적]         홈에서 전국을 선택해 전국 랭킹(트렌드)을 조회하고 가게를 탐색하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입       → (자동) GET /trend/nearby
//   2. 전국 선택                   (region picker UI → sleep)
//   3. 전국 랭킹 보기              → GET /trend/nationwide (파라미터 없음)
//   4. 랭킹 중 여러 가게 상세 탐색   → GET /stores/{storeId} (+ 첫 곳 /menus) ×2~3
//
// ─────────────────────────────────────────────────────────────────────────────
// BE/FE 확인 결과 (§3)
//   - "전국 선택/전국 랭킹" = GET /trend/nationwide (TrendController, @RequestParam 없음).
//     ⚠ 현재위치로(GET /trend/nearby) · 지역선택(GET /trend/select?region) 과 혼동 금지.
//     이 시나리오의 "랭킹 보기" 호출은 오직 /trend/nationwide 하나다.
//   - FE: 홈에서 region picker 로 "전국" 선택 → feedSource={type:'nationwide'}
//     → getNationwideTrend() → GET /trend/nationwide. (선택 행위 자체는 UI, BE 호출은 nationwide)
//   - ⚠ 체이닝 필드: 주의/카탈로그엔 hotStores[].storeId 로 적혀 있으나, 실제 BE DTO
//     RegionTrendResponse 와 FE 매핑은 categories[].stores[].storeId 다(nearby/select/nationwide
//     모두 동일 DTO). → categories[].stores[].storeId 로 체이닝한다. 하드코딩 금지.
//   - 여러 가게는 직전 응답에서 시드 기반(재현 가능)으로 2~3개 골라 탐색 → 테스트마다 다른 가게.
//   - 결과/메뉴가 비면 가드 후 종료(단계 유지, skip 금지).
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계                  | 포함/제외/mock | HTTP | name 태그                   | 인증 | 쿼리/바디 · 체이닝                  |
// |---|-----------------------|---------------|------|-----------------------------|------|-------------------------------------|
// | 1 | 앱 실행               | 제외(sleep)    | -    | -                           | -    | think()                             |
// | 2 | JWT 인증              | 제외           | -    | -                           | -    | pickToken()                         |
// | 3 | 홈 진입(자동 현위치)    | 포함           | GET  | GET /trend/nearby           | Y    | params: lat,lng                     |
// | 4 | 전국 선택             | 제외(sleep)    | -    | -                           | -    | region picker UI → think()          |
// | 5 | 전국 랭킹 보기         | 포함           | GET  | GET /trend/nationwide       | Y    | 파라미터 없음. storeId 체이닝        |
// | 6 | 여러 가게 상세(2~3)    | 포함(반복)     | GET  | GET /stores/{storeId}       | Y    | storeId = 5번 응답 시드 선택         |
// | 7 | (첫 가게) 메뉴 조회    | 포함           | GET  | GET /stores/{storeId}/menus | Y    | 6번 첫 storeId 동시 호출            |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('nationwide_trend');

// 재현 가능한 결정적 인덱스(데이터 §0). 같은 (VU, iter, salt) 면 같은 선택.
function seededIndex(len, salt) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503 + (salt | 0) * 97;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

// RegionTrendResponse.categories[].stores[] 평탄화 → storeId 목록(중복 제거).
function collectStoreIds(data) {
  const ids = [];
  if (!data || !Array.isArray(data.categories)) return ids;
  const seen = {};
  for (const cat of data.categories) {
    if (cat && Array.isArray(cat.stores)) {
      for (const s of cat.stores) {
        if (s && s.storeId != null && !seen[s.storeId]) {
          seen[s.storeId] = true;
          ids.push(s.storeId);
        }
      }
    }
  }
  return ids;
}

export default function nationwideTrend() {
  const { token } = pickToken();
  const loc = pickLocation();
  const storeIds = [];

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
  // 2. 전국 선택 = region picker UI(BE 호출 없음) → sleep
  think();

  group('02. 전국 랭킹 보기', () => {
    const res = apiGet('/trend/nationwide', {
      token,
      name: 'GET /trend/nationwide', // ⚠ 파라미터 없음. nearby/select 와 혼동 금지.
    });
    checkOk(res, 'GET /trend/nationwide');

    const ids = collectStoreIds(dataOf(res));
    if (ids.length > 0) {
      // 2~3곳을 시드 기반으로 골라 탐색(테스트마다 랜덤).
      const visitCount = Math.min(2 + seededIndex(2, 1), ids.length); // 2 또는 3
      const start = seededIndex(ids.length, 2);
      for (let i = 0; i < visitCount; i++) {
        storeIds.push(ids[(start + i) % ids.length]);
      }
    }
  });
  think();

  group('03. 랭킹 중 여러 가게 상세 탐색', () => {
    if (storeIds.length === 0) return; // 트렌드 비면 가드 후 종료(단계 유지)
    for (let i = 0; i < storeIds.length; i++) {
      const storeId = storeIds[i];
      const detail = apiGet(`/stores/${storeId}`, {
        token,
        name: 'GET /stores/{storeId}',
      });
      checkOk(detail, 'GET /stores/{storeId}');

      // 첫 가게는 상세 진입과 동시에 메뉴도 조회(카탈로그: 동시 호출).
      if (i === 0) {
        const menus = apiGet(`/stores/${storeId}/menus`, {
          token,
          name: 'GET /stores/{storeId}/menus',
        });
        checkOk(menus, 'GET /stores/{storeId}/menus');
      }
    }
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/nationwide-trend.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/nationwide-trend.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/nationwide-trend.js
