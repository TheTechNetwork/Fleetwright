package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reconnecting a pool's servers, run rather than read: the sign-in as the
 * machine opens it (`run` in src/fleet/host/xo-setup.js), the outcome as it
 * seals it back, what each server is said to have come to, when the pool's
 * page offers it, and where a tapped notification goes.
 *
 * WHY A JUNIT TEST. Whether a state Xen Orchestra sent that this app does not
 * know comes out as "not known" or as connected, whether "2 of 3" counts the
 * servers that are connected after rather than the ones touched, and whether
 * the page row appears for a pool still listing every name, are questions
 * about a parse and a predicate; the words a person meets are pinned here
 * because the function that builds them is the thing under test.
 */
class XoReconnectTest {
    private val job = "0123456789ab"
    private val address = "xo.lan"

    private fun server(label: String, action: String?, before: String? = "disconnected", after: String? = "connected", error: String? = null, enabled: Any? = true): JSONObject =
        JSONObject().put("label", label).put("host", "$label.lan").put("before", before).put("enabled", enabled)
            .put("after", after).put("action", action).put("error", error)

    private fun outcome(vararg servers: JSONObject, pools: JSONArray = JSONArray().put(JSONObject().put("id", "p1").put("name", "Lab"))): JSONObject =
        JSONObject().put("v", 1).put("servers", JSONArray(servers.toList())).put("pools", pools)

    @Test
    fun theSignInIsThePolicySignInsShapeWithThisPurposeInsideTheSeal() {
        val jobKey = Seal.newKey()
        val reply = Seal.newKey()
        fun open(sealed: String): JSONObject {
            val parts = sealed.split(".")
            return Seal.open(jobKey, XoSetup.aad(job, address), JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2]))
        }
        val inside = open(XoReconnect.sealSignIn(jobKey.publicKey, job, address, "admin@xo.lan", "pw", reply.publicKey))
        // The machine reads `purpose` and `reply` from inside, under setup's
        // binding, exactly as it does a policy sign-in: the same keys, nothing more.
        val policy = open(XoPolicy.sealSignIn(jobKey.publicKey, job, address, "admin@xo.lan", "pw", reply.publicKey))
        assertEquals(policy.keys().asSequence().toSet(), inside.keys().asSequence().toSet())
        assertEquals("reconnect", inside.getString("purpose"))
        assertEquals(1, inside.getInt("v"))
        assertEquals(reply.publicKey, inside.getString("reply"))
        assertEquals("admin@xo.lan", inside.getJSONObject("xo").getString("email"))
        assertEquals("pw", inside.getJSONObject("xo").getString("password"))
    }

    @Test
    fun theOutcomeOpensOnlyUnderItsOwnJobAndAddressWithThisKey() {
        // The same string as xosetupReconnectAad in src/fleet/seal.js.
        assertEquals("fleetwright-xosetup-reconnect/v1:J:A", Seal.xosetupReconnectAad("J", "A"))
        val key = Seal.newKey()
        fun sealed(aad: String, to: String = key.publicKey): String {
            val box = Seal.seal(to, aad, outcome(server("xcp1", "enabled")))
            return "${box.getString("epk")}.${box.getString("iv")}.${box.getString("ct")}"
        }
        val opened = XoReconnect.openResult(sealed(Seal.xosetupReconnectAad(job, address)), job, address, key)
        assertNotNull(opened)
        assertEquals(listOf("xcp1"), opened!!.servers.map { it.label })
        // Another job, another pool, another binding, another phone's key: nothing.
        assertNull(XoReconnect.openResult(sealed(Seal.xosetupReconnectAad("ba9876543210", address)), job, address, key))
        assertNull(XoReconnect.openResult(sealed(Seal.xosetupReconnectAad(job, "other.lan")), job, address, key))
        assertNull(XoReconnect.openResult(sealed(XoPolicy.inventoryAad(job, address)), job, address, key))
        assertNull(XoReconnect.openResult(sealed(Seal.xosetupReconnectAad(job, address), Seal.newKey().publicKey), job, address, key))
        assertNull(XoReconnect.openResult("not.sealed", job, address, key))
    }

    @Test
    fun whatThisAppDoesNotKnowIsKeptAsNotKnown() {
        val r = XoReconnect.parse(
            outcome(
                server("odd", "rebooted", before = "booting", after = "sideways", enabled = JSONObject.NULL),
                JSONObject().put("host", "10.0.0.9").put("action", "left").put("after", "connected"),
                pools = JSONArray().put(JSONObject().put("name", "no id")).put(JSONObject().put("id", "p2")),
            ),
        )!!
        val odd = r.servers[0]
        assertNull(odd.action)
        assertNull(odd.before)
        assertNull(odd.after)
        assertNull(odd.enabled)
        assertEquals("The machine said something about it this app does not know.", XoReconnect.serverLine(odd))
        // A server with no label is named by its host, never dropped.
        assertEquals("10.0.0.9", r.servers[1].label)
        // A pool without an id is dropped; one without a name is named by its id.
        assertEquals(listOf(XoReconnect.Pool("p2", "p2")), r.pools)
        // Not an outcome at all: nothing, not an empty one.
        assertNull(XoReconnect.parse(JSONObject().put("v", 2).put("servers", JSONArray())))
        assertNull(XoReconnect.parse(JSONObject().put("v", 1)))
    }

    @Test
    fun eachServerIsSaidAsWhatHappenedToIt() {
        val cases = listOf(
            server("a", "left", before = "connected") to "Already connected, so it was left as it was.",
            server("b", "enabled") to "Connected again.",
            server("c", "enabled", after = "connecting") to "Turned back on. Xen Orchestra says it is still connecting.",
            server("d", "cycled", before = "connecting") to "Disconnected and connected again.",
            server("e", "cycled", after = "disconnected") to "Disconnected and turned back on. Xen Orchestra says it is disconnected.",
            server("f", "cycled", after = null) to "Disconnected and turned back on. Xen Orchestra says it is in a state this app does not know.",
            server("g", "skipped-disabled", after = "disconnected", enabled = false) to
                "Turned off in Xen Orchestra, so it was left off. Only a person turns a server back on.",
            server("h", "failed", after = "disconnected", error = "PoolAlreadyConnected") to "Not reconnected: PoolAlreadyConnected",
            server("i", "failed", after = "disconnected") to "Not reconnected. Xen Orchestra gave no reason.",
        )
        val r = XoReconnect.parse(outcome(*cases.map { it.first }.toTypedArray()))!!
        r.servers.zip(cases).forEach { (s, case) -> assertEquals(s.label, case.second, XoReconnect.serverLine(s)) }
        // Only a failure is set in the bad tone, and its words say it too.
        assertEquals(listOf("h", "i"), r.servers.filter { XoReconnect.failed(it) }.map { it.label })
    }

    @Test
    fun theCountIsOfServersConnectedAfterNotOfServersTouched() {
        val mixed = XoReconnect.parse(outcome(server("a", "left", before = "connected"), server("b", "enabled"), server("c", "failed", after = "disconnected", error = "x")))!!
        assertEquals("2 of 3 servers are connected now.", XoReconnect.summary(mixed))
        val one = XoReconnect.parse(outcome(server("a", "failed", after = "disconnected")))!!
        assertEquals("0 of 1 server is connected now.", XoReconnect.summary(one))
        val untouched = XoReconnect.parse(outcome(server("a", "left", before = "connected"), server("b", "left", before = "connected")))!!
        assertEquals("Every server was already connected, so nothing was changed.", XoReconnect.summary(untouched))
        val none = XoReconnect.parse(outcome())!!
        assertEquals("Xen Orchestra lists no servers, so there was nothing to reconnect.", XoReconnect.summary(none))
    }

    @Test
    fun thePoolsAreWhatTheAdminSignInSeesAndAKeptNameStillMissingIsNamed() {
        val back = XoReconnect.parse(outcome(server("a", "enabled")))!!
        assertEquals("Xen Orchestra shows this pool now:", XoReconnect.poolsLine(back))
        assertNull(XoReconnect.stillMissing(listOf("Lab"), back))
        assertNull("no names kept is nothing to compare, not something missing", XoReconnect.stillMissing(null, back))
        assertEquals("Still not shown: Prod.", XoReconnect.stillMissing(listOf("Lab", "Prod"), back))
        val gone = XoReconnect.parse(outcome(server("a", "failed"), pools = JSONArray()))!!
        assertEquals("Xen Orchestra still shows no pools, even to the admin sign-in.", XoReconnect.poolsLine(gone))
        // No pools said at all is cannot tell, never none, and nothing is called missing.
        val unsaid = XoReconnect.parse(JSONObject().put("v", 1).put("servers", JSONArray().put(server("a", "enabled"))))!!
        assertNull(unsaid.pools)
        assertEquals("Cannot tell which pools Xen Orchestra shows now: the machine did not say.", XoReconnect.poolsLine(unsaid))
        assertNull(XoReconnect.stillMissing(listOf("Lab"), unsaid))
    }

    @Test
    fun thePoolsPageOffersItOnlyWhenWhatItReadShowsAPoolGone() {
        // An admin, a page that has read the pool, and nothing to show for it.
        assertTrue(XoReconnect.offered(true, loaded = true, seen = emptyList(), held = null))
        assertTrue(XoReconnect.offered(true, loaded = true, seen = listOf("Lab"), held = listOf("Lab", "Prod")))
        // Every kept name shown, or none kept and something shown: nothing to reconnect.
        assertFalse(XoReconnect.offered(true, loaded = true, seen = listOf("Lab"), held = listOf("Lab")))
        assertFalse(XoReconnect.offered(true, loaded = true, seen = listOf("Lab"), held = null))
        // A page that has not read the pool has said nothing either way.
        assertFalse(XoReconnect.offered(true, loaded = false, seen = emptyList(), held = listOf("Lab")))
        // A member, or cannot tell: never.
        assertFalse(XoReconnect.offered(false, loaded = true, seen = emptyList(), held = null))
        assertFalse(XoReconnect.offered(null, loaded = true, seen = emptyList(), held = null))
    }

    @Test
    fun aTapReconnectsOnlyFromALostPoolsButton() {
        assertEquals(PoolTap("xo.lan", "deb132", reconnect = true), PoolNotice.tap("pool-lost", "xo.lan", "deb132", "reconnect"))
        // The body, or a pool that is back, opens the pool's page.
        assertEquals(PoolTap("xo.lan", "deb132", reconnect = false), PoolNotice.tap("pool-lost", "xo.lan", "deb132", null))
        assertEquals(PoolTap("xo.lan", null, reconnect = false), PoolNotice.tap("pool-back", "xo.lan", "", "reconnect"))
        // Not one of these, or no address it could connect to: nothing.
        assertNull(PoolNotice.tap("holder-join", "xo.lan", "deb132", null))
        assertNull(PoolNotice.tap("pool-lost", "https://xo.lan/", "deb132", "reconnect"))
        assertNull(PoolNotice.tap("pool-lost", null, "deb132", "reconnect"))
    }

    @Test
    fun theOngoingNotificationSaysTheCoordinatorsWords() {
        assertEquals("Reconnecting Xen Orchestra’s servers", XoReconnect.title("running"))
        assertEquals("Reconnecting Xen Orchestra’s servers", XoReconnect.title("waiting"))
        assertEquals("Pools back", XoReconnect.title("done"))
        assertEquals("The pools did not come back", XoReconnect.title("failed"))
        assertEquals("Reconnecting cancelled", XoReconnect.title("cancelled"))
        assertEquals("Reading Xen Orchestra’s servers", XoReconnect.stepWords("servers", 2, 5))
        assertEquals("Step 5 of 5", XoReconnect.stepWords("later", 7, 5))
    }
}
