package network.thetech.fleetwright

import android.content.Context
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * A word the user picks, so "start a dev session" means something.
 *
 * A kind is not an alias for a phrase: it carries the defaults that would
 * otherwise have to be spoken — mode, a title prefix — so one short sentence is
 * a whole configuration. That is what makes it worth storing rather than just
 * accepting free text after "start a".
 *
 * ANDROID FINISHES THE JOB THAT IOS CANNOT. On iOS an app may not register a
 * Siri phrase; the user has to complete it in Shortcuts. Here a dynamic
 * shortcut's `shortLabel` IS the phrase Assistant matches, so adding a kind in
 * the app is the whole setup. The iOS flow has a handoff step and this one does
 * not — deliberately. Copying that step across for the sake of the two screens
 * looking alike would be consistency serving us rather than the person holding
 * the phone.
 */
data class SessionKind(
    /** Stable across renames, so a shortcut keeps working when the word changes. */
    val id: String = UUID.randomUUID().toString(),
    val word: String,
    val mode: String? = null,
    /** Prefixed onto a generated title, so a list groups by eye. */
    val titlePrefix: String = "",
    /**
     * Where it lands. Empty means "wherever the scheduler puts it", which is
     * the right default — most people have one host and should never meet this.
     *
     * PRESENT ON iOS SINCE PLACEMENT SHIPPED AND MISSING HERE, which is the
     * gap docs/app-parity.md exists to catch: a kind naming a box did nothing
     * on Android, silently, and a setting that works on one phone and not the
     * other is worse than one that works on neither.
     */
    val host: String = "",
    /**
     * WHAT A SESSION OF THIS KIND DOES, by name.
     *
     * The field that makes a kind a configuration rather than a label: "orgi"
     * can mean "bootstrap the org repos" without anybody typing a task. The
     * words are not here and cannot be — a profile is a file on the host, and
     * this is its name. Empty means the session comes up idle, which stays the
     * default: a kind that silently gave a session work would be a surprise the
     * first time somebody reused an old word.
     */
    val profile: String = "",
) {
    val displayName: String get() = word.ifBlank { "session" }
}

object SessionKinds {
    private const val PREFS = "fleetwright"
    private const val KEY = "sessionKinds"

    fun all(context: Context): List<SessionKind> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            ?: return emptyList()
        return runCatching {
            val out = mutableListOf<SessionKind>()
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out += SessionKind(
                    id = o.optString("id", UUID.randomUUID().toString()),
                    word = o.optString("word"),
                    mode = o.optString("mode").ifBlank { null },
                    titlePrefix = o.optString("titlePrefix"),
                    // A kind stored before these existed reads as "", which is
                    // the same as not set. Losing somebody's kinds on upgrade
                    // is the failure this whole loader is written around.
                    host = o.optString("host"),
                    profile = o.optString("profile"),
                )
            }
            out
        }.getOrDefault(emptyList())
    }

    fun save(context: Context, kinds: List<SessionKind>) {
        val arr = JSONArray()
        kinds.forEach {
            arr.put(
                JSONObject()
                    .put("id", it.id)
                    .put("word", it.word)
                    .put("mode", it.mode ?: "")
                    .put("titlePrefix", it.titlePrefix)
                    .put("host", it.host)
                    .put("profile", it.profile),
            )
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY, arr.toString()).apply()
        publish(context, kinds)
    }

    fun find(context: Context, word: String): SessionKind? {
        val wanted = word.trim().lowercase()
        return all(context).firstOrNull { it.word.lowercase() == wanted }
    }

    /**
     * Push the kinds to the launcher and to Assistant.
     *
     * `shortLabel` is what gets spoken back and matched against, so it is the
     * user's own word and nothing else — no product name, no "Fleetwright:"
     * prefix. That prefix is exactly the tax iOS forces and Android does not,
     * and adding it voluntarily would be bringing a constraint along for no
     * reason.
     *
     * Replaced wholesale rather than merged: a kind the user deleted must stop
     * being offered, and reconciling two lists is how one of them keeps an entry
     * nobody can see any more.
     */
    fun publish(context: Context, kinds: List<SessionKind>) {
        val shortcuts = kinds.take(ShortcutManagerCompat.getMaxShortcutCountPerActivity(context))
            .filter { it.word.isNotBlank() }
            .map { kind ->
                val intent = Intent(context, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    putExtra(EXTRA_KIND_ID, kind.id)
                }
                ShortcutInfoCompat.Builder(context, "kind-${kind.id}")
                    .setShortLabel(kind.word)
                    .setLongLabel("Start a ${kind.word} session")
                    .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                    .setIntent(intent)
                    .build()
            }
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts) }
    }

    const val EXTRA_KIND_ID = "network.thetech.fleetwright.KIND_ID"
}
