// lib/http.js
// 모든 HTTP 요청은 반드시 이 래퍼를 경유한다.
//  - Authorization: Bearer 헤더 일관 부착
//  - name 태그로 고-카디널리티 URL 정규화 (경로변수 치환 금지)
//  - ApiResponse({ success, data, ... }) 파싱 헬퍼 제공

import http from 'k6/http';
import { BASE_URL } from './config.js';

// k6 의 params 는 url 에 직접 쿼리를 붙이는 방식이라, qs 를 수동으로 직렬화한다.
function withQuery(path, params) {
  if (!params) return `${BASE_URL}${path}`;
  const usp = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return usp ? `${BASE_URL}${path}?${usp}` : `${BASE_URL}${path}`;
}

function reqParams({ token, name }) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return { headers, tags: name ? { name } : undefined };
}

export function apiGet(path, { token, params, name } = {}) {
  return http.get(withQuery(path, params), reqParams({ token, name }));
}

export function apiPost(path, { token, body, params, name } = {}) {
  return http.post(
    withQuery(path, params),
    body !== undefined ? JSON.stringify(body) : null,
    reqParams({ token, name })
  );
}

export function apiPatch(path, { token, body, params, name } = {}) {
  return http.patch(
    withQuery(path, params),
    body !== undefined ? JSON.stringify(body) : null,
    reqParams({ token, name })
  );
}

export function apiDelete(path, { token, params, name } = {}) {
  return http.del(withQuery(path, params), null, reqParams({ token, name }));
}

/**
 * ApiResponse 의 .data 를 안전하게 추출. 파싱 실패/비정상 응답이면 null.
 * @param {object} res k6 response
 * @returns {*|null}
 */
export function dataOf(res) {
  try {
    const body = res.json();
    if (body && typeof body === 'object' && 'data' in body) {
      return body.data;
    }
    return null;
  } catch (_e) {
    return null;
  }
}
