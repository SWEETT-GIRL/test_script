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

// 카카오 좌표→행정구역 매핑용 (구, 동) 풀. 모두 유효한 Region3rd '구_동' 이며
// 빵집/트렌드 데이터가 있는 지역 위주. BE 는 coord2address(구) + coord2regioncode(동)
// 를 합쳐 Region3rd.valueOf("구_동") 을 만들므로 두 응답이 같은 쌍을 줘야 한다.
// regions.csv(Region3rd 전체)를 시작 시 읽어 (구, 동) 풀을 구성한다.
// '구_동' 을 '_' 기준으로 분리하고, '_전체'(동 아님)는 제외 → 약 2,400개.
const fs = require('fs');
const path = require('path');
const REGIONS_CSV = process.env.REGIONS_CSV || path.join(__dirname, '..', 'data', 'regions.csv');

function loadRegionPool() {
  const fallback = [{ gu: '강남구', dong: '역삼동' }];
  try {
    const lines = fs.readFileSync(REGIONS_CSV, 'utf8').split(/\r?\n/).slice(1); // 헤더 제외
    const pool = [];
    for (const line of lines) {
      const v = line.trim();
      const us = v.indexOf('_');
      if (us <= 0) continue;
      const dong = v.slice(us + 1);
      if (!dong || dong === '전체') continue; // 동/읍/면 만 (BE endsWithDongSuffix 통과용)
      pool.push({ gu: v.slice(0, us), dong });
    }
    return pool.length ? pool : fallback;
  } catch (e) {
    console.warn(`[mock] regions.csv 로드 실패(${REGIONS_CSV}) → 기본 풀 사용: ${e.message}`);
    return fallback;
  }
}

const REGION_POOL = loadRegionPool();

// 좌표(x=lon, y=lat)를 결정적으로 풀의 한 (구,동) 으로 매핑. 같은 좌표면 항상 같은 결과.
function pickRegion(url) {
  const x = parseFloat(url.searchParams.get('x'));
  const y = parseFloat(url.searchParams.get('y'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return REGION_POOL[0];
  const h = Math.abs(Math.round(x * 1000) + Math.round(y * 1000));
  return REGION_POOL[h % REGION_POOL.length];
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

  // 카카오 좌표→주소 (coord2address) — trend/nearby 가 여기서 region2nd(구) 를 뽑는다.
  // addressName 의 두 번째 토큰이 구가 되도록 "시도 구 동" 형태로 준다.
  if (path.startsWith('/v2/local/geo/coord2address')) {
    const r = pickRegion(url);
    return json(res, 200, {
      documents: [
        {
          road_address: { region_3depth_name: r.dong },
          address: {
            address_name: `대한민국 ${r.gu} ${r.dong}`,
            region_2depth_name: r.gu,
            region_3depth_name: r.dong,
          },
        },
      ],
      meta: { total_count: 1 },
    });
  }

  // 카카오 좌표→행정구역 (coord2regioncode) — trend/nearby 가 여기서 region3rd(동) 를 뽑는다.
  // 같은 좌표면 coord2address 와 동일한 (구,동) → Region3rd "구_동" 매핑이 일관된다.
  if (path.startsWith('/v2/local/geo/coord2regioncode')) {
    const r = pickRegion(url);
    return json(res, 200, {
      documents: [
        { region_type: 'B', region_2depth_name: r.gu, region_3depth_name: r.dong },
        { region_type: 'H', region_2depth_name: r.gu, region_3depth_name: r.dong },
      ],
      meta: { total_count: 2 },
    });
  }

  // 네이버 지역검색 — BE 의 가게 추가 제보(/stores/add-reports/naver/search)가 부르는 외부 의존.
  // BE(NaverLocalSearchResponse)는 mapx/mapy(=좌표×10^7 문자열)를 ÷10^7 해서 lat/lng 로 쓰고,
  // link 의 place id(정규식 (?:code=|/place/)(\d+)) 를 naverPlaceId 로 추출한다.
  if (path.startsWith('/v1/search/local')) {
    const query = url.searchParams.get('query') || 'mock';
    const display = Math.min(Math.max(parseInt(url.searchParams.get('display'), 10) || 10, 1), 30);
    const baseLon = 127.0557;
    const baseLat = 37.5446;
    return json(res, 200, {
      items: Array.from({ length: display }).map((_, i) => {
        const r = REGION_POOL[i % REGION_POOL.length]; // 항목마다 다른 구/동
        const lon = baseLon + i * 0.0017; // 항목마다 좌표 흩기(유효 double)
        const lat = baseLat + i * 0.0013;
        return {
          title: `${query} 베이커리 ${i}`, // BE 가 <b> 태그 제거하므로 평문이어도 됨
          link: `https://map.naver.com/p/place/${1000000 + i}`, // → naverPlaceId 1000000+i
          category: '음식점>베이커리',
          telephone: `02-000-${String(1000 + i).slice(-4)}`,
          address: `${r.gu} ${r.dong} ${i + 1}-${i + 1}`,
          roadAddress: `${r.gu} ${r.dong}로 ${i + 1}`,
          mapx: String(Math.round(lon * 1e7)), // 좌표 × 10^7
          mapy: String(Math.round(lat * 1e7)),
        };
      }),
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
