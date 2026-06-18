// scenarios/hyun/report-notification-flow-test.js
//
// [담당자]       hyun
// [slug]         report-notification-flow-test
// [scenarioName] report_notification_flow
// [목적]         홈에서 제보 알림을 확인하고 읽음 처리하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 홈화면 진입           → GET /trend/nearby
//   3. 알람 버튼 클릭        → GET /alarm/report-notifications
//   4. 알림 읽음 처리        → PATCH /alarm/report-notifications/{id}/read
//
// | # | 단계                    | 포함/제외/mock | HTTP  | name 태그                                      | 인증 | 비고                               |
// |---|-------------------------|---------------|-------|------------------------------------------------|------|------------------------------------|
// | 1 | 앱 실행                 | 제외(sleep)   | —     | —                                              | —    | think()                            |
// | 2 | 홈화면 진입             | 포함          | GET   | GET /trend/nearby                              | Y    | lat, lng                           |
// | 3 | 제보 알림 조회          | 포함          | GET   | GET /alarm/report-notifications               | Y    | id = data[0].id (직접 배열)        |
// | 4 | 알림 읽음 처리          | 포함          | PATCH | PATCH /alarm/report-notifications/{id}/read   | Y    | 알림 없으면 group 내 가드 후 skip  |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPatch, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('report_notification_flow');

export default function reportNotificationFlow() {
  const { token } = pickToken();
  const loc = pickLocation();
  let notificationId;

  group('01. 홈화면 진입', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. 제보 알림 조회', () => {
    const res = apiGet('/alarm/report-notifications', { token, name: 'GET /alarm/report-notifications' });
    checkOk(res, 'GET /alarm/report-notifications');
    const data = dataOf(res);
    if (Array.isArray(data) && data.length > 0) {
      notificationId = data[0].id; // 직접 배열, id 필드
    }
  });
  think();

  group('03. 알림 읽음 처리', () => {
    if (!notificationId) return;
    const res = apiPatch(`/alarm/report-notifications/${notificationId}/read`, {
      token,
      name: 'PATCH /alarm/report-notifications/{id}/read',
    });
    checkOk(res, 'PATCH /alarm/report-notifications/{id}/read');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/report-notification-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/report-notification-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/report-notification-flow-test.js
