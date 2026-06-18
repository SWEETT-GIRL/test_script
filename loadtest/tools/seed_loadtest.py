#!/usr/bin/env python3
"""
seed_loadtest.py — dev DB 에 loadtest 유저 시드 + access token 발급 + tokens.csv 생성 (한 번에).

동작:
  1) member 테이블에 'loadtest-user-N' 멤버 COUNT 명 INSERT (RETURNING id)
  2) (옵션) 각 멤버의 notification_setting 행 INSERT  ← notification-settings 시나리오용
  3) 각 member id 로 BE(JwtProvider)와 동일하게 HS256 JWT 발급
       - 서명키 = base64decode(jwt.secret) raw 바이트 (== Keys.hmacShaKeyFor)
       - payload: { sub, jti, iat, exp }, 검증은 서명+만료만 → exp 길게(기본 7일)
  4) data/tokens.csv 작성 (member_id,access_token)

사전 준비:
  pip install psycopg2-binary

접속정보(환경변수, libpq 표준):
  PGHOST(기본 54.79.182.81) PGPORT(5432) PGDATABASE(soboro) PGUSER(sweetgirl) PGPASSWORD(필수)
  또는 DATABASE_URL=postgresql://user:pw@host:5432/db 로 한 번에.

기타 환경변수:
  JWT_SECRET   (필수) BE 의 jwt.secret (Base64 문자열 그대로)
  COUNT        (기본 2000) 시드할 멤버 수
  EXPIRY_DAYS  (기본 7)    토큰 유효기간(일)
  OUT          (기본 ../data/tokens.csv)
  WITH_NOTIF   (기본 1)    notification_setting 도 시드(0이면 멤버만)

사용 예:
  PGPASSWORD=... JWT_SECRET='YmJhbmct...==' COUNT=2000 python3 tools/seed_loadtest.py

  # 다른 DB/계정이면:
  DATABASE_URL='postgresql://user:pw@54.79.182.81:5432/soboro' \
  JWT_SECRET='YmJhbmct...==' python3 tools/seed_loadtest.py

주의:
  - 재실행하면 멤버가 "추가" 됩니다(중복 생성). 정리: DELETE FROM member WHERE nickname LIKE 'loadtest-user-%';
    (FK 때문에 notification_setting 등 자식 먼저 삭제 필요할 수 있음)
  - 컬럼명은 Hibernate snake_case 기준으로 작성. 만약 INSERT 가 컬럼 에러나면
    `\d+ member`, `\d+ notification_setting` 로 실제 컬럼명 확인 후 아래 SQL 의 컬럼만 맞춰주세요.
  - 쓰기 작업이므로 dev/loadtest DB 에만 실행하세요(운영 금지).
"""

import base64
import hmac
import hashlib
import json
import os
import sys
import time
import uuid

# ---- 설정 로드 -------------------------------------------------------------
SECRET_B64 = os.environ.get("JWT_SECRET")
if not SECRET_B64:
    sys.exit("ERROR: JWT_SECRET 환경변수 필요 (BE jwt.secret, Base64 문자열).")
KEY = base64.b64decode(SECRET_B64)
if len(KEY) < 32:
    sys.exit(f"ERROR: 디코드된 키가 {len(KEY)}바이트. HS256 은 최소 32바이트 필요.")

COUNT = int(os.environ.get("COUNT", "2000"))
EXPIRY_DAYS = int(os.environ.get("EXPIRY_DAYS", "7"))
EXPIRY_SEC = EXPIRY_DAYS * 24 * 60 * 60
WITH_NOTIF = os.environ.get("WITH_NOTIF", "1") != "0"
OUT = os.environ.get(
    "OUT", os.path.join(os.path.dirname(__file__), "..", "data", "tokens.csv")
)

# ---- JWT (BE JwtProvider 와 동일: HS256, sub/jti/iat/exp) -------------------
def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def mint(member_id: int, now: int) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": str(member_id),
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + EXPIRY_SEC,
    }
    seg = _b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + _b64url(
        json.dumps(payload, separators=(",", ":")).encode()
    )
    sig = hmac.new(KEY, seg.encode("ascii"), hashlib.sha256).digest()
    return seg + "." + _b64url(sig)


# ---- DB 시드 ---------------------------------------------------------------
def connect():
    try:
        import psycopg2  # type: ignore
    except ImportError:
        sys.exit("ERROR: psycopg2 가 필요합니다 →  pip install psycopg2-binary")
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return psycopg2.connect(dsn)
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "54.79.182.81"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "soboro"),
        user=os.environ.get("PGUSER", "sweetgirl"),
        password=os.environ.get("PGPASSWORD"),
    )


MEMBER_SQL = """
INSERT INTO member
  (nickname, agree_to_terms, agree_to_privacy, agree_to_age_over14,
   agree_to_location, agree_to_marketing, agree_to_night_marketing,
   created_at, updated_at)
SELECT 'loadtest-user-' || g,
       true, true, true, true, true, true, NOW(), NOW()
FROM generate_series(1, %s) AS g
RETURNING id;
"""

# notification_setting: 한 멤버당 1행. 컬럼명은 Hibernate snake_case 기준.
NOTIF_SQL = """
INSERT INTO notification_setting
  (member_id, is_notification_enabled, notification_radius,
   start_time, end_time, days_of_week, is_marketing_enabled,
   created_at, updated_at)
SELECT id, true, 'R500', TIME '09:00', TIME '21:00',
       'MONDAY,WEDNESDAY,FRIDAY', true, NOW(), NOW()
FROM unnest(%s::bigint[]) AS id;
"""


def main():
    print(f"[seed] COUNT={COUNT} WITH_NOTIF={WITH_NOTIF} EXPIRY_DAYS={EXPIRY_DAYS}")
    conn = connect()
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(MEMBER_SQL, (COUNT,))
            ids = [r[0] for r in cur.fetchall()]
            print(f"[seed] member {len(ids)}명 생성 (id {ids[0]}..{ids[-1]})")

            if WITH_NOTIF:
                cur.execute(NOTIF_SQL, (ids,))
                print(f"[seed] notification_setting {cur.rowcount}행 생성")
        conn.commit()
        print("[seed] commit 완료")
    except Exception as e:
        conn.rollback()
        sys.exit(f"ERROR: DB 시드 실패(rollback) → {e}")
    finally:
        conn.close()

    # ---- 토큰 발급 + csv ----
    now = int(time.time())
    rows = ["member_id,access_token"]
    for mid in ids:
        rows.append(f"{mid},{mint(mid, now)}")
    out_path = os.path.abspath(OUT)
    with open(out_path, "w") as f:
        f.write("\n".join(rows) + "\n")
    print(
        f"[token] {out_path} 작성 — {len(ids)}개, "
        f"exp {EXPIRY_DAYS}일 후까지"
    )


if __name__ == "__main__":
    main()
