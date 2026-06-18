// lib/config.js
// 모든 시나리오가 공유하는 부하 프로파일 / threshold / tag 를 한 곳에서 고정한다.
// 시나리오 작성자는 이 파일을 수정하지 않고 getOptions(scenarioName) 만 호출한다.

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// LOAD_LEVEL: 'smoke' | 'full'(기본)
//   - full : 1000 → 1500 → 2000 RPS 점진 증가 (목표 부하)
//   - smoke: 50 RPS 저강도 (로컬 동작 확인용)
const LOAD_LEVEL = (__ENV.LOAD_LEVEL || 'full').toLowerCase();

// ramping-arrival-rate: "초당 도착 요청수(RPS)" 를 직접 제어한다. VU 고정이 아니다.
const PROFILES = {
  full: {
    startRate: 1000,
    stages: [
      { target: 1000, duration: '1m' }, // 워밍업 후 1000 RPS 유지
      { target: 1000, duration: '2m' },
      { target: 1500, duration: '1m' }, // 1500 으로 증가
      { target: 1500, duration: '2m' },
      { target: 2000, duration: '1m' }, // 2000 으로 증가
      { target: 2000, duration: '2m' }, // 2000 RPS 유지 (피크)
      { target: 0, duration: '30s' }, // 쿨다운
    ],
    preAllocatedVUs: 500,
    maxVUs: 4000,
  },
  smoke: {
    startRate: 10,
    stages: [
      { target: 50, duration: '20s' },
      { target: 50, duration: '40s' },
      { target: 0, duration: '10s' },
    ],
    preAllocatedVUs: 20,
    maxVUs: 200,
  },
};

// 공통 threshold. 시나리오별 조정이 필요하면 시나리오 정의에서 요청한다.
const THRESHOLDS = {
  http_req_failed: ['rate<0.01'], // 에러율 1% 미만
  http_req_duration: ['p(95)<800'], // p95 < 800ms
  checks: ['rate>0.99'], // check 통과율 99% 이상
};

/**
 * @param {string} scenarioName snake_case. Grafana/k6 scenario 태그명.
 * @returns {object} k6 options
 */
export function getOptions(scenarioName) {
  if (!scenarioName) {
    throw new Error('getOptions(scenarioName): scenarioName(snake_case) 는 필수입니다.');
  }

  const profile = PROFILES[LOAD_LEVEL] || PROFILES.full;

  return {
    scenarios: {
      [scenarioName]: {
        executor: 'ramping-arrival-rate',
        startRate: profile.startRate,
        timeUnit: '1s',
        preAllocatedVUs: profile.preAllocatedVUs,
        maxVUs: profile.maxVUs,
        stages: profile.stages,
        tags: { scenario: scenarioName },
      },
    },
    thresholds: THRESHOLDS,
    // 모든 메트릭에 공통으로 붙는 태그
    tags: {
      scenario: scenarioName,
      load_level: LOAD_LEVEL,
    },
    // 부하 종료 후 미완료 요청 정리 시간
    gracefulStop: '15s',
  };
}
