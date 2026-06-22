# ngrinder/ — nGrinder 부하 스크립트 (Groovy)

k6 시나리오(`scenarios/`)를 nGrinder Groovy 문법으로 옮긴 것.

## k6 와 다른 점
- **부하 프로파일(Vuser 수 / Duration / Ramp-Up / Agent 수)은 스크립트에 없다.**
  nGrinder **Performance Test 생성 UI**에서 매번 설정한다.
  스크립트는 "한 vuser 가 뭘 하는지"(시나리오 + `grinder.sleep` think time)만 정의.
- 토큰/위치/지역은 **리소스 CSV**(`tokens.csv`, `locations.csv`, `regions.csv`)를 스크립트와
  같은 폴더에 업로드해 `new File(...).readLines("UTF-8")` 로 읽는다.

## 공통 규약 (붙여넣기 안전 + 한글 인코딩)
- 긴 줄은 wrap 시 깨지므로 **URL 은 변수로 분리**, 한 줄을 짧게.
- 외부(mock) 응답의 한글은 `new String(r.getData(), "UTF-8")` 로 디코딩 (getText() 는 Latin-1 로 깨짐).
- BE 쿼리 파라미터(한글 region 등)는 직접 인코딩하지 말고 **`new NVPair("region", region)`** 로 전달.
- mock 호출은 BE 와 **별도 HTTPRequest(`mockRequest`)** 로 (상태 간섭 방지).

## 실행 전 체크
- `BASE` = 부하 대상 BE 주소, `MOCK` = mock 서버 주소.
- mock 서버가 떠 있고, 에이전트에서 그 포트로 닿아야 함(보안그룹).
- 리소스에 `tokens.csv`/`locations.csv`/`regions.csv` 업로드.
- Validate → `loaded t=...` + 에러 0 확인 후 Performance Test.
