// nGrinder 부하 스크립트 — [랭킹] 내 주변 유명한 빵집 보기
//   홈(현위치 트렌드) -> 지역선택(다른 지역) -> 가게 1개 상세 -> "현재위치로" 재조회
//   원본 k6: scenarios/olivia/current-location-trend.js
//
// 구조 메모:
//   - 현위치(home/back): 좌표 -> mock(coord2regioncode) -> 구_동 -> BE /trend/select
//   - 지역선택(regionSelect): regions.csv 의 다른 지역 -> BE /trend/select (storeId 체이닝)
//   - 부하 프로파일(vuser/duration/ramp)은 스크립트에 없음 -> nGrinder Performance Test UI 에서 설정
//
// 리소스(스크립트와 같은 폴더에 업로드): tokens.csv, locations.csv, regions.csv
// BASE = 부하 대상 BE / MOCK = 외부 API 대체 mock 서버
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
	public static GTest tRegionSelect
	public static GTest tStoreDetail
	public static GTest tBack
	public static HTTPRequest request
	public static HTTPRequest mockRequest

	public static List TOKENS = new ArrayList()
	public static List LOCATIONS = new ArrayList()
	public static List REGIONS = new ArrayList()

	@BeforeProcess
	public static void beforeProcess() {
		HTTPPluginControl.getConnectionDefaults().timeout = 8000
		tHome = new GTest(1, "01 home")
		tRegionSelect = new GTest(2, "02 select")
		tStoreDetail = new GTest(3, "03 store")
		tBack = new GTest(4, "04 back")
		request = new HTTPRequest()
		mockRequest = new HTTPRequest()
		loadData()
		grinder.logger.info("loaded t=" + TOKENS.size())
	}

	private static void loadData() {
		List tl = readCsv("tokens.csv")
		for (int i = 1; i < tl.size(); i++) {
			String line = tl.get(i)
			if (line == null) continue
			if (line.trim().isEmpty()) continue
			String[] c = line.split(",")
			if (c.length >= 2) TOKENS.add(c[1].trim())
		}
		List ll = readCsv("locations.csv")
		for (int i = 1; i < ll.size(); i++) {
			String line = ll.get(i)
			if (line == null) continue
			if (line.trim().isEmpty()) continue
			String[] c = line.split(",")
			if (c.length < 3) continue
			List p = new ArrayList()
			p.add(Double.parseDouble(c[1].trim()))
			p.add(Double.parseDouble(c[2].trim()))
			LOCATIONS.add(p)
		}
		List rl = readCsv("regions.csv")
		for (int i = 1; i < rl.size(); i++) {
			String s = rl.get(i)
			if (s == null) continue
			s = s.trim()
			if (s.isEmpty()) continue
			if (s.endsWith("_전체")) continue
			REGIONS.add(s)
		}
		if (TOKENS.isEmpty()) throw new RuntimeException("tokens empty")
		if (LOCATIONS.isEmpty()) throw new RuntimeException("loc empty")
		if (REGIONS.isEmpty()) throw new RuntimeException("reg empty")
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
		tRegionSelect.record(this, "regionSelect")
		tStoreDetail.record(this, "storeDetail")
		tBack.record(this, "back")
		grinder.statistics.delayReports = true
	}

	private int seededIndex(int salt, int len) {
		long tn = (long) grinder.threadNumber
		long it = (long) grinder.runNumber
		long seed = tn * 2654435761L
		seed = seed + (it + 1L) * 40503L
		seed = seed + (long) salt * 97L
		long m = seed & 0xffffffffL
		long h = m ^ (m >> 13)
		return (int) ((h & 0xffffffffL) % (long) len)
	}

	private NVPair[] authHeaders() {
		int idx = grinder.threadNumber % TOKENS.size()
		String token = (String) TOKENS.get(idx)
		NVPair[] h = new NVPair[2]
		h[0] = new NVPair("Authorization", "Bearer " + token)
		h[1] = new NVPair("Content-Type", "application/json")
		return h
	}

	private String geoRegion(double lat, double lon) {
		String url = MOCK + "/v2/local/geo/coord2regioncode.json"
		url = url + "?x=" + lon + "&y=" + lat
		NVPair[] none = new NVPair[0]
		HTTPResponse r = mockRequest.GET(url, none, none)
		String result = null
		try {
			String body = new String(r.getData(), "UTF-8")
			def parsed = new JsonSlurper().parseText(body)
			def docs = parsed.get("documents")
			if (docs != null && docs.size() > 0) {
				def d = docs.get(0)
				String gu = (String) d.get("region_2depth_name")
				String dong = (String) d.get("region_3depth_name")
				result = gu + "_" + dong
			}
		} catch (Exception e) {
			grinder.logger.warn("geo fail " + e.message)
		}
		return result
	}

	private long storeId = -1L

	private void selectByRegion(String region) {
		if (region == null) return
		NVPair[] params = new NVPair[1]
		params[0] = new NVPair("region", region)
		String url = BASE + "/trend/select"
		HTTPResponse r = request.GET(url, params, authHeaders())
		assertThat(r.statusCode, is(200))
	}

	public void home() {
		int idx = seededIndex(1, LOCATIONS.size())
		List loc = (List) LOCATIONS.get(idx)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)
		String region = geoRegion(lat, lon)
		selectByRegion(region)
	}

	public void regionSelect() {
		int idx = seededIndex(2, REGIONS.size())
		String region = (String) REGIONS.get(idx)
		NVPair[] params = new NVPair[1]
		params[0] = new NVPair("region", region)
		String url = BASE + "/trend/select"
		HTTPResponse r = request.GET(url, params, authHeaders())
		assertThat(r.statusCode, is(200))
		storeId = -1L
		try {
			def parsed = new JsonSlurper().parseText(r.getText())
			def cats = parsed?.data?.categories
			if (cats != null) {
				for (c in cats) {
					if (c?.stores) {
						storeId = (c.stores[0].storeId as long)
						break
					}
				}
			}
		} catch (Exception e) {
			grinder.logger.warn("select fail " + e.message)
		}
	}

	public void storeDetail() {
		if (storeId < 0) return
		String url = BASE + "/stores/" + storeId
		NVPair[] params = new NVPair[0]
		HTTPResponse r = request.GET(url, params, authHeaders())
		assertThat(r.statusCode, is(200))
	}

	public void back() {
		int idx = seededIndex(1, LOCATIONS.size())
		List loc = (List) LOCATIONS.get(idx)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)
		String region = geoRegion(lat, lon)
		selectByRegion(region)
	}

	@Test
	public void test() {
		home()
		grinder.sleep(800)
		regionSelect()
		grinder.sleep(800)
		storeDetail()
		grinder.sleep(1200)
		back()
		grinder.sleep(500)
	}
}
