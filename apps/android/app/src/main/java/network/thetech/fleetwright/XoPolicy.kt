package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToLong

/**
 * Changing what the fleet may use on a hypervisor pool: the half that is
 * arithmetic and words, kept apart from the screen so a JVM test can run it,
 * as XoSetup is for adding one. docs/hypervisors.md, and the `policy` phase
 * of `xosetup` in src/fleet/protocol/intents.js.
 *
 * WHY A JOB OF ITS OWN. Setup applies defaults when it first makes the pool's
 * resource set (the pools' default storage, half the pool, no networks) and
 * never touches an existing one again, so a person's choice survives running
 * setup again for a new token. Changing that choice is begun the same way as
 * setup (a probe, a machine, its key checked before anything is sealed), and
 * differs in three places, all here:
 *
 *   1. The sealed sign-in carries `purpose: "policy"` INSIDE the seal, where
 *      the coordinator relaying it can neither read nor change it, and a key
 *      this phone made for the pool to come back to. That key is kept in
 *      memory and nowhere else: this is a screen somebody is looking at, not
 *      a token to collect with the app closed (XoHandoff is that, and writes
 *      its key down because it has to).
 *   2. The machine signs in, reads the pool, and hands back its storage,
 *      networks and capacity sealed to that key under
 *      `fleetwright-xosetup-inventory/v1:<job>:<address>`, because a network
 *      map is not the coordinator's to read. [openInventory].
 *   3. The person's choice goes back sealed to the job's key, the one `begin`
 *      answered with and the phone already checked, under
 *      `fleetwright-xosetup-policy/v1:<job>:<address>`. [sealChoice].
 *
 * THE RULES ARE THE MACHINE'S, mirrored. checkPolicy in xo-setup.js is the
 * bound and refuses anything outside it; [problem] says the same thing here
 * first, in the same words, so Apply is offered only for a choice the machine
 * will take, and a refusal is never the first the person hears of a rule.
 */
internal object XoPolicy {

    /** What the sealed sign-in names as its purpose. Inside the seal, never a param. */
    const val PURPOSE = "policy"

    const val GIB = 1024L * 1024L * 1024L

    /** The smallest limits the machine accepts: a GiB of memory, ten of disk, one vCPU. */
    const val MIN_MEMORY = GIB
    const val MIN_DISK = 10 * GIB

    /**
     * A policy job's steps, in XOPOLICY_STEPS order, with the words the
     * machine uses for each (STEP_WORDS in xo-setup.js): onboarding's first
     * three, then the person's choice and applying it.
     */
    val STEPS: List<Pair<String, String>> = listOf(
        "connect" to "Reaching Xen Orchestra",
        "sign-in" to "Signing in",
        "inventory" to "Reading the pool",
        "choose" to "Waiting for your choice",
        "apply" to "Applying what you chose",
    )

    fun stepWords(phase: String?, step: Int, of: Int): String {
        if (phase == "done") return "Done"
        STEPS.firstOrNull { it.first == phase }?.let { return it.second }
        val n = (step + 1).coerceIn(1, maxOf(of, 1))
        return "Step $n of ${maxOf(of, 1)}"
    }

    /** The pool, sealed by the machine to this phone's key: this job, this address. */
    fun inventoryAad(job: String, address: String): String = "fleetwright-xosetup-inventory/v1:$job:$address"

    /** The person's choice, sealed by this phone to the job's key: this job, this address. */
    fun policyAad(job: String, address: String): String = "fleetwright-xosetup-policy/v1:$job:$address"

    data class Pool(val id: String, val name: String)

    /** A storage repository a VM's disk can go on. Bytes, as the machine counts them. */
    data class Storage(val id: String, val name: String, val pool: String?, val size: Long, val free: Long, val shared: Boolean)

    /** A network. [vlan] is null for one with no VLAN; [egress] is the one tagged as the way out now. */
    data class Network(val id: String, val name: String, val pool: String?, val vlan: Int?, val egress: Boolean)

    /** A resource set's limits as they stand. NULL IS NO LIMIT SET, not zero (currentLimits in xo-setup.js). */
    data class Limits(val cpus: Long?, val memory: Long?, val disk: Long?)

    /**
     * What the machine read: the pool's storage and networks, what its hosts
     * add up to, and what the fleet may use now.
     */
    data class Inventory(
        val address: String,
        val pools: List<Pool>,
        val srs: List<Storage>,
        val networks: List<Network>,
        val cpus: Int,
        val memory: Long,
        val currentSrs: List<String>,
        val currentNetworks: List<String>,
        val currentLimits: Limits,
        /**
         * Each pool's edge router, from a machine that can build one; null
         * from one older than that, which is "cannot tell", never "none".
         */
        val edges: List<Edge>? = null,
        /**
         * Each pool's machine image, from a machine that can build one; null
         * from one older than that, which is "cannot tell", never "none".
         */
        val images: List<Image>? = null,
        /**
         * The operating systems a machine image can be made of, from this
         * machine's catalogue (vm-image.js, IMAGES); null from one older than
         * the choice, which builds Debian alone.
         */
        val imageKinds: List<ImageKind>? = null,
        /**
         * Each pool's group networks, from a machine that makes them; null
         * from one older than that, which is "cannot tell", never "none".
         */
        val groups: List<GroupNetwork>? = null,
        /**
         * Each pool's own machine, from a machine that can make one
         * (xo-holder.js); null from one older than that, which is "cannot
         * tell", never "none".
         */
        val holders: List<Holder>? = null,
    )

    /** A network for machines that work together: no way off the pool. */
    data class GroupNetwork(val id: String, val name: String, val pool: String?)

    /** What a group network is called, and the most a policy makes on one pool (edge-router.js). */
    const val GROUP_PREFIX = "fleetwright-group-"
    const val MAX_GROUPS = 4

    /** The networks a person chooses among: the pool's, less its group networks, which are this policy's to make. */
    fun choosable(inv: Inventory): List<Network> = inv.networks.filterNot { it.name.startsWith(GROUP_PREFIX) }

    /** How many group networks the pool this network is in has. */
    fun groupCount(inv: Inventory, network: String?): Int {
        val pool = inv.networks.firstOrNull { it.id == network }?.pool ?: return 0
        return (inv.groups ?: emptyList()).count { it.pool == pool }
    }

    /**
     * What the stepper says: a count, said as a count, and what Apply will
     * make. The same words as iOS (AddHypervisorView.groupsLine). Asked for,
     * of the first version's "1: 1 made when you apply": "What does this
     * even mean".
     */
    fun groupsLine(groups: Int, there: Int): String {
        val count = if (groups == 1) "1 group" else "$groups groups"
        val more = groups - there
        if (groups == 0) return "None, so every machine is on its own"
        if (more <= 0) return count
        return if (there == 0) "$count, made when you apply" else "$count: $there there now, $more made when you apply"
    }

    /** The fewest there can be is the ones there now, which are never removed: a machine may be on one. */
    fun groupRange(inv: Inventory, c: Choice): IntRange = minOf(groupCount(inv, c.egress), MAX_GROUPS)..MAX_GROUPS


    /** A pool's own machine: a permanent fleet host on the pool that holds it once its owner approves it. */
    data class Holder(val pool: String?, val name: String, val running: Boolean)

    /** The pool's own machine on the pool this network is in, if it has one. */
    fun holderOn(inv: Inventory, network: String?): Holder? {
        val pool = inv.networks.firstOrNull { it.id == network }?.pool ?: return null
        return inv.holders?.firstOrNull { it.pool == pool }
    }

    /**
     * A pool's machine image: the template sessions' machines are cloned
     * from. [key] is which of the catalogue's it is; null from a machine that
     * predates saying, which only ever built Debian.
     */
    data class Image(val pool: String?, val name: String, val key: String? = null)

    /** One operating system an image can be made of. */
    data class ImageKind(val key: String, val os: String)

    /** The image an older machine builds, and what an image that predates saying which it is was made of. */
    const val DEBIAN_KEY = "debian-13"

    /** The images already on the pool this network is in, by key. */
    fun imageKeysOn(inv: Inventory, network: String?): Set<String> {
        val pool = inv.networks.firstOrNull { it.id == network }?.pool ?: return emptySet()
        return (inv.images ?: emptyList()).filter { it.pool == pool }.map { it.key ?: DEBIAN_KEY }.toSet()
    }

    /** The images asked for that the way out's pool does not have yet. */
    fun imagesToBuild(inv: Inventory, c: Choice): Set<String> {
        if (!c.imageChoice || !c.wantsImage) return emptySet()
        return (if (c.imagesChoice) c.images else setOf(DEBIAN_KEY)) - imageKeysOn(inv, c.egress)
    }

    /** The machine image on the pool this network is in, if it has one. */
    fun imageOn(inv: Inventory, network: String?): Image? {
        val pool = inv.networks.firstOrNull { it.id == network }?.pool ?: return null
        return inv.images?.firstOrNull { it.pool == pool }
    }

    /** The machine image's disk, VM_IMAGE.diskSize in vm-image.js. */
    const val IMAGE_DISK = 20L * 1024 * 1024 * 1024

    /** The router or the image is to be built now, on storage still to be picked. */
    fun building(inv: Inventory, c: Choice): Pair<Boolean, Boolean> =
        (c.edge && edgeOn(inv, c.egress) == null) to imagesToBuild(inv, c).isNotEmpty()

    /** How much room the disks being built need: the image's when it is one of them, the router's otherwise. */
    fun diskNeed(inv: Inventory, c: Choice): Long = if (building(inv, c).second) IMAGE_DISK else EDGE_DISK

    /**
     * The edge router on a pool, whether it is running, and whether it drops
     * what its threat rules match (null from a machine that predates saying,
     * which built none that did).
     */
    data class Edge(val pool: String?, val running: Boolean, val sr: String? = null, val blocks: Boolean? = null)

    /** The edge router on the pool this network is in, if it has one. */
    fun edgeOn(inv: Inventory, network: String?): Edge? {
        val pool = inv.networks.firstOrNull { it.id == network }?.pool ?: return null
        return inv.edges?.firstOrNull { it.pool == pool }
    }

    /** The edge router's raw disk, OPNSENSE_IMAGE.rawSize in edge-router.js. */
    const val EDGE_DISK = 3L * 1024 * 1024 * 1024

    /**
     * Storage the router's disk can go on: in the way out's pool, with room
     * for its 3 GiB raw disk. Any the pool listed, not only the fleet's,
     * because the router is not one of the fleet's VMs.
     */
    fun edgeDisks(inv: Inventory, network: String?, need: Long = EDGE_DISK): List<Storage> {
        val pool = inv.networks.firstOrNull { it.id == network }?.pool ?: return emptyList()
        return inv.srs.filter { it.pool == pool && it.free > need }
    }

    /**
     * The storage the router's disk will go on: the person's pick while it
     * still fits on the way out's pool, otherwise the fleet's chosen storage
     * there with the most room, otherwise the pool's. Null when nothing in
     * that pool has room. Asked for: "which disk did it put it on?"
     */
    fun edgeDisk(inv: Inventory, c: Choice): String? {
        val fits = edgeDisks(inv, c.egress, diskNeed(inv, c))
        c.edgeSr?.let { pick -> if (fits.any { it.id == pick }) return pick }
        val fleet = fits.filter { it.id in c.srs }
        return (fleet.ifEmpty { fits }).maxByOrNull { it.free }?.id
    }

    /**
     * What the person has chosen so far. Memory and disk in whole GiB, which
     * is what a stepper moves in and what the machine says back; the payload
     * multiplies them out to bytes.
     */
    data class Choice(
        val srs: Set<String>,
        val networks: Set<String>,
        val egress: String?,
        val cpus: Int,
        val memoryGib: Long,
        val diskGib: Long,
        /**
         * Build the edge router on the way out, or keep the one there in step
         * with it. Needs a way out, and goes with it.
         */
        val edge: Boolean = false,
        /**
         * The machine takes any of the pool's networks as the way out
         * (`egress-any` in begin's `can`), not only one the fleet may use.
         * An older one refuses those, so they are not offered to it.
         */
        val anyWayOut: Boolean = false,
        /** Where the router's disk goes, when the person picked; null is [edgeDisk]'s default. */
        val edgeSr: String? = null,
        /**
         * The machine reads [edgeSr] (`edge-disk` in begin's `can`). An older
         * one ignores it, so it is neither offered nor sent.
         */
        val edgeDiskChoice: Boolean = false,
        /** The edge drops what its threat rules match, rather than only logging it. Changing it on an edge that is there rebuilds it. */
        val edgeBlock: Boolean = false,
        /** The machine builds either kind (`edge-block` in begin's `can`). An older one only logs, so it is neither offered nor sent. */
        val edgeBlockChoice: Boolean = false,
        /**
         * Make the machine image sessions' machines are cloned from, on the
         * way out's pool, behind its router. Needs the router, there or
         * built with it.
         */
        val image: Boolean = false,
        /** The machine builds one (`image` in begin's `can`). An older one cannot, so it is neither offered nor sent. */
        val imageChoice: Boolean = false,
        /**
         * Which images to make, by key, for a machine that builds any of its
         * catalogue (`images` in begin's `can`). Asked for: "os selection
         * not just Debian".
         */
        val images: Set<String> = emptySet(),
        /** The machine takes [images]. An older one is sent `image` alone, and offered Debian alone. */
        val imagesChoice: Boolean = false,
        /** How many group networks the way out's pool is to have. Asked for: "the 3 VMs need to reach each other". */
        val groups: Int = 0,
        /** The machine makes them (`groups` in begin's `can`). An older one cannot, so they are neither offered nor sent. */
        val groupsChoice: Boolean = false,
        /**
         * Make the pool a machine of its own on the way out, or keep the one
         * there running (xo-holder.js). Needs the pool's machine image, there
         * or made with it.
         */
        val holder: Boolean = false,
        /** The machine makes one (`holder` in begin's `can`). An older one cannot, so it is neither offered nor sent. */
        val holderChoice: Boolean = false,
    ) {
        /** An image is asked for, in whichever form this machine reads. */
        val wantsImage: Boolean get() = if (imagesChoice) images.isNotEmpty() else image
    }

    /**
     * The admin sign-in for a policy job, sealed to the job's key under the
     * same binding as setup's (XoSetup.aad), with [reply], the key the pool
     * comes back to, and the purpose beside it. Returned rather than kept:
     * the caller clears the password the moment this returns.
     */
    fun sealSignIn(key: String, job: String, address: String, email: String, password: String, reply: String): String {
        val payload = JSONObject()
            .put("v", 1)
            .put("xo", JSONObject().put("email", email).put("password", password))
            .put("reply", reply)
            .put("purpose", PURPOSE)
        return joined(Seal.seal(key, XoSetup.aad(job, address), payload))
    }

    /**
     * The pool as the machine sealed it, or null for anything that does not
     * open under this job and address with this key, or opens to something
     * that is not an inventory of that address.
     */
    fun openInventory(sealed: String, job: String, address: String, key: Seal.OneUseKey): Inventory? = runCatching {
        val parts = sealed.split(".")
        require(parts.size == 3)
        val box = JSONObject().put("epk", parts[0]).put("iv", parts[1]).put("ct", parts[2])
        parse(Seal.open(key, inventoryAad(job, address), box))?.takeIf { it.address == address }
    }.getOrNull()

    /**
     * An inventory, read tolerantly: anything without an id is dropped, every
     * size is a Long at least zero, a VLAN or a limit that is JSON null stays
     * null (org.json would otherwise hand back 0, and "VLAN 0" and "no
     * limit" are not the same thing as nothing said), and what the fleet may
     * use now is held to ids the inventory lists.
     */
    fun parse(json: JSONObject): Inventory? {
        if (json.optInt("v", 0) != 1) return null
        val address = json.optString("address").takeIf { it.isNotBlank() && !json.isNull("address") } ?: return null
        fun text(o: JSONObject, key: String): String? = o.takeIf { it.has(key) && !it.isNull(key) }?.optString(key)?.takeIf { it.isNotBlank() }
        fun objects(key: String): List<JSONObject> {
            val a: JSONArray = json.optJSONArray(key) ?: return emptyList()
            return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
        }
        val pools = objects("pools").mapNotNull { p -> text(p, "id")?.let { Pool(it, text(p, "name") ?: "") } }
        val srs = objects("srs").mapNotNull { s ->
            val id = text(s, "id") ?: return@mapNotNull null
            Storage(
                id = id,
                name = text(s, "name") ?: "",
                pool = text(s, "pool"),
                size = s.optLong("size", 0L).coerceAtLeast(0L),
                free = s.optLong("free", 0L).coerceAtLeast(0L),
                shared = s.optBoolean("shared", false),
            )
        }
        val networks = objects("networks").mapNotNull { n ->
            val id = text(n, "id") ?: return@mapNotNull null
            Network(
                id = id,
                name = text(n, "name") ?: "",
                pool = text(n, "pool"),
                vlan = if (!n.has("vlan") || n.isNull("vlan")) null else n.optInt("vlan", -1).takeIf { it >= 0 },
                egress = n.optBoolean("egress", false),
            )
        }
        val capacity = json.optJSONObject("capacity")
        val current = json.optJSONObject("current")
        fun ids(key: String, known: Set<String>): List<String> {
            val a = current?.optJSONArray(key) ?: return emptyList()
            return (0 until a.length()).mapNotNull { i -> a.optString(i, "").takeIf { !a.isNull(i) && it in known } }.distinct()
        }
        val limits = current?.optJSONObject("limits")
        fun limit(key: String): Long? {
            if (limits == null || !limits.has(key) || limits.isNull(key)) return null
            val v = limits.optDouble(key, Double.NaN)
            return if (v.isFinite() && v > 0) v.roundToLong() else null
        }
        return Inventory(
            address = address,
            pools = pools,
            srs = srs,
            networks = networks,
            cpus = capacity?.optInt("cpus", 0)?.coerceAtLeast(0) ?: 0,
            memory = capacity?.optLong("memory", 0L)?.coerceAtLeast(0L) ?: 0L,
            currentSrs = ids("srs", srs.map { it.id }.toSet()),
            currentNetworks = ids("networks", networks.map { it.id }.toSet()),
            currentLimits = Limits(limit("cpus"), limit("memory"), limit("disk")),
            edges = json.optJSONArray("edges")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    a.optJSONObject(i)?.let { e ->
                        Edge(text(e, "pool"), e.optBoolean("running", false), text(e, "sr"), if (e.has("blocks")) e.optBoolean("blocks", false) else null)
                    }
                }
            },
            images = json.optJSONArray("images")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    a.optJSONObject(i)?.let { m -> Image(text(m, "pool"), text(m, "name") ?: "Fleetwright Debian 13", text(m, "key")) }
                }
            },
            holders = json.optJSONArray("holders")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    a.optJSONObject(i)?.let { h -> Holder(text(h, "pool"), text(h, "name") ?: "", h.optBoolean("running", false)) }
                }
            },
            groups = json.optJSONArray("groups")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    a.optJSONObject(i)?.let { g ->
                        val id = text(g, "id") ?: return@let null
                        GroupNetwork(id, text(g, "name") ?: id, text(g, "pool"))
                    }
                }
            },
            imageKinds = json.optJSONArray("imageKinds")?.let { a ->
                (0 until a.length()).mapNotNull { i ->
                    a.optJSONObject(i)?.let { k ->
                        val key = text(k, "key") ?: return@let null
                        ImageKind(key, text(k, "os") ?: key)
                    }
                }
            },
        )
    }

    // THE BOUNDS, as checkPolicy works them out: at least a usable machine,
    // at most what is there. A pool that reported nothing still has room for
    // the minimum, because the machine allows exactly that.
    fun maxCpus(inv: Inventory): Int = maxOf(1, inv.cpus)
    fun maxMemoryGib(inv: Inventory): Long = maxOf(MIN_MEMORY, inv.memory) / GIB
    fun maxDiskGib(inv: Inventory, srs: Set<String>): Long = maxOf(MIN_DISK, room(inv, srs)) / GIB

    /** What the chosen storage holds in all, which is as much disk as the fleet could be allowed. */
    fun room(inv: Inventory, srs: Set<String>): Long = inv.srs.filter { it.id in srs }.sumOf { it.size }

    /**
     * Where the form starts: what the fleet may use now, and for a limit with
     * nothing set, half of what is there, as setup's own defaults are. The
     * way out starts on the network already tagged as it, when the machine
     * would take that network as the way out; otherwise none, which the
     * person can change.
     */
    fun defaults(inv: Inventory, anyWayOut: Boolean = false): Choice {
        val srs = inv.currentSrs.toSet()
        val networks = inv.currentNetworks.toSet()
        val egress = inv.networks.firstOrNull { it.egress && (anyWayOut || it.id in networks) }?.id
        val cpus = (inv.currentLimits.cpus ?: (inv.cpus / 2).toLong()).coerceIn(1L, maxCpus(inv).toLong()).toInt()
        val memory = (inv.currentLimits.memory?.let { gibRounded(it) } ?: (inv.memory / 2 / GIB)).coerceIn(1L, maxMemoryGib(inv))
        val free = inv.srs.filter { it.id in srs }.sumOf { it.free }
        val disk = (inv.currentLimits.disk?.let { gibRounded(it) } ?: (free / 2 / GIB)).coerceIn(MIN_DISK / GIB, maxDiskGib(inv, srs))
        // On when there is one already, so Apply keeps it on the way out; the
        // same for the pool's own machine, which Apply keeps, or starts.
        // As many group networks as there are: Apply asks for none it does not show.
        return Choice(
            srs, networks, egress, cpus, memory, disk,
            edge = edgeOn(inv, egress) != null, anyWayOut = anyWayOut, groups = groupCount(inv, egress),
            // As it is: Apply rebuilds nothing the person did not change.
            edgeBlock = edgeOn(inv, egress)?.blocks ?: false,
            holder = holderOn(inv, egress) != null,
        )
    }

    /**
     * Storage switched on or off. The disk limit follows it down, because
     * it cannot be more than the storage chosen holds.
     */
    fun withStorage(inv: Inventory, c: Choice, id: String, on: Boolean): Choice {
        val srs = if (on) c.srs + id else c.srs - id
        return c.copy(srs = srs, diskGib = c.diskGib.coerceIn(MIN_DISK / GIB, maxDiskGib(inv, srs)))
    }

    /**
     * A network switched on or off. On a machine that holds the way out to
     * the networks chosen, switching that one off leaves none; on one that
     * takes any of the pool's, the way out stays where it is.
     */
    fun withNetwork(c: Choice, id: String, on: Boolean): Choice {
        val networks = if (on) c.networks + id else c.networks - id
        val egress = c.egress?.takeIf { c.anyWayOut || it in networks }
        return c.copy(networks = networks, egress = egress, edge = c.edge && egress != null, holder = c.holder && egress != null)
    }

    /**
     * How far one press of a stepper moves: one, until a range is long
     * enough that one at a time is a chore, then the largest power of two
     * that crosses it in about sixteen presses. Powers of two because that is
     * how memory is sized, and disk does not mind.
     */
    fun stepFor(max: Long): Long {
        var step = 1L
        while (step * 2 <= max / 16) step *= 2
        return step
    }

    /**
     * What stops this choice being applied, in the machine's own words, or
     * null when it would take it. The same checks in the same order as
     * checkPolicy, so the sentence under a switched-off Apply is the one the
     * machine would have sent back.
     */
    fun problem(inv: Inventory, c: Choice): String? {
        if (c.srs.isEmpty()) return "Choose at least one storage repository: a VM needs somewhere for its disk."
        val srIds = inv.srs.map { it.id }.toSet()
        val networkIds = inv.networks.map { it.id }.toSet()
        if (!srIds.containsAll(c.srs) || !networkIds.containsAll(c.networks)) {
            return "That names storage or a network this pool did not list. Nothing was changed."
        }
        if (c.egress != null && c.egress !in networkIds) return "The way out has to be a network this pool listed. Nothing was changed."
        if (!c.anyWayOut && c.egress != null && c.egress !in c.networks) return "The way out has to be one of the networks the fleet may use."
        if (c.edge && c.egress == null) return "The edge router needs a way out: choose the network its WAN goes on."
        if (c.groupsChoice && c.groups > 0 && c.egress == null) {
            return "Group networks are made in the way out’s pool: choose the way out. Nothing was changed."
        }
        if (c.imageChoice && c.wantsImage && c.egress == null) {
            return "The machine image is built behind the edge router: choose the way out it leaves through."
        }
        if (c.imageChoice && c.wantsImage && !c.edge && edgeOn(inv, c.egress) == null) {
            return "The machine image is built behind the edge router, and that pool has none yet. Build the router with it."
        }
        if (c.holderChoice && c.holder && c.egress == null) return "The pool’s own machine goes on the way out: choose the network it is on."
        if (c.holderChoice && c.holder && imageOn(inv, c.egress) == null && !(c.imageChoice && c.wantsImage)) {
            return "The pool’s own machine is made from its machine image, and that pool has none yet. Build one with it."
        }
        val (buildEdge, buildImage) = building(inv, c)
        if (c.edgeDiskChoice && (buildEdge || buildImage) && edgeDisk(inv, c) == null) {
            return if (buildImage) "Nothing in the way out’s pool has 20 GiB free for the machine image’s disk."
            else "Nothing in the way out’s pool has 3 GiB free for the edge router’s disk."
        }
        val maxCpus = maxCpus(inv)
        if (c.cpus < 1 || c.cpus > maxCpus) return "vCPUs are between 1 and $maxCpus, what the pool has."
        val maxMemory = maxOf(MIN_MEMORY, inv.memory)
        val memory = c.memoryGib * GIB
        if (memory < MIN_MEMORY || memory > maxMemory) return "Memory is between 1 GiB and ${gib(maxMemory)}, what the pool has."
        val maxDisk = maxOf(MIN_DISK, room(inv, c.srs))
        val disk = c.diskGib * GIB
        if (disk < MIN_DISK || disk > maxDisk) return "Disk is between 10 GiB and ${gib(maxDisk)}, the size of the storage chosen."
        return null
    }

    /**
     * The choice as the machine reads it: ids in the order the pool listed
     * them, the way out or JSON null, and the limits in bytes.
     */
    fun payload(inv: Inventory, c: Choice): JSONObject =
        JSONObject()
            .put("v", 1)
            .put("srs", JSONArray(inv.srs.map { it.id }.filter { it in c.srs }))
            .put("networks", JSONArray(inv.networks.map { it.id }.filter { it in c.networks }))
            .put("egress", c.egress ?: JSONObject.NULL)
            .put("edge", c.edge)
            .put("limits", JSONObject().put("cpus", c.cpus).put("memory", c.memoryGib * GIB).put("disk", c.diskGib * GIB))
            // Only to a machine that builds an image, and only when asked.
            .apply {
                if (c.imageChoice && c.wantsImage) {
                    if (c.imagesChoice) {
                        put("images", JSONArray((inv.imageKinds ?: emptyList()).map { it.key }.filter { it in c.images }))
                    } else {
                        put("image", true)
                    }
                }
            }
            // Only to a machine that makes them, and only with a way out.
            .apply { if (c.groupsChoice && c.egress != null) put("groups", c.groups) }
            // Only to a machine that makes one, and only when asked.
            .apply { if (c.holderChoice && c.holder) put("holder", true) }
            // Only to a machine that reads it, and only with something to build.
            .apply { if (c.edgeBlockChoice && c.edge) put("edgeBlock", c.edgeBlock) }
            .apply { if (c.edgeDiskChoice && (c.edge || (c.imageChoice && c.wantsImage))) put("edgeSr", edgeDisk(inv, c) ?: JSONObject.NULL) }

    /** The choice, sealed to the job's key, as the one string `policy` carries. */
    fun sealChoice(key: String, job: String, address: String, inv: Inventory, c: Choice): String =
        joined(Seal.seal(key, policyAad(job, address), payload(inv, c)))

    /** Bytes as a person reads a size here: whole GiB, rounded, as the machine says them. */
    fun gib(bytes: Long): String = "${gibRounded(bytes)} GiB"

    /** One storage repository's second line: how much is free of how much, and whether every host in the pool sees it. */
    fun storageLine(s: Storage): String = "${gib(s.free)} free of ${gib(s.size)} · ${if (s.shared) "shared" else "local"}"

    /** One network's second line. */
    fun networkLine(n: Network): String = n.vlan?.let { "VLAN $it" } ?: "no VLAN"

    private fun gibRounded(bytes: Long): Long = (bytes.toDouble() / GIB).roundToLong()

    private fun joined(sealed: JSONObject): String = "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
}
