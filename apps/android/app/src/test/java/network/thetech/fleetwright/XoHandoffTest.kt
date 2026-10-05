package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * [XoHandoff.open] against a token record sealed the way the machine seals
 * it: to the key this phone sent inside the sign-in, under
 * `fleetwright-xosetup-handoff/v1:<job>:<address>` (xosetupHandoffAad in
 * src/fleet/seal.js). The seal itself is held to seal.js by SealTest; what is
 * pinned here is the binding, and what the phone refuses to keep.
 * XOSetupHandoffTests.swift is the same on iOS.
 */
class XoHandoffTest {
    private val job = "0123456789ab"
    private val address = "xo.lan"

    private fun record(address: String = this.address, token: String = "tok-limited-123"): JSONObject =
        JSONObject().put("v", 1).put("address", address).put("pin", JSONObject.NULL).put("plain", true)
            .put("user", "fleetwright").put("token", token)

    private fun sealed(record: JSONObject, to: Seal.OneUseKey, aad: String): String {
        val box = Seal.seal(to.publicKey, aad, record)
        return "${box.getString("epk")}.${box.getString("iv")}.${box.getString("ct")}"
    }

    @Test
    fun theBindingIsTheMachines() {
        assertEquals("fleetwright-xosetup-handoff/v1:J:A", XoHandoff.aad("J", "A"))
    }

    @Test
    fun theTokenOpensUnderItsOwnJobAndAddress() {
        val key = Seal.newKey()
        val kept = XoHandoff.open(sealed(record(), key, XoHandoff.aad(job, address)), job, address, key)
        assertNotNull(kept)
        val o = JSONObject(kept!!)
        assertEquals("tok-limited-123", o.getString("token"))
        assertEquals(address, o.getString("address"))
    }

    @Test
    fun aSealedSignInIsNotATokenAndAnotherJobIsNotThisOne() {
        val key = Seal.newKey()
        assertNull(XoHandoff.open(sealed(record(), key, XoSetup.aad(job, address)), job, address, key))
        assertNull(XoHandoff.open(sealed(record(), key, XoHandoff.aad("ba9876543210", address)), job, address, key))
    }

    @Test
    fun anotherPhonesKeyOpensNothing() {
        val handoff = sealed(record(), Seal.newKey(), XoHandoff.aad(job, address))
        assertNull(XoHandoff.open(handoff, job, address, Seal.newKey()))
    }

    @Test
    fun aRecordForAnotherPoolOrWithNoTokenIsNotKept() {
        val key = Seal.newKey()
        val aad = XoHandoff.aad(job, address)
        assertNull(XoHandoff.open(sealed(record(address = "other.lan"), key, aad), job, address, key))
        assertNull(XoHandoff.open(sealed(record(token = ""), key, aad), job, address, key))
        assertNull(XoHandoff.open("not.sealed", job, address, key))
    }
}
