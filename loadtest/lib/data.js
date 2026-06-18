// lib/data.js
// 위치/검색어 같은 가변 테스트 데이터를 CSV 에서 시드 기반(재현 가능)으로 뽑는다.
// 시나리오는 pickLocation()/pickQuery() 로만 접근한다(하드코딩 금지).

import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.2/index.js';

const LOCATIONS_PATH = __ENV.LOCATIONS_CSV || './data/locations.csv';
const QUERIES_PATH = __ENV.QUERIES_CSV || './data/search-queries.csv';

const locations = new SharedArray('locations', function () {
  const parsed = papaparse.parse(open(LOCATIONS_PATH), {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data
    .map((r) => ({ name: r.name, lat: Number(r.lat), lon: Number(r.lon) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
});

const queries = new SharedArray('search_queries', function () {
  const parsed = papaparse.parse(open(QUERIES_PATH), {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.map((r) => ({ query: r.query })).filter((r) => r.query);
});

// 결정적(재현 가능) 의사난수: VU + 반복(iteration) 기반 시드.
// Math.random() 과 달리 같은 (VU, iter) 면 같은 행을 고른다.
function seededIndex(len) {
  if (len === 0) return 0;
  const seed = __VU * 2654435761 + (__ITER + 1) * 40503;
  // 32bit 로 줄이고 양수화
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

/** @returns {{ name: string, lat: number, lon: number }} */
export function pickLocation() {
  if (locations.length === 0) {
    throw new Error(`locations.csv 가 비었습니다 (${LOCATIONS_PATH}). 헤더: name,lat,lon`);
  }
  return locations[seededIndex(locations.length)];
}

/** @returns {{ query: string }} */
export function pickQuery() {
  if (queries.length === 0) {
    throw new Error(`search-queries.csv 가 비었습니다 (${QUERIES_PATH}). 헤더: query`);
  }
  return queries[seededIndex(queries.length)];
}
