package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

/**
 * [ProxmoxThrough] against what the machine does (src/fleet/host/pve-setup.js):
 * the bytes it signs this job's key over (`signingInput('pvesetup-key', …)`),
 * the root password and reply key sealed under this job's own binding
 * (pvesetupAad), and the line coming back under its own (pvesetupHandoffAad),
 * which opens only with the key this screen holds.
 */
class ProxmoxThroughTest {
    private val key = "B" + "a".repeat(86)
    private val pin = "ab".repeat(32)
    private val job = "0123456789ab"

    @Test
    fun theKeyIsSignedUnderThisJobsOwnContextOverTheHostKey() {
        assertEquals(
            "agent-fleet/v1/pvesetup-key\n{\"address\":\"pve1.lan\",\"job\":\"$job\",\"key\":\"$key\",\"pin\":\"$pin\"}",
            String(ProxmoxThrough.signingInput("pve1.lan", job, key, pin), Charsets.UTF_8),
        )
        assertFalse(ProxmoxThrough.signingInput("pve1.lan", job, key, pin).contentEquals(XoWatchdog.signingInput("pve1.lan", job, key, pin)))
    }

    @Test
    fun theRootPasswordOpensUnderThisJobsBindingWithAKeyForTheLine() {
        val jobKey = Seal.newKey()
        val reply = Seal.newKey()
        val sealed = ProxmoxThrough.sealRoot(jobKey.publicKey, job, "pve1.lan", "hunter2", reply.publicKey).split(".")
        val box = JSONObject().put("epk", sealed[0]).put("iv", sealed[1]).put("ct", sealed[2])
        val opened = Seal.open(jobKey, "fleetwright-pvesetup/v1:$job:pve1.lan", box)
        assertEquals(1, opened.getInt("v"))
        assertEquals("pve", opened.getString("purpose"))
        assertEquals("hunter2", opened.getJSONObject("root").getString("password"))
        assertEquals(reply.publicKey, opened.getString("reply"))
        // Never as the watchdog's, which would do something else with it.
        assertThrows(Exception::class.java) { Seal.open(jobKey, XoWatchdog.aad(job, "pve1.lan"), box) }
    }

    @Test
    fun theLineOpensOnlyWithThisScreensKeyUnderTheHandOffsName() {
        val reply = Seal.newKey()
        val record = JSONObject()
            .put("kind", "proxmox")
            .put("address", "pve1.lan:8006")
            .put("token", "fleetwright@pve!fleet=0b8e6f0e-6a3e-4c55-9f4c-7c5d2b1a9e01")
            .put("pool", "fleetwright")
            .put("ca", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")
        val line = ProxmoxLine.PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(record.toString().toByteArray())
        val sealed = Seal.seal(reply.publicKey, "fleetwright-pvesetup-handoff/v1:$job:pve1.lan", JSONObject().put("v", 1).put("line", line))
        val handoff = "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
        val opened = ProxmoxThrough.openLine(handoff, job, "pve1.lan", reply)
        assertNotNull(opened)
        assertEquals("pve1.lan:8006", opened!!.address)
        // Another node's, or another key's, opens to nothing.
        assertNull(ProxmoxThrough.openLine(handoff, job, "pve2.lan", reply))
        assertNull(ProxmoxThrough.openLine(handoff, job, "pve1.lan", Seal.newKey()))
    }

    // HOW FAR INTO THE STEP, read as pve-setup.js's partOf reads it: only the
    // step it is on, a bar only for what was measured.
    @Test
    fun aPartIsReadForTheStepItWasSaidIn() {
        val mid = ProxmoxSsh.progressOf("fleetwright-step: image\nfleetwright-part: 432 downloading: 180 of 416 MB\nstate=active")
        assertEquals(ProxmoxSsh.Part(432, "downloading: 180 of 416 MB"), mid.part)
        assertEquals(ProxmoxSsh.Part(null, "VM 104 is building the image (3 min so far)"), ProxmoxSsh.partOf("fleetwright-part: - VM 104 is building the image (3 min so far)"))
        assertNull(ProxmoxSsh.progressOf("fleetwright-step: image\nfleetwright-part: 432 x\nfleetwright-step: line").part)
        assertNull(ProxmoxSsh.partOf("fleetwright-part: lots of it"))
    }
}
