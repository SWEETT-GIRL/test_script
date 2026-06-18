// scenarios/danajlim/my-favorite-bread.js
//
// [담당자]      danajlim
// [slug]        my-favorite-bread
// [scenarioName] my_favorite_bread
// [목적]        MY탭에서 '빵 취향'을 열어 현재 취향을 보고, 새로운 빵을 추가해 저장하는 흐름
//               ("요즘은 이게 맛있더라")의 성능 확인. 읽기(홈·MY·취향) + 취향 저장(쓰기) 혼합 부하.
// [사용자 행동 순서]
//   1. 앱 실행                  (비-API → sleep)
//   2. JWT로 인증               (제외 → 사전 발급 토큰 사용)
//   3. 홈화면 진입              → GET /trend/nearby
//   4. MY탭 진입               → GET /users/me  +  GET /users/me/store-count
//   5. 빵 취향 카테고리 화면 진입 → GET /users/me/favorite-bread        (현재 취향 breadKind[] 체이닝)
//   6. 카테고리 선택 / 새로운 빵 누르기 (비-API → sleep, FE 상수 목록에서 클라가 토글)
//   7. 저장하기                 → POST /users/me/favorite-bread        (쓰기·멱등·200)
// [주의사항]    7 은 쓰기지만 본인 데이터. loadtest 전용 토큰(pickToken)만 사용.
//               · 저장은 멱등: updateLikeMenuCategory 가 deleteByMemberId 후 재insert(=replace) 라
//                 같은 바디를 반복해도 409/중복 없이 안전. 부수효과는 본인 LikedMenuCategory 갱신뿐(FCM/외부 X).
//               · POST 응답은 ApiResponse.ok(null) = HTTP 200 → checkOk (201 아님).
//               · ⚠ body 는 객체가 아니라 raw String 배열: ["소금빵","크루아상",...]. FE saveFavoriteBreads
//                 도 배열을 그대로 POST. 각 원소는 BE MenuKind enum 값과 정확히 일치해야 함
//                 (MenuKind.valueOf → 틀리면 500, menu_category 미존재면 404). 아래 상수는 모두 유효값.
//               · '빵 취향 카테고리' 선택지는 FE 상수(src/constants/breadCategories.ts BREAD_CATEGORY_OPTIONS)
//                 라 별도 API 가 없다 → 선택/새 빵 누르기는 sleep 으로 모델링.
//
// 단계 → 엔드포인트 매핑
// | # | 단계                    | 포함/제외        | HTTP | name 태그                      | 인증 | 비고                              |
// |---|-------------------------|------------------|------|--------------------------------|------|-----------------------------------|
// | 1 | 앱 실행                 | 제외(sleep)      | -    | -                              | -    | think()                           |
// | 2 | JWT 인증                | 제외             | -    | -                              | -    | pickToken()                       |
// | 3 | 홈화면 진입             | 포함             | GET  | GET /trend/nearby              | Y    | params: lat,lng (CSV lon→lng)     |
// | 4 | MY탭 진입               | 포함             | GET  | GET /users/me                  | Y    | FE mypage 호출                    |
// | 4 | MY탭 진입               | 포함             | GET  | GET /users/me/store-count      | Y    | FE mypage 호출                    |
// | 5 | 빵 취향 화면 진입       | 포함             | GET  | GET /users/me/favorite-bread   | Y    | 현재 breadKind[] 체이닝           |
// | 6 | 카테고리 선택·새 빵 누르기 | 제외(sleep)     | -    | -                              | -    | FE 상수 목록, API 없음            |
// | 7 | 저장하기                | 포함(쓰기·멱등·200)| POST | POST /users/me/favorite-bread  | Y    | raw String[] (MenuKind 값)        |

import { group } from 'k6';
import { getOptions } from '../../lib/config.js';
import { pickToken } from '../../lib/auth.js';
import { pickLocation } from '../../lib/data.js';
import { apiGet, apiPost, dataOf } from '../../lib/http.js';
import { checkOk } from '../../lib/checks.js';
import { think } from '../../lib/think.js';

export const options = getOptions('my_favorite_bread');

// "요즘 맛있는 새 빵" — 현재 취향에 추가할 카테고리. 기본 저장 세트도 모두 MenuKind enum 유효값.
const NEW_BREAD = '소금빵';
const DEFAULT_BREADS = ['소금빵', '크루아상', '베이글'];

export default function myFavoriteBread() {
  const { token } = pickToken();
  const loc = pickLocation();
  let current = []; // 현재 빵 취향(breadKind[])

  group('01. 홈화면 진입 — 위치 기반 트렌드 조회', () => {
    const res = apiGet('/trend/nearby', {
      token,
      params: { lat: loc.lat, lng: loc.lon }, // ⚠ trend/* 는 lng (CSV 컬럼은 lon)
      name: 'GET /trend/nearby',
    });
    checkOk(res, 'GET /trend/nearby');
  });
  think();

  group('02. MY탭 진입 — 프로필 + 구독 빵집 수', () => {
    const meRes = apiGet('/users/me', { token, name: 'GET /users/me' });
    checkOk(meRes, 'GET /users/me');

    const countRes = apiGet('/users/me/store-count', {
      token,
      name: 'GET /users/me/store-count',
    });
    checkOk(countRes, 'GET /users/me/store-count');
  });
  think();

  group('03. 빵 취향 카테고리 화면 진입 — 현재 취향 조회', () => {
    const res = apiGet('/users/me/favorite-bread', {
      token,
      name: 'GET /users/me/favorite-bread',
    });
    checkOk(res, 'GET /users/me/favorite-bread');

    // 응답: ApiResponse<MenuCategoryResponse> → data.breadKind 는 String[](MenuKind 이름)
    const data = dataOf(res);
    if (data && Array.isArray(data.breadKind)) {
      current = data.breadKind;
    }
  });
  think();

  // 04. 카테고리 선택 / 새로운 빵 누르기 — FE 상수 목록에서 클라가 토글. 별도 API 없음(sleep).
  think();

  group('05. 저장하기 — 빵 취향 업데이트', () => {
    // 기존 취향 + 새 빵(중복 제거). 비어 있으면 기본 세트. 전부 MenuKind 유효값.
    const next =
      current.length > 0 ? Array.from(new Set([...current, NEW_BREAD])) : DEFAULT_BREADS;

    const res = apiPost('/users/me/favorite-bread', {
      token,
      body: next, // ⚠ 객체가 아니라 raw String 배열
      name: 'POST /users/me/favorite-bread',
    });
    // 응답 ApiResponse.ok(null) = 200 → checkOk (replace 라 멱등)
    checkOk(res, 'POST /users/me/favorite-bread');
  });
}

// 실행 명령
// ----------------------------------------------------------------------------
// # 기본 실행
// BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/my-favorite-bread.js
//
// # Prometheus remote write (Grafana 연동)
// BASE_URL=http://localhost:8080 \
// K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
//   k6 run -o experimental-prometheus-rw \
//   --tag testid=$(date +%Y%m%d-%H%M%S) \
//   scenarios/danajlim/my-favorite-bread.js
//
// # 저강도 스모크 (RPS 낮춤)
// LOAD_LEVEL=smoke BASE_URL=http://localhost:8080 k6 run scenarios/danajlim/my-favorite-bread.js
