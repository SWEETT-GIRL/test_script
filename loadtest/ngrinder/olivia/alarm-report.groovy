// nGrinder 부하 스크립트 — [알림] 제보 알림 확인
//   홈화면(벨 뱃지) → 알람 버튼 클릭 → 제보 알림 목록 → 읽음 처리
//
// 구조 메모:
//   - home()       : 좌표 → mock(coord2regioncode) → 구_동 → BE /trend/select
//                    + GET /alarm/history (홈 진입 시 벨 뱃지)
//   - alarmList()  : GET /alarm/report-notifications → notificationId 수집
//   - markRead()   : PATCH /alarm/report-notifications/{id}/read (첫 번째 알림 읽음 처리)
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
	public static GTest tAlarmList
	public static GTest tMarkRead
	public static HTTPRequest request
	public static HTTPRequest mockRequest

	public static List TOKENS    = new ArrayList()
	public static List LOCATIONS = new ArrayList()

	@BeforeProcess
	public static void beforeProcess() {
		HTTPPluginControl.getConnectionDefaults().timeout = 8000
		tHome      = new GTest(1, "01 home")
		tAlarmList = new GTest(2, "02 alarm-list")
		tMarkRead  = new GTest(3, "03 mark-read")
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
		tAlarmList.record(this, "alarmList")
		tMarkRead.record(this, "markRead")
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
	private long notificationId = -1L

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
	// 01 home: 현위치 → /trend/select + /alarm/history (벨 뱃지)
	// ──────────────────────────────────────────────────────────────────────────
	public void home() {
		int idx    = seededIndex(1, LOCATIONS.size())
		List loc   = (List) LOCATIONS.get(idx)
		double lat = (double) loc.get(0)
		double lon = (double) loc.get(1)
		String region = geoRegion(lat, lon)

		if (region != null) {
			NVPair[] params = new NVPair[1]
			params[0] = new NVPair("region", region)
			HTTPResponse r = request.GET(BASE + "/trend/select", params, authHeaders())
			assertThat(r.statusCode, is(200))
		}

		// 홈 진입 시 벨 뱃지용 알림 히스토리
		NVPair[] none  = new NVPair[0]
		HTTPResponse rh = request.GET(BASE + "/alarm/history", none, authHeaders())
		assertThat(rh.statusCode, is(200))
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 02 alarmList: 알람 버튼 클릭 → GET /alarm/report-notifications
	// ──────────────────────────────────────────────────────────────────────────
	public void alarmList() {
		notificationId = -1L
		NVPair[] none  = new NVPair[0]
		HTTPResponse r = request.GET(BASE + "/alarm/report-notifications", none, authHeaders())
		assertThat(r.statusCode, is(200))
		try {
			def parsed  = new JsonSlurper().parseText(r.getText())
			def content = parsed?.data?.content
			if (content == null) content = parsed?.data?.notifications
			if (content != null && content.size() > 0) {
				notificationId = content[0].id as long
			}
		} catch (Exception e) {
			grinder.logger.warn("alarmList parse fail " + e.message)
		}
		grinder.logger.info("alarm notificationId=" + notificationId)
	}

	// ──────────────────────────────────────────────────────────────────────────
	// 03 markRead: PATCH /alarm/report-notifications/{id}/read (읽음 처리)
	// ──────────────────────────────────────────────────────────────────────────
	public void markRead() {
		if (notificationId < 0) return
		String url    = BASE + "/alarm/report-notifications/" + notificationId + "/read"
		NVPair[] none = new NVPair[0]
		HTTPResponse r = request.PATCH(url, none, authHeaders(), new byte[0])
		assertThat(r.statusCode, is(200))
	}

	@Test
	public void test() {
		home()
		grinder.sleep(800)
		alarmList()
		grinder.sleep(800)
		markRead()
		grinder.sleep(500)
	}
}
