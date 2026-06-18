// scenarios/olivia/my-reviews.js
//
// [담당자]       olivia
// [slug]         my-reviews
// [scenarioName] my_reviews
// [목적]         MY 탭에 진입해 내가 쓴 리뷰 목록을 조회하는 흐름의 성능 확인
// [사용자 행동 순서]
//   1. 앱 실행 / 홈 화면 진입                  → (자동) GET /trend/nearby
//   2. MY 탭 진입 (내가 쓴 리뷰 목록이 바로 표시) → GET /users/me + GET /users/me/reviews
//
// ─────────────────────────────────────────────────────────────────────────────
// 확인 결과
//   - MY 탭 진입 시 호출: GET /users/me(프로필) + GET /users/me/reviews(내가 쓴 리뷰 목록). 둘 다 인증.
//   - GET /users/me/reviews FE 기본 파라미터: page=0, size=20.
//   - 리뷰 목록이 MY 탭에서 바로 보이는 구조이므로 리뷰 상세(GET /reviews/{reviewId})는 넣지 않음.
//   - 읽기 전용(부수효과 없음).
// ─────────────────────────────────────────────────────────────────────────────
//
// 단계 → 엔드포인트 매핑
// | # | 단계              | 포함/제외 | HTTP | name 태그              | 인증 | 비고                    |
// |---|-------------------|-----------|------|------------------------|------|-------------------------|
// | 1 | 앱 실행           | 제외(sleep)| -    | -                      | -    | think()                 |
// | 2 | JWT 인증          | 제외      | -    | -                      | -    | pickToken()             |
// | 3 | 홈 진입           | 포함      | GET  | GET /trend/nearby      | Y    | params: lat,lng         |
// | 4 | MY 탭 진입(프로필) | 포함      | GET  | GET /users/me          | Y    | MY 탭 동시 호출          |
// | 5 | 내가 쓴 리뷰 목록  | 포함      | GET  | GET /users/me/reviews  | Y    | params: page=0, size=20 |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

// scenarioName(snake_case) = Grafana scenario 태그.
export const options = getOptions('my_reviews');

export default function myReviews() {
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

  group('02. MY 탭 진입 — 프로필 + 내가 쓴 리뷰 목록', () => {
    const me = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(me, 'GET /users/me');

    const reviews = apiGet('/users/me/reviews', {
      token,
      params: { page: 0, size: 20 },
      name: 'GET /users/me/reviews',
    });
    checkOk(reviews, 'GET /users/me/reviews');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/olivia/my-reviews.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/olivia/my-reviews.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/olivia/my-reviews.js
