// scenarios/danajlim/store-add-report.js
//
// [담당자]      danajlim
// [slug]        store-add-report
// [scenarioName] store_add_report
// [목적]        가게를 검색했으나 결과가 없어("안 뜨네") 사용자가 직접 가게를 추가 제보하는 흐름의
//               성능 확인. 읽기(홈·검색) + 외부 네이버 장소검색(BE→mock) + 가게추가 제보(쓰기) 혼합 부하.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입              → GET /trend/nearby
//   4. 가게 검색                → GET /stores/search                  (결과 없음 → '가게 추가' 버튼 노출)
//   5. 가게 추가 버튼 → 폼 진입  (비-API → sleep)
//   6. 네이버 장소 검색          → GET /stores/add-reports/naver/search (BE→네이버 mock, 결과 체이닝)
//   7. 가게 추가 제보 제출        → POST /stores/add-reports             (부수효과·201)
// [주의사항]    7 은 쓰기(부수효과). loadtest 전용 토큰(pickToken)만 사용.
//               · FE 대조(src/services/api/storeAddReportService.ts, app/bakery/add-report.tsx):
//                 '가게 추가'는 POST /stores/kakao 가 아니라 /stores/add-reports 를 쓴다. 외부는 네이버.
//               · ⚠ 멱등 아님 + 중복 409: BE 가 같은 naverPlaceId 가 이미 Store 면 REPORT_STORE_ALREADY_EXISTS,
//                 같은 naverPlaceId 또는 같은 name+address 의 PENDING 제보가 있으면 REPORT_DUPLICATED 로
//                 409 를 던진다. 반복 부하에서 같은 바디를 보내면 2회차부터 409 폭증 → 에러율 오염.
//                 → iteration 마다 name/address 를 __VU/__ITER 로 유니크하게 만들고, naverPlaceId 는
//                   null 로 보내(blankToNull) place-id 중복검사를 우회한다. (__VU/__ITER 는 k6 실행
//                   컨텍스트 전역 — 같은 run 에서 재현가능하게 유니크.) name/address 는 'loadtest-' prefix.
//               · 네이버 검색은 BE 가 내부적으로 네이버 Local API 호출 → loadtest 는 BE 가 네이버→mock
//                 바라봄(§0, 인프라 책임). k6 는 BE 만 때린다. 이미지/presigned/S3 단계는 이 흐름에 없음.
//               · latitude/longitude(@NotNull) 는 네이버 결과(좌표 있는 첫 항목)에서 체이닝, 없으면
//                 pickLocation() 으로 폴백(항상 non-null 보장 → 제보 단계 skip 안 됨).
//               · 검색(GET /stores/search)·네이버검색은 200(checkOk), 제보는 201(checkCreated).
//               · 생성 시 adminReportNotificationPublisher 가 어드민 알림 발행(loadtest FCM→mock).
//                 호출마다 ContributionReport + StoreContributionReport(PENDING) row 누적 → DB 정리
//                 (reason/ name LIKE 'loadtest-%').
//
// 단계 → 엔드포인트 매핑
// | # | 단계               | 포함/제외          | HTTP | name 태그                              | 인증 | 비고                            |
// |---|--------------------|--------------------|------|----------------------------------------|------|---------------------------------|
// | 1 | 앱 실행            | 제외(sleep)        | -    | -                                      | -    | think()                         |
// | 2 | JWT 인증           | 제외               | -    | -                                      | -    | pickToken()                     |
// | 3 | 홈화면 진입        | 포함               | GET  | GET /trend/nearby                      | Y    | lat,lng (CSV lon→lng)           |
// | 4 | 가게 검색          | 포함               | GET  | GET /stores/search                     | Y    | query, lat,lon (결과없음 가정)  |
// | 5 | 추가 버튼→폼 진입   | 제외(sleep)        | -    | -                                      | -    | 폼 화면                         |
// | 6 | 네이버 장소 검색    | 포함(BE→mock)      | GET  | GET /stores/add-reports/naver/search   | Y    | keyword, 좌표 체이닝            |
// | 7 | 가게 추가 제보 제출  | 포함(부수효과·201) | POST | POST /stores/add-reports               | Y    | 유니크 name/address, 좌표       |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk, checkCreated } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_add_report');

const REPORT_REASON = 'loadtest- 검색에 없어 직접 추가 (부하테스트 제보)';

// 좌표가 있는 네이버 결과만 선택 가능(FE hasCoordinates 가드와 동일).
function pickPlaceWithCoords(list) {
  if (!Array.isArray(list)) return undefined;
  return list.find((p) => p && p.latitude != null && p.longitude != null);
}

export default function storeAddReport() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let place; // 네이버 검색 결과(좌표 보유 첫 항목) — roadAddress/phone/좌표 체이닝용

  group('01. 홈화면 진입 — 위치 기반 트렌드 조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. 가게 검색 (결과 없음 → 추가 버튼)', () => {
    const res = apiGet('/stores/search', {
      token,
      // ⚠ /stores/search 만 lon (나머지는 lng)
      params: {
        query: q.query,
        lat: loc.lat,
        lon: loc.lon,
        page: 0,
        size: 15,
        sort: 'distance', // 검색 기본값
      },
      name: 'GET /stores/search',
    });
    checkOk(res, 'GET /stores/search');
    // 결과가 비어 '가게 추가' 버튼이 노출되는 상황을 모델링(빈/비빈과 무관하게 추가 흐름 진행).
  });
  think();

  // 03. '가게 추가' 버튼 탭 → 추가 폼 진입. 별도 API 없음(sleep).
  think();

  group('03. 네이버 장소 검색 (외부 API — BE→네이버 mock)', () => {
    const res = apiGet('/stores/add-reports/naver/search', {
      token,
      params: { keyword: q.query },
      name: 'GET /stores/add-reports/naver/search',
    });
    checkOk(res, 'GET /stores/add-reports/naver/search');

    // 응답: ApiResponse<List<NaverPlaceSearchResult>> → data 가 곧 배열. 좌표 보유 첫 항목 선택.
    place = pickPlaceWithCoords(dataOf(res));
  });
  think();

  group('04. 가게 추가 제보 제출', () => {
    // 좌표는 네이버 결과 우선, 없으면 pickLocation 폴백(@NotNull 보장).
    const latitude = place && place.latitude != null ? place.latitude : loc.lat;
    const longitude = place && place.longitude != null ? place.longitude : loc.lon;

    // ⚠ 중복 409 회피: name/address 를 VU·iteration 으로 유니크하게. naverPlaceId 는 null 로 우회.
    const uniq = `${__VU}-${__ITER}`;
    const res = apiPost('/stores/add-reports', {
      token,
      body: {
        naverPlaceId: null, // place-id 중복검사 우회(blankToNull)
        name: `loadtest-가게-${uniq}`,
        address: `loadtest-주소-${uniq}`,
        roadAddress: place ? place.roadAddress : null,
        phone: place ? place.phone : null,
        latitude,
        longitude,
        reason: REPORT_REASON,
      },
      name: 'POST /stores/add-reports',
    });
    // ⚠ 201 Created 반환 → checkCreated
    checkCreated(res, 'POST /stores/add-reports');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-add-report.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-add-report.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-add-report.js
