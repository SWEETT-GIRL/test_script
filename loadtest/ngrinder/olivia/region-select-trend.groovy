// nGrinder 부하 스크립트 — [랭킹] 여행갈 지역 빵 탐색
//   홈화면 -> 여행갈 지역(시군구) 선택 -> 그 안 여러 동 트렌드 탐색 -> 가게 상세
//   원본 k6: scenarios/olivia/region-select-trend.js (pickRegionCluster)
//
// 구조 메모:
//   - home(): 좌표 -> mock(coord2regioncode) -> 구_동 -> BE /trend/select (현위치 홈 피드)
//   - clusterSelect(): regions.csv 를 시군구별로 묶어 1개 선택 -> 그 안 동 2~3개 각각 /trend/select
//   - storeDetail(): 탐색 결과 storeId -> /stores/{id}
//   - 부하 프로파일(vuser/duration/ramp)은 nGrinder Performance Test UI 에서 설정
//
// 리소스(같은 폴더 업로드): tokens.csv, locations.csv, regions.csv
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
	public static GTest tCluster
	public static GTest tStore
	public static HTTPRequest request
	public static HTTPRequest mockRequest

	public static List TOKENS = new ArrayList()
	public static List LOCATIONS = new ArrayList()
	public static List SIGUNGU = new ArrayList()
	public static Map CLUSTERS = new HashMap()

	@BeforeProcess
	public static void beforeProcess() {
		HTTPPluginControl.getConnectionDefaults().timeout = 8000
		tHome = new GTest(1, "01 home")
		tCluster = new GTest(2, "02 cluster")
		tStore = new GTest(3, "03 store")
		request = new HTTPRequest()
		mockRequest = new HTTPRequest()
		loadData()
		grinder.logger.info("loaded t=" + TOKENS.size() + " gu=" + SIGUNGU.size())
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
			int u = s.indexOf('_')
			if (u <= 0) continue
			String dong = s.substring(u + 1)
			if (dong == "전체") continue
			String gu = s.substring(0, u)
			List lst = (List) CLUSTERS.get(gu)
			if (lst == null) {
				lst = new ArrayList()
				CLUSTERS.put(gu, lst)
				SIGUNGU.add(gu)
			}
			lst.add(s)
		}
		if (TOKENS.isEmpty()) throw new RuntimeException("tokens empty")
		if (LOCATIONS.isEmpty()) throw new RuntimeException("loc empty")
		if (SIGUNGU.isEmpty()) throw new RuntimeException("region empty")
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
		tCluster.record(this, "clusterSelect")
		tStore.record(this, "storeDetail")
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

	private void trendSelect(String region) {
		NVPair[] params = new NVPair[1]
		params[0] = new NVPair("region", region)
		String url = BASE + "/trend/select"
		HTTPResponse r = request.GET(url, params, authHeaders())
		assertThat(r.statusCode, is(200))
		if (storeId < 0) {
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
	}

	public void home() {
		int idx = seededIndex(1, LOCATIONS.size())
		List loc = (List) LOCATIONS.get(idx)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)
		String region = geoRegion(lat, lon)
		if (region != null) trendSelect(region)
	}

	public void clusterSelect() {
		storeId = -1L
		int gi = seededIndex(2, SIGUNGU.size())
		String gu = (String) SIGUNGU.get(gi)
		List dongs = (List) CLUSTERS.get(gu)
		int count = 2 + seededIndex(3, 2)
		if (count > dongs.size()) count = dongs.size()
		int start = seededIndex(4, dongs.size())
		for (int k = 0; k < count; k++) {
			String region = (String) dongs.get((start + k) % dongs.size())
			trendSelect(region)
		}
	}

	public void storeDetail() {
		if (storeId < 0) return
		String url = BASE + "/stores/" + storeId
		NVPair[] params = new NVPair[0]
		HTTPResponse r = request.GET(url, params, authHeaders())
		assertThat(r.statusCode, is(200))
	}

	@Test
	public void test() {
		home()
		grinder.sleep(800)
		clusterSelect()
		grinder.sleep(1000)
		storeDetail()
		grinder.sleep(500)
	}
}
