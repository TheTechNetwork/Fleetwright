package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Seal.kt against the message the minter's own code sealed.
 *
 * test/fixtures/parity/seal.json is one message sealed by src/fleet/seal.js
 * with its random values written down; test/seal-parity.test.js opens it with
 * seal.js. Here the phone seals the same plaintext with the same values and
 * must produce the same ciphertext, which is the only way to know the minter
 * will open what this phone sends. And the phone opens the fixture as the
 * recipient, which is the direction the minter's answers travel.
 */
class SealTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/seal.json")
            ?: error("parity/seal.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    @Test
    fun sealsTheSameBytesAsTheMinter() {
        val eph = fixture.getJSONObject("ephemeral")
        val sealed = fixture.getJSONObject("sealed")
        val ours = Seal.seal(
            to = fixture.getJSONObject("recipient").getString("publicKey"),
            aad = fixture.getString("aad"),
            plaintext = fixture.getString("plaintext").toByteArray(Charsets.UTF_8),
            ephemeral = Seal.keyPairFromJwk(eph.getString("d"), eph.getString("x"), eph.getString("y")),
            iv = java.util.Base64.getUrlDecoder().decode(sealed.getString("iv")),
        )
        assertEquals(sealed.getString("epk"), ours.getString("epk"))
        assertEquals(sealed.getString("iv"), ours.getString("iv"))
        assertEquals(sealed.getString("ct"), ours.getString("ct"))
    }

    @Test
    fun opensWhatTheMinterSealed() {
        val r = fixture.getJSONObject("recipient")
        val key = Seal.OneUseKey(Seal.keyPairFromJwk(r.getString("d"), r.getString("x"), r.getString("y")).private, r.getString("publicKey"))
        val opened = Seal.open(key, fixture.getString("aad"), fixture.getJSONObject("sealed"))
        assertEquals(JSONObject(fixture.getString("plaintext")).toString(), opened.toString())
        // Bound to its purpose: the same bytes under another additional data do not open.
        assertThrows(Exception::class.java) { Seal.open(key, "something else", fixture.getJSONObject("sealed")) }
    }

    @Test
    fun worksOutTheFingerprintABoxPrints() {
        assertEquals(fixture.getString("fingerprint"), PhoneVault.fingerprint(fixture.getJSONObject("boxKey")))
    }

    @Test
    fun aKeyItMakesOpensWhatIsSealedToIt() {
        val key = Seal.newKey()
        val sealed = Seal.seal(key.publicKey, Seal.GITHUB_REPLY_AAD, JSONObject().put("accessToken", "ghu_x"))
        assertEquals("ghu_x", Seal.open(key, Seal.GITHUB_REPLY_AAD, sealed).getString("accessToken"))
    }
}
