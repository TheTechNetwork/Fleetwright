package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * HolderJoin against the proof src/fleet/protocol/holder-join.js makes.
 *
 * test/fixtures/parity/holder-join.json is one request proved with its secret
 * written down; test/holder-join.test.js checks it with holder-join.js itself,
 * and HolderJoinTests.swift with the iPhone's. The phone that checks a request
 * is the only party that can, so a proof this file computes differently is a
 * machine that can never be let in.
 */
class HolderJoinTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/holder-join.json")
            ?: error("parity/holder-join.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    private val hostId get() = fixture.getString("hostId")
    private val address get() = fixture.getString("address")
    private val jwk get() = fixture.getJSONObject("publicJwk")
    private val keyHash get() = fixture.getString("keyHash")
    private val secret get() = fixture.getString("secret")
    private val proof get() = fixture.getString("proof")

    @Test
    fun theProofIsTheOneTheMachineMakes() {
        assertEquals(keyHash, HolderJoin.keyHash(jwk))
        assertEquals(fixture.getString("message"), HolderJoin.message(hostId, address, keyHash))
        assertEquals(proof, HolderJoin.proof(secret, hostId, address, keyHash))
        assertNull(HolderJoin.proof("short", hostId, address, keyHash))
    }

    @Test
    fun onlyARequestThisPhonesSecretProvesIsLetIn() {
        val real = HolderJoin.Request(key = keyHash, publicJwk = jwk, proof = proof, at = 1)
        // A request whose key is not the one it names, and one proved with another secret.
        val lying = HolderJoin.Request(key = "e".repeat(64), publicJwk = jwk, proof = proof, at = 2)
        val stranger = HolderJoin.Request(key = keyHash, publicJwk = jwk, proof = "0".repeat(64), at = 3)
        val waiting = HolderJoin.Waiting(hostId, address, madeAt = 0, until = 1, requests = listOf(lying, stranger, real))
        val match = HolderJoin.proven(waiting, listOf("cd".repeat(32), secret))
        assertEquals(real, match?.first)
        assertEquals(secret, match?.second)
        assertNull("another phone's secret proves nothing", HolderJoin.proven(waiting, listOf("cd".repeat(32))))
        val elsewhere = HolderJoin.Waiting(hostId, "10.10.10.231", madeAt = 0, until = 1, requests = listOf(real))
        assertNull("a proof for one pool is not one for another", HolderJoin.proven(elsewhere, listOf(secret)))
    }

    @Test
    fun aWaitingNameIsReadAsTheFleetSendsIt() {
        val sent = JSONObject()
            .put("hostId", hostId).put("address", address).put("madeAt", 5).put("until", 9)
            .put("requests", org.json.JSONArray().put(JSONObject().put("key", keyHash).put("publicJwk", jwk).put("proof", proof).put("at", 7)))
        val waiting = HolderJoin.waitingFrom(sent)!!
        assertEquals(hostId, waiting.hostId)
        assertEquals(listOf(HolderJoin.Request(keyHash, jwk, proof, 7)), waiting.requests)
        assertNull("a name is what it is listed by", HolderJoin.waitingFrom(JSONObject().put("address", address)))
    }
}
