package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reassurance line, run against the table both phones share.
 *
 * WHAT THIS REPLACES. test/reassurance.test.js asserted parity between the two
 * apps by matching words in their source:
 *
 *     assert.match(model, /quietFor/, "${name} does not compute it")
 *
 * which passes whether this file's stall floor is 90 seconds and Swift's is
 * 120. Both sources contain the word, the phones disagree, and nothing goes
 * red. A grep can prove a rule is MENTIONED in two places; only running both
 * against the same inputs proves they agree.
 *
 * So the expected answers live in test/fixtures/parity/reassurance.json, read
 * here and by FleetwrightTests/ReassuranceParityTests.swift. Change the rule
 * and the table has to change, which fails both apps until both are updated.
 *
 * A PLAIN JVM UNIT TEST, not an instrumented one. Nothing here touches the
 * framework: `headline` and `basis` are pure functions of six fields, so this
 * runs in seconds on an ordinary runner with no emulator.
 */
class ReassuranceParityTest {

    /**
     * The shared table, off the test classpath.
     *
     * `org.json` here is the REAL implementation, not Android's stub — see the
     * comment on the testImplementation line in build.gradle.kts. The stub
     * returns defaults for everything, which would make this pass on an empty
     * fixture.
     */
    private fun cases(): List<JSONObject> {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/reassurance.json")
        requireNotNull(stream) { "parity/reassurance.json is not on the test classpath" }
        val array = JSONObject(stream.bufferedReader().use { it.readText() }).getJSONArray("cases")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    private fun reassuranceOf(input: JSONObject): Reassurance {
        val unwellArray = input.getJSONArray("unwell")
        return Reassurance(
            waiting = input.getInt("waiting"),
            running = input.getInt("running"),
            quiet = input.getInt("quiet"),
            unwell = (0 until unwellArray.length()).map { unwellArray.getString(it) },
            blind = input.getBoolean("blind"),
            healthy = input.getInt("healthy"),
        )
    }

    @Test
    fun `the table is not empty, because a vacuous pass is the failure this guards`() {
        // Every assertion below is inside a loop. An empty or unreadable fixture
        // would make all of them pass while checking nothing, which is exactly
        // the shape of green this whole change exists to remove.
        assertTrue("no cases were read from the fixture", cases().size >= 10)
    }

    @Test
    fun `every case in the shared table produces the headline it says`() {
        for (case in cases()) {
            val why = case.getString("why")
            assertEquals(why, case.getString("headline"), reassuranceOf(case.getJSONObject("in")).headline)
        }
    }

    @Test
    fun `every case in the shared table produces the basis it says`() {
        for (case in cases()) {
            val why = case.getString("why")
            assertEquals(why, case.getString("basis"), reassuranceOf(case.getJSONObject("in")).basis)
        }
    }
}
