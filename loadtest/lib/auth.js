// lib/auth.js
// data/tokens.csv 를 SharedArray 로 한 번만 로드하고, VU 마다 다른 토큰을 매핑한다.
// 실토큰은 커밋 금지. tokens.csv 는 .gitignore 대상이며 tokens.sample.csv 만 커밋한다.

import { SharedArray } from 'k6/data';
import papaparse from './vendor/papaparse.js';

const TOKENS_PATH = __ENV.TOKENS_CSV || '../data/tokens.csv';

// SharedArray: 파일을 한 번만 파싱해 모든 VU 가 메모리를 공유한다(수만 행도 안전).
const tokens = new SharedArray('tokens', function () {
  const raw = open(TOKENS_PATH);
  const parsed = papaparse.parse(raw, { header: true, skipEmptyLines: true });
  const rows = parsed.data
    .map((r) => ({
      memberId: r.member_id,
      accessToken: r.access_token,
    }))
    .filter((r) => r.accessToken);

  if (rows.length === 0) {
    throw new Error(
      `tokens.csv 에 유효한 행이 없습니다 (${TOKENS_PATH}). 헤더: member_id,access_token`
    );
  }
  return rows;
});

/**
 * 현재 VU 에 매핑된 토큰을 반환한다. VU 별로 결정적으로 다른 행을 고른다.
 * @returns {{ token: string, accessToken: string, memberId: string }}
 *   token === accessToken (스켈레톤의 `const { token } = pickToken()` 호환용 alias)
 */
export function pickToken() {
  // __VU 는 1부터 시작. 토큰 수보다 VU 가 많으면 순환한다.
  const idx = (__VU - 1) % tokens.length;
  const row = tokens[idx];
  return {
    token: row.accessToken,
    accessToken: row.accessToken,
    memberId: row.memberId,
  };
}

export function tokenCount() {
  return tokens.length;
}
