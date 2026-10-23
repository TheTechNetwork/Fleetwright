package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * [XoWatchdog] against what the machine does: the bytes it signs this job's
 * key over (`signingInput('xowatchdog-key', …)` in src/fleet/crypto.js), and
 * the root password sealed under this job's own binding (xowatchdogAad in
 * src/fleet/seal.js), which an install's never opens.
 */
class XoWatchdogTest {
    private val key = "B" + "a".repeat(86)
    private val pin = "ab".repeat(32)

    @Test
    fun theKeyIsSignedUnderThisJobsOwnContextOverTheHostKey() {
        assertEquals(
            "agent-fleet/v1/xowatchdog-key\n{\"address\":\"xcp1.lan\",\"job\":\"0123456789ab\",\"key\":\"$key\",\"pin\":\"$pin\"}",
            String(XoWatchdog.signingInput("xcp1.lan", "0123456789ab", key, pin), Charsets.UTF_8),
        )
        assertFalse(XoWatchdog.signingInput("xcp1.lan", "0123456789ab", key, pin).contentEquals(XoDeploy.signingInput("xcp1.lan", "0123456789ab", key, pin)))
    }

    @Test
    fun theRootPasswordOpensUnderThisJobsBindingWithXenOrchestrasAddressAndNoReply() {
        val jobKey = Seal.newKey()
        val sealed = XoWatchdog.sealRoot(jobKey.publicKey, "0123456789ab", "xcp1.lan", "hunter2", "xo.lan:8443").split(".")
        val box = JSONObject().put("epk", sealed[0]).put("iv", sealed[1]).put("ct", sealed[2])
        val opened = Seal.open(jobKey, "fleetwright-xowatchdog/v1:0123456789ab:xcp1.lan", box)
        assertEquals(1, opened.getInt("v"))
        assertEquals("watchdog", opened.getString("purpose"))
        assertEquals("hunter2", opened.getJSONObject("root").getString("password"))
        assertEquals("xo.lan:8443", opened.getJSONObject("xo").getString("address"))
        assertFalse(opened.has("reply"))
        // Never as an install's.
        assertThrows(Exception::class.java) { Seal.open(jobKey, XoDeploy.aad("0123456789ab", "xcp1.lan"), box) }
    }

    @Test
    fun aMachineThatDidNotLookIsSaidAsTooOldForThisJob() {
        val probe = Fleet.Probe("deb14", reachable = true, xo = false, tls = true, cert = null, version = null, ssh = null)
        assertEquals("Too old to add the watchdog. Update it, then ask again.", XoWatchdog.describe(probe))
        assertEquals(
            "Too old to add the watchdog, so they did not look: deb14. Update one, then ask again.",
            XoDeploy.nobody(listOf(probe), "xcp1.lan", doing = "add the watchdog"),
        )
    }
}
