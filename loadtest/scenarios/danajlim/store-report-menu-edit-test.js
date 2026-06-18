// scenarios/danajlim/store-report-menu-edit-test.js
//
// [담당자]      danajlim
// [slug]        store-report-menu-edit-test
// [scenarioName] store_report_menu_edit
// [목적]        가게 상세에서 '가게 정보 수정 제안 → 메뉴 수정/삭제'로 들어가 특정 메뉴의
//               가격 수정 + 사진 삭제 + 사진 추가를 제보하는 흐름("이 메뉴 가격/사진 바뀌었어요")의
//               성능 확인. 읽기(검색·상세·메뉴목록) + presigned 발급 + 제보 등록(쓰기) 혼합 부하.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입              → GET /trend/nearby
//   4. 가게 검색                → GET /stores/search                            (storeId 체이닝)
//   5. 가게 상세 진입           → GET /stores/{storeId}                         (menuImages 체이닝)
//   6. 가게 정보 수정 제안       (비-API → sleep, 수정 항목 선택 화면)
//   7. 메뉴 수정/삭제            → GET /stores/{storeId}/menus                   (menuId·price 선택)
//   8. 가격 수정·사진 삭제·사진 추가
//        - 사진 추가용 presigned → POST /menus/{menuId}/reports/images/presigned-urls (awsKey 체이닝)
//        - S3 업로드             (외부 → mock, k6 미호출)
//   9. 수정 요청하기            → POST /menus/{menuId}/reports/edit             (부수효과·201)
// [주의사항]    8·9 은 쓰기(부수효과). loadtest 전용 토큰(pickToken)만 사용.
//               · FE 대조(app/bakery/edit-request.tsx): 이 화면은 진입 시 GET /stores/{storeId} +
//                 GET /stores/{storeId}/menus 두 개만 부른다. 메뉴 상세(GET /menus/{menuId})는
//                 호출하지 않는다. 삭제할 메뉴 사진 id 는 store 상세의 menuImages(각 항목에 menuId)
//                 에서 뽑고, 현재 가격은 메뉴 목록 StoreMenuResponse.price 에서 뽑는다. → 그대로 모델링.
//               · presigned-urls 는 200(checkOk), 최종 edit 제보는 201 — checkOk(2xx 통과).
//               · 사진 추가 awsKey 는 presigned 응답값을 그대로 사용(체이닝). BE 가 awsKey 가
//                 reports/stores/{storeId}/menus/{menuId}/ prefix 인지 검증(아니면 REPORT_INVALID_AWS_KEY).
//               · S3 실제 업로드(uploadUrl PUT)는 외부 → k6 호출 안 함. FE 는 uploadToS3 로 올리지만
//                 §0 대로 k6 는 BE 만 때린다. 제보는 awsKey 만 저장(객체 존재 미검증)하므로 등록 성공.
//               · 사진 삭제 deleteImageIds 는 해당 메뉴 소유 이미지 id 여야 함(아니면
//                 REPORT_MENU_IMAGE_NOT_OWNED). "제보"일 뿐 실제 삭제는 아님(어드민 검토용).
//               · price/deleteImageIds/addImages 중 최소 1개 필요(없으면 REPORT_EDIT_CONTENT_EMPTY).
//                 price 는 항상 채우므로 통과.
//               · 멱등 아님(append-only): 호출마다 MenuContributionReport(+이미지) row 누적, 409 없음.
//                 1000~2000 RPS 면 row 대량 누적 → loadtest DB 정리(reason LIKE 'loadtest-%').
//               · 생성 시 adminReportNotificationPublisher 가 어드민 알림 발행(loadtest FCM→mock).
//
// 단계 → 엔드포인트 매핑
// | # | 단계                 | 포함/제외          | HTTP | name 태그                                          | 인증 | 비고                       |
// |---|----------------------|--------------------|------|----------------------------------------------------|------|----------------------------|
// | 1 | 앱 실행              | 제외(sleep)        | -    | -                                                  | -    | think()                    |
// | 2 | JWT 인증             | 제외               | -    | -                                                  | -    | pickToken()                |
// | 3 | 홈화면 진입          | 포함               | GET  | GET /trend/nearby                                  | Y    | lat,lng (CSV lon→lng)      |
// | 4 | 가게 검색            | 포함               | GET  | GET /stores/search                                 | Y    | storeId 체이닝             |
// | 5 | 가게 상세 진입       | 포함               | GET  | GET /stores/{storeId}                              | Y    | menuImages 체이닝          |
// | 6 | 가게 정보 수정 제안   | 제외(sleep)        | -    | -                                                  | -    | 항목 선택 화면             |
// | 7 | 메뉴 수정/삭제(목록) | 포함               | GET  | GET /stores/{storeId}/menus                        | Y    | menuId·price 선택          |
// | 8 | 사진 추가(presigned) | 포함               | POST | POST /menus/{menuId}/reports/images/presigned-urls | Y    | mimeTypes, awsKey 체이닝   |
// | - | S3 업로드            | 제외(외부·mock)    | -    | -                                                  | -    | k6 미호출                  |
// | 9 | 수정 요청하기        | 포함(부수효과·201) | POST | POST /menus/{menuId}/reports/edit                  | Y    | price+delete+add 바디      |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_report_menu_edit');

// 추가할 사진 1장의 mime. presigned 요청/제보 contentType 을 동일하게(FE 도 MIME_TYPE='image/jpeg').
const ADD_IMAGE_MIME = 'image/jpeg';
const ADD_IMAGE_FILENAME = 'loadtest-menu.jpg';
const REPORT_REASON = 'loadtest- 메뉴 가격/사진이 변경되었어요 (부하테스트 제보)';

export default function storeReportMenuEdit() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;
  let menuImages = []; // store 상세의 menuImages[] = { menuId, id, awsKey }
  let menuId;
  let currentPrice; // 메뉴 목록에서 읽은 현재 가격(없으면 기본값 사용)
  let deleteImageId; // 삭제 제안할 이미지 id(해당 메뉴 소유 이미지 있을 때만)
  let addAwsKey; // presigned 가 돌려준 awsKey(사진 추가용)

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

    // 응답: ApiResponse<StoreDetailResponse> → data.menuImages[] = { menuId, id, awsKey }
    // FE(edit-request)는 이 menuImages 로 메뉴별 사진을 구성한다(메뉴 상세 호출 X).
    const data = dataOf(res);
    if (data && Array.isArray(data.menuImages)) {
      menuImages = data.menuImages;
    }
  });
  think();

  // 04. 가게 정보 수정 제안 — 수정 항목(영업시간/주소/메뉴) 선택 화면. 별도 API 없음(sleep).
  think();

  group('05. 메뉴 수정/삭제 — 메뉴 목록 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, {
      token,
      name: 'GET /stores/{storeId}/menus',
    });
    checkOk(res, 'GET /stores/{storeId}/menus');

    // 응답: ApiResponse<List<StoreMenuResponse>> → 첫 메뉴를 수정 대상으로 선택(menuId, price)
    const menus = dataOf(res);
    if (Array.isArray(menus) && menus.length > 0 && menus[0]) {
      menuId = menus[0].menuId;
      if (typeof menus[0].price === 'number') currentPrice = menus[0].price;
      // 삭제 제안 이미지 = store 상세 menuImages 중 이 메뉴 소유 첫 이미지(FE 와 동일 소스)
      const owned = menuImages.find((im) => im && im.menuId === menuId);
      if (owned) deleteImageId = owned.id;
    }
  });
  think();

  group('06. 사진 추가 — presigned URL 발급', () => {
    if (!menuId) return;
    const res = apiPost(`/menus/${menuId}/reports/images/presigned-urls`, {
      token,
      body: { mimeTypes: [ADD_IMAGE_MIME] }, // 1~5장. 여기선 1장 추가
      name: 'POST /menus/{menuId}/reports/images/presigned-urls',
    });
    checkOk(res, 'POST /menus/{menuId}/reports/images/presigned-urls');

    // 응답: ApiResponse<PresignedUrlInfoResponse> → data.presignedUrls[].awsKey
    // ⚠ awsKey 는 BE prefix 검증을 위해 그대로 체이닝.
    const data = dataOf(res);
    if (data && Array.isArray(data.presignedUrls) && data.presignedUrls.length > 0) {
      addAwsKey = data.presignedUrls[0].awsKey;
    }
    // S3 실제 업로드(uploadUrl PUT)는 외부 → k6 호출하지 않는다(§0).
  });
  think();

  group('07. 수정 요청하기 — 메뉴 수정 제보 등록', () => {
    if (!menuId) return;

    // 가격 수정 + (있으면)사진 삭제 + (있으면)사진 추가를 한 제보로 묶는다(FE 와 동일 바디).
    const body = {
      price: (typeof currentPrice === 'number' ? currentPrice : 4000) + 100, // @Positive 변경 제안가
      deleteImageIds: deleteImageId != null ? [deleteImageId] : [],
      addImages: addAwsKey
        ? [{ fileName: ADD_IMAGE_FILENAME, contentType: ADD_IMAGE_MIME, awsKey: addAwsKey }]
        : [],
      reason: REPORT_REASON,
    };

    const res = apiPost(`/menus/${menuId}/reports/edit`, {
      token,
      body,
      name: 'POST /menus/{menuId}/reports/edit',
    });
    // 201 Created 반환 → checkOk 가 2xx 통과
    checkOk(res, 'POST /menus/{menuId}/reports/edit');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-report-menu-edit-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-report-menu-edit-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-report-menu-edit-test.js
