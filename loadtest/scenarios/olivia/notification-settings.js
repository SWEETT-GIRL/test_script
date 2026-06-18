// scenarios/olivia/notification-settings.js
//
// [담당자]       olivia
// [slug]         notification-settings
// [scenarioName] notification_settings
// [목적]         MY 탭 설정에서 빵알람 알림의 반경·요일·시간대를 조회 후 수정하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입   → (자동) GET /trend/nearby
//   2. MY 탭 진입             → GET /users/me (+ GET /users/me/store-count)
//   3. 설정 진입              (별도 API 없음 → sleep)
//   4. 알림 설정 진입          → GET /alarm/settings/notification
//   5. 반경 수정              → GET /users/me/notification-radius → PATCH /users/me/notification-radius
//   6. 요일 수정              → GET /users/me/notification-days  → POST  /users/me/notification-days
//   7. 시간대 수정            → GET /users/me/notification-time  → PATCH /users/me/notification-time
//
// ─────────────────────────────────────────────────────────────────────────────
// BE 소스로 확인한 쓰기 body 스펙 (§3 — 추측 아님, 실제 DTO 기준)
//   - PATCH /users/me/notification-radius ← NotificationRadiusRequest { direction: "UP"|"DOWN" }
//       반경 단계: 100→300→500→700→1000(m). 최솟값에서 DOWN/최댓값에서 UP 은 400.
//       GET /users/me/notification-radius → { radius:<int m> }.
//       ⚠ 반복 안전: GET 으로 현재 radius 를 읽어 방향 결정(1000→DOWN, 100→UP, 중간→시드). 경계 400 회피.
//   - POST /users/me/notification-days ← @RequestBody String (raw 문자열)
//       대문자 NotificationDay enum 을 콤마로 이은 문자열. 예: "MONDAY,WEDNESDAY,FRIDAY".
//       (서버가 JSON 따옴표를 제거 후 콤마 split → NotificationDay.from 검증)
//       유효값: MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY,SUNDAY.
//   - PATCH /users/me/notification-time ← NotificationTimeRequest { startTime, endTime }
//       HH:mm (^([01]\d|2[0-3]):[0-5]\d$), startTime < endTime 필수.
//   - 모든 호출 인증 필요. ⚠ PATCH/POST 는 "인증된 본인" 알림설정을 변경(부수효과).
//     tokens.csv 는 반드시 loadtest 전용 유저여야 한다. 위 값들은 멱등/유효라 반복 안전.
//   - "설정 진입"(step 3)은 별도 API 없음 → sleep. "알림 설정 진입" = GET /alarm/settings/notification.
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계            | 포함/제외 | HTTP  | name 태그                          | 인증 | 비고                              |
// |---|-----------------|-----------|-------|------------------------------------|------|-----------------------------------|
// | 1 | 앱 실행         | 제외(sleep)| -     | -                                  | -    | think()                           |
// | 2 | JWT 인증        | 제외      | -     | -                                  | -    | pickToken()                       |
// | 3 | 홈 진입         | 포함      | GET   | GET /trend/nearby                  | Y    | params: lat,lng                   |
// | 4 | MY 탭 진입      | 포함      | GET   | GET /users/me                      | Y    | + GET /users/me/store-count       |
// | 5 | 설정 진입       | 제외(sleep)| -     | -                                  | -    | UI → think()                      |
// | 6 | 알림 설정 진입  | 포함      | GET   | GET /alarm/settings/notification   | Y    | -                                 |
// | 7 | 반경 조회·수정  | 포함      | GET/PATCH | GET·PATCH /users/me/notification-radius | Y | direction = 현재값 기반(안전)   |
// | 8 | 요일 조회·수정  | 포함      | GET/POST  | GET·POST /users/me/notification-days    | Y | body: 대문자 요일 콤마 문자열   |
// | 9 | 시간대 조회·수정| 포함      | GET/PATCH | GET·PATCH /users/me/notification-time   | Y | body: {startTime,endTime} HH:mm |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { apiGet, apiPost, apiPatch, dataOf } from '../../lib/http.js';
import { pickLocation } from '../../lib/data.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('notification_settings');

// 재현 가능한 결정적 인덱스(데이터 §0). 같은 (VU, iter, salt) 면 같은 선택.
function seededIndex(len, salt) {
  if (len <= 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503 + (salt | 0) * 97;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

// 모두 유효한 NotificationDay(대문자) 조합. 멱등(반복 안전).
const DAY_SETS = [
  'MONDAY,WEDNESDAY,FRIDAY',
  'SATURDAY,SUNDAY',
  'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY',
];
// 항상 startTime < endTime 인 유효 HH:mm 조합.
const START_TIMES = ['08:00', '09:00', '10:00'];
const END_TIMES = ['20:00', '21:00', '22:00'];

export default function notificationSettings() {
  const { token } = pickToken();
  const loc = pickLocation();

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

  group('02. MY 탭 진입', () => {
    const me = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(me, 'GET /users/me');

    const count = apiGet('/users/me/store-count', {
      token,
      name: 'GET /users/me/store-count',
    });
    checkOk(count, 'GET /users/me/store-count');
  });
  // 3. 설정 진입 = UI(별도 API 없음) → sleep
  think();

  group('03. 알림 설정 진입', () => {
    const res = apiGet('/alarm/settings/notification', {
      token,
      name: 'GET /alarm/settings/notification',
    });
    checkOk(res, 'GET /alarm/settings/notification');
  });
  think();

  group('04. 반경 조회 → 수정', () => {
    const res = apiGet('/users/me/notification-radius', {
      token,
      name: 'GET /users/me/notification-radius',
    });
    checkOk(res, 'GET /users/me/notification-radius');

    const data = dataOf(res);
    const radius = data && typeof data.radius === 'number' ? data.radius : null;
    if (radius === null) return; // 현재값을 못 읽으면 경계 400 위험 → PATCH skip(가드)

    // 경계 회피: 최댓값(1000)→DOWN, 최솟값(100)→UP, 중간 단계→시드로 UP/DOWN.
    const direction =
      radius >= 1000 ? 'DOWN' : radius <= 100 ? 'UP' : seededIndex(2, 1) ? 'UP' : 'DOWN';

    const patch = apiPatch('/users/me/notification-radius', {
      token,
      body: { direction },
      name: 'PATCH /users/me/notification-radius',
    });
    checkOk(patch, 'PATCH /users/me/notification-radius');
  });
  think();

  group('05. 요일 조회 → 수정', () => {
    const res = apiGet('/users/me/notification-days', {
      token,
      name: 'GET /users/me/notification-days',
    });
    checkOk(res, 'GET /users/me/notification-days');

    // @RequestBody String — 대문자 요일을 콤마로 이은 raw 문자열(서버가 따옴표 제거).
    const dayList = DAY_SETS[seededIndex(DAY_SETS.length, 2)];
    const post = apiPost('/users/me/notification-days', {
      token,
      body: dayList,
      name: 'POST /users/me/notification-days',
    });
    checkOk(post, 'POST /users/me/notification-days');
  });
  think();

  group('06. 시간대 조회 → 수정', () => {
    const res = apiGet('/users/me/notification-time', {
      token,
      name: 'GET /users/me/notification-time',
    });
    checkOk(res, 'GET /users/me/notification-time');

    const startTime = START_TIMES[seededIndex(START_TIMES.length, 3)];
    const endTime = END_TIMES[seededIndex(END_TIMES.length, 4)]; // 항상 start < end
    const patch = apiPatch('/users/me/notification-time', {
      token,
      body: { startTime, endTime },
      name: 'PATCH /users/me/notification-time',
    });
    checkOk(patch, 'PATCH /users/me/notification-time');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/notification-settings.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/notification-settings.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/notification-settings.js
