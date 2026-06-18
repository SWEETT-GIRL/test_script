// lib/checks.js
// 응답 검증을 한 줄로 표준화한다: http 200 && body.success === true

import { check } from 'k6';

/**
 * @param {object} res k6 response
 * @param {string} name check 라벨(보통 name 태그와 동일)
 * @returns {boolean} 통과 여부
 */
export function checkOk(res, name) {
  return check(res, {
    [`${name} status 200`]: (r) => r.status === 200,
    [`${name} success true`]: (r) => {
      try {
        return r.json('success') === true;
      } catch (_e) {
        return false;
      }
    },
  });
}
