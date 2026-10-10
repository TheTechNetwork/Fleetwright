package network.thetech.fleetwright

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * One pool, watched from this phone while its page is open. docs/manage.md,
 * "The first slice". The same design as PoolWatch.swift.
 *
 * WHERE THE TOKEN COMES FROM. A pool added through Add a hypervisor already
 * has its token here: setup sealed it back to this phone, and XoHandoff keeps
 * the record encrypted under the address, with the certificate the person
 * accepted as its pin. So connecting is reading that record. Nothing else is
 * read for it: never XoSaved, which keeps the admin sign-in for setup when a
 * person asks it to, because a password used to make a token is not a thing
 * this screen holds.
 *
 * WHAT THAT TOKEN REACHES is what the `fleetwright` user setup made may see:
 * Xen Orchestra gives every token its user's rights, and that user's are its
 * resource set's. The screen says so in a sentence rather than presenting a
 * short list as the whole pool (C-5).
 *
 * WHILE THE PAGE IS OPEN, AND NOT OTHERWISE. The socket opens when the pool's
 * page does, stays current from the `all` notifications, and closes when the
 * page goes or the app stops. Nothing watches while the app is closed, so
 * what is kept is when it was last looked at, and the screen says that time
 * rather than implying the picture is current.
 *
 * Every method here runs on the main thread, from [scope]: the composition's.
 */
internal class PoolWatch(private val settings: Settings, val address: String, private val scope: CoroutineScope) {

    sealed interface Phase {
        object Idle : Phase
        object Connecting : Phase
        object Live : Phase

        /**
         * Not connected, a sentence saying why, and whether looking again could
         * change the answer: a lost connection can, a pool set up over plain
         * HTTP cannot, and a button that can only fail is not drawn.
         */
        data class Stopped(val why: String, val retry: Boolean) : Phase
    }

    var phase by mutableStateOf<Phase>(Phase.Idle)
        private set
    var snapshot by mutableStateOf(Manage.Snapshot())
        private set

    /** The methods this Xen Orchestra lists. Null is cannot tell, which offers nothing (C-2). */
    var methods by mutableStateOf<Set<String>?>(null)
        private set
    var lookedAt by mutableStateOf(Manage.lastLooked(settings, address))
        private set

    /** The user the token is for, as the record names it. */
    var user by mutableStateOf<String?>(null)
        private set

    private var link: XoLink? = null

    /**
     * Bumped by every start and every stop. STOPPED WHILE IT WAITED: the page
     * went, or the app stopped, between one answer and the next; whatever
     * came of the wait is not news then, and stop() has already said what is.
     */
    private var generation = 0

    /** Connect, sign in with the token, read the method list and the pool. A second call while connecting or connected does nothing. */
    suspend fun start() {
        if (phase == Phase.Connecting || phase == Phase.Live) return
        val record = settings.secret(XoHandoff.tokenName(address))?.let { Manage.record(it, address) }
        if (record == null) {
            phase = Phase.Stopped(Manage.Words.noToken(address), retry = false)
            return
        }
        user = record.user
        val pin = record.pin
        if (record.plain || pin == null) {
            phase = Phase.Stopped(Manage.Words.plainPool(address), retry = false)
            return
        }
        val expires = record.expires
        if (expires != null && expires < System.currentTimeMillis()) {
            val on = java.text.DateFormat.getDateInstance(java.text.DateFormat.LONG).format(java.util.Date(expires))
            phase = Phase.Stopped(Manage.Words.expired(address, on), retry = false)
            return
        }
        phase = Phase.Connecting
        val mine = ++generation
        val opened = try {
            XoLink.open(address, pin)
        } catch (e: XoLink.Failure) {
            if (generation != mine) return
            phase = if (e.kind == XoLink.Failure.Kind.WRONG_CERTIFICATE) {
                Phase.Stopped(Manage.Words.wrongCertificate(address), retry = false)
            } else {
                Phase.Stopped(Manage.Words.unreachable(address, e.message ?: "it did not answer"), retry = true)
            }
            return
        } catch (e: Exception) {
            // AWAY FROM THE POOL'S NETWORK: the socket never opened, which is
            // a pool this phone could not reach, not a connection that ended.
            if (generation != mine) return
            phase = Phase.Stopped(Manage.Words.unreachable(address, e.message ?: "it did not answer"), retry = true)
            return
        }
        if (generation != mine) {
            opened.close()
            return
        }
        link = opened
        scope.launch {
            val why = opened.end.await()
            lost(opened, why)
        }
        try {
            opened.call("session.signIn", JSONObject().put("token", record.token))
        } catch (e: Exception) {
            if (generation != mine) return
            drop(opened)
            phase = Phase.Stopped(Manage.Words.signInRefused(address, e.message ?: "no reason given"), retry = false)
            return
        }
        // A LIST THAT COULD NOT BE READ IS NOT AN EMPTY ONE: null draws no
        // action and says why, rather than drawing none and saying nothing.
        val listed = runCatching { opened.call("system.getMethodsInfo") }.getOrNull() as? JSONObject
        if (generation != mine) return
        val methods = listed?.keys()?.asSequence()?.toSet()
        if (methods != null && "xo.getAllObjects" !in methods) {
            drop(opened)
            phase = Phase.Stopped(Manage.Words.noObjects, retry = false)
            return
        }
        var next = Manage.Snapshot()
        try {
            for (type in Manage.objectTypes) {
                next = next.taking(opened.call("xo.getAllObjects", JSONObject().put("filter", JSONObject().put("type", type))))
            }
        } catch (e: Exception) {
            if (generation != mine) return
            drop(opened)
            phase = Phase.Stopped(Manage.Words.lost(e.message ?: "it stopped answering"), retry = true)
            return
        }
        if (generation != mine || link !== opened) return
        this.methods = methods
        snapshot = next
        phase = Phase.Live
        touch()
        // NOTIFICATIONS THAT ARRIVED DURING THE READ waited in the channel,
        // in order, and are applied now on top of what was read.
        scope.launch {
            for ((method, params) in opened.notices) {
                if (link !== opened) break
                snapshot.applying(method, params)?.let {
                    snapshot = it
                    touch()
                }
            }
        }
    }

    /** Close the socket, keeping what was seen and when. */
    fun stop() {
        generation++
        if (phase == Phase.Connecting) phase = Phase.Idle
        val open = link ?: return
        link = null
        open.close()
        if (phase == Phase.Live) touch()
        phase = Phase.Idle
    }

    /** Pull to refresh: read everything again, from a new connection. */
    suspend fun again() {
        stop()
        start()
    }

    /**
     * Call one method on the open connection, and say what came of it. Xen
     * Orchestra answers once it is done, so a yes is done, and the change
     * itself arrives as a notification.
     */
    suspend fun run(method: String, params: Map<String, Any>, done: String): Pair<Boolean, String> {
        val open = link
        if (open == null || phase != Phase.Live) return false to Manage.Words.lost("this phone is not connected")
        return try {
            open.call(method, JSONObject(params), timeoutMs = 300_000)
            touch()
            true to done
        } catch (e: XoLink.Failure) {
            false to when (e.kind) {
                XoLink.Failure.Kind.REFUSED -> Manage.Words.refused(e.message ?: "no reason given")
                XoLink.Failure.Kind.SLOW -> Manage.Words.slow
                else -> Manage.Words.lost(e.message ?: "the connection closed")
            }
        } catch (e: Exception) {
            false to Manage.Words.lost(e.message ?: "the connection closed")
        }
    }

    /** When it was last looked at, or that it never has been. */
    val lookedLine: String
        get() {
            val at = lookedAt ?: return Manage.Words.never
            val time = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(at))
            return Manage.Words.lookedAt("$time, ${relative(at)}")
        }

    /** How current what is shown is: watching, or when it was last looked at. */
    val currentLine: String get() = if (phase == Phase.Live) Manage.Words.watching else lookedLine

    /** The socket ended without being asked to: a phone that slept, a network that changed, a server that went. */
    private fun lost(which: XoLink, why: String) {
        if (link !== which) return
        link = null
        if (phase == Phase.Live || phase == Phase.Connecting) phase = Phase.Stopped(Manage.Words.lost(why), retry = true)
    }

    private fun drop(which: XoLink) {
        if (link === which) link = null
        which.close()
    }

    private fun touch() {
        val now = System.currentTimeMillis()
        lookedAt = now
        Manage.rememberLooked(settings, address, now)
    }
}
