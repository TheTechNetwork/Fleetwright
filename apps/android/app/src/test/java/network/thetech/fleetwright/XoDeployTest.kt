package network.thetech.fleetwright

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [XoDeploy] against what the machine does: the bytes it signs an install's
 * key over (`signingInput('xodeploy-key', …)` in src/fleet/crypto.js), the
 * binding both passwords are sealed under, and which machines the screen may
 * offer. DeployXOView.swift says the same on iOS.
 */
class XoDeployTest {
    private val key = "B" + "a".repeat(86)
    private val sshKey = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
    private val pin = "ab".repeat(32)

    private fun probe(ssh: Fleet.SshProbe?) = Fleet.Probe("deb14", reachable = true, xo = false, tls = true, cert = null, version = null, ssh = ssh)

    @Test
    fun theKeyIsSignedUnderTheInstallsOwnContextOverTheHostKey() {
        assertEquals(
            "agent-fleet/v1/xodeploy-key\n{\"address\":\"xcp1.lan\",\"job\":\"0123456789ab\",\"key\":\"$key\",\"pin\":\"$pin\"}",
            String(XoDeploy.signingInput("xcp1.lan", "0123456789ab", key, pin), Charsets.UTF_8),
        )
        assertEquals("fleetwright-xodeploy/v1:J:A", XoDeploy.aad("J", "A"))
    }

    @Test
    fun onlyAMachineThatReachedItWithAKeyAndCanInstallIsOffered() {
        val good = Fleet.SshProbe(true, listOf(Fleet.SshKey("ssh-ed25519", sshKey, pin)), deploy = true, missing = emptyList())
        assertTrue(XoDeploy.canInstall(probe(good)))
        assertFalse(XoDeploy.canInstall(probe(good.copy(deploy = false, missing = listOf("getopt")))))
        assertFalse(XoDeploy.canInstall(probe(good.copy(keys = emptyList()))))
        assertFalse(XoDeploy.canInstall(probe(null)))
        assertEquals("Reached its SSH server, and has no getopt to install with", XoDeploy.describe(probe(good.copy(deploy = false, missing = listOf("getopt")))))
        // Cannot tell is said as that, and a machine that did not look as too old.
        assertEquals("Cannot tell: it has no ssh-keyscan to look with", XoDeploy.describe(probe(good.copy(reachable = null))))
        assertEquals("Too old to install Xen Orchestra. Update it, then ask again.", XoDeploy.describe(probe(null)))
    }

    @Test
    fun nobodyIsSaidWithWhatToCheckAndNeverWhenAMachineGotThrough() {
        val missed = Fleet.SshProbe(false, emptyList(), deploy = true, missing = emptyList())
        val got = Fleet.SshProbe(true, listOf(Fleet.SshKey("ssh-ed25519", sshKey, pin)), deploy = true, missing = emptyList())
        assertNull(XoDeploy.nobody(listOf(probe(got), probe(missed)), "xcp1.lan"))
        val said = XoDeploy.nobody(listOf(probe(missed)), "xcp1.lan")!!
        assertTrue(said.startsWith("No machine reached SSH at xcp1.lan."))
        assertTrue(XoDeploy.nobody(listOf(probe(null)), "xcp1.lan")!!.startsWith("Too old to install Xen Orchestra"))
    }

    @Test
    fun theAdminPasswordIsAtLeastWhatTheMachineTakes() {
        assertFalse(XoDeploy.adminPasswordOk("a".repeat(11)))
        assertTrue(XoDeploy.adminPasswordOk("a".repeat(12)))
        assertFalse(XoDeploy.adminPasswordOk("a".repeat(257)))
    }
}
