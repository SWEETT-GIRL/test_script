// lib/checks.js
// 응답 검증을 한 줄로 표준화한다: http 2xx && body.success === true

import { check } from 'k6';

// ApiResponse 의 success 플래그 안전 추출(파싱 실패 시 false).
function isSuccess(r) {
  try {
    return r.json('success') === true;
  } catch (_e) {
    return false;
  }
}

/**
 * http 2xx && body.success === true 검증(조회·생성·제보 공통).
 * 200(조회·좋아요 등)과 201 Created(리뷰 작성·제보 등)을 모두 통과시킨다.
 * → 엔드포인트별 200/201 구분을 호출부에서 신경 쓸 필요 없음.
 * @param {object} res k6 response
 * @param {string} name check 라벨(보통 name 태그와 동일)
 * @returns {boolean} 통과 여부
 */
export function checkOk(res, name) {
  return check(res, {
    [`${name} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${name} success true`]: isSuccess,
  });
}
