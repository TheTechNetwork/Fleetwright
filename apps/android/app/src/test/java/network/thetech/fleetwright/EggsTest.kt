package network.thetech.fleetwright

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Eggs.kt against test/fixtures/parity/eggs.json, which EggsTests.swift runs on iOS too. */
class EggsTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/eggs.json")
            ?: error("parity/eggs.json is not on the test classpath")
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    @Test
    fun theCountAndTheWordsAreTheTable() {
        assertEquals(fixture.getInt("taps"), Eggs.TAPS)
        assertEquals(fixture.getString("line"), Eggs.LINE)
    }

    @Test
    fun everyCase() {
        val cases = fixture.getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val taps = c.getInt("taps")
            val expected = if (c.getBoolean("shows")) fixture.getString("line") else null
            assertEquals("$taps taps", expected, Eggs.buildLine(taps))
        }
    }
}
