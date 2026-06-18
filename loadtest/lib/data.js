// lib/data.js
// 위치/검색어 같은 가변 테스트 데이터를 CSV 에서 시드 기반(재현 가능)으로 뽑는다.
// 시나리오는 pickLocation()/pickQuery() 로만 접근한다(하드코딩 금지).

import { SharedArray } from 'k6/data';
import papaparse from './vendor/papaparse.js';

const LOCATIONS_PATH = __ENV.LOCATIONS_CSV || '../data/locations.csv';
const QUERIES_PATH = __ENV.QUERIES_CSV || '../data/search-queries.csv';
const REGIONS_PATH = __ENV.REGIONS_CSV || '../data/regions.csv';
const REGION_QUERIES_PATH = __ENV.REGION_QUERIES_CSV || '../data/region-search-queries.csv';

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

const regions = new SharedArray('regions', function () {
  const parsed = papaparse.parse(open(REGIONS_PATH), {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.map((r) => r.region).filter((r) => r);
});

// 검색창에 입력하는 한 단어 지역명(예: 강남, 제주, 대전). /stores/search 의 query 로 쓴다.
const regionQueries = new SharedArray('region_queries', function () {
  const parsed = papaparse.parse(open(REGION_QUERIES_PATH), {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.map((r) => r.query).filter((r) => r);
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

// pickLocation/pickQuery 와 상관(correlation)되지 않도록 시드 곱셈 상수 순서를 바꾼다.
// → 같은 iteration 에서도 위치와 지역이 서로 다른 인덱스로 흩어진다(둘 다 재현 가능).
function seededRegionIndex(len) {
  if (len === 0) return 0;
  const seed = __VU * 40503 + (__ITER + 1) * 2654435761;
  const h = (seed >>> 0) ^ ((seed >>> 0) >> 13);
  return (h >>> 0) % len;
}

/**
 * trend/select 용 Region3rd 값(예: '강남구_역삼동')을 시드 기반(재현 가능)으로 고른다.
 * data/regions.csv(헤더: region) = Region3rd enum 전체 값.
 * @returns {string}
 */
export function pickRegion() {
  if (regions.length === 0) {
    throw new Error(`regions.csv 가 비었습니다 (${REGIONS_PATH}). 헤더: region`);
  }
  return regions[seededRegionIndex(regions.length)];
}

/**
 * /stores/search 의 query 로 쓸 한 단어 지역명(예: '강남')을 시드 기반(재현 가능)으로 고른다.
 * data/region-search-queries.csv(헤더: query).
 * @returns {{ query: string }}
 */
export function pickRegionQuery() {
  if (regionQueries.length === 0) {
    throw new Error(`region-search-queries.csv 가 비었습니다 (${REGION_QUERIES_PATH}). 헤더: query`);
  }
  return { query: regionQueries[seededRegionIndex(regionQueries.length)] };
}

// Region3rd('시군구_읍면동') 를 시군구(prefix) 기준으로 묶는다. '_전체' 는 읍면동이 아니라 제외.
// VU 마다 한 번만 만들어 캐시(약 2,689행, 가벼움).
let _sigunguGroups = null;
function sigunguGroups() {
  if (_sigunguGroups) return _sigunguGroups;
  const map = {};
  for (const r of regions) {
    const us = r.indexOf('_');
    if (us <= 0) continue;
    const dong = r.slice(us + 1);
    if (dong === '전체') continue; // 시군구 전체는 읍면동 목록에서 제외
    const sgg = r.slice(0, us);
    (map[sgg] = map[sgg] || []).push(r);
  }
  _sigunguGroups = { map, keys: Object.keys(map) };
  return _sigunguGroups;
}

/**
 * 시군구 1개를 시드 기반으로 고르고, 그 안의 읍/면/동 Region3rd 값 최대 count 개를 반환한다.
 * (모두 같은 시군구 소속. 재현 가능: 같은 (VU, iter) 면 같은 시군구·같은 동 묶음)
 * @param {number} count 원하는 읍/면/동 개수(시군구에 그보다 적으면 있는 만큼)
 * @returns {{ sigungu: string, regions: string[] }}
 */
export function pickRegionCluster(count) {
  const { map, keys } = sigunguGroups();
  if (keys.length === 0) {
    throw new Error(`regions.csv 에 유효한 시군구가 없습니다 (${REGIONS_PATH}).`);
  }
  const sigungu = keys[seededRegionIndex(keys.length)];
  const dongs = map[sigungu];
  const n = Math.min(count, dongs.length);
  const start = seededRegionIndex(dongs.length);
  const picked = [];
  for (let i = 0; i < n; i++) {
    picked.push(dongs[(start + i) % dongs.length]); // 연속 슬라이스 → 서로 다른 동
  }
  return { sigungu, regions: picked };
}
