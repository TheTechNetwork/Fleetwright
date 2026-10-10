package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Managing a Xen Orchestra pool from this phone, directly: the rules the
 * screens in PoolPage.kt draw, with no networking in them. docs/manage.md,
 * "The first slice". The same design as Manage.swift, rule for rule.
 *
 * A COMPONENT HAS THREE PARTS, and every row and every page is built from
 * them, so a pool, a host, a VM and a storage repository are the same kind of
 * row (RHYTHM 1): what it is (its name, its kind, where it lives and what it
 * belongs to), how it is (one state from a fixed set, and the numbers behind
 * it), and what it can do (the actions that exist for it now, and what each
 * costs).
 *
 * AN ACTION IS DRAWN ONLY WHEN THE SERVER LISTS ITS METHOD (C-2).
 * `system.getMethodsInfo` is Xen Orchestra's own list, so an action whose
 * method this server does not offer is not drawn, rather than drawn and
 * refused. A list that could not be read is cannot tell and draws nothing.
 *
 * WHAT IT COSTS TO UNDO decides how it is confirmed. Reversible (start,
 * resume, a snapshot, maintenance mode) is one tap. Interrupting (shut down,
 * reboot, pause, suspend) asks, naming what it interrupts. Destructive
 * (forcing a VM off or to restart, deleting one) asks for the name typed
 * back. Growing a disk asks too: nothing is lost, and it cannot be undone.
 *
 * MISSING IS CANNOT TELL. A token sees only what its user may see, so a VM
 * can sit on a host the list does not have, and a field Xen Orchestra did not
 * send is said as not known rather than drawn as a zero or a blank (C-5).
 *
 * HELD TO iOS BY A TABLE, test/fixtures/parity/manage.json, which
 * ManageParityTest runs here and ManageParityTests.swift runs there: change a
 * sentence or a rule in one and that table has to change, which fails the
 * other until it agrees.
 */
internal object Manage {

    // --- What is listed ---------------------------------------------------

    enum class Kind(val raw: String) { POOL("pool"), HOST("host"), VM("vm"), SR("sr") }

    /**
     * How a host or a VM is. Null is cannot tell, and a pool or a storage
     * repository has none of its own: its numbers say how it is.
     */
    enum class State { RUNNING, STOPPED, SUSPENDED, PAUSED, MAINTENANCE }

    data class Component(
        val id: String,
        val kind: Kind,
        val name: String,
        val state: State?,
        val poolId: String?,
        /**
         * Xen Orchestra's `$container`: the host a running VM or a local
         * storage repository is on, or the pool when it is on none.
         */
        val containerId: String?,
        /** A VM's vCPUs, a host's cores. */
        val cpus: Int?,
        /** A VM's memory, a host's total. */
        val memory: Long?,
        /** A host's memory in use. */
        val memoryUsed: Long?,
        /** A storage repository's size, and what is physically used of it. */
        val size: Long?,
        val used: Long?,
        /** A VM's main address, a host's management address. */
        val address: String?,
        /**
         * A VM's guest tools: true when either the agent or the drivers were
         * detected, false when both were said to be missing, null when
         * neither was said.
         */
        val toolsRunning: Boolean?,
        val storageType: String?,
        val shared: Boolean?,
        /** A host's "XCP-ng 8.3.0". */
        val software: String?,
    )

    /** A VM's disk, for growing it. */
    data class Disk(val id: String, val name: String, val size: Long?, val storageId: String?)

    /** A VBD: which disk is attached to which VM, and where. */
    data class Attachment(val vm: String, val vdi: String?, val cd: Boolean, val position: String)

    /** The types read, each with its own `xo.getAllObjects` filter. */
    val objectTypes = listOf("pool", "host", "VM", "SR", "VBD", "VDI")

    // --- Decoding what Xen Orchestra sent ---------------------------------

    fun text(any: Any?): String? = (any as? String)?.trim()?.takeIf { it.isNotEmpty() }

    /** A count or a size. org.json's booleans are not Numbers, so a flag is never one. */
    fun number(any: Any?): Long? {
        val n = any as? Number ?: return null
        val d = n.toDouble()
        if (!d.isFinite() || d < 0 || d >= 9.0e18) return null
        return d.toLong()
    }

    fun flag(any: Any?): Boolean? = any as? Boolean

    fun kindWord(kind: Kind): String = when (kind) {
        Kind.POOL -> "pool"
        Kind.HOST -> "host"
        Kind.VM -> "VM"
        Kind.SR -> "storage"
    }

    fun component(o: JSONObject): Component? {
        val id = text(o.opt("id")) ?: return null
        // As String because Android marks opt() @RecentlyNullable, and over that
        // type Kotlin 2.4 calls the when below not exhaustive, else and all.
        val kind = when (o.opt("type") as? String) {
            "pool" -> Kind.POOL
            "host" -> Kind.HOST
            "VM" -> Kind.VM
            "SR" -> Kind.SR
            else -> return null
        }
        val memory = o.optJSONObject("memory")
        val agent = flag(o.opt("managementAgentDetected"))
        val drivers = flag(o.opt("pvDriversDetected"))
        val tools = when {
            agent == true || drivers == true -> true
            agent == false || drivers == false -> false
            else -> null
        }
        val software = listOfNotNull(text(o.opt("productBrand")), text(o.opt("version"))).joinToString(" ")
        val count = when (kind) {
            Kind.VM -> number(o.optJSONObject("CPUs")?.opt("number"))
            Kind.HOST -> number(o.optJSONObject("cpus")?.opt("cores"))
            else -> null
        }
        val sized = kind == Kind.VM || kind == Kind.HOST
        val storage = kind == Kind.SR
        return Component(
            id = id,
            kind = kind,
            name = text(o.opt("name_label")) ?: "Unnamed ${kindWord(kind)} ${id.take(8)}",
            state = state(kind, o),
            poolId = text(o.opt("\$pool")),
            containerId = text(o.opt("\$container")),
            cpus = count?.toInt(),
            memory = if (sized) number(memory?.opt("size")) else null,
            memoryUsed = if (kind == Kind.HOST) number(memory?.opt("usage")) else null,
            size = if (storage) number(o.opt("size")) else null,
            used = if (storage) number(o.opt("physical_usage")) else null,
            address = when (kind) {
                Kind.VM -> vmAddress(o)
                Kind.HOST -> text(o.opt("address"))
                else -> null
            },
            toolsRunning = if (kind == Kind.VM) tools else null,
            storageType = if (storage) text(o.opt("SR_type")) else null,
            shared = if (storage) flag(o.opt("shared")) else null,
            software = if (kind == Kind.HOST && software.isNotEmpty()) software else null,
        )
    }

    fun state(kind: Kind, o: JSONObject): State? {
        val power = o.opt("power_state") as? String
        return when (kind) {
            Kind.VM -> when (power) {
                "Running" -> State.RUNNING
                "Halted" -> State.STOPPED
                "Suspended" -> State.SUSPENDED
                "Paused" -> State.PAUSED
                else -> null
            }
            // A disabled host takes no new VMs: maintenance mode, as Xen
            // Orchestra's own screens call it.
            Kind.HOST -> when (power) {
                "Halted" -> State.STOPPED
                "Running" -> if (flag(o.opt("enabled")) == false) State.MAINTENANCE else State.RUNNING
                else -> null
            }
            Kind.POOL, Kind.SR -> null
        }
    }

    /** The address a VM's guest agent reported: the main one, or the first IPv4 one, as xo-pools.js reads it. */
    fun vmAddress(o: JSONObject): String? {
        text(o.opt("mainIpAddress"))?.let { return it }
        val all = o.optJSONObject("addresses") ?: return null
        val keys = all.keys().asSequence().toList().sorted()
        val key = keys.firstOrNull { it.contains("ipv4") } ?: keys.firstOrNull() ?: return null
        return text(all.opt(key))
    }

    fun attachment(o: JSONObject): Attachment? {
        val vm = text(o.opt("VM")) ?: return null
        return Attachment(vm, text(o.opt("VDI")), flag(o.opt("is_cd_drive")) == true, text(o.opt("position")) ?: "")
    }

    fun disk(o: JSONObject): Disk? {
        val id = text(o.opt("id")) ?: return null
        return Disk(id, text(o.opt("name_label")) ?: "Unnamed disk ${id.take(8)}", number(o.opt("size")), text(o.opt("\$SR")))
    }

    // --- What the phone knows about the pool ------------------------------

    /**
     * Everything read, kept current from the notifications Xen Orchestra
     * pushes on the same socket rather than by asking again. Each change is a
     * new picture, so the screen that reads it recomposes.
     */
    data class Snapshot(
        val components: Map<String, Component> = emptyMap(),
        val disks: Map<String, Disk> = emptyMap(),
        val attachments: Map<String, Attachment> = emptyMap(),
    ) {
        /** What `xo.getAllObjects` answered: objects keyed by id, or a list of them from an older server. */
        fun taking(answer: Any?): Snapshot = edit { b ->
            when (answer) {
                is JSONObject -> answer.keys().forEach { id -> answer.optJSONObject(id)?.let { b.enter(it) } }
                is JSONArray -> for (i in 0 until answer.length()) answer.optJSONObject(i)?.let { b.enter(it) }
            }
        }

        /**
         * A notification from the socket. Only `all` carries objects: an
         * `enter` is an object that arrived or changed, an `exit` one that
         * went. Null for anything else, which changes nothing.
         */
        fun applying(method: String, params: Any?): Snapshot? {
            if (method != "all") return null
            val p = params as? JSONObject ?: return null
            val type = p.opt("type") as? String ?: return null
            val items = p.optJSONObject("items") ?: return null
            return edit { b ->
                items.keys().forEach { id ->
                    if (type == "exit") b.leave(id) else if (type == "enter") items.optJSONObject(id)?.let { b.enter(it) }
                }
            }
        }

        /** One kind, by name, the way a person scans for one. */
        fun list(kind: Kind): List<Component> =
            components.values.filter { it.kind == kind }.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))

        val isEmpty: Boolean get() = components.isEmpty()

        /** The host a VM or a storage repository is on, when it is on one: `$container` names the pool otherwise. */
        fun hostId(c: Component): String? {
            val container = c.containerId ?: return null
            return if (container == c.poolId) null else container
        }

        /** How many VMs this token can see running on a host. */
        fun runningOn(hostId: String): Int =
            components.values.count { it.kind == Kind.VM && it.state == State.RUNNING && hostId(it) == hostId }

        /** A VM's disks, CD drives left out, in the order they are attached. */
        fun attachedDisks(vmId: String): List<Disk> =
            attachments.values
                .filter { it.vm == vmId && !it.cd && it.vdi != null }
                .sortedWith(compareBy({ it.position.toIntOrNull() ?: Int.MAX_VALUE }, { it.position }))
                .mapNotNull { a -> a.vdi?.let { disks[it] } }

        private fun edit(block: (Builder) -> Unit): Snapshot {
            val b = Builder(this)
            block(b)
            return b.build()
        }
    }

    private class Builder(s: Snapshot) {
        val components = s.components.toMutableMap()
        val disks = s.disks.toMutableMap()
        val attachments = s.attachments.toMutableMap()

        fun enter(o: JSONObject) {
            val id = text(o.opt("id")) ?: return
            when (o.opt("type") as? String) {
                "VBD" -> attachment(o)?.let { attachments[id] = it }
                "VDI" -> disk(o)?.let { disks[id] = it }
                else -> component(o)?.let { components[id] = it }
            }
        }

        fun leave(id: String) {
            components.remove(id)
            disks.remove(id)
            attachments.remove(id)
        }

        fun build() = Snapshot(components.toMap(), disks.toMap(), attachments.toMap())
    }

    // --- Words ------------------------------------------------------------

    /**
     * Sizes in powers of 1024, as Xen Orchestra reports them, to a tenth,
     * rounded half up by hand so both phones round alike.
     */
    fun bytes(b: Long): String {
        val units = listOf((1L shl 40) to "TiB", (1L shl 30) to "GiB", (1L shl 20) to "MiB")
        for ((size, unit) in units) {
            if (b >= size) {
                val tenths = Math.round(b.toDouble() / size * 10)
                return if (tenths % 10 == 0L) "${tenths / 10} $unit" else "${tenths / 10}.${tenths % 10} $unit"
            }
        }
        return "$b byte${if (b == 1L) "" else "s"}"
    }

    fun stateWords(state: State?): String = when (state) {
        State.RUNNING -> "running"
        State.STOPPED -> "stopped"
        State.SUSPENDED -> "suspended"
        State.PAUSED -> "paused"
        State.MAINTENANCE -> "in maintenance mode"
        null -> "cannot tell"
    }

    /** The state word a row carries, or null for a kind that has no state. */
    fun stateWords(c: Component): String? =
        if (c.kind == Kind.VM || c.kind == Kind.HOST) stateWords(c.state) else null

    fun poolWords(id: String?, s: Snapshot): String {
        val p = id?.let { s.components[it] }
        return if (p != null && p.kind == Kind.POOL) "pool ${p.name}" else "a pool this token cannot see"
    }

    /** What it is: its kind, and where it lives. */
    fun what(c: Component, s: Snapshot): String = when (c.kind) {
        Kind.POOL -> {
            val n = s.components.values.count { it.kind == Kind.HOST && it.poolId == c.id }
            "Pool of $n host${if (n == 1) "" else "s"}"
        }
        Kind.HOST -> {
            val place = "Host in ${poolWords(c.poolId, s)}"
            c.software?.let { "$place · $it" } ?: place
        }
        Kind.VM -> {
            val hostId = s.hostId(c)
            if (hostId != null) {
                val host = s.components[hostId]
                if (host == null || host.kind != Kind.HOST) "VM on a host this token cannot see"
                else "VM on ${host.name} in ${poolWords(c.poolId, s)}"
            } else {
                "VM in ${poolWords(c.poolId, s)}, not on a host"
            }
        }
        Kind.SR -> {
            val parts = mutableListOf("Storage")
            c.storageType?.let { parts.add(it) }
            val hostId = s.hostId(c)
            if (hostId != null) {
                val host = s.components[hostId]
                parts.add(if (host != null && host.kind == Kind.HOST) "on ${host.name}" else "on a host this token cannot see")
            } else if (c.shared == true || c.containerId != null) {
                parts.add("shared by ${poolWords(c.poolId, s)}")
            }
            parts.joinToString(", ")
        }
    }

    /** The numbers behind how it is. Each one Xen Orchestra did not send is said as cannot tell, in its place. */
    fun numbers(c: Component, s: Snapshot): String = when (c.kind) {
        Kind.POOL -> {
            val vms = s.components.values.filter { it.kind == Kind.VM && it.poolId == c.id }
            val running = vms.count { it.state == State.RUNNING }
            if (vms.isEmpty()) "No VMs" else "$running of ${vms.size} VMs running"
        }
        Kind.HOST -> {
            val cores = c.cpus?.let { "$it core${if (it == 1) "" else "s"}" } ?: "cores: cannot tell"
            val size = c.memory
            val used = c.memoryUsed
            val memory = when {
                size != null && used != null -> "${bytes(used)} of ${bytes(size)} in use"
                size != null -> "${bytes(size)}, use cannot tell"
                else -> "memory: cannot tell"
            }
            val n = s.runningOn(c.id)
            val vms = if (n == 0) "no VMs running" else "$n VM${if (n == 1) "" else "s"} running"
            listOf(cores, memory, vms).joinToString(" · ")
        }
        Kind.VM -> {
            val parts = mutableListOf(
                c.cpus?.let { "$it vCPU${if (it == 1) "" else "s"}" } ?: "vCPUs: cannot tell",
                c.memory?.let { bytes(it) } ?: "memory: cannot tell",
            )
            c.address?.let { parts.add(it) }
            parts.joinToString(" · ")
        }
        Kind.SR -> {
            val size = c.size
            val used = c.used
            if (size == null || used == null) "space: cannot tell" else "${bytes(maxOf(0L, size - used))} free of ${bytes(size)}"
        }
    }

    /** A disk, as its row says it: its size and where it is kept. */
    fun diskLine(d: Disk, s: Snapshot): String {
        val size = d.size?.let { bytes(it) } ?: "size cannot tell"
        val sr = d.storageId?.let { s.components[it] }
        return if (sr != null && sr.kind == Kind.SR) "$size on ${sr.name}" else "$size on storage this token cannot see"
    }

    // --- What it can do ---------------------------------------------------

    enum class Cost(val raw: String) { REVERSIBLE("reversible"), INTERRUPTING("interrupting"), DESTRUCTIVE("destructive") }

    enum class Verb(val raw: String) {
        START("start"), RESUME("resume"), UNPAUSE("unpause"), SNAPSHOT("snapshot"), CLONE("clone"),
        SHUTDOWN("shutdown"), REBOOT("reboot"), PAUSE("pause"), SUSPEND("suspend"),
        FORCE_REBOOT("forceReboot"), FORCE_SHUTDOWN("forceShutdown"), DELETE("delete"),
        MAINTENANCE_ON("maintenanceOn"), MAINTENANCE_OFF("maintenanceOff"), HOST_REBOOT("hostReboot"),
    }

    /** An action that exists now: what it is called, the method it calls (one the server listed), and its cost. */
    data class Action(val verb: Verb, val label: String, val method: String, val cost: Cost) {
        val id: String get() = verb.raw
    }

    /** How an action is confirmed, decided by what it costs to undo. */
    sealed interface Confirmation {
        object None : Confirmation
        data class Ask(val title: String, val button: String) : Confirmation
        data class TypeName(val title: String, val name: String, val button: String) : Confirmation
    }

    /**
     * The actions that exist for this component now, in the order they are
     * drawn: the ones that undo themselves first, the ones that cannot last.
     * Nothing when the methods could not be read, and nothing when its state
     * is not known, because every one of these depends on it.
     */
    fun offered(c: Component, methods: Set<String>?): List<Action> {
        if (methods == null) return emptyList()
        val state = c.state ?: return emptyList()
        val out = mutableListOf<Action>()
        fun add(verb: Verb, label: String, method: String, cost: Cost, ok: Boolean) {
            if (ok && method in methods) out.add(Action(verb, label, method, cost))
        }
        when (c.kind) {
            Kind.VM -> {
                // NO GUEST TOOLS, NO CLEAN SHUTDOWN: Xen Orchestra asks the
                // guest to shut itself down, and a guest with no agent cannot
                // hear it. Not drawn when it was said to be missing; drawn when
                // nothing was said, because that is cannot tell, not no.
                val tools = c.toolsRunning != false
                add(Verb.START, "Start", "vm.start", Cost.REVERSIBLE, state == State.STOPPED)
                add(Verb.RESUME, "Resume", "vm.resume", Cost.REVERSIBLE, state == State.SUSPENDED)
                add(Verb.UNPAUSE, "Unpause", "vm.unpause", Cost.REVERSIBLE, state == State.PAUSED)
                add(Verb.SNAPSHOT, "Take a snapshot", "vm.snapshot", Cost.REVERSIBLE, true)
                add(Verb.CLONE, "Clone", "vm.clone", Cost.REVERSIBLE, state == State.STOPPED)
                add(Verb.SHUTDOWN, "Shut down", "vm.stop", Cost.INTERRUPTING, state == State.RUNNING && tools)
                add(Verb.REBOOT, "Reboot", "vm.restart", Cost.INTERRUPTING, state == State.RUNNING && tools)
                add(Verb.PAUSE, "Pause", "vm.pause", Cost.INTERRUPTING, state == State.RUNNING)
                add(Verb.SUSPEND, "Suspend", "vm.suspend", Cost.INTERRUPTING, state == State.RUNNING)
                add(Verb.FORCE_REBOOT, "Force a restart", "vm.restart", Cost.DESTRUCTIVE, state == State.RUNNING || state == State.PAUSED)
                add(
                    Verb.FORCE_SHUTDOWN, "Force off", "vm.stop", Cost.DESTRUCTIVE,
                    state == State.RUNNING || state == State.PAUSED || state == State.SUSPENDED,
                )
                add(Verb.DELETE, "Delete", "vm.delete", Cost.DESTRUCTIVE, state == State.STOPPED)
            }
            Kind.HOST -> {
                // setMaintenanceMode moves a host's VMs off first; an older Xen
                // Orchestra has only disable and enable, which is the same mode.
                val modern = "host.setMaintenanceMode" in methods
                add(
                    Verb.MAINTENANCE_ON, "Enter maintenance mode", if (modern) "host.setMaintenanceMode" else "host.disable",
                    Cost.REVERSIBLE, state == State.RUNNING,
                )
                add(
                    Verb.MAINTENANCE_OFF, "Leave maintenance mode", if (modern) "host.setMaintenanceMode" else "host.enable",
                    Cost.REVERSIBLE, state == State.MAINTENANCE,
                )
                add(Verb.HOST_REBOOT, "Reboot", "host.restart", Cost.INTERRUPTING, state == State.RUNNING || state == State.MAINTENANCE)
            }
            Kind.POOL, Kind.SR -> {}
        }
        return out
    }

    fun cloneName(c: Component): String = "${c.name} (clone)"

    /** A snapshot's name: the VM's, and when, in UTC so both phones and Xen Orchestra's own list agree on it. */
    fun stamp(at: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return "${f.format(Date(at))} UTC"
    }

    /** What is sent, in the shapes xo-pools.js and vm-image.js already send. */
    fun params(a: Action, c: Component, now: Long): Map<String, Any> = when (a.verb) {
        Verb.SHUTDOWN, Verb.REBOOT -> mapOf("id" to c.id, "force" to false)
        Verb.FORCE_SHUTDOWN, Verb.FORCE_REBOOT -> mapOf("id" to c.id, "force" to true)
        Verb.SNAPSHOT -> mapOf("id" to c.id, "name" to "${c.name} ${stamp(now)}")
        Verb.CLONE -> mapOf("id" to c.id, "name" to cloneName(c), "full_copy" to false)
        Verb.DELETE -> mapOf("id" to c.id, "deleteDisks" to true)
        Verb.MAINTENANCE_ON ->
            if (a.method == "host.setMaintenanceMode") mapOf("id" to c.id, "maintenance" to true) else mapOf("id" to c.id)
        Verb.MAINTENANCE_OFF ->
            if (a.method == "host.setMaintenanceMode") mapOf("id" to c.id, "maintenance" to false) else mapOf("id" to c.id)
        Verb.START, Verb.RESUME, Verb.UNPAUSE, Verb.PAUSE, Verb.SUSPEND, Verb.HOST_REBOOT -> mapOf("id" to c.id)
    }

    fun confirmation(a: Action, c: Component, s: Snapshot): Confirmation {
        val n = c.name
        return when (a.verb) {
            Verb.SHUTDOWN -> Confirmation.Ask("Shut down $n? Everything running on it stops.", "Shut down")
            Verb.REBOOT -> Confirmation.Ask("Reboot $n? Everything running on it restarts.", "Reboot")
            Verb.PAUSE -> Confirmation.Ask("Pause $n? Everything running on it is frozen until it is unpaused.", "Pause")
            Verb.SUSPEND -> Confirmation.Ask(
                "Suspend $n? Everything running on it stops until it is resumed, from where it left off.", "Suspend",
            )
            Verb.HOST_REBOOT -> {
                val k = s.runningOn(c.id)
                val cost = when (k) {
                    0 -> "No VM this phone can see is running on it."
                    1 -> "1 VM running on it stops with it unless Xen Orchestra moves it to another host first."
                    else -> "$k VMs running on it stop with it unless Xen Orchestra moves them to another host first."
                }
                Confirmation.Ask("Reboot $n? $cost", "Reboot")
            }
            Verb.FORCE_REBOOT -> Confirmation.TypeName(
                "Force $n to restart? It is reset as if its power button were held: anything not saved on it is lost.",
                n, "Force a restart",
            )
            Verb.FORCE_SHUTDOWN -> Confirmation.TypeName(
                "Force $n off? It is cut off as if unplugged: anything not saved on it is lost.", n, "Force it off",
            )
            Verb.DELETE -> Confirmation.TypeName("Delete $n and its disks? This cannot be undone.", n, "Delete it")
            Verb.START, Verb.RESUME, Verb.UNPAUSE, Verb.SNAPSHOT, Verb.CLONE, Verb.MAINTENANCE_ON, Verb.MAINTENANCE_OFF ->
                Confirmation.None
        }
    }

    /** What is said once Xen Orchestra has answered yes. */
    fun done(a: Action, c: Component): String {
        val n = c.name
        return when (a.verb) {
            Verb.START -> "Started $n."
            Verb.RESUME -> "Resumed $n."
            Verb.UNPAUSE -> "Unpaused $n."
            Verb.SNAPSHOT -> "Took a snapshot of $n."
            Verb.CLONE -> "Cloned $n as ${cloneName(c)}."
            Verb.SHUTDOWN -> "Shut down $n."
            Verb.REBOOT -> "Rebooted $n."
            Verb.PAUSE -> "Paused $n."
            Verb.SUSPEND -> "Suspended $n."
            Verb.FORCE_REBOOT -> "Forced $n to restart."
            Verb.FORCE_SHUTDOWN -> "Forced $n off."
            Verb.DELETE -> "Deleted $n and its disks."
            Verb.MAINTENANCE_ON -> "$n is in maintenance mode."
            Verb.MAINTENANCE_OFF -> "$n is out of maintenance mode."
            Verb.HOST_REBOOT -> "Rebooting $n."
        }
    }

    // --- Its size ---------------------------------------------------------

    const val GIB = 1L shl 30

    /**
     * vCPUs and memory, offered only while the VM is stopped: Xen Orchestra
     * changes a running VM's only within limits set while it was stopped,
     * and a change that might be refused is not offered as one.
     */
    fun canResize(c: Component, methods: Set<String>?): Boolean =
        c.kind == Kind.VM && c.state == State.STOPPED && methods?.contains("vm.set") == true

    /** The sentence in its place on a VM that could be resized if stopped. */
    fun resizeNeedsStopped(c: Component, methods: Set<String>?): Boolean =
        c.kind == Kind.VM && c.state != null && c.state != State.STOPPED && methods?.contains("vm.set") == true

    /** How a disk is grown, in the host's order (RESIZE_METHODS in src/fleet/host/xo-setup.js). */
    val growMethods = listOf("disk.resize", "vdi.set")

    /** Running or not; null when neither method is listed or the VM's state is not known. */
    fun growMethod(c: Component, methods: Set<String>?): String? {
        if (c.kind != Kind.VM || c.state == null || methods == null) return null
        return growMethods.firstOrNull { it in methods }
    }

    fun resizeParams(c: Component, cpus: Int, memoryGib: Int): Map<String, Any> =
        mapOf("id" to c.id, "CPUs" to cpus, "memory" to memoryGib.toLong() * GIB)

    fun resized(c: Component, cpus: Int, memoryGib: Int): String =
        "${c.name} now has $cpus vCPU${if (cpus == 1) "" else "s"} and ${bytes(memoryGib.toLong() * GIB)}."

    fun growParams(d: Disk, toGib: Int): Map<String, Any> = mapOf("id" to d.id, "size" to toGib.toLong() * GIB)

    fun growConfirmation(d: Disk, toGib: Int): Confirmation =
        Confirmation.Ask("Grow ${d.name} to ${bytes(toGib.toLong() * GIB)}? A disk cannot be made smaller again.", "Grow it")

    fun grown(d: Disk, toGib: Int): String = "${d.name} is now ${bytes(toGib.toLong() * GIB)}."

    // --- The token this phone holds ---------------------------------------

    /**
     * What setup sealed back to this phone (XoHandoff), as much of it as
     * connecting needs. The admin sign-in is not in it and never was: a
     * password used to make a token is dropped on the machine that used it.
     * [expires] null is the server's own default length, which it does not say.
     */
    data class Record(val token: String, val pin: String?, val plain: Boolean, val user: String?, val expires: Long?)

    fun record(raw: String, address: String): Record? {
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        if (o.opt("address") != address) return null
        val token = o.opt("token") as? String
        if (token.isNullOrEmpty()) return null
        val expires = (o.opt("tokenExpires") as? String)?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
        return Record(token, text(o.opt("pin")), flag(o.opt("plain")) == true, text(o.opt("user")), expires)
    }

    /** A certificate's SHA-256 as the host writes a pin: lowercase hex of the DER (certSha256 in xo-ws.js). */
    fun fingerprint(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    // --- When it was last looked at ---------------------------------------

    /**
     * Nothing watches a phone-direct pool while the app is closed, so the
     * screen says when it last knew. Kept per address, as epoch
     * milliseconds in plain preferences; not a secret.
     */
    fun lastLooked(settings: Settings, address: String): Long? = runCatching {
        JSONObject(settings.xoLooked.ifBlank { "{}" }).optLong(address, -1L).takeIf { it > 0 }
    }.getOrNull()

    fun rememberLooked(settings: Settings, address: String, at: Long) {
        val all = runCatching { JSONObject(settings.xoLooked.ifBlank { "{}" }) }.getOrDefault(JSONObject())
        settings.xoLooked = all.put(address, at).toString()
    }

    // --- Sentences --------------------------------------------------------

    /** Every sentence the screens say about a pool, in one place, held equal to Manage.swift's by the shared table. */
    object Words {
        const val watching = "Watching now. Changes arrive as Xen Orchestra makes them."
        fun connecting(address: String) = "Connecting to $address…"
        const val never = "Not looked at from this phone yet."
        const val closed = "Nothing watches while the app is closed."
        fun lookedAt(time: String) = "Last looked at $time. $closed"
        fun rowLooked(time: String) = "Last looked at $time"
        fun plainPool(address: String) =
            "$address was set up over plain HTTP. This phone manages a pool only over HTTPS, with the certificate pinned at setup, " +
                "so it does not connect to this one."
        fun noToken(address: String) = "This phone holds no token for $address any more. Run Add a hypervisor again for it."
        fun expired(address: String, date: String) = "Its token ran out on $date. Run Add a hypervisor again for $address to make a new one."
        fun wrongCertificate(address: String) =
            "$address answered with a different certificate from the one pinned when it was set up. Nothing was sent. " +
                "If Xen Orchestra’s certificate changed, run Add a hypervisor again for it."
        fun signInRefused(address: String, why: String) =
            "Xen Orchestra refused this phone’s token for $address: $why. If it ran out or was revoked, run Add a hypervisor again for it."
        const val noObjects = "This Xen Orchestra does not offer xo.getAllObjects, so nothing can be listed."
        fun lost(why: String) = "The connection ended: $why. Look again to reconnect."
        /** Away from the pool's network, said as that rather than as a connection that ended (Manage.swift says why). */
        fun unreachable(address: String, why: String) =
            "This phone could not reach $address: $why. The pool’s page works from the pool’s own network or over a VPN to it; " +
                "changing what the fleet may use works from anywhere, through one of your machines."
        /** While a machine is asked to read it instead. */
        fun askingFleet(address: String) = "This phone cannot reach $address from here, so it is asking one of your machines that can."
        /** Read through a machine, said with when: nothing pushes changes that way, so "Watching now" would claim what is not happening (C-5). */
        fun through(host: String, time: String) =
            "Read through $host at $time. This phone cannot reach the pool from here, so the page is read there again every 20 seconds while it is open."
        fun throughLost(host: String, why: String) = "$host stopped reading this pool for the phone: $why. What is shown is from the last time it did."
        fun unreachableEverywhere(address: String, why: String, fleetWhy: String) =
            "This phone could not reach $address: $why. None of your machines could read it for the phone either: $fleetWhy"
        /** When the fleet did not say which machine read it. */
        const val oneOfYours = "one of your machines"
        const val methodsUnknown = "Cannot tell which actions this Xen Orchestra offers, so none are drawn."
        const val nothingOffered = "Nothing Xen Orchestra offers can be done to it in the state it is in."
        const val seesNothing = "This token sees nothing on the pool."
        fun limitedUser(user: String) =
            "Signed in as $user, the limited user setup made, so only what its resource set allows is listed."
        const val tuneNeedsStopped = "vCPUs and memory change only while it is stopped."
        const val growNote = "A disk can grow while the VM runs. It cannot be made smaller again."
        fun refused(why: String) = "Xen Orchestra refused: $why"
        const val slow = "Xen Orchestra did not answer in time. It may still be doing it; the list shows what it reports."
        fun typePrompt(name: String) = "Type $name to confirm."
        const val actionsFooter = "Each action is here only because this Xen Orchestra lists its method. Shutting down, rebooting, " +
            "pausing and suspending ask first; forcing a VM off or deleting one asks for its name typed back."
        const val gone = "Xen Orchestra no longer lists it. It may have been deleted, or this token can no longer see it."
        const val lookAgain = "Look again"
        const val changePolicy = "Change what the fleet may use"
        const val whatItIs = "What it is"
        const val howItIs = "How it is"
        const val whatItCanDo = "What it can do"
        fun resizeButton(cpus: Int, memoryGib: Int) = "Set to $cpus vCPU${if (cpus == 1) "" else "s"} and $memoryGib GiB"
        fun growButton(disk: String, toGib: Int) = "Grow $disk to $toGib GiB"

        /** A section of the pool's page. */
        fun heading(kind: Kind) = when (kind) {
            Kind.POOL -> "Pools"
            Kind.HOST -> "Hosts"
            Kind.VM -> "VMs"
            Kind.SR -> "Storage"
        }

        /** What a component is, on its own page. */
        fun kindTitle(kind: Kind) = when (kind) {
            Kind.POOL -> "Pool"
            Kind.HOST -> "Host"
            Kind.VM -> "VM"
            Kind.SR -> "Storage"
        }
    }
}
