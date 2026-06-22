// nGrinder 부하 스크립트 — [검색] 여행갈 지역 빵 탐색
//   홈화면 → 여행 도시 키워드 검색 → 가게 목록 스크롤(page 1→2) → 가게 상세
//
// 구조 메모:
//   - home()        : 좌표 → mock(coord2regioncode) → 구_동 → BE /trend/select (현위치 홈 피드)
//   - searchRegion(): KEYWORDS 에서 여행 도시 1개 선택 → /stores/district?keyword&lat&lng&page=1
//   - scrollStores(): 동일 keyword, page=2 (사용자 스크롤 모사)
//   - storeDetail() : 검색 결과 storeIds 앞 최대 2개 → /stores/{id}
//
// ※ /stores/district 의 위경도 파라미터명은 lng (lon 아님)
//
// 리소스(같은 폴더 업로드): tokens.csv, locations.csv, region-search-queries.csv

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
	public static GTest tScroll
	public static GTest tStore
	public static HTTPRequest request
	public static HTTPRequest mockRequest

	public static List TOKENS    = new ArrayList()
	public static List LOCATIONS = new ArrayList()
	public static List KEYWORDS  = new ArrayList()

	@BeforeProcess
	public static void beforeProcess() {
		HTTPPluginControl.getConnectionDefaults().timeout = 8000
		tHome   = new GTest(1, "01 home")
		tSearch = new GTest(2, "02 search-region")
		tScroll = new GTest(3, "03 scroll-page2")
		tStore  = new GTest(4, "04 store-detail")
		request     = new HTTPRequest()
		mockRequest = new HTTPRequest()
		loadData()
		grinder.logger.info("loaded tokens=" + TOKENS.size()
			+ " loc=" + LOCATIONS.size()
			+ " keywords=" + KEYWORDS.size())
	}

	private static void loadData() {
		// ── tokens ──────────────────────────────────────────────────────────
		List tl = readCsv("tokens.csv")
		for (int i = 1; i < tl.size(); i++) {
			String line = tl.get(i)
			if (line == null || line.trim().isEmpty()) continue
			String[] c = line.split(",")
			if (c.length >= 2) TOKENS.add(c[1].trim())
		}

		// ── locations (lat, lon) ────────────────────────────────────────────
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

		// ── keywords (지역 검색어) ──────────────────────────────────────────
		// region-search-queries.csv 포맷: 헤더행(query) + 지역명 한 행에 하나
		List kl = readCsv("region-search-queries.csv")
		for (int i = 1; i < kl.size(); i++) {
			String line = kl.get(i)
			if (line == null || line.trim().isEmpty()) continue
			String kw = line.trim().split(",")[0].trim()
			if (!kw.isEmpty()) KEYWORDS.add(kw)
		}

		if (TOKENS.isEmpty())    throw new RuntimeException("tokens empty")
		if (LOCATIONS.isEmpty()) throw new RuntimeException("locations empty")
		if (KEYWORDS.isEmpty())  throw new RuntimeException("keywords empty")
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
		tSearch.record(this, "searchRegion")
		tScroll.record(this, "scrollStores")
		tStore.record(this, "storeDetail")
		grinder.statistics.delayReports = true
	}

	// ── 결정적(재현 가능) 인덱스 ─────────────────────────────────────────────
	// threadNumber·runNumber·salt 로 해시 → 같은 vuser·반복이면 항상 같은 값
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
	private long   homeTrendStoreId = -1L
	private String lastKeyword      = ""
	private double lastLat          = 0.0
	private double lastLng          = 0.0
	private List   searchStoreIds   = new ArrayList()

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

	// ── 응답에서 storeId 목록 추출 (/stores/district 응답 구조) ────────────────
	private List extractStoreIds(HTTPResponse r) {
		List ids = new ArrayList()
		try {
			def parsed = new JsonSlurper().parseText(r.getText())
			def stores = parsed?.data?.stores
			if (stores == null) stores = parsed?.data?.content
			if (stores != null) {
				for (s in stores) {
					if (s?.id != null) ids.add(s.id as long)
				}
			}
		} catch (Exception e) {
			grinder.logger.warn("extractStoreIds fail: " + e.message)
		}
		return ids
	}

	// ── district 검색 공통 호출 ───────────────────────────────────────────────
	private List districtSearch(String keyword, double lat, double lng, int page) {
		NVPair[] params = new NVPair[6]
		params[0] = new NVPair("keyword", keyword)
		params[1] = new NVPair("lat",     String.valueOf(lat))
		params[2] = new NVPair("lng",     String.valueOf(lng))  // ※ lng (lon 아님)
		params[3] = new NVPair("page",    String.valueOf(page))
		params[4] = new NVPair("size",    "15")
		params[5] = new NVPair("sort",    "popularity")
		HTTPResponse r = request.GET(BASE + "/stores/district", params, authHeaders())
		assertThat(r.statusCode, is(200))
		return extractStoreIds(r)
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 01 home: 현위치 좌표 → mock coord2regioncode → /trend/select
	// ──────────────────────────────────────────────────────────────────────────
	public void home() {
		int idx   = seededIndex(1, LOCATIONS.size())
		List loc  = (List) LOCATIONS.get(idx)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)
		String region = geoRegion(lat, lon)
		if (region == null) return

		NVPair[] params = new NVPair[1]
		params[0] = new NVPair("region", region)
		HTTPResponse r  = request.GET(BASE + "/trend/select", params, authHeaders())
		assertThat(r.statusCode, is(200))

		try {
			def cats = new JsonSlurper().parseText(r.getText())?.data?.categories
			if (cats != null) {
				for (c in cats) {
					if (c?.stores) { homeTrendStoreId = c.stores[0].storeId as long; break }
				}
			}
		} catch (Exception e) {
			grinder.logger.warn("home parse fail " + e.message)
		}
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 02 searchRegion: 여행 도시 키워드 → /stores/district page=1
	// ──────────────────────────────────────────────────────────────────────────
	public void searchRegion() {
		searchStoreIds.clear()

		int ki     = seededIndex(2, KEYWORDS.size())
		lastKeyword = (String) KEYWORDS.get(ki)

		int li     = seededIndex(3, LOCATIONS.size())
		List loc   = (List) LOCATIONS.get(li)
		lastLat    = (double) loc.get(0)
		lastLng    = (double) loc.get(1)

		searchStoreIds = districtSearch(lastKeyword, lastLat, lastLng, 1)
		grinder.logger.info("search keyword=" + lastKeyword + " hits=" + searchStoreIds.size())
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 03 scrollStores: 동일 keyword page=2 (사용자 스크롤)
	// ──────────────────────────────────────────────────────────────────────────
	public void scrollStores() {
		if (lastKeyword.isEmpty()) return
		List page2 = districtSearch(lastKeyword, lastLat, lastLng, 2)
		for (Object id : page2) {
			if (!searchStoreIds.contains(id)) searchStoreIds.add(id)
		}
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 04 storeDetail: 검색 결과 앞 최대 2개 가게 상세 진입
	// ──────────────────────────────────────────────────────────────────────────
	public void storeDetail() {
		int count = Math.min(2, searchStoreIds.size())
		for (int i = 0; i < count; i++) {
			long sid    = (long) searchStoreIds.get(i)
			NVPair[] p  = new NVPair[0]
			HTTPResponse r = request.GET(BASE + "/stores/" + sid, p, authHeaders())
			assertThat(r.statusCode, is(200))
			if (i < count - 1) grinder.sleep(600)
		}
	}

	@Test
	public void test() {
		home()
		grinder.sleep(800)
		searchRegion()
		grinder.sleep(1200)
		scrollStores()
		grinder.sleep(800)
		storeDetail()
		grinder.sleep(500)
	}
}
