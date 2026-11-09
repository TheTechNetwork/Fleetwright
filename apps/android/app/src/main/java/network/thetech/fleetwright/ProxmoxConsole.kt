package network.thetech.fleetwright

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URLEncoder
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * A Proxmox VE cluster this phone keeps the record for, as the line carried
 * it: the token, and how to trust the cluster. docs/proxmox.md, "A machine's
 * page". The same as iOS (ProxmoxConsole.swift, ProxmoxKept).
 *
 * KEPT HERE TOO, NOT ONLY IN THE VAULT, for the console in the app: the phone
 * opens the console itself, with the token, behind TLS held to the cluster's
 * own CA, so the screen and every key typed travel encrypted from this phone
 * to the node, through one of your machines from away (ConsoleTunnel) as well.
 * Encrypted as a pool's token is (Settings.putSecret), and gone at sign-out
 * (Settings.forgetHypervisors).
 */
internal object ProxmoxKept {
    private fun name(address: String) = "proxmox-record.$address"

    fun keep(settings: Settings, record: ProxmoxLine.Record) {
        settings.putSecret(name(record.address), record.json)
        val all = addresses(settings)
        if (record.address !in all) settings.pveHeld = JSONArray(all + record.address).toString()
    }

    /** The addresses this phone keeps a record for, whose record is still readable here. */
    fun held(settings: Settings): List<String> = addresses(settings).filter { settings.secret(name(it)) != null }

    fun trust(settings: Settings, address: String): Trust? = runCatching {
        val o = JSONObject(settings.secret(name(address)) ?: return@runCatching null)
        val token = o.optString("token").takeIf { it.isNotBlank() && it != "null" } ?: return@runCatching null
        val ca = o.optString("ca").takeIf { it.isNotBlank() && it != "null" }
        if (ca != null) {
            val anchors = Trust.certificates(ca)
            if (anchors.isEmpty()) null else Trust(token, anchors, null)
        } else if (o.optString("trust") == "public") {
            Trust(token, null, o.optString("name").takeIf { it.isNotBlank() && it != "null" })
        } else null
    }.getOrNull()

    private fun addresses(settings: Settings): List<String> = runCatching {
        val all = JSONArray(settings.pveHeld.ifBlank { "[]" })
        (0 until all.length()).map { all.getString(it) }
    }.getOrDefault(emptyList())

    /**
     * The token, and the one way the cluster is trusted, as the boxes trust it
     * (src/fleet/host/pve-api.js, connectTrusted): the cluster's own CA and
     * only it, with no name checked, or a publicly trusted certificate held to
     * the name it was issued to while the address is dialled.
     */
    class Trust(val token: String, private val anchors: List<X509Certificate>?, private val name: String?) {
        /** A check of the server's chain for [host], and whether it refused one. */
        fun manager(host: String): ClusterTrust = ClusterTrust(anchors, name ?: host)

        companion object {
            fun certificates(pem: String): List<X509Certificate> {
                val factory = CertificateFactory.getInstance("X.509")
                return Regex("-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\\s]+?-----END CERTIFICATE-----").findAll(pem).mapNotNull { m ->
                    runCatching { factory.generateCertificate(ByteArrayInputStream(m.value.toByteArray())) as X509Certificate }.getOrNull()
                }.toList()
            }
        }
    }

    class ClusterTrust(anchors: List<X509Certificate>?, private val name: String) : X509TrustManager {
        @Volatile var mismatch = false
        private val base: X509TrustManager
        private val onlyCa = anchors != null

        init {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            if (anchors != null) {
                val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                    load(null, null)
                    anchors.forEachIndexed { i, c -> setCertificateEntry("ca$i", c) }
                }
                factory.init(store)
            } else {
                factory.init(null as KeyStore?)
            }
            base = factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("this client asks no certificate of anyone")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            try {
                base.checkServerTrusted(chain, authType)
                // THE CLUSTER'S CA SIGNS ONLY ITS OWN NODES, so no name is
                // checked; a public one is held to the name it was issued to.
                if (!onlyCa && !names(chain?.firstOrNull() ?: throw CertificateException("no certificate"), name)) {
                    throw CertificateException("the certificate was not issued to $name")
                }
            } catch (e: CertificateException) {
                mismatch = true
                throw e
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

        /** Whether [leaf] names [host]: a DNS name, one wildcard label at most, or an address. */
        private fun names(leaf: X509Certificate, host: String): Boolean {
            val want = host.lowercase().trimEnd('.')
            return (leaf.subjectAlternativeNames ?: emptyList()).any { san ->
                val kind = san.getOrNull(0) as? Int
                val value = (san.getOrNull(1) as? String)?.lowercase()?.trimEnd('.') ?: return@any false
                when (kind) {
                    7 -> value == want
                    2 -> value == want || (value.startsWith("*.") && want.substringAfter('.', "") == value.removePrefix("*.") && want.count { it == '.' } == value.count { it == '.' })
                    else -> false
                }
            }
        }
    }
}

/**
 * One machine's screen from Proxmox VE, in two requests: `vncproxy` hands back
 * a port and a one-use ticket ([ticket]), and `vncwebsocket` carries the VNC
 * ([open]). Both send the token as Proxmox VE reads it
 * (`Authorization: PVEAPIToken=…`), behind TLS held to the cluster. The ticket
 * is also the VNC password noVNC is asked for (page.js, `fwConsole.password`).
 *
 * TWO CONNECTIONS, ONE AFTER THE OTHER, because a tunnel from away carries one
 * (ConsoleTunnel): the screen takes a tunnel of its own after the ticket's is
 * closed. The same as iOS.
 */
internal object ProxmoxConsole {
    data class Handed(val port: Int, val ticket: String)

    private val NODE = Regex("^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$")

    private fun path(node: String, vmid: Int): String {
        require(NODE.matches(node)) { "the machine's place on the cluster is not one this phone can name" }
        return "/api2/json/nodes/$node/qemu/$vmid"
    }

    /**
     * Ask the cluster for a console. Throws an [XoLink.Failure] of kind
     * WRONG_CERTIFICATE for a server whose chain is not the cluster's, having
     * sent it nothing, and REFUSED for a cluster that would not hand one out.
     */
    suspend fun ticket(address: String, node: String, vmid: Int, trust: ProxmoxKept.Trust, via: Socket? = null, timeoutMs: Int = 15_000): Handed = withContext(Dispatchers.IO) {
        val (host, port) = XoLink.splitAddress(address)
        val check = trust.manager(host)
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(check), null) }
        val raw = via ?: Socket()
        try {
            if (via == null) raw.connect(InetSocketAddress(host, port), timeoutMs)
            raw.soTimeout = timeoutMs
            val ssl = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
            try {
                ssl.startHandshake()
            } catch (e: Exception) {
                if (check.mismatch) throw XoLink.Failure("the certificate was not the cluster's", XoLink.Failure.Kind.WRONG_CERTIFICATE)
                throw e
            }
            val body = "websocket=1"
            val hostHeader = if (host.contains(':')) "[$host]:$port" else "$host:$port"
            ssl.outputStream.write(
                ("POST ${path(node, vmid)}/vncproxy HTTP/1.1\r\nHost: $hostHeader\r\nAuthorization: PVEAPIToken=${trust.token}\r\n" +
                    "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body").toByteArray(Charsets.ISO_8859_1),
            )
            ssl.outputStream.flush()
            val all = ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (true) {
                val n = ssl.inputStream.read(buf)
                if (n < 0) break
                all.write(buf, 0, n)
                if (all.size() > 256 * 1024) break
            }
            runCatching { ssl.close() }
            val bytes = all.toByteArray()
            val split = String(bytes, Charsets.ISO_8859_1).indexOf("\r\n\r\n")
            if (split < 0) throw XoLink.Failure("the cluster did not answer", XoLink.Failure.Kind.CLOSED)
            val head = String(bytes, 0, split, Charsets.ISO_8859_1)
            val status = Regex("^HTTP/1\\.[01] (\\d{3})").find(head)?.groupValues?.get(1)
            var payload = bytes.copyOfRange(split + 4, bytes.size)
            if (Regex("(?im)^transfer-encoding:\\s*chunked").containsMatchIn(head)) payload = unchunk(payload)
            if (status != "200") {
                throw XoLink.Failure(
                    if (status == "403") "the cluster's token may not open this machine's console; run the setup again on the node"
                    else "the cluster did not hand out a console (${status ?: "no status"})",
                    XoLink.Failure.Kind.REFUSED,
                )
            }
            val data = JSONObject(String(payload, Charsets.UTF_8)).optJSONObject("data")
            val ticket = data?.optString("ticket")?.takeIf { it.isNotBlank() } ?: throw XoLink.Failure("the cluster handed out no ticket", XoLink.Failure.Kind.REFUSED)
            val vncPort = data.optString("port").toIntOrNull() ?: throw XoLink.Failure("the cluster handed out no port", XoLink.Failure.Kind.REFUSED)
            Handed(vncPort, ticket)
        } catch (e: Exception) {
            runCatching { raw.close() }
            throw e
        }
    }

    /** Open the screen the cluster handed out, the bytes carried as Xen Orchestra's are ([XoConsole]). */
    suspend fun open(address: String, node: String, vmid: Int, trust: ProxmoxKept.Trust, handed: Handed, via: Socket? = null): XoConsole {
        val (host, _) = XoLink.splitAddress(address)
        val check = trust.manager(host)
        val query = "port=${handed.port}&vncticket=" + URLEncoder.encode(handed.ticket, "UTF-8")
        val headers = "Authorization: PVEAPIToken=${trust.token}\r\nSec-WebSocket-Protocol: binary\r\n"
        val (ssl, rest) = XoLink.handshakeTrusting(address, check, { check.mismatch }, "${path(node, vmid)}/vncwebsocket?$query", headers, via = via)
        return XoConsole.wrap(ssl, rest)
    }

    /** A chunked body, joined. */
    private fun unchunk(body: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < body.size) {
            val lineEnd = (i until body.size - 1).firstOrNull { body[it] == '\r'.code.toByte() && body[it + 1] == '\n'.code.toByte() } ?: break
            val size = String(body, i, lineEnd - i, Charsets.ISO_8859_1).substringBefore(';').trim().toIntOrNull(16) ?: break
            if (size == 0) break
            val start = lineEnd + 2
            if (start + size > body.size) break
            out.write(body, start, size)
            i = start + size + 2
        }
        return out.toByteArray()
    }
}
