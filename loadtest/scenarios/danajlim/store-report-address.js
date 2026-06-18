// scenarios/danajlim/store-report-address.js
//
// [담당자]      danajlim
// [slug]        store-report-address
// [scenarioName] store_report_address
// [목적]        홈에서 가게를 검색해 상세로 들어가, '가게 정보 수정 제안'에서 주소를 검색해
//               가게 주소 수정을 제보하는 흐름("이 가게 주소 바뀌었어요")의 성능 확인.
//               읽기(검색·상세) + 외부 주소검색(BE→카카오 mock) + 제보 등록(쓰기) 혼합 부하.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입              → GET /trend/nearby
//   4. 가게 검색                → GET /stores/search                  (storeId 체이닝)
//   5. 가게 상세 진입           → GET /stores/{storeId}
//   6. 가게 정보 수정 제안       (비-API → sleep, 수정 항목 선택 화면)
//   7. 주소 검색(외부 API)       → GET /address/search                 (BE→카카오 mock, 결과 체이닝)
//   8. 주소 수정 요청            → POST /stores/{storeId}/reports/address (부수효과·201)
// [주의사항]    8 은 쓰기(부수효과). loadtest 전용 토큰(pickToken)만 사용.
//               · 주소 검색은 BE 가 내부적으로 카카오 Local API 를 호출(searchByKeywordForAddress).
//                 loadtest 환경은 BE 가 카카오→mock 을 바라봄(§0, 인프라 책임). k6 는 BE 만 호출.
//               · 제보 바디(address/roadAddress/placeName/lat/lng)는 검색 결과 첫 항목을 그대로
//                 체이닝한다(StoreReportController 문서: "주소 검색 결과를 그대로 body에"). 하드코딩 X.
//               · address(@NotBlank), latitude/longitude(@NotNull) 필수 → 검색 결과가 비면 가드 후 skip.
//               · /address/search 는 200(checkOk), 주소 제보는 201(checkCreated).
//               · 멱등 아님(append-only): 호출마다 StoreContributionReport row 누적, 409 없음.
//                 1000~2000 RPS 면 row 대량 누적 → loadtest DB 정리(reason LIKE 'loadtest-%').
//               · 생성 시 adminReportNotificationPublisher 가 어드민 알림 발행(loadtest FCM→mock).
//               · searchKeyword 는 주소 데이터셋이 없어 pickQuery() 로 공급. 카카오 mock 이 canned
//                 응답이라 값은 사실상 cosmetic(실 주소 분포가 필요하면 data 담당자에 주소 CSV 요청).
//
// 단계 → 엔드포인트 매핑
// | # | 단계               | 포함/제외          | HTTP | name 태그                                | 인증 | 비고                          |
// |---|--------------------|--------------------|------|------------------------------------------|------|-------------------------------|
// | 1 | 앱 실행            | 제외(sleep)        | -    | -                                        | -    | think()                       |
// | 2 | JWT 인증           | 제외               | -    | -                                        | -    | pickToken()                   |
// | 3 | 홈화면 진입        | 포함               | GET  | GET /trend/nearby                        | Y    | params: lat,lng (CSV lon→lng) |
// | 4 | 가게 검색          | 포함               | GET  | GET /stores/search                       | Y    | storeId 체이닝                |
// | 5 | 가게 상세 진입     | 포함               | GET  | GET /stores/{storeId}                    | Y    | 4번 storeId                   |
// | 6 | 가게 정보 수정 제안 | 제외(sleep)        | -    | -                                        | -    | 항목 선택 화면                |
// | 7 | 주소 검색(외부 API) | 포함(BE→mock)      | GET  | GET /address/search                      | Y    | searchKeyword, 결과 체이닝    |
// | 8 | 주소 수정 요청     | 포함(부수효과·201) | POST | POST /stores/{storeId}/reports/address   | Y    | 검색결과 바디                 |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk, checkCreated } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_report_address');

const REPORT_REASON = 'loadtest- 가게 주소가 변경되었어요 (부하테스트 제보)';

export default function storeReportAddress() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;
  let addr; // 주소 검색 결과 첫 항목(제보 바디로 체이닝)

  group('01. 홈화면 진입 — 위치 기반 트렌드 조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. 가게 검색', () => {
    const res = apiGet('/stores/search', {
      token,
      // ⚠ /stores/search 만 lon (나머지는 lng)
      params: {
        query: q.query,
        lat: loc.lat,
        lon: loc.lon,
        page: 0,
        size: 15,
        sort: 'popularity', // SearchSort: distance|popularity|relevance
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

  group('03. 가게 상세 진입', () => {
    if (!storeId) return; // 검색 결과가 비면 가드 후 종료(단계 자체는 유지)
    const res = apiGet(`/stores/${storeId}`, {
      token,
      name: 'GET /stores/{storeId}',
    });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  // 04. 가게 정보 수정 제안 — 수정 항목(영업시간/주소/메뉴) 선택 화면. 별도 API 없음(sleep).
  think();

  group('05. 주소 검색 (외부 API — BE→카카오 mock)', () => {
    const res = apiGet('/address/search', {
      token,
      params: { searchKeyword: q.query }, // 주소 데이터셋 부재 → pickQuery 로 키워드 공급
      name: 'GET /address/search',
    });
    checkOk(res, 'GET /address/search');

    // 응답: ApiResponse<List<AddressSearchResult>> → data 가 곧 배열. 첫 항목 선택.
    const list = dataOf(res);
    if (Array.isArray(list) && list.length > 0 && list[0]) {
      addr = list[0];
    }
  });
  think();

  group('06. 주소 수정 요청', () => {
    if (!storeId) return;
    // address(@NotBlank) + lat/lng(@NotNull) 없으면 제보 불가 → 가드 후 종료(단계 유지)
    if (!addr || !addr.address || addr.latitude == null || addr.longitude == null) return;

    const res = apiPost(`/stores/${storeId}/reports/address`, {
      token,
      body: {
        address: addr.address,
        roadAddress: addr.roadAddress,
        placeName: addr.placeName,
        latitude: addr.latitude,
        longitude: addr.longitude,
        reason: REPORT_REASON,
      },
      name: 'POST /stores/{storeId}/reports/address',
    });
    // ⚠ 201 Created 반환 → checkCreated
    checkCreated(res, 'POST /stores/{storeId}/reports/address');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-report-address.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-report-address.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-report-address.js
