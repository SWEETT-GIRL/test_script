// nGrinder 부하 스크립트 — [가게 상세] 메뉴 카테고리 필터 (소금빵)
//   홈화면 → 가게 검색 → 상세+전체메뉴 → 소금빵 필터(카테고리 목록 조회)
//
// 구조 메모:
//   - home()              : 좌표 → mock(coord2regioncode) → 구_동 → BE /trend/select
//   - searchStore()       : search-queries.csv 키워드 → /stores/search?sort=popularity → storeId 추출
//                           응답: { data: { content: [ { id, name, ... } ], hasNext } }
//   - storeDetail()       : /stores/{storeId} + /stores/{storeId}/menus (전체)
//   - filterSogeumppang() : /menu-categories 조회 (필터 칩 렌더링용)
//                           ※ /stores/{storeId}/menus 는 서버사이드 카테고리 필터 미지원
//                              → 카테고리 필터는 클라이언트에서 처리, 추가 API 호출 없음
//
// ※ /stores/search 의 위경도 파라미터명은 lon (lng 아님)
//
// 리소스(같은 폴더 업로드): tokens.csv, locations.csv, search-queries.csv

import static net.grinder.script.Grinder.grinder
import static org.junit.Assert.*
import static org.hamcrest.Matchers.*
import net.grinder.plugin.http.HTTPRequest
import net.grinder.plugin.http.HTTPPluginControl
import net.grinder.script.GTest
import net.grinder.scriptengine.groovy.junit.GrinderRunner
import net.grinder.scriptengine.groovy.junit.annotation.BeforeProcess
import net.grinder.scriptengine.groovy.junit.annotation.BeforeThread
import org.junit.Test
import org.junit.runner.RunWith
import HTTPClient.HTTPResponse
import HTTPClient.NVPair
import groovy.json.JsonSlurper

@RunWith(GrinderRunner)
class TestRunner {

	public static final String BASE = "https://bbang-ggut.site"
	public static final String MOCK = "http://3.27.155.129:9900"

	public static GTest tHome
	public static GTest tSearch
	public static GTest tStoreDetail
	public static GTest tFilterMenu
	public static HTTPRequest request
	public static HTTPRequest mockRequest

	public static List TOKENS    = new ArrayList()
	public static List LOCATIONS = new ArrayList()
	public static List QUERIES   = new ArrayList()

	@BeforeProcess
	public static void beforeProcess() {
		HTTPPluginControl.getConnectionDefaults().timeout = 8000
		tHome        = new GTest(1, "01 home")
		tSearch      = new GTest(2, "02 search-store")
		tStoreDetail = new GTest(3, "03 store-detail")
		tFilterMenu  = new GTest(4, "04 filter-sogeumppang")
		request     = new HTTPRequest()
		mockRequest = new HTTPRequest()
		loadData()
		grinder.logger.info("loaded tokens=" + TOKENS.size()
			+ " loc=" + LOCATIONS.size()
			+ " queries=" + QUERIES.size())
	}

	private static void loadData() {
		List tl = readCsv("tokens.csv")
		for (int i = 1; i < tl.size(); i++) {
			String line = tl.get(i)
			if (line == null || line.trim().isEmpty()) continue
			String[] c = line.split(",")
			if (c.length >= 2) TOKENS.add(c[1].trim())
		}
		List ll = readCsv("locations.csv")
		for (int i = 1; i < ll.size(); i++) {
			String line = ll.get(i)
			if (line == null || line.trim().isEmpty()) continue
			String[] c = line.split(",")
			if (c.length < 3) continue
			List p = new ArrayList()
			p.add(Double.parseDouble(c[1].trim()))
			p.add(Double.parseDouble(c[2].trim()))
			LOCATIONS.add(p)
		}
		List ql = readCsv("search-queries.csv")
		for (int i = 1; i < ql.size(); i++) {
			String line = ql.get(i)
			if (line == null || line.trim().isEmpty()) continue
			String q = line.trim().split(",")[0].trim()
			if (!q.isEmpty()) QUERIES.add(q)
		}
		if (TOKENS.isEmpty())    throw new RuntimeException("tokens empty")
		if (LOCATIONS.isEmpty()) throw new RuntimeException("locations empty")
		if (QUERIES.isEmpty())   throw new RuntimeException("queries empty")
	}

	private static List readCsv(String name) {
		String[] paths = [name, "./" + name, "resources/" + name]
		for (String p : paths) {
			File f = new File(p)
			if (f.exists()) return f.readLines("UTF-8")
		}
		throw new RuntimeException(name + " not found")
	}

	@BeforeThread
	public void beforeThread() {
		tHome.record(this, "home")
		tSearch.record(this, "searchStore")
		tStoreDetail.record(this, "storeDetail")
		tFilterMenu.record(this, "filterSogeumppang")
		grinder.statistics.delayReports = true
	}

	private int seededIndex(int salt, int len) {
		long tn   = (long) grinder.threadNumber
		long it   = (long) grinder.runNumber
		long seed = tn * 2654435761L
		seed = seed + (it + 1L) * 40503L
		seed = seed + (long) salt * 97L
		long m = seed & 0xffffffffL
		long h = m ^ (m >> 13)
		return (int) ((h & 0xffffffffL) % (long) len)
	}

	private NVPair[] authHeaders() {
		int idx    = grinder.threadNumber % TOKENS.size()
		String tok = (String) TOKENS.get(idx)
		NVPair[] h = new NVPair[2]
		h[0] = new NVPair("Authorization", "Bearer " + tok)
		h[1] = new NVPair("Content-Type", "application/json")
		return h
	}

	// ── 스레드 로컬 상태 ──────────────────────────────────────────────────────
	private long storeId = -1L

	// ── mock: 좌표 → 구_동 ───────────────────────────────────────────────────
	private String geoRegion(double lat, double lon) {
		String url = MOCK + "/v2/local/geo/coord2regioncode.json?x=" + lon + "&y=" + lat
		NVPair[] none = new NVPair[0]
		HTTPResponse r = mockRequest.GET(url, none, none)
		try {
			def parsed = new JsonSlurper().parseText(new String(r.getData(), "UTF-8"))
			def docs   = parsed.get("documents")
			if (docs != null && docs.size() > 0) {
				def d = docs.get(0)
				return d.get("region_2depth_name") + "_" + d.get("region_3depth_name")
			}
		} catch (Exception e) {
			grinder.logger.warn("geo fail " + e.message)
		}
		return null
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 01 home: 현위치 좌표 → mock coord2regioncode → /trend/select
	// ──────────────────────────────────────────────────────────────────────────
	public void home() {
		int idx    = seededIndex(1, LOCATIONS.size())
		List loc   = (List) LOCATIONS.get(idx)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)
		String region = geoRegion(lat, lon)
		if (region == null) return

		NVPair[] params = new NVPair[1]
		params[0] = new NVPair("region", region)
		HTTPResponse r = request.GET(BASE + "/trend/select", params, authHeaders())
		assertThat(r.statusCode, is(200))
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 02 searchStore: search-queries.csv 키워드 → /stores/search → storeId 추출
	// ※ /stores/search 는 lon (lng 아님)
	// ──────────────────────────────────────────────────────────────────────────
	public void searchStore() {
		storeId = -1L

		int qi     = seededIndex(2, QUERIES.size())
		String q   = (String) QUERIES.get(qi)
		int li     = seededIndex(3, LOCATIONS.size())
		List loc   = (List) LOCATIONS.get(li)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)

		NVPair[] params = new NVPair[6]
		params[0] = new NVPair("query", q)
		params[1] = new NVPair("lat",   String.valueOf(lat))
		params[2] = new NVPair("lon",   String.valueOf(lon))  // ※ lon
		params[3] = new NVPair("page",  "0")
		params[4] = new NVPair("size",  "15")
		params[5] = new NVPair("sort",  "popularity")
		HTTPResponse r = request.GET(BASE + "/stores/search", params, authHeaders())
		assertThat(r.statusCode, is(200))

		try {
			// 실제 응답: { data: { content: [ { id: 75, ... }, ... ], hasNext: true } }
			def content = new JsonSlurper().parseText(r.getText())?.data?.content
			if (content != null && content.size() > 0) {
				storeId = content[0].id as long
			}
		} catch (Exception e) {
			grinder.logger.warn("searchStore parse fail " + e.message)
		}
		grinder.logger.info("search q=" + q + " storeId=" + storeId)
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 03 storeDetail: /stores/{storeId} + /stores/{storeId}/menus (전체)
	// ──────────────────────────────────────────────────────────────────────────
	public void storeDetail() {
		if (storeId < 0) return

		NVPair[] none = new NVPair[0]
		HTTPResponse r1 = request.GET(BASE + "/stores/" + storeId, none, authHeaders())
		assertThat(r1.statusCode, is(200))

		HTTPResponse r2 = request.GET(BASE + "/stores/" + storeId + "/menus", none, authHeaders())
		assertThat(r2.statusCode, is(200))
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 04 filterSogeumppang: /menu-categories → 소금빵 categoryId → /stores/{storeId}/menus?categoryId
	// ──────────────────────────────────────────────────────────────────────────
	// ──────────────────────────────────────────────────────────────────────────
	// 04 filterSogeumppang: /menu-categories 조회 (필터 칩 렌더링)
	//    카테고리 필터는 클라이언트 처리 → 추가 menus 호출 없음
	// ──────────────────────────────────────────────────────────────────────────
	public void filterSogeumppang() {
		NVPair[] none  = new NVPair[0]
		HTTPResponse r = request.GET(BASE + "/menu-categories", none, authHeaders())
		assertThat(r.statusCode, is(200))
	}

	@Test
	public void test() {
		home()
		grinder.sleep(800)
		searchStore()
		grinder.sleep(1000)
		storeDetail()
		grinder.sleep(1200)
		filterSogeumppang()
		grinder.sleep(800)
	}
}
