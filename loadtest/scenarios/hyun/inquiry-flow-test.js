// scenarios/hyun/inquiry-flow-test.js
//
// [담당자]       hyun
// [slug]         inquiry-flow-test
// [scenarioName] inquiry_flow
// [목적]         MY탭 앱 설정에서 문의를 등록하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행              (비-API → sleep)
//   2. 홈화면 진입           → GET /trend/nearby
//   3. MY탭 진입             → GET /users/me
//   4. 문의 등록             → POST /inquiries
//
// | # | 단계           | 포함/제외/mock | HTTP | name 태그            | 인증 | 비고                       |
// |---|----------------|---------------|------|----------------------|------|----------------------------|
// | 1 | 앱 실행        | 제외(sleep)   | —    | —                    | —    | think()                    |
// | 2 | 홈화면 진입    | 포함          | GET  | GET /trend/nearby    | Y    | lat, lng                   |
// | 3 | MY탭 진입      | 포함          | GET  | GET /users/me        | Y    |                            |
// | 4 | 문의 등록      | 포함          | POST | POST /inquiries      | Y    | ⚠ 부수효과. 개발 서버 DB  |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPost } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('inquiry_flow');

export default function inquiryFlow() {
  const { token } = pickToken();
  const loc = pickLocation();

  group('01. 홈화면 진입', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. MY탭 진입', () => {
    const res = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(res, 'GET /users/me');
  });
  think();

  group('03. 문의 등록', () => {
    const res = apiPost('/inquiries', {
      token,
      body: {
        category: 'STORE',
        title: 'loadtest-inquiry-title',
        content: 'loadtest-inquiry-content',
      },
      name: 'POST /inquiries',
    });
    checkOk(res, 'POST /inquiries');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/hyun/inquiry-flow-test.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/hyun/inquiry-flow-test.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/hyun/inquiry-flow-test.js
