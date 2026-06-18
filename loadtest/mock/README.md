# mock/ — 외부 API 대체 서버

loadtest 환경에서 BE 가 호출하는 **외부 API(카카오 로컬/주소 검색/FCM/S3 presign 등)** 를
빠르고 결정적으로 대체한다.

> ⚠ k6 는 이 서버를 **직접 호출하지 않는다.** k6 는 우리 BE 만 때린다.
> BE 가 외부를 부를 때 이 mock 서버를 바라보도록 구성하는 것은 **인프라 책임**이다.

## 실행

```bash
# 의존성 없음(Node 내장 http 만 사용)
node mock/server.js
# 포트 변경
MOCK_PORT=9900 node mock/server.js
```

기본 포트: `9900` (`MOCK_PORT` 로 변경)

## 제공 엔드포인트

| 경로 | 대체 대상 | 응답 |
|------|-----------|------|
| `GET /health` | - | `{ status: "ok" }` |
| `GET /v2/local/search/keyword?query=` | 카카오 로컬 키워드 검색 | 가짜 장소 5건 |
| `GET /v2/local/search/address`, `GET /address/search` | 주소 검색 | 가짜 주소 1건 |
| `POST /fcm/send`, `*/messages:send` | FCM 발송 | 가짜 message id |
| `*presigned*`, `POST /s3/presign` | S3 presigned URL | 가짜 presign URL |
| `PUT /s3/upload/*` | S3 업로드 | `{ ok: true }` |
| 그 외 | - | `{ ok: true, path }` |

## BE 연동 (인프라)

loadtest 프로파일에서 BE 의 외부 API base URL 환경변수를 이 서버로 향하게 한다. 예:

```
KAKAO_LOCAL_BASE_URL=http://mock:9900
FCM_BASE_URL=http://mock:9900
S3_ENDPOINT=http://mock:9900
```

(실제 환경변수명은 BE 설정에 맞춘다.)
