// scenarios/olivia/review-report-block.js
//
// [담당자]       olivia
// [slug]         review-report-block
// [scenarioName] review_report_block
// [목적]         가게 상세→메뉴→리뷰까지 타고 들어가 특정 리뷰를 신고하고 그 작성자를
//               차단하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입   → (자동/탐색) GET /trend/nearby  (storeId 공급원)
//   2. 탐색 → 가게 상세 진입    → GET /stores/{storeId}
//   3. 메뉴 리스트 조회         → GET /stores/{storeId}/menus
//   4. 메뉴 상세 조회           → GET /menus/{menuId}
//   5. 리뷰 리스트 조회         → GET /menus/{menuId}/reviews  (reviewId + 작성자 memberId 추출)
//   6. 해당 리뷰 신고           → POST /abuse-reports
//   7. 해당 사용자 차단         → POST /blocks
//
// ─────────────────────────────────────────────────────────────────────────────
// BE 소스로 확인 (§3 — 추측 아님)
//   - 2번 "탐색" storeId 공급원: GET /trend/nearby 응답의 categories[].stores[].storeId 사용.
//   - 리뷰 리스트 GET /menus/{menuId}/reviews → ReviewListResponse.content[] = MenuReviewResponse.
//       reviewId = content[].id, 작성자 memberId = content[].author.id (author 는 NON_NULL → 없을 수 있음).
//       파라미터(FE 기본): sort=recent, photoOnly=false, page=0, size=20.
//   - 6번 신고 = POST /abuse-reports (AbuseReportController, §6 카탈로그에 없음). body(검증):
//       { targetType:"REVIEW", targetId:<reviewId>, reasonType:"ABUSE", reasonDetail:"loadtest" }
//       targetType: REVIEW|MEMBER_PROFILE / reasonType: SPAM|ABUSE|HATE|PRIVACY|SEXUAL|ETC / reasonDetail<=500(선택)
//   - 7번 차단 = POST /blocks. body: { blockedMemberId:<memberId> }.
//   - 멱등성/부수효과(중요):
//       · POST /blocks  : 자기차단→4xx(가드함). 중복차단→에러 없음(기존 반환 200) ⇒ 멱등, 반복 안전.
//       · POST /abuse-reports : 자기신고→4xx(가드함). 중복신고→REPORT_ALREADY_EXISTS 4xx ⇒ 비멱등!
//         같은 VU(토큰)가 같은 reviewId 를 재신고하면 4xx → http_req_failed 상승.
//         완화: 대상 reviewId 를 (VU,ITER) 시드로 분산해 중복을 최소화한다. 그러나 리뷰 풀이 유한해
//         장시간/고RPS 에서는 중복 신고 4xx 가 불가피 → 이 엔드포인트는 다음 중 하나로 운영 권장:
//           (a) loadtest 리뷰 데이터를 충분히 크게, (b) 주기적으로 loadtest 유저 abuse_reports 정리,
//           (c) /abuse-reports 만 실패율 임계에서 제외. (block 은 안전)
//   - 자기 자신 신고/차단 방지: 작성자 memberId == 현재 토큰 memberId 면 신고/차단 스킵.
//   - 중간 응답이 비면 group 안에서 가드 후 종료(단계 유지, skip 금지).
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계            | 포함/제외 | HTTP | name 태그                    | 인증 | 체이닝/바디                         |
// |---|-----------------|-----------|------|------------------------------|------|-------------------------------------|
// | 1 | 앱 실행         | 제외(sleep)| -    | -                            | -    | think()                             |
// | 2 | JWT 인증        | 제외      | -    | -                            | -    | pickToken() (memberId 포함)         |
// | 3 | 탐색(홈)        | 포함      | GET  | GET /trend/nearby            | Y    | categories[].stores[].storeId 공급  |
// | 4 | 가게 상세       | 포함      | GET  | GET /stores/{storeId}        | Y    | storeId 시드 선택                   |
// | 5 | 메뉴 리스트     | 포함      | GET  | GET /stores/{storeId}/menus  | Y    | menus[].menuId                      |
// | 6 | 메뉴 상세       | 포함      | GET  | GET /menus/{menuId}          | Y    | menuId 시드 선택                    |
// | 7 | 리뷰 리스트     | 포함      | GET  | GET /menus/{menuId}/reviews  | Y    | content[].id + author.id (non-self) |
// | 8 | 리뷰 신고       | 포함(POST)| POST | POST /abuse-reports          | Y    | body: REVIEW/ABUSE, targetId=reviewId|
// | 9 | 작성자 차단     | 포함(POST)| POST | POST /blocks                 | Y    | body: blockedMemberId=author.id     |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('review_report_block');

// 재현 가능한 결정적 인덱스(데이터 §0). 같은 (VU, iter, salt) 면 같은 선택.
function seededIndex(len, salt) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503 + (salt | 0) * 97;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

// RegionTrendResponse.categories[].stores[] 평탄화 → storeId 목록.
function collectStoreIds(data) {
  const ids = [];
  if (!data || !Array.isArray(data.categories)) return ids;
  for (const cat of data.categories) {
    if (cat && Array.isArray(cat.stores)) {
      for (const s of cat.stores) {
        if (s && s.storeId != null) ids.push(s.storeId);
      }
    }
  }
  return ids;
}

export default function reviewReportBlock() {
  const { token, memberId: myMemberId } = pickToken();
  const loc = pickLocation();

  let storeId;
  let menuId;
  let reviewId;
  let authorId;

  // 1. 앱 실행 = 비-API/제외 (think + pickToken 으로 모델링)
  think();

  group('01. 탐색 — 홈 현위치 피드(storeId 공급원)', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');

    const ids = collectStoreIds(dataOf(res));
    if (ids.length > 0) storeId = ids[seededIndex(ids.length, 1)];
  });
  think();

  group('02. 가게 상세 진입', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}`, { token, name: 'GET /stores/{storeId}' });
    checkOk(res, 'GET /stores/{storeId}');
  });
  think();

  group('03. 메뉴 리스트 조회', () => {
    if (!storeId) return;
    const res = apiGet(`/stores/${storeId}/menus`, {
      token,
      name: 'GET /stores/{storeId}/menus',
    });
    checkOk(res, 'GET /stores/{storeId}/menus');

    const menus = dataOf(res);
    if (Array.isArray(menus) && menus.length > 0) {
      const m = menus[seededIndex(menus.length, 2)];
      if (m && m.menuId != null) menuId = m.menuId;
    }
  });
  think();

  group('04. 메뉴 상세 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}`, { token, name: 'GET /menus/{menuId}' });
    checkOk(res, 'GET /menus/{menuId}');
  });
  think();

  group('05. 리뷰 리스트 조회', () => {
    if (!menuId) return;
    const res = apiGet(`/menus/${menuId}/reviews`, {
      token,
      params: { sort: 'recent', photoOnly: false, page: 0, size: 20 },
      name: 'GET /menus/{menuId}/reviews',
    });
    checkOk(res, 'GET /menus/{menuId}/reviews');

    const data = dataOf(res);
    const content = data && Array.isArray(data.content) ? data.content : [];
    if (content.length === 0) return;

    // 시드 시작점부터 순회하며 "내가 쓴 리뷰가 아닌" 첫 리뷰를 고른다(자기 신고/차단 방지).
    const start = seededIndex(content.length, 3);
    for (let i = 0; i < content.length; i++) {
      const r = content[(start + i) % content.length];
      if (!r || r.id == null || !r.author || r.author.id == null) continue;
      if (myMemberId != null && String(r.author.id) === String(myMemberId)) continue; // self skip
      reviewId = r.id;
      authorId = r.author.id;
      break;
    }
  });
  think();

  group('06. 해당 리뷰 신고', () => {
    if (!reviewId) return; // 신고 대상 없으면 가드 후 종료
    // ⚠ 비멱등: 같은 VU가 같은 reviewId 재신고 시 REPORT_ALREADY_EXISTS(4xx) 가능(상단 주석 참고).
    const res = apiPost('/abuse-reports', {
      token,
      body: {
        targetType: 'REVIEW',
        targetId: reviewId,
        reasonType: 'ABUSE',
        reasonDetail: 'loadtest',
      },
      name: 'POST /abuse-reports',
    });
    checkOk(res, 'POST /abuse-reports');
  });
  think();

  group('07. 해당 사용자 차단', () => {
    if (authorId == null) return; // 차단 대상 없으면 가드 후 종료
    // 중복 차단은 BE 가 기존 반환(200) → 멱등, 반복 안전.
    const res = apiPost('/blocks', {
      token,
      body: { blockedMemberId: authorId },
      name: 'POST /blocks',
    });
    checkOk(res, 'POST /blocks');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/review-report-block.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/review-report-block.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/review-report-block.js
