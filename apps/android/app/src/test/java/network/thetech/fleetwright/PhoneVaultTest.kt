package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PhoneVault.approves: which of the vault's grants is the person's word that a
 * key is a machine's, so an admin's secret is sealed to it without the
 * comparison. PhoneVaultTests.swift is the same table on iOS.
 *
 * WHAT IS PINNED is that a grant scoped by `only`, the one this phone writes
 * when it lets a pool's own machine in to hold its pool's record, is not that
 * word, and that the key is held to the whole hash the minter names the grant
 * by, not to its sixteen-character prefix.
 */
class PhoneVaultTest {

    private val key = JSONObject().put("kty", "EC").put("crv", "P-256")
        .put("x", "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU")
        .put("y", "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0")

    /** boxKeyHash(key) in src/fleet/minter/vault.js, worked out there. */
    private val hash = "a0a232c2f194a53553cb1310ddbc0821e414b9d7ebfc290b323084d7d1020fe5"

    private fun grant(key: String, label: String = "deb132", only: List<String> = emptyList()) =
        PhoneVault.Grant(key, key.take(16), label, "eli@example.com", only)

    @Test
    fun theKeyHashIsTheMintersAndTheFingerprintItsStart() {
        assertEquals(hash, PhoneVault.keyHash(key))
        assertEquals("a0a232c2f194a535", PhoneVault.fingerprint(key))
    }

    @Test
    fun aWholeVaultGrantForThatMachineByThatKeyIsApproval() {
        assertTrue(PhoneVault.approves(listOf(grant(hash)), "deb132", key))
    }

    @Test
    fun aPoolMachinesScopedGrantIsNotApproval() {
        assertFalse(PhoneVault.approves(listOf(grant(hash, only = listOf("hypervisor:xo.lan"))), "deb132", key))
    }

    @Test
    fun theSixteenCharacterPrefixAloneIsNotApproval() {
        assertFalse(PhoneVault.approves(listOf(grant(hash.take(16) + "0".repeat(48))), "deb132", key))
    }

    @Test
    fun aGrantUnderAnotherNameIsNotApproval() {
        assertFalse(PhoneVault.approves(listOf(grant(hash, label = "deb133")), "deb132", key))
    }
}
