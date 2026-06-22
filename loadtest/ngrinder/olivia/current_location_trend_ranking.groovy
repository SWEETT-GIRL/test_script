import static net.grinder.script.Grinder.grinder
import static org.hamcrest.Matchers.*
import static org.junit.Assert.*

import HTTPClient.NVPair
import groovy.json.JsonSlurper
import java.net.URLEncoder
import net.grinder.plugin.http.HTTPRequest
import net.grinder.plugin.http.HTTPResponse
import net.grinder.script.GTest
import net.grinder.scriptengine.groovy.junit.GrinderRunner
import net.grinder.scriptengine.groovy.junit.annotation.BeforeProcess
import net.grinder.scriptengine.groovy.junit.annotation.BeforeThread
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * [랭킹] 지금 빵 먹고싶은데 내 주변에 뭐가 유명한지 보고싶다!
 *
 * 사용자 흐름
 *   1. 홈 화면: 현재 위치 기반 랭킹 조회           -> GET /trend/nearby?lat&lng
 *   2. 지역선택: 다른 지역 좌표를 mock API로 역지오코딩
 *   3. 다른 지역 가게 1개 탐색                    -> GET /trend/select?region, GET /stores/{storeId}
 *   4. "현재 위치로" 버튼                         -> GET /trend/nearby?lat&lng
 *
 * 지역 문자열(예: 양천구_목동)은 CSV를 읽지 않고 MOCK_API_URL의
 * /v2/local/geo/coord2address, /v2/local/geo/coord2regioncode 응답으로 만든다.
 *
 * nGrinder 실행 시 바꿀 수 있는 값
 *   -DbaseUrl=http://<BE_HOST>:8080
 *   -DmockApiUrl=http://3.27.155.129:3000
 *   -DaccessToken=<JWT>
 *   -DtokensCsv=/path/to/tokens.csv
 */
@RunWith(GrinderRunner)
class TestRunner {
    public static final String BASE_URL = prop('baseUrl', 'BASE_URL', 'http://localhost:8080')
    public static final String MOCK_API_URL = prop('mockApiUrl', 'MOCK_API_URL', 'http://3.27.155.129:3000')
    public static final String ACCESS_TOKEN = prop('accessToken', 'ACCESS_TOKEN', '')
    public static final String TOKENS_CSV = prop('tokensCsv', 'TOKENS_CSV', './data/tokens.csv')

    public static GTest nearbyTest
    public static GTest selectTest
    public static GTest storeTest
    public static GTest coord2AddressTest
    public static GTest coord2RegionCodeTest

    public static HTTPRequest nearbyRequest
    public static HTTPRequest selectRequest
    public static HTTPRequest storeRequest
    public static HTTPRequest coord2AddressRequest
    public static HTTPRequest coord2RegionCodeRequest
    public static JsonSlurper jsonSlurper
    public static List<String> tokens = []

    public static final List<Map> CURRENT_LOCATIONS = [
        [name: 'mokdong', lat: 37.5260d, lng: 126.8750d],
        [name: 'yeouido', lat: 37.5219d, lng: 126.9245d],
        [name: 'gangnam', lat: 37.4979d, lng: 127.0276d],
    ]

    public static final List<Map> OTHER_REGION_LOCATIONS = [
        [name: 'seongsu', lat: 37.5446d, lng: 127.0557d],
        [name: 'hongdae', lat: 37.5563d, lng: 126.9220d],
        [name: 'jamsil', lat: 37.5133d, lng: 127.1000d],
        [name: 'jongno', lat: 37.5729d, lng: 126.9794d],
        [name: 'songdo', lat: 37.3894d, lng: 126.6390d],
    ]

    @BeforeProcess
    public static void beforeProcess() {
        nearbyTest = new GTest(1, 'GET /trend/nearby')
        selectTest = new GTest(2, 'GET /trend/select')
        storeTest = new GTest(3, 'GET /stores/{storeId}')
        coord2AddressTest = new GTest(4, 'GET /v2/local/geo/coord2address')
        coord2RegionCodeTest = new GTest(5, 'GET /v2/local/geo/coord2regioncode')

        nearbyRequest = new HTTPRequest()
        selectRequest = new HTTPRequest()
        storeRequest = new HTTPRequest()
        coord2AddressRequest = new HTTPRequest()
        coord2RegionCodeRequest = new HTTPRequest()
        jsonSlurper = new JsonSlurper()
        tokens = loadTokens()

        nearbyTest.record(nearbyRequest)
        selectTest.record(selectRequest)
        storeTest.record(storeRequest)
        coord2AddressTest.record(coord2AddressRequest)
        coord2RegionCodeTest.record(coord2RegionCodeRequest)

        grinder.logger.info("BASE_URL=${BASE_URL}, MOCK_API_URL=${MOCK_API_URL}, tokenCount=${tokens.size()}")
    }

    @BeforeThread
    public void beforeThread() {
        grinder.statistics.delayReports = true
    }

    @Before
    public void before() {
        NVPair[] beHeaders = headers()
        nearbyRequest.setHeaders(beHeaders)
        selectRequest.setHeaders(beHeaders)
        storeRequest.setHeaders(beHeaders)

        NVPair[] mockHeaders = [new NVPair('Content-Type', 'application/json')] as NVPair[]
        coord2AddressRequest.setHeaders(mockHeaders)
        coord2RegionCodeRequest.setHeaders(mockHeaders)
    }

    @Test
    public void scenario() {
        Map current = pick(CURRENT_LOCATIONS, 11)
        Map other = pick(OTHER_REGION_LOCATIONS, 29)

        HTTPResponse homeRes = getNearby([lat: current.lat, lng: current.lng])
        assertOkApi(homeRes, 'home nearby ranking')

        String selectedRegion = reverseGeocodeRegion(other.lat as double, other.lng as double)
        HTTPResponse selectedRes = getSelect([region: selectedRegion])
        assertOkApi(selectedRes, 'selected region ranking')

        Long storeId = firstStoreId(apiData(selectedRes))
        if (storeId != null) {
            HTTPResponse storeRes = getStore(storeId)
            assertOkApi(storeRes, 'selected region store detail')
        } else {
            grinder.logger.warn("No storeId in /trend/select response. region=${selectedRegion}")
        }

        HTTPResponse backToCurrentRes = getNearby([lat: current.lat, lng: current.lng])
        assertOkApi(backToCurrentRes, 'back to current location ranking')
    }

    private static HTTPResponse getNearby(Map params) {
        return nearbyRequest.GET("${BASE_URL}/trend/nearby${query(params)}")
    }

    private static HTTPResponse getSelect(Map params) {
        return selectRequest.GET("${BASE_URL}/trend/select${query(params)}")
    }

    private static HTTPResponse getStore(Long storeId) {
        return storeRequest.GET("${BASE_URL}/stores/${storeId}")
    }

    private static HTTPResponse getCoord2Address(Map params) {
        return coord2AddressRequest.GET("${MOCK_API_URL}/v2/local/geo/coord2address${query(params)}")
    }

    private static HTTPResponse getCoord2RegionCode(Map params) {
        return coord2RegionCodeRequest.GET("${MOCK_API_URL}/v2/local/geo/coord2regioncode${query(params)}")
    }

    private static String reverseGeocodeRegion(double lat, double lng) {
        HTTPResponse addressRes = getCoord2Address([x: lng, y: lat])
        assertThat('coord2address status', addressRes.statusCode, is(200))

        HTTPResponse regionCodeRes = getCoord2RegionCode([x: lng, y: lat])
        assertThat('coord2regioncode status', regionCodeRes.statusCode, is(200))

        Map addressBody = parseJson(addressRes)
        Map regionCodeBody = parseJson(regionCodeRes)

        Map address = firstDocument(addressBody)?.address as Map
        String gu = address?.region_2depth_name
        if (!gu && address?.address_name) {
            List<String> parts = "${address.address_name}".split(/\s+/) as List<String>
            gu = parts.size() >= 2 ? parts[1] : null
        }

        Map regionDoc = firstRegionDocument(regionCodeBody)
        String dong = regionDoc?.region_3depth_name ?: address?.region_3depth_name

        assertNotNull("reverse geocode gu is empty. lat=${lat}, lng=${lng}", gu)
        assertNotNull("reverse geocode dong is empty. lat=${lat}, lng=${lng}", dong)

        return "${gu}_${dong}"
    }

    private static Map firstDocument(Map body) {
        List docs = body?.documents as List
        return docs ? docs[0] as Map : null
    }

    private static Map firstRegionDocument(Map body) {
        List docs = body?.documents as List
        if (!docs) return null
        Map legal = docs.find { it instanceof Map && it.region_type == 'B' } as Map
        return legal ?: docs[0] as Map
    }

    private static Long firstStoreId(Object data) {
        if (!(data instanceof Map)) return null
        List categories = data.categories as List
        if (!categories) return null

        for (Object category : categories) {
            if (!(category instanceof Map)) continue
            List stores = category.stores as List
            if (!stores) continue
            for (Object store : stores) {
                if (!(store instanceof Map)) continue
                Object id = store.storeId
                if (id instanceof Number) return id.longValue()
                if (id != null && "${id}".isLong()) return "${id}".toLong()
            }
        }
        return null
    }

    private static void assertOkApi(HTTPResponse response, String label) {
        assertThat("${label} HTTP status", response.statusCode, is(200))
        Map body = parseJson(response)
        if (body.containsKey('success')) {
            assertThat("${label} ApiResponse.success", body.success, is(true))
        }
    }

    private static Object apiData(HTTPResponse response) {
        Map body = parseJson(response)
        return body.data
    }

    private static Map parseJson(HTTPResponse response) {
        Object parsed = jsonSlurper.parseText(response.text ?: '{}')
        assertThat('JSON body must be object', parsed, instanceOf(Map))
        return parsed as Map
    }

    private static NVPair[] headers() {
        String token = pickToken()
        List<NVPair> result = [new NVPair('Content-Type', 'application/json')]
        if (token) {
            result.add(new NVPair('Authorization', "Bearer ${token}"))
        }
        return result as NVPair[]
    }

    private static String pickToken() {
        if (ACCESS_TOKEN) return ACCESS_TOKEN
        if (!tokens) return ''
        int idx = Math.abs((grinder.threadNumber * 40503 + grinder.runNumber * 265443576) as int) % tokens.size()
        return tokens[idx]
    }

    private static Map pick(List<Map> rows, int salt) {
        int idx = Math.abs((grinder.threadNumber * 1103515245 + grinder.runNumber * 12345 + salt) as int) % rows.size()
        return rows[idx]
    }

    private static String query(Map params) {
        if (!params) return ''
        String qs = params.findAll { it.value != null }
            .collect { k, v -> "${enc(k as String)}=${enc(v as String)}" }
            .join('&')
        return qs ? "?${qs}" : ''
    }

    private static String enc(String value) {
        return URLEncoder.encode(value, 'UTF-8')
    }

    private static List<String> loadTokens() {
        if (ACCESS_TOKEN) return [ACCESS_TOKEN]

        File file = new File(TOKENS_CSV)
        if (!file.exists()) {
            grinder.logger.warn("tokens csv not found: ${TOKENS_CSV}. Authorization header will be omitted.")
            return []
        }

        return file.readLines('UTF-8')
            .drop(1)
            .collect { it.trim() }
            .findAll { it }
            .collect { line ->
                List<String> cols = line.split(',', 2) as List<String>
                cols.size() == 2 ? cols[1].trim() : ''
            }
            .findAll { it }
    }

    private static String prop(String propName, String envName, String defaultValue) {
        return System.getProperty(propName) ?: System.getenv(envName) ?: defaultValue
    }
}
