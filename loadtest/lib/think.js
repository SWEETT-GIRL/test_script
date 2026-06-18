// lib/think.js
// 단계(group) 사이의 사용자 체류시간을 랜덤 sleep 으로 모사한다.

import { sleep } from 'k6';

const MIN = Number(__ENV.THINK_MIN || 0.5); // 초
const MAX = Number(__ENV.THINK_MAX || 2.0); // 초

/**
 * MIN ~ MAX 초 사이 랜덤 sleep.
 * @param {number} [min] override 최소 초
 * @param {number} [max] override 최대 초
 */
export function think(min = MIN, max = MAX) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const sec = lo + Math.random() * (hi - lo);
  sleep(sec);
}
