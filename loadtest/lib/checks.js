// lib/checks.js
// 응답 검증을 한 줄로 표준화한다: http status && body.success === true

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
 * http 200 && body.success === true 검증(조회·200 응답 API 전용).
 * @param {object} res k6 response
 * @param {string} name check 라벨(보통 name 태그와 동일)
 * @returns {boolean} 통과 여부
 */
export function checkOk(res, name) {
  return check(res, {
    [`${name} status 200`]: (r) => r.status === 200,
    [`${name} success true`]: isSuccess,
  });
}

/**
 * http 201 Created && body.success === true 검증(생성/제보 등 201 응답 API 전용).
 * 예: POST /menus/{menuId}/reviews, POST /stores/{storeId}/reports/business-hours.
 * @param {object} res k6 response
 * @param {string} name check 라벨(보통 name 태그와 동일)
 * @returns {boolean} 통과 여부
 */
export function checkCreated(res, name) {
  return check(res, {
    [`${name} status 201`]: (r) => r.status === 201,
    [`${name} success true`]: isSuccess,
  });
}
