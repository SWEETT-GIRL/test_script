// mock/server.js
// loadtest 환경에서 BE 가 바라보는 외부 API 대체 서버.
// k6 는 이 서버를 직접 호출하지 않는다 — BE 가 외부 호출을 이 서버로 향하게 구성한다(인프라 책임).
// 목적: 외부 의존(카카오 로컬/주소 검색/FCM/S3 presign 등)을 빠르고 결정적으로 대체.
//
// 실행:  node mock/server.js   (기본 포트 9900, MOCK_PORT 로 변경)

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 9900);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // 헬스체크
  if (path === '/health') {
    return json(res, 200, { status: 'ok' });
  }

  // 카카오 로컬 — 키워드 장소 검색
  if (path.startsWith('/v2/local/search/keyword')) {
    const query = url.searchParams.get('query') || 'mock';
    return json(res, 200, {
      documents: Array.from({ length: 5 }).map((_, i) => ({
        id: `mock-place-${i}`,
        place_name: `${query} 빵집 ${i}`,
        address_name: '서울 성동구 mock 1-1',
        road_address_name: '서울 성동구 mockro 1',
        x: '127.0557',
        y: '37.5446',
        phone: '02-000-0000',
        category_group_code: 'FD6',
      })),
      meta: { total_count: 5, pageable_count: 5, is_end: true },
    });
  }

  // 주소 검색 (행정/도로명) — BE 의 /address/search 가 호출하는 외부 의존 대체
  if (path.startsWith('/address/search') || path.startsWith('/v2/local/search/address')) {
    return json(res, 200, {
      documents: [
        {
          address_name: '서울 성동구 성수동 1-1',
          x: '127.0557',
          y: '37.5446',
        },
      ],
      meta: { total_count: 1, is_end: true },
    });
  }

  // FCM 발송 mock
  if (path.startsWith('/fcm/send') || path.includes('/messages:send')) {
    return json(res, 200, { name: 'projects/mock/messages/mock-message-id' });
  }

  // S3 presigned URL mock — 실제 업로드 없이 가짜 URL 반환
  if (path.includes('presigned') || path.startsWith('/s3/presign')) {
    return json(res, 200, {
      url: `http://localhost:${PORT}/s3/upload/mock-object`,
      fields: { key: 'mock-object' },
    });
  }

  // S3 업로드 대상 (PUT) — 항상 성공
  if (path.startsWith('/s3/upload/')) {
    return json(res, 200, { ok: true });
  }

  // 그 외는 빈 성공
  return json(res, 200, { ok: true, path });
});

server.listen(PORT, () => {
  console.log(`[mock] external-API mock listening on http://localhost:${PORT}`);
});
