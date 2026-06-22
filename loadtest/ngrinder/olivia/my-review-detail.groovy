// nGrinder 부하 스크립트 — [설정] MY 탭 → 내 리뷰 상세
//   홈화면 → MY 탭 진입 → 내가 쓴 리뷰 목록 → 리뷰 상세
//
// 구조 메모:
//   - home()        : 좌표 → mock(coord2regioncode) → 구_동 → BE /trend/select (현위치 홈 피드)
//   - myTab()       : GET /users/me (MY 탭 진입)
//   - myReviews()   : GET /users/me/reviews → reviewId 수집
//   - reviewDetail(): GET /reviews/{reviewId} (앞 최대 2개)
//
// 리소스(같은 폴더 업로드): tokens.csv, locations.csv

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
	public static GTest tMyTab
	public static GTest tMyReviews
	public static GTest tReviewDetail
	public static HTTPRequest request
	public static HTTPRequest mockRequest

	public static List TOKENS    = new ArrayList()
	public static List LOCATIONS = new ArrayList()

	@BeforeProcess
	public static void beforeProcess() {
		HTTPPluginControl.getConnectionDefaults().timeout = 8000
		tHome         = new GTest(1, "01 home")
		tMyTab        = new GTest(2, "02 my-tab")
		tMyReviews    = new GTest(3, "03 my-reviews")
		tReviewDetail = new GTest(4, "04 review-detail")
		request     = new HTTPRequest()
		mockRequest = new HTTPRequest()
		loadData()
		grinder.logger.info("loaded tokens=" + TOKENS.size() + " loc=" + LOCATIONS.size())
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
		if (TOKENS.isEmpty())    throw new RuntimeException("tokens empty")
		if (LOCATIONS.isEmpty()) throw new RuntimeException("locations empty")
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
		tMyTab.record(this, "myTab")
		tMyReviews.record(this, "myReviews")
		tReviewDetail.record(this, "reviewDetail")
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
	private List reviewIds = new ArrayList()

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
	// 02 myTab: GET /users/me (MY 탭 진입)
	// ──────────────────────────────────────────────────────────────────────────
	public void myTab() {
		NVPair[] params = new NVPair[0]
		HTTPResponse r  = request.GET(BASE + "/users/me", params, authHeaders())
		assertThat(r.statusCode, is(200))
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 03 myReviews: GET /users/me/reviews → reviewId 수집
	// ──────────────────────────────────────────────────────────────────────────
	public void myReviews() {
		reviewIds.clear()
		NVPair[] params = new NVPair[2]
		params[0] = new NVPair("page", "0")
		params[1] = new NVPair("size", "20")
		HTTPResponse r  = request.GET(BASE + "/users/me/reviews", params, authHeaders())
		assertThat(r.statusCode, is(200))
		try {
			def parsed  = new JsonSlurper().parseText(r.getText())
			def content = parsed?.data?.content
			if (content == null) content = parsed?.data?.reviews
			if (content != null) {
				for (rv in content) {
					if (rv?.reviewId != null) reviewIds.add(rv.reviewId as long)
				}
			}
		} catch (Exception e) {
			grinder.logger.warn("myReviews parse fail " + e.message)
		}
		grinder.logger.info("my reviews=" + reviewIds.size())
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 04 reviewDetail: 리뷰 목록 앞 최대 2개 상세 진입
	// ──────────────────────────────────────────────────────────────────────────
	public void reviewDetail() {
		int count = Math.min(2, reviewIds.size())
		for (int i = 0; i < count; i++) {
			long rid   = (long) reviewIds.get(i)
			NVPair[] p = new NVPair[0]
			HTTPResponse r = request.GET(BASE + "/reviews/" + rid, p, authHeaders())
			assertThat(r.statusCode, is(200))
			if (i < count - 1) grinder.sleep(600)
		}
	}

	@Test
	public void test() {
		home()
		grinder.sleep(800)
		myTab()
		grinder.sleep(600)
		myReviews()
		grinder.sleep(1000)
		reviewDetail()
		grinder.sleep(500)
	}
}
