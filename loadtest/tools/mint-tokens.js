#!/usr/bin/env node
/**
 * mint-tokens.js — loadtest 유저용 access token(JWT) 발급기.
 *
 * BE(JwtProvider)와 바이트 단위로 동일하게 서명한다:
 *   - HS256 (HMAC-SHA256)
 *   - 서명키 = Base64.decode(jwt.secret) 의 raw 바이트 (== Keys.hmacShaKeyFor)
 *   - payload: { sub: String(memberId), jti: UUID, iat, exp }
 *   - BE 검증은 서명+만료만 확인하므로 exp 를 길게 잡아도 통과(부하 중 만료 방지).
 *
 * member id 출처(둘 중 하나):
 *   1) ids.txt 파일(한 줄에 id 하나) 이 있으면 그걸 사용  ← dev DB 에서 뽑은 실제 id 권장
 *   2) 없으면 RANGE(기본 "1-2000") 범위를 사용
 *
 * 사용 예:
 *   # dev DB 에서 실제 id 뽑아서:
 *   psql "$DB_URL" -t -A -c "SELECT id FROM member WHERE nickname LIKE 'loadtest-user-%' ORDER BY id" > tools/ids.txt
 *   JWT_SECRET='YmJhbmct...==' node tools/mint-tokens.js
 *
 *   # 범위로 바로:
 *   JWT_SECRET='YmJhbmct...==' RANGE=1-2000 node tools/mint-tokens.js
 *
 * 환경변수:
 *   JWT_SECRET  (필수) BE 의 jwt.secret (Base64 문자열 그대로)
 *   RANGE       (선택) "start-end" (ids.txt 없을 때만). 기본 "1-2000"
 *   EXPIRY_MS   (선택) 토큰 유효기간(ms). 기본 7일
 *   IDS_FILE    (선택) id 목록 파일 경로. 기본 tools/ids.txt
 *   OUT         (선택) 출력 CSV 경로. 기본 data/tokens.csv
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_B64 = process.env.JWT_SECRET;
if (!SECRET_B64) {
  console.error('ERROR: JWT_SECRET 환경변수가 필요합니다 (BE 의 jwt.secret, Base64 문자열).');
  process.exit(1);
}
const key = Buffer.from(SECRET_B64, 'base64'); // == BE Keys.hmacShaKeyFor(Base64.decode(secret))
if (key.length < 32) {
  console.error(`ERROR: 디코드된 키가 ${key.length} 바이트입니다. HS256 은 최소 32바이트 필요.`);
  process.exit(1);
}

const EXPIRY_MS = Number(process.env.EXPIRY_MS || 7 * 24 * 60 * 60 * 1000); // 기본 7일
const IDS_FILE = process.env.IDS_FILE || path.join(__dirname, 'ids.txt');
const OUT = process.env.OUT || path.join(__dirname, '..', 'data', 'tokens.csv');

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sign(memberId, nowSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: String(memberId),
    jti: crypto.randomUUID(),
    iat: nowSec,
    exp: nowSec + Math.floor(EXPIRY_MS / 1000),
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', key).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

// member id 목록 결정
let ids = [];
if (fs.existsSync(IDS_FILE)) {
  ids = fs
    .readFileSync(IDS_FILE, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  console.log(`ids: ${IDS_FILE} 에서 ${ids.length}개 로드`);
} else {
  const [a, b] = (process.env.RANGE || '1-2000').split('-').map(Number);
  for (let i = a; i <= b; i++) ids.push(i);
  console.log(`ids: RANGE=${a}-${b} (${ids.length}개). ⚠ 실제 DB id 와 일치하는지 확인하세요.`);
}
if (ids.length === 0) {
  console.error('ERROR: 발급할 member id 가 없습니다.');
  process.exit(1);
}

const nowSec = Math.floor(Date.now() / 1000);
const rows = ['member_id,access_token'];
for (const id of ids) rows.push(`${id},${sign(id, nowSec)}`);
fs.writeFileSync(OUT, rows.join('\n') + '\n');

console.log(
  `wrote ${OUT} — ${ids.length} tokens, exp ${Math.round(EXPIRY_MS / 3600000)}h ` +
    `(${new Date((nowSec + EXPIRY_MS / 1000) * 1000).toISOString()} 까지)`
);
