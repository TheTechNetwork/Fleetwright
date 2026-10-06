package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Changing what the fleet may use on a pool, run rather than read: the pool
 * as the machine seals it (inventoryOf in src/fleet/host/xo-setup.js), the
 * form's starting point, the rules Apply waits on (checkPolicy, mirrored),
 * and the choice as the machine reads it.
 *
 * WHY A JUNIT TEST. test/xopolicy-android-in-apps.test.js holds the words, the
 * bindings and where the keys live, which is answerable by reading the
 * Kotlin. Whether a JSON null VLAN comes out as "no VLAN" or as VLAN 0, a
 * null limit as half the pool or as zero, and whether the disk bound follows
 * the storage chosen, are questions about arithmetic and org.json, and the
 * one way to lose them quietly is a parse or a clamp that is wrong by a
 * little.
 */
class XoPolicyTest {
    private val job = "0123456789ab"
    private val address = "xo.lan"
    private val gib = XoPolicy.GIB

    private fun inventoryJson(
        limits: JSONObject = JSONObject().put("cpus", JSONObject.NULL).put("memory", JSONObject.NULL).put("disk", JSONObject.NULL),
        currentSrs: List<String> = listOf("sr-a"),
        currentNetworks: List<String> = listOf("net-lab"),
    ): JSONObject =
        JSONObject()
            .put("v", 1)
            .put("address", address)
            .put("pools", JSONArray().put(JSONObject().put("id", "pool-1").put("name", "rack")))
            .put(
                "srs",
                JSONArray()
                    .put(JSONObject().put("id", "sr-a").put("name", "Local storage").put("pool", "pool-1").put("size", 500 * gib).put("free", 300 * gib).put("shared", false))
                    .put(JSONObject().put("id", "sr-b").put("name", "NFS").put("pool", "pool-1").put("size", 2000 * gib).put("free", 1500 * gib).put("shared", true))
                    .put(JSONObject().put("name", "no id, dropped")),
            )
            .put(
                "networks",
                JSONArray()
                    .put(JSONObject().put("id", "net-mgmt").put("name", "Pool-wide network").put("pool", "pool-1").put("vlan", JSONObject.NULL).put("egress", false))
                    .put(JSONObject().put("id", "net-lab").put("name", "lab").put("pool", "pool-1").put("vlan", 20).put("egress", true)),
            )
            .put("capacity", JSONObject().put("cpus", 16).put("memory", 64 * gib))
            .put(
                "current",
                JSONObject()
                    .put("srs", JSONArray(currentSrs + "sr-not-listed"))
                    .put("networks", JSONArray(currentNetworks))
                    .put("limits", limits),
            )

    private fun inventory(json: JSONObject = inventoryJson()): XoPolicy.Inventory = XoPolicy.parse(json)!!

    @Test
    fun anOlderMachineSaysNothingAboutEdgeRoutersAndThatIsNotNone() {
        val inv = inventory()
        assertEquals(null, inv.edges)
        assertFalse(XoPolicy.defaults(inv).edge)
    }

    @Test
    fun theSwitchStartsOnWhenThePoolHasOneSoApplyKeepsIt() {
        val inv = inventory(inventoryJson().put("edges", JSONArray().put(JSONObject().put("pool", "pool-1").put("running", false))))
        assertEquals(false, XoPolicy.edgeOn(inv, "net-lab")?.running)
        assertTrue(XoPolicy.defaults(inv).edge)
        assertFalse(XoPolicy.defaults(inventory(inventoryJson().put("edges", JSONArray()))).edge)
    }

    @Test
    fun theEdgeRouterGoesWithItsWayOut() {
        val inv = inventory(inventoryJson().put("edges", JSONArray()))
        val asked = XoPolicy.defaults(inv).copy(edge = true)
        assertEquals(null, XoPolicy.problem(inv, asked))
        assertTrue(XoPolicy.payload(inv, asked).getBoolean("edge"))
        val dropped = XoPolicy.withNetwork(asked, "net-lab", false)
        assertEquals(null, dropped.egress)
        assertFalse("a router with no way out was left asked for", dropped.edge)
        assertEquals(
            "The edge router needs a way out: choose the network its WAN goes on.",
            XoPolicy.problem(inv, dropped.copy(edge = true)),
        )
    }

    @Test
    fun theBindingsAreTheMachines() {
        // The same strings as xosetupInventoryAad and xosetupPolicyAad in
        // src/fleet/seal.js, and neither is setup's or the token's.
        assertEquals("fleetwright-xosetup-inventory/v1:J:A", XoPolicy.inventoryAad("J", "A"))
        assertEquals("fleetwright-xosetup-policy/v1:J:A", XoPolicy.policyAad("J", "A"))
    }

    @Test
    fun theInventoryIsReadWithNullsKeptAsNulls() {
        val inv = inventory()
        assertEquals(listOf("sr-a", "sr-b"), inv.srs.map { it.id })
        assertEquals(500 * gib, inv.srs[0].size)
        assertEquals(1500 * gib, inv.srs[1].free)
        assertTrue(inv.srs[1].shared)
        // No VLAN is null, not VLAN 0, and is said as no VLAN.
        assertNull(inv.networks[0].vlan)
        assertEquals("no VLAN", XoPolicy.networkLine(inv.networks[0]))
        assertEquals(20, inv.networks[1].vlan)
        assertEquals("VLAN 20", XoPolicy.networkLine(inv.networks[1]))
        assertEquals(16, inv.cpus)
        assertEquals(64 * gib, inv.memory)
        // What the fleet may use now is held to what the pool listed.
        assertEquals(listOf("sr-a"), inv.currentSrs)
        // No limit set is null, not zero.
        assertEquals(XoPolicy.Limits(null, null, null), inv.currentLimits)
        assertEquals("300 GiB free of 500 GiB · local", XoPolicy.storageLine(inv.srs[0]))
        assertEquals("1500 GiB free of 2000 GiB · shared", XoPolicy.storageLine(inv.srs[1]))
    }

    @Test
    fun anythingThatIsNotAnInventoryIsNothing() {
        assertNull(XoPolicy.parse(JSONObject().put("v", 2).put("address", address)))
        assertNull(XoPolicy.parse(JSONObject().put("v", 1)))
    }

    @Test
    fun theInventoryOpensOnlyUnderItsOwnJobAndAddressWithThisKey() {
        val key = Seal.newKey()
        fun sealed(aad: String, json: JSONObject = inventoryJson()): String {
            val box = Seal.seal(key.publicKey, aad, json)
            return "${box.getString("epk")}.${box.getString("iv")}.${box.getString("ct")}"
        }
        assertNotNull(XoPolicy.openInventory(sealed(XoPolicy.inventoryAad(job, address)), job, address, key))
        // Another job, another binding, another phone's key, another pool: nothing.
        assertNull(XoPolicy.openInventory(sealed(XoPolicy.inventoryAad("ba9876543210", address)), job, address, key))
        assertNull(XoPolicy.openInventory(sealed(XoSetup.aad(job, address)), job, address, key))
        assertNull(XoPolicy.openInventory(sealed(XoPolicy.inventoryAad(job, address)), job, address, Seal.newKey()))
        assertNull(XoPolicy.openInventory(sealed(XoPolicy.inventoryAad(job, address), inventoryJson().put("address", "other.lan")), job, address, key))
        assertNull(XoPolicy.openInventory("not.sealed", job, address, key))
    }

    @Test
    fun withNoLimitsSetTheFormStartsAtHalfThePool() {
        val c = XoPolicy.defaults(inventory())
        assertEquals(setOf("sr-a"), c.srs)
        assertEquals(setOf("net-lab"), c.networks)
        // The network tagged as the way out, because it is one the fleet may use.
        assertEquals("net-lab", c.egress)
        assertEquals(8, c.cpus)
        assertEquals(32L, c.memoryGib)
        // Half the chosen storage's free space.
        assertEquals(150L, c.diskGib)
        assertNull(XoPolicy.problem(inventory(), c))
    }

    @Test
    fun theLimitsSetStartTheFormAndAreHeldToThePool() {
        val limits = JSONObject().put("cpus", 64).put("memory", 12 * gib).put("disk", 4000 * gib)
        val c = XoPolicy.defaults(inventory(inventoryJson(limits = limits)))
        assertEquals(16, c.cpus)
        assertEquals(12L, c.memoryGib)
        // Clamped to the storage chosen: sr-a holds 500 GiB.
        assertEquals(500L, c.diskGib)
    }

    @Test
    fun theWayOutIsNotPreselectedOffTheNetworksChosen() {
        val c = XoPolicy.defaults(inventory(inventoryJson(currentNetworks = listOf("net-mgmt"))))
        assertNull(c.egress)
    }

    @Test
    fun aSmallPoolStillStartsAtTheMinimum() {
        val json = inventoryJson(currentSrs = emptyList())
        json.put("capacity", JSONObject().put("cpus", 1).put("memory", 0))
        val inv = inventory(json)
        val c = XoPolicy.defaults(inv)
        assertEquals(1, c.cpus)
        assertEquals(1L, c.memoryGib)
        assertEquals(10L, c.diskGib)
        // Nothing chosen to put a disk on is the first thing Apply waits for.
        assertEquals("Choose at least one storage repository: a VM needs somewhere for its disk.", XoPolicy.problem(inv, c))
    }

    @Test
    fun theDiskFollowsTheStorageDownAndTheWayOutGoesWithItsNetwork() {
        val inv = inventory()
        val wide = XoPolicy.withStorage(inv, XoPolicy.defaults(inv), "sr-b", true).copy(diskGib = 2400)
        assertNull(XoPolicy.problem(inv, wide))
        val narrow = XoPolicy.withStorage(inv, wide, "sr-b", false)
        assertEquals(500L, narrow.diskGib)
        val noLab = XoPolicy.withNetwork(narrow, "net-lab", false)
        assertNull(noLab.egress)
        assertNull(XoPolicy.problem(inv, noLab))
    }

    /**
     * Asked for: a way out that is not one of the fleet's networks. A machine
     * that takes that keeps the way out when its network goes off, starts
     * with it where Xen Orchestra's tag is, and sends it.
     */
    @Test
    fun onAMachineThatTakesAnyNetworkTheWayOutNeedNotBeTheFleets() {
        val inv = inventory(inventoryJson(currentNetworks = listOf("net-mgmt")))
        assertNull("an older machine would refuse it, so it is not chosen", XoPolicy.defaults(inv).egress)
        val any = XoPolicy.defaults(inv, anyWayOut = true)
        assertEquals("the tagged network, though the fleet may not use it", "net-lab", any.egress)
        val off = XoPolicy.withNetwork(XoPolicy.withNetwork(any, "net-mgmt", false), "net-mgmt", true)
        assertEquals("net-lab", off.egress)
        assertNull(XoPolicy.problem(inv, off))
        assertEquals("net-lab", XoPolicy.payload(inv, off).getString("egress"))
        assertEquals(
            "The way out has to be a network this pool listed. Nothing was changed.",
            XoPolicy.problem(inv, off.copy(egress = "net-elsewhere")),
        )
    }

    /**
     * Asked for: "which disk did it put it on?" The router's disk goes on the
     * storage picked, any in the way out's pool with room; unpicked, the
     * fleet's there with the most room; and it is sent only to a machine
     * that reads it.
     */
    @Test
    fun theRoutersDiskGoesWhereItIsPickedAndIsSentOnlyToAMachineThatReadsIt() {
        val inv = inventory()
        val c = XoPolicy.defaults(inv).copy(edge = true)
        assertEquals(listOf("sr-a", "sr-b"), XoPolicy.edgeDisks(inv, c.egress).map { it.id })
        assertEquals("the fleet's storage first, though sr-b has more room", "sr-a", XoPolicy.edgeDisk(inv, c))
        assertFalse("an older machine is not sent it", XoPolicy.payload(inv, c).has("edgeSr"))
        val asked = c.copy(edgeDiskChoice = true)
        assertEquals("sr-a", XoPolicy.payload(inv, asked).getString("edgeSr"))
        assertEquals("sr-b", XoPolicy.payload(inv, asked.copy(edgeSr = "sr-b")).getString("edgeSr"))
        assertEquals("a pick that no longer fits falls back", "sr-a", XoPolicy.edgeDisk(inv, asked.copy(edgeSr = "sr-gone")))
        assertNull(XoPolicy.problem(inv, asked))
    }

    @Test
    fun applyWaitsForWhatTheMachineWouldTake() {
        val inv = inventory()
        val ok = XoPolicy.defaults(inv)
        assertEquals("The way out has to be one of the networks the fleet may use.", XoPolicy.problem(inv, ok.copy(egress = "net-mgmt")))
        assertEquals("That names storage or a network this pool did not list. Nothing was changed.", XoPolicy.problem(inv, ok.copy(srs = setOf("sr-x"))))
        assertEquals("vCPUs are between 1 and 16, what the pool has.", XoPolicy.problem(inv, ok.copy(cpus = 17)))
        assertEquals("vCPUs are between 1 and 16, what the pool has.", XoPolicy.problem(inv, ok.copy(cpus = 0)))
        assertEquals("Memory is between 1 GiB and 64 GiB, what the pool has.", XoPolicy.problem(inv, ok.copy(memoryGib = 65)))
        assertEquals("Disk is between 10 GiB and 500 GiB, the size of the storage chosen.", XoPolicy.problem(inv, ok.copy(diskGib = 501)))
        assertEquals("Disk is between 10 GiB and 500 GiB, the size of the storage chosen.", XoPolicy.problem(inv, ok.copy(diskGib = 9)))
        assertNull(XoPolicy.problem(inv, ok.copy(cpus = 16, memoryGib = 64, diskGib = 500)))
    }

    @Test
    fun theChoiceIsWhatTheMachineReads() {
        val inv = inventory()
        val c = XoPolicy.withStorage(inv, XoPolicy.defaults(inv), "sr-b", true)
        val p = XoPolicy.payload(inv, c)
        assertEquals(1, p.getInt("v"))
        // In the pool's order, whatever order they were switched on in.
        assertEquals(listOf("sr-a", "sr-b"), (0 until p.getJSONArray("srs").length()).map { p.getJSONArray("srs").getString(it) })
        assertEquals("net-lab", p.getJSONArray("networks").getString(0))
        assertEquals("net-lab", p.getString("egress"))
        val limits = p.getJSONObject("limits")
        assertEquals(8, limits.getInt("cpus"))
        assertEquals(32 * gib, limits.getLong("memory"))
        assertEquals(150 * gib, limits.getLong("disk"))
        // No way out is JSON null, not a missing key and not the word "null".
        val none = XoPolicy.payload(inv, c.copy(egress = null))
        assertTrue(none.has("egress") && none.isNull("egress"))
    }

    @Test
    fun theChoiceOpensWithTheJobsKeyUnderItsOwnBinding() {
        val jobKey = Seal.newKey()
        val inv = inventory()
        val parts = XoPolicy.sealChoice(jobKey.publicKey, job, address, inv, XoPolicy.defaults(inv)).split(".")
        assertEquals(3, parts.size)
        val box = JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2])
        assertEquals(1, Seal.open(jobKey, XoPolicy.policyAad(job, address), box).getInt("v"))
        assertFalse(runCatching { Seal.open(jobKey, XoSetup.aad(job, address), box) }.isSuccess)
    }

    @Test
    fun thePurposeIsInsideTheSealedSignIn() {
        val jobKey = Seal.newKey()
        val reply = Seal.newKey()
        val parts = XoPolicy.sealSignIn(jobKey.publicKey, job, address, "admin@xo.lan", "pw", reply.publicKey).split(".")
        val box = JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2])
        val inside = Seal.open(jobKey, XoSetup.aad(job, address), box)
        assertEquals("policy", inside.getString("purpose"))
        assertEquals(reply.publicKey, inside.getString("reply"))
        assertEquals("admin@xo.lan", inside.getJSONObject("xo").getString("email"))
    }

    @Test
    fun aStepperCrossesItsRangeInAboutSixteenPresses() {
        assertEquals(1L, XoPolicy.stepFor(16))
        assertEquals(4L, XoPolicy.stepFor(64))
        assertEquals(64L, XoPolicy.stepFor(2000))
    }
}
