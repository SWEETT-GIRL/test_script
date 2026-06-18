// scenarios/danajlim/store-subscribe-alarm-test.js
//
// [담당자]      danajlim
// [slug]        store-subscribe-alarm-test
// [scenarioName] store_subscribe_alarm
// [목적]        인스타에서 본 빵집을 검색해 상세로 들어가 '빵알람'을 설정하는 흐름
//               ("이 빵집 근처 가면 알려줘")의 성능 확인. 검색·상세(읽기) + 구독(쓰기) 혼합 부하.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 빵집 검색                → GET /stores/search           (storeId 체이닝)
//   4. 상세페이지 진입          → GET /stores/{storeId}        (isSubscribed 추출)
//   5. 빵알람 설정              → POST /stores/{storeId}/subscribe   (부수효과)
//   6. 빵알람 해제(정리)        → DELETE /stores/{storeId}/subscribe (부수효과·멱등 유지)
// [주의사항]    5·6 은 쓰기(부수효과). loadtest 전용 토큰(pickToken)만 사용.
//               · subscribeStore 는 이미 구독 시 ALREADY_SUBSCRIBED(409) 를 던진다(멱등 X).
//                 → 같은 VU 반복 시 409 로 에러율이 오염되므로, 매 iteration POST 직후
//                   DELETE 로 구독을 정리해 항상 "미구독" 상태로 되돌린다.
//               · 첫 진입에서 이미 구독돼 있으면(잔여 상태) 상세의 isSubscribed 로 가드해
//                 POST 를 건너뛰고 DELETE(정리)만 수행 → self-heal.
//               · 부수효과는 SubscribedStore 레코드 생성/삭제뿐. 구독 시점 FCM 발송 없음(안전).
//
// 단계 → 엔드포인트 매핑
// | # | 단계              | 포함/제외        | HTTP   | name 태그                          | 인증 | 비고                              |
// |---|-------------------|------------------|--------|------------------------------------|------|-----------------------------------|
// | 1 | 앱 실행           | 제외(sleep)      | -      | -                                  | -    | think()                           |
// | 2 | JWT 인증          | 제외             | -      | -                                  | -    | pickToken()                       |
// | 3 | 빵집 검색         | 포함             | GET    | GET /stores/search                 | Y    | query=pickQuery(), lat,lon        |
// | 4 | 상세페이지 진입   | 포함             | GET    | GET /stores/{storeId}              | Y    | storeId 체이닝, isSubscribed 추출 |
// | 5 | 빵알람 설정       | 포함(부수효과)   | POST   | POST /stores/{storeId}/subscribe   | Y    | !isSubscribed 일 때만             |
// | 6 | 빵알람 해제(정리) | 포함(부수효과)   | DELETE | DELETE /stores/{storeId}/subscribe | Y    | 멱등 유지용 cleanup               |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation, pickQuery } from '../../lib/data.js';
import { apiGet, apiPost, apiDelete, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('store_subscribe_alarm');

export default function storeSubscribeAlarm() {
  const { token } = pickToken();
  const loc = pickLocation();
  const q = pickQuery();
  let storeId;
  let alreadySubscribed = false; // 상세 응답 isSubscribed (잔여 구독 상태 가드용)
  let subscribed = false; // 이번 iteration 에서 우리가 구독에 성공했는지(정리 판단용)

  group('01. 빵집 검색', () => {
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

  group('02. 상세페이지 진입', () => {
    if (!storeId) return; // 검색 결과가 비면 가드 후 종료(단계 자체는 유지)
    const res = apiGet(`/stores/${storeId}`, {
      token,
      name: 'GET /stores/{storeId}',
    });
    checkOk(res, 'GET /stores/{storeId}');

    // 응답: ApiResponse<StoreDetailResponse> → data.isSubscribed (빵알람 버튼 상태)
    const data = dataOf(res);
    if (data && data.isSubscribed === true) {
      alreadySubscribed = true;
    }
  });
  think();

  group('03. 빵알람 설정', () => {
    if (!storeId) return;
    if (alreadySubscribed) return; // 이미 구독(잔여 상태) → 409 방지로 POST 건너뜀(정리는 04에서)
    const res = apiPost(`/stores/${storeId}/subscribe`, {
      token,
      name: 'POST /stores/{storeId}/subscribe',
    });
    subscribed = checkOk(res, 'POST /stores/{storeId}/subscribe');
  });
  think();

  group('04. 빵알람 해제 — 멱등 유지용 정리', () => {
    if (!storeId) return;
    // 이번에 구독했거나(subscribed), 들어올 때 이미 구독돼 있던(alreadySubscribed) 경우 정리.
    if (!subscribed && !alreadySubscribed) return;
    const res = apiDelete(`/stores/${storeId}/subscribe`, {
      token,
      name: 'DELETE /stores/{storeId}/subscribe',
    });
    checkOk(res, 'DELETE /stores/{storeId}/subscribe');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-subscribe-alarm-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/store-subscribe-alarm-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/store-subscribe-alarm-test.js
