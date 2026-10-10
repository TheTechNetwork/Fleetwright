package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * Managing a pool from this phone (Manage.kt), run against the table both
 * phones share: test/fixtures/parity/manage.json, read here and by
 * FleetwrightTests/ManageParityTests.swift.
 *
 * WHAT IT PROTECTS. The rows a person reads, the buttons they are offered and
 * the way each asks before it acts are decided by rules written twice, once
 * here and once in Swift. A Node test reading both sources can prove a
 * sentence is in both files; only running both against the same inputs
 * proves the phones agree on which button a server's method list draws and
 * what a VM with no state is offered (nothing). A plain JVM test with the
 * real org.json on the test classpath (build.gradle.kts), so the table is
 * actually parsed rather than read as empty by the platform's stub.
 */
class ManageParityTest {

    private val table: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity/manage.json")
        requireNotNull(stream) { "parity/manage.json is not on the test classpath" }
        JSONObject(stream.bufferedReader().use { it.readText() })
    }

    private fun list(key: String): List<JSONObject> {
        val a = table.getJSONArray(key)
        return (0 until a.length()).map { a.getJSONObject(it) }
    }

    private fun snapshot(): Manage.Snapshot = Manage.Snapshot().taking(table.getJSONArray("objects"))

    /** "all", a list, or null (cannot tell). */
    private fun methods(value: Any?): Set<String>? = when (value) {
        "all" -> strings(table.getJSONObject("methods").getJSONArray("all")).toSet()
        is JSONArray -> strings(value).toSet()
        else -> null
    }

    private fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.getString(it) }

    private fun opt(o: JSONObject, key: String): String? = if (o.isNull(key)) null else o.getString(key)

    private fun component(s: Manage.Snapshot, id: String): Manage.Component =
        requireNotNull(s.components[id]) { "no component $id" }

    private fun said(c: Manage.Confirmation): JSONObject = when (c) {
        Manage.Confirmation.None -> JSONObject().put("kind", "none")
        is Manage.Confirmation.Ask -> JSONObject().put("kind", "ask").put("title", c.title).put("button", c.button)
        is Manage.Confirmation.TypeName -> JSONObject().put("kind", "type").put("title", c.title).put("name", c.name).put("button", c.button)
    }

    /**
     * The same object: the same keys, numbers equal as numbers (a Long sent
     * and an Integer parsed are one value), everything else equal. Written
     * here because the compile classpath is Android's org.json, which has no
     * `similar`.
     */
    private fun same(got: Any, want: JSONObject, why: String) {
        val mine = if (got is Map<*, *>) JSONObject(got) else got as JSONObject
        assertTrue("$why: $mine is not $want", alike(mine, want))
    }

    private fun alike(a: Any?, b: Any?): Boolean = when {
        a is JSONObject && b is JSONObject ->
            a.keys().asSequence().toSet() == b.keys().asSequence().toSet() && a.keys().asSequence().all { alike(a.opt(it), b.opt(it)) }
        a is Number && b is Number -> a.toDouble() == b.toDouble()
        else -> a == b
    }

    @Test
    fun `the table is not empty, because a vacuous pass is the failure this guards`() {
        for (key in listOf("objects", "components", "actions", "details", "tuning", "notifications", "records")) {
            assertTrue("$key is empty", table.getJSONArray(key).length() > 0)
        }
    }

    @Test
    fun `sizes read the same on both phones`() {
        val cases = table.getJSONArray("bytes")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            assertEquals(c.getString(1), Manage.bytes(c.getLong(0)))
        }
    }

    @Test
    fun `the phone computes the pin the machine wrote`() {
        val pin = table.getJSONObject("pin")
        assertEquals(pin.getString("sha256"), Manage.fingerprint(Base64.getDecoder().decode(pin.getString("der"))))
    }

    @Test
    fun `every object becomes the row the table says`() {
        val s = snapshot()
        for (want in list("components")) {
            val c = component(s, want.getString("id"))
            assertEquals("${c.id} kind", want.getString("kind"), c.kind.raw)
            assertEquals("${c.id} name", want.getString("name"), c.name)
            assertEquals("${c.id} state", opt(want, "state"), Manage.stateWords(c))
            assertEquals("${c.id} what it is", want.getString("what"), Manage.what(c, s))
            assertEquals("${c.id} numbers", want.getString("numbers"), Manage.numbers(c, s))
        }
        // Nothing that is not a component became one: a VBD, a VDI and a
        // message are read, and none of them is a row.
        assertEquals(list("components").size, s.components.size)
    }

    @Test
    fun `each kind is listed by name`() {
        val s = snapshot()
        val lists = table.getJSONObject("lists")
        for (kind in Manage.Kind.values()) {
            assertEquals("$kind order", strings(lists.getJSONArray(kind.raw)), s.list(kind).map { it.id })
        }
    }

    @Test
    fun `a VM's disks are its attached ones without the CD drive`() {
        val s = snapshot()
        for (want in list("disks")) {
            val got = s.attachedDisks(want.getString("vm"))
            val disks = want.getJSONArray("disks")
            assertEquals((0 until disks.length()).map { disks.getJSONObject(it).getString("id") }, got.map { it.id })
            got.forEachIndexed { i, d ->
                val w = disks.getJSONObject(i)
                assertEquals(w.getString("name"), d.name)
                assertEquals(w.getString("size"), d.size?.let { Manage.bytes(it) })
                assertEquals(w.getString("line"), Manage.diskLine(d, s))
            }
        }
    }

    @Test
    fun `an action is offered only when its method is listed and the state allows it`() {
        val s = snapshot()
        for (want in list("actions")) {
            val c = component(s, want.getString("component"))
            val got = Manage.offered(c, methods(want.opt("methods"))).map { it.id }
            assertEquals(want.getString("why"), strings(want.getJSONArray("offered")), got)
        }
    }

    @Test
    fun `each action says, calls and asks what the table says`() {
        val s = snapshot()
        val now = table.getLong("now")
        for (want in list("details")) {
            val c = component(s, want.getString("component"))
            val offered = Manage.offered(c, methods(want.opt("methods")))
            val a = offered.firstOrNull { it.id == want.getString("action") }
            assertNotNull("${c.id} is not offered ${want.getString("action")}", a)
            a!!
            assertEquals(want.getString("label"), a.label)
            assertEquals("${c.id} ${a.id} method", want.getString("method"), a.method)
            assertEquals("${c.id} ${a.id} cost", want.getString("cost"), a.cost.raw)
            same(Manage.params(a, c, now), want.getJSONObject("params"), "${c.id} ${a.id} params")
            same(said(Manage.confirmation(a, c, s)), want.getJSONObject("confirm"), "${c.id} ${a.id} asks")
            assertEquals(want.getString("done"), Manage.done(a, c))
        }
    }

    @Test
    fun `the size is changed only where it can be, and says why not elsewhere`() {
        val s = snapshot()
        for (want in list("tuning")) {
            val c = component(s, want.getString("component"))
            val m = methods(want.opt("methods"))
            val why = want.getString("why")
            assertEquals(why, want.getBoolean("resize"), Manage.canResize(c, m))
            assertEquals(why, want.getBoolean("needsStopped"), Manage.resizeNeedsStopped(c, m))
            assertEquals(why, opt(want, "grow"), Manage.growMethod(c, m))
        }
        for (want in list("resize")) {
            val c = component(s, want.getString("component"))
            val cpus = want.getInt("cpus")
            val gib = want.getInt("memoryGiB")
            same(Manage.resizeParams(c, cpus, gib), want.getJSONObject("params"), "resize params")
            assertEquals(want.getString("done"), Manage.resized(c, cpus, gib))
        }
        for (want in list("grow")) {
            val c = component(s, want.getString("component"))
            val d = s.attachedDisks(c.id).first { it.id == want.getString("disk") }
            val gib = want.getInt("toGiB")
            assertEquals(want.getString("method"), Manage.growMethod(c, methods(want.opt("methods"))))
            same(Manage.growParams(d, gib), want.getJSONObject("params"), "grow params")
            same(said(Manage.growConfirmation(d, gib)), want.getJSONObject("confirm"), "grow asks")
            assertEquals(want.getString("done"), Manage.grown(d, gib))
        }
    }

    @Test
    fun `a notification changes the picture the way Xen Orchestra meant it`() {
        for (want in list("notifications")) {
            val why = want.getString("why")
            val s = snapshot().applying("all", want.getJSONObject("notice"))
            assertNotNull(why, s)
            s!!
            val states = want.getJSONObject("states")
            for (id in states.keys()) assertEquals(why, states.getString(id), s.components[id]?.let { Manage.stateWords(it) })
            val numbers = want.getJSONObject("numbers")
            for (id in numbers.keys()) assertEquals(why, numbers.getString(id), s.components[id]?.let { Manage.numbers(it, s) })
            for (id in strings(want.getJSONArray("absent"))) assertNull(why, s.components[id])
        }
        // A method that is not `all` is not a change.
        assertNull(snapshot().applying("message", JSONObject().put("type", "enter").put("items", JSONObject())))
    }

    @Test
    fun `the record setup handed back is read for this address only`() {
        for (want in list("records")) {
            val why = want.getString("why")
            val r = Manage.record(want.getString("text"), want.getString("address"))
            if (!want.getBoolean("ok")) {
                assertNull(why, r)
                continue
            }
            assertNotNull(why, r)
            r!!
            assertEquals(why, want.getString("token"), r.token)
            assertEquals(why, opt(want, "pin"), r.pin)
            assertEquals(why, want.getBoolean("plain"), r.plain)
            assertEquals(why, opt(want, "user"), r.user)
            assertEquals(why, if (want.isNull("expires")) null else want.getLong("expires"), r.expires)
        }
    }

    @Test
    fun `every sentence is the one the table says`() {
        val words = table.getJSONObject("words")
        fun arg(key: String, i: Int) = words.getJSONArray(key).getString(i)

        val fixed = mapOf(
            "watching" to Manage.Words.watching, "never" to Manage.Words.never, "closed" to Manage.Words.closed,
            "noObjects" to Manage.Words.noObjects, "methodsUnknown" to Manage.Words.methodsUnknown,
            "nothingOffered" to Manage.Words.nothingOffered, "seesNothing" to Manage.Words.seesNothing,
            "tuneNeedsStopped" to Manage.Words.tuneNeedsStopped, "growNote" to Manage.Words.growNote, "slow" to Manage.Words.slow,
            "actionsFooter" to Manage.Words.actionsFooter, "gone" to Manage.Words.gone, "lookAgain" to Manage.Words.lookAgain,
            "changePolicy" to Manage.Words.changePolicy, "whatItIs" to Manage.Words.whatItIs, "howItIs" to Manage.Words.howItIs,
            "whatItCanDo" to Manage.Words.whatItCanDo,
        )
        for ((key, value) in fixed) assertEquals(key, words.getString(key), value)

        val single: Map<String, (String) -> String> = mapOf(
            "connecting" to Manage.Words::connecting, "plainPool" to Manage.Words::plainPool, "noToken" to Manage.Words::noToken,
            "wrongCertificate" to Manage.Words::wrongCertificate, "limitedUser" to Manage.Words::limitedUser,
            "typePrompt" to Manage.Words::typePrompt, "refused" to Manage.Words::refused, "lost" to Manage.Words::lost,
        )
        for ((key, say) in single) assertEquals(key, arg(key, 1), say(arg(key, 0)))

        assertEquals(arg("expired", 2), Manage.Words.expired(arg("expired", 0), arg("expired", 1)))
        assertEquals(arg("signInRefused", 2), Manage.Words.signInRefused(arg("signInRefused", 0), arg("signInRefused", 1)))
        assertEquals(arg("unreachable", 2), Manage.Words.unreachable(arg("unreachable", 0), arg("unreachable", 1)))
        val resize = words.getJSONArray("resizeButton")
        for (i in 0 until resize.length()) {
            val c = resize.getJSONArray(i)
            assertEquals(c.getString(2), Manage.Words.resizeButton(c.getInt(0), c.getInt(1)))
        }
        val grow = words.getJSONArray("growButton")
        assertEquals(grow.getString(2), Manage.Words.growButton(grow.getString(0), grow.getInt(1)))
        val heading = words.getJSONObject("heading")
        val kindTitle = words.getJSONObject("kindTitle")
        for (kind in Manage.Kind.values()) {
            assertEquals(heading.getString(kind.raw), Manage.Words.heading(kind))
            assertEquals(kindTitle.getString(kind.raw), Manage.Words.kindTitle(kind))
        }

        // EVERY KEY IS CHECKED: a sentence added to the table and to neither
        // phone would otherwise sit there proving nothing.
        val checked = fixed.keys + single.keys + setOf("expired", "signInRefused", "unreachable", "resizeButton", "growButton", "heading", "kindTitle")
        assertEquals(checked, words.keys().asSequence().toSet())
        assertFalse(checked.isEmpty())
    }
}
