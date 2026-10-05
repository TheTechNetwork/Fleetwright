package network.thetech.fleetwright

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Base64
import java.util.Locale

/**
 * Adding a hypervisor: the half that is arithmetic and words, kept apart from
 * the screen so a JVM test can run it. docs/hypervisors.md, and the two verbs
 * in src/fleet/protocol/intents.js (`xoprobe`, `xosetup`).
 *
 * WHAT THE PHONE HAS TO GET RIGHT, in the order it happens:
 *
 *   1. `begin` answers with a key the chosen machine made for this job, and a
 *      signature over that key by the machine's ENROLMENT key. The coordinator
 *      relays both and could replace both, so the phone checks the signature
 *      against the key it already knows for that machine, or shows the person
 *      the fingerprint to compare with `fleetwright-sidecar identity` on it.
 *      A sign-in sealed to a key nobody vouched for is a sign-in handed to
 *      whoever made the key.
 *   2. The admin sign-in is sealed to that key, with the job and the address
 *      as the additional data, so a sealed message for one job cannot be
 *      replayed into another.
 *   3. Progress arrives as a step number and a key from XOSETUP_STEPS; the
 *      words for each key live here, the same words as iOS, so a lock screen
 *      is shown numbers and the app turns them into a sentence.
 */
internal object XoSetup {

    /**
     * The steps, in the host's order, each with the words this app says for
     * it. Append only, like the list it mirrors: a key this app has not heard
     * of is said as "Step N of M" rather than guessed at.
     */
    val STEPS: List<Pair<String, String>> = listOf(
        "connect" to "Reaching Xen Orchestra",
        "sign-in" to "Signing in",
        "inventory" to "Reading the pool",
        "user" to "Making the fleetwright user",
        "resource-set" to "Setting what it may use",
        "token" to "Making its token",
        "updates" to "Turning on updates",
        "hand-off" to "Handing over",
    )

    /**
     * What one progress update says. [step] is zero-based, as the host counts
     * it, so the step number a person reads is one more.
     */
    fun stepWords(phase: String?, step: Int, of: Int): String {
        if (phase == "done") return "Done"
        STEPS.firstOrNull { it.first == phase }?.let { return it.second }
        val n = (step + 1).coerceIn(1, maxOf(of, 1))
        return "Step $n of ${maxOf(of, 1)}"
    }

    /** A Xen Orchestra address: the same shape XO_ADDRESS_RE accepts, so a refusal is said here rather than by the fleet. */
    val ADDRESS_RE = Regex(
        "^(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]{2,45}\\])(?::[0-9]{1,5})?$",
    )

    /** A setup job id: twelve lowercase hex digits, made by the machine. */
    val JOB_RE = Regex("^[0-9a-f]{12}$")

    /** A certificate fingerprint: SHA-256, lowercase hex. */
    val PIN_RE = Regex("^[0-9a-f]{64}$")

    /** Base64url without padding, which is the only alphabet a key or a signature here uses. */
    private val B64URL_RE = Regex("^[A-Za-z0-9_-]+$")

    /** The SHA-256 of a certificate, as a person compares it: eight groups of eight. */
    fun groupedPin(pin: String): String = pin.chunked(8).joinToString(" ")

    /**
     * The bytes the machine signed: the fleet's signing context for this, then
     * the four values as canonical JSON (keys sorted, no whitespace), exactly
     * as src/fleet/crypto.js `signingInput` builds it. Every value is held to
     * its own shape first, which is what makes writing the JSON by hand safe:
     * none of them can contain a quote, a backslash or anything else JSON
     * would have to escape.
     */
    fun signingInput(address: String, job: String, key: String, pin: String): ByteArray {
        require(ADDRESS_RE.matches(address)) { "not a Xen Orchestra address" }
        require(JOB_RE.matches(job)) { "not a setup job" }
        require(Seal.KEY_RE.matches(key)) { "not a P-256 public key" }
        require(PIN_RE.matches(pin)) { "not a certificate fingerprint" }
        return "agent-fleet/v1/xosetup-key\n{\"address\":\"$address\",\"job\":\"$job\",\"key\":\"$key\",\"pin\":\"$pin\"}"
            .toByteArray(Charsets.UTF_8)
    }

    /**
     * Did [hostKey] sign [input] with [keySig]? ECDSA on P-256 with SHA-256,
     * the signature as the 64 raw bytes r||s that WebCrypto produces, base64url
     * without padding. java.security wants DER, so the two halves are wrapped
     * as a SEQUENCE of two INTEGERs first. False for anything malformed: a key
     * that is not on the curve, a signature of the wrong length, a bad
     * alphabet. None of those is a reason to proceed.
     */
    fun verifyKeySig(hostKey: JSONObject?, keySig: String?, input: ByteArray): Boolean {
        if (hostKey == null || keySig.isNullOrBlank() || !B64URL_RE.matches(keySig)) return false
        if (hostKey.optString("kty") != "EC" || hostKey.optString("crv") != "P-256") return false
        return runCatching {
            val raw = Base64.getUrlDecoder().decode(keySig)
            require(raw.size == 64)
            val x = hostKey.optString("x")
            val y = hostKey.optString("y")
            require(B64URL_RE.matches(x) && B64URL_RE.matches(y))
            val point = ECPoint(BigInteger(1, Base64.getUrlDecoder().decode(x)), BigInteger(1, Base64.getUrlDecoder().decode(y)))
            val public = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, p256))
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(public)
                update(input)
                verify(derFromRaw(raw))
            }
        }.getOrDefault(false)
    }

    /**
     * r||s to DER: SEQUENCE { INTEGER r, INTEGER s }, each INTEGER minimal and
     * positive, so a leading zero is dropped and one is added back when the
     * top bit is set. Two 32-byte halves can need up to 33 bytes each, which
     * keeps the SEQUENCE under 128 bytes and its length in one byte.
     */
    fun derFromRaw(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "an ECDSA P-256 signature is 64 bytes" }
        fun integer(bytes: ByteArray): ByteArray {
            var start = 0
            while (start < bytes.size - 1 && bytes[start] == 0.toByte()) start++
            val body = bytes.copyOfRange(start, bytes.size)
            val padded = if (body[0] < 0) byteArrayOf(0) + body else body
            return byteArrayOf(2, padded.size.toByte()) + padded
        }
        val r = integer(raw.copyOfRange(0, 32))
        val s = integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, (r.size + s.size).toByte()) + r + s
    }

    /** The additional data the sign-in is sealed under: this job, at this address, and nothing else. */
    fun aad(job: String, address: String): String = "fleetwright-xosetup/v1:$job:$address"

    /**
     * The admin sign-in, sealed to the job's key, as the one string `run`
     * carries. Built here and returned rather than kept: the caller clears the
     * password the moment this returns.
     */
    fun sealSignIn(key: String, job: String, address: String, email: String, password: String): String {
        val payload = JSONObject().put("v", 1).put("xo", JSONObject().put("email", email).put("password", password))
        val sealed = Seal.seal(key, aad(job, address), payload)
        return "${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"
    }

    /**
     * How a probe reads to a person, and whether this machine can run the
     * setup. Only a machine that reached the address over TLS can: the
     * installer's default is HTTPS, and the pin that protects the sign-in on
     * its way is the certificate's, so no certificate means nothing to pin.
     */
    fun describe(probe: Fleet.Probe): String = when {
        !probe.reachable -> "Could not reach it"
        !probe.tls || probe.cert == null -> "Answered without HTTPS. Setup needs HTTPS, which the Xen Orchestra installer turns on by default."
        probe.xo == true -> "Reached it over HTTPS" + (probe.version?.let { ". Xen Orchestra $it" } ?: ". Looks like Xen Orchestra")
        probe.xo == false -> "Reached it over HTTPS, but it does not look like Xen Orchestra"
        else -> "Reached it over HTTPS. Cannot tell what is answering"
    }

    /**
     * What a probe may say is wrong with a certificate, in the words the
     * coordinator uses (core.js CERT_PROBLEMS). Anything else it says is
     * dropped rather than shown as a word this app cannot explain.
     */
    val CERT_PROBLEMS: List<String> = listOf("self-signed", "untrusted-issuer", "expired", "not-yet-valid", "name-mismatch")

    /**
     * A probe's `certificate`, read tolerantly: null in, null out; `trusted`
     * is true only when it is literally true AND nothing is named wrong, the
     * same rule the coordinator applies, so a half-filled object lands on the
     * side that asks; every text field is null unless it is a non-empty
     * string, because org.json renders a JSON null as the word "null".
     */
    fun certificate(json: JSONObject?): Fleet.Certificate? {
        if (json == null) return null
        fun text(key: String): String? = json.takeIf { it.has(key) && !it.isNull(key) }?.optString(key)?.takeIf { it.isNotBlank() }
        fun strings(key: String): List<String> {
            val a: JSONArray = json.optJSONArray(key) ?: return emptyList()
            return (0 until a.length()).mapNotNull { i -> a.optString(i, "").takeIf { it.isNotBlank() && !a.isNull(i) } }
        }
        val problems = strings("problems").filter { it in CERT_PROBLEMS }
        return Fleet.Certificate(
            trusted = json.optBoolean("trusted", false) && problems.isEmpty(),
            problems = problems,
            subject = text("subject"),
            issuer = text("issuer"),
            notBefore = text("notBefore"),
            notAfter = text("notAfter"),
            names = strings("names"),
        )
    }

    /**
     * An ISO 8601 instant as a person reads a date, in their own locale and
     * zone ("3 Oct 2026", "Oct 3, 2026"). The raw string when it does not
     * parse: a date the machine wrote is still better than nothing, and
     * better than a wrong one.
     */
    fun mediumDate(iso: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        runCatching {
            Instant.parse(iso).atZone(zone).toLocalDate().format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
        }.getOrDefault(iso)

    /**
     * What is wrong with a certificate, one line per problem, in the words
     * iOS uses too. The address is named in the mismatch line because "a
     * different name" begs the question "different from what".
     *
     * A certificate the machine could not read is a line of its own, and a
     * certificate the machine distrusts without saying why is said as that:
     * neither is "fine", and C-5 is why neither is silent.
     */
    fun problemLines(c: Fleet.Certificate?, address: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): List<String> {
        if (c == null) return listOf("This machine could not read the certificate’s details.")
        if (c.trusted) return emptyList()
        val lines = c.problems.map { k ->
            when (k) {
                "self-signed" -> "Self-signed: nothing but the server itself vouches for it."
                "untrusted-issuer" -> "Signed by an authority this machine does not trust."
                "expired" -> "Expired on ${c.notAfter?.let { mediumDate(it, zone, locale) } ?: "a date this machine did not say"}."
                "not-yet-valid" -> "Not valid until ${c.notBefore?.let { mediumDate(it, zone, locale) } ?: "a date this machine did not say"}."
                else -> "Issued for a different name than $address."
            }
        }
        return lines.ifEmpty { listOf("Not trusted by that machine, which did not say why.") }
    }

    /**
     * The one calm line for a certificate that checks out: who it was issued
     * to, by whom, and until when, each only when the machine said.
     */
    fun trustedLine(c: Fleet.Certificate, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val who = listOfNotNull(c.subject?.let { "issued to $it" }, c.issuer?.let { "by $it" }).joinToString(" ")
        val parts = listOfNotNull(who.ifBlank { null }, c.notAfter?.let { "valid until ${mediumDate(it, zone, locale)}" })
        return if (parts.isEmpty()) "Its certificate checks out." else "Its certificate checks out: ${parts.joinToString(", ")}."
    }

    /**
     * The `trust` to send with `begin`: "accepted" only for a certificate that
     * did not check out and that the person acknowledged having seen, and
     * nothing for one that did. The host refuses to connect without it in the
     * first case and never looks for it in the second, so sending it for a
     * trusted certificate would record an acceptance nobody was asked for.
     */
    fun trustFor(c: Fleet.Certificate?, acknowledged: Boolean): String? =
        if (c?.trusted == true) null else if (acknowledged) "accepted" else null

    private val p256: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }
}
