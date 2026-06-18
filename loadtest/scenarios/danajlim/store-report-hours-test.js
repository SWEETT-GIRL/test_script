// scenarios/danajlim/store-report-hours-test.js
//
// [담당자]      danajlim
// [slug]        store-report-hours-test
// [scenarioName] store_report_hours
// [목적]        홈에서 가게를 검색해 상세로 들어가, '가게 정보 수정 제안'에서 영업시간 수정을
//               제보하는 흐름("이 가게 영업시간 틀렸어요")의 성능 확인. 읽기(검색·상세) + 쓰기(제보) 혼합.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입              → GET /trend/nearby
//   4. 가게 검색                → GET /stores/search                       (storeId 체이닝)
//   5. 가게 상세 진입           → GET /stores/{storeId}
//   6. 가게 정보 수정 제안       (비-API → sleep, 수정 항목 선택 화면)
//   7. 영업시간 수정 요청        → POST /stores/{storeId}/reports/business-hours (부수효과·201)
// [주의사항]    7 은 쓰기(부수효과). loadtest 전용 토큰(pickToken)만 사용.
//               · 응답이 201 Created 이지만 checkOk 가 2xx(200·201) 통과라 그대로 사용.
//               · 멱등 아님(append-only): 호출마다 새 제보(ContributionReport) row 생성, 409 없음.
//                 1000~2000 RPS 면 제보 row 가 대량 누적된다(삭제 API 없음 → loadtest DB 정리 별도 필요).
//               · 생성 시 adminReportNotificationPublisher 가 어드민 신규 제보 알림을 발행한다.
//                 loadtest 환경은 BE 가 FCM→mock 을 바라보므로 안전(§0, 인프라 책임). 실 FCM 발송 아님.
//               · BE 검증: 각 요일 closed=false 면 openTime/closeTime 필수 + open<close (아니면 400).
//                 아래 페이로드는 이 규칙을 만족한다.
//
// 단계 → 엔드포인트 매핑
// | # | 단계               | 포함/제외          | HTTP | name 태그                                       | 인증 | 비고                              |
// |---|--------------------|--------------------|------|-------------------------------------------------|------|-----------------------------------|
// | 1 | 앱 실행            | 제외(sleep)        | -    | -                                               | -    | think()                           |
// | 2 | JWT 인증           | 제외               | -    | -                                               | -    | pickToken()                       |
// | 3 | 홈화면 진입        | 포함               | GET  | GET /trend/nearby                               | Y    | params: lat,lng (CSV lon→lng)     |
// | 4 | 가게 검색          | 포함               | GET  | GET /stores/search                              | Y    | query=pickQuery(), lat,lon        |
// | 5 | 가게 상세 진입     | 포함               | GET  | GET /stores/{storeId}                           | Y    | storeId = 4번 응답 체이닝         |
// | 6 | 가게 정보 수정 제안 | 제외(sleep)        | -    | -                                               | -    | 수정 항목 선택 화면, 별도 API 없음 |
// | 7 | 영업시간 수정 요청  | 포함(부수효과·201) | POST | POST /stores/{storeId}/reports/business-hours   | Y    | body: hours[]+reason              |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_report_hours');

// 제보로 보낼 영업시간 페이로드(수정 제안 내용 = 콘텐츠이지 테스트-선택 데이터가 아님).
// BE 규칙 충족: closed=false 요일은 openTime/closeTime 필수 + open<close. 월요일 정기휴무 가정.
// reason 은 loadtest- prefix 로 표시해 부하테스트 생성분을 식별/정리 가능하게 한다.
const REPORT_BODY = {
  hours: [
    { dayOfWeek: 'MONDAY', closed: true, openTime: null, closeTime: null },
    { dayOfWeek: 'TUESDAY', closed: false, openTime: '09:00', closeTime: '21:00' },
    { dayOfWeek: 'WEDNESDAY', closed: false, openTime: '09:00', closeTime: '21:00' },
    { dayOfWeek: 'THURSDAY', closed: false, openTime: '09:00', closeTime: '21:00' },
    { dayOfWeek: 'FRIDAY', closed: false, openTime: '09:00', closeTime: '22:00' },
    { dayOfWeek: 'SATURDAY', closed: false, openTime: '10:00', closeTime: '22:00' },
    { dayOfWeek: 'SUNDAY', closed: false, openTime: '10:00', closeTime: '20:00' },
  ],
  reason: 'loadtest- 영업시간이 실제와 달라요 (부하테스트 제보)',
};

export default function storeReportHours() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;

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

  // 04. 가게 정보 수정 제안 — 수정 항목(영업시간/주소/이미지) 선택 화면. 별도 API 없음(sleep).
  think();

  group('05. 영업시간 수정 요청', () => {
    if (!storeId) return;
    const res = apiPost(`/stores/${storeId}/reports/business-hours`, {
      token,
      body: REPORT_BODY,
      name: 'POST /stores/{storeId}/reports/business-hours',
    });
    // 201 Created 반환 → checkOk 가 2xx 통과
    checkOk(res, 'POST /stores/{storeId}/reports/business-hours');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-report-hours-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-report-hours-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-report-hours-test.js
