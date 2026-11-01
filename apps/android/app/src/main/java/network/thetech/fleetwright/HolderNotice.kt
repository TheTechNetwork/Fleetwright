package network.thetech.fleetwright

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A pool's own machine asking to join, as the push says it: let in by this
 * phone first, where it is the phone that made it, and drawn afterwards as
 * what happened.
 *
 * The coordinator pushes `kind: "holder-join"` to the owner's phones with
 * the name and the pool's address, `drawnByApp` and under the category
 * `fleet.holder.join`, so it arrives here as data rather than in the tray.
 * Before anything is drawn this phone tries to let the machine in by itself
 * (HolderJoin.admit): the secret it kept at Apply proves the request, the
 * fleet enrols the key and the vault lets it hold its pool, with nobody
 * present. What is drawn is then the word that it joined, with nothing to
 * press. A phone that did not make it, or keeps its secret from before
 * behind the owner's check, draws that it asks, with Let it in on it, which
 * opens Machines: the card there has the button and the check. Bounded, as
 * FCM bounds what runs here: a few seconds, then the ask is drawn and the
 * card on Machines finishes it.
 *
 * A TAP OPENS MACHINES AND NOTHING MORE, from the body and the button alike,
 * so the intent carries what the tray's tap carried (`kind`, `hostId`) and
 * needs no word of its own: an app that starts MainActivity with these
 * extras opens a list, and the only approval there is of a request this
 * phone's own secret proves.
 */
internal object HolderNotice {
    const val KIND = "holder-join"
    const val CHANNEL = "fleetwright.holders"
    /** The category the push carries. */
    const val CATEGORY = "fleet.holder.join"
    const val ACTION = "letin"
    /** How long letting it in may take here before the ask is drawn instead. */
    private const val QUIET_MS = 8_000L

    fun handles(kind: String?): Boolean = kind == KIND

    /**
     * Let it in where this phone can, then draw what happened: the word that
     * it joined, or the ask with Let it in. [title] and [body] are the
     * coordinator's words for the ask.
     */
    fun post(context: Context, data: Map<String, String>, title: String?, body: String?) {
        // Silent when permission was never granted, for the reason LocalNotice
        // gives. POST_NOTIFICATIONS is a runtime grant on Android 13+ and
        // posting without it throws.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return
        val hostId = data["hostId"]?.takeIf { it.isNotBlank() } ?: return
        val settings = Settings(context)
        val outcome = if (settings.configured) {
            runBlocking { withTimeoutOrNull(QUIET_MS) { runCatching { HolderJoin.admit(context, settings, hostId) }.getOrNull() } }
        } else {
            null
        }

        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(CHANNEL, "Pools’ own machines", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A pool’s own machine asking to join, and the word that it did."
            },
        )
        // ONE PER NAME: the word that it joined replaces the ask.
        val id = (data["name"]?.takeIf { it.isNotBlank() } ?: "$KIND-$hostId").hashCode()
        val joined = outcome?.isIn == true
        val words = if (joined) outcome?.said.orEmpty() else body?.takeIf { it.isNotBlank() }.orEmpty()
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(if (joined) HolderJoin.joinedTitle(hostId) else title?.takeIf { it.isNotBlank() } ?: HolderJoin.asks(hostId))
            .setContentText(words)
            .setStyle(NotificationCompat.BigTextStyle().bigText(words))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, hostId, id, action = null))
        // THE BUTTON ONLY WHERE THERE IS SOMETHING LEFT TO PRESS (C-2): an ask
        // this phone did not settle by itself.
        if (!joined) builder.addAction(0, HolderJoin.LET_IN_WORD, openIntent(context, hostId, id, action = ACTION))
        NotificationManagerCompat.from(context).notify(id, builder.build())
    }

    /**
     * Explicit in a call and immutable, for the reasons Messaging.kt gives
     * over its PendingIntents. The request code carries the action, because
     * FLAG_UPDATE_CURRENT matches on it and not on extras.
     */
    private fun openIntent(context: Context, hostId: String, id: Int, action: String?): PendingIntent {
        val intent = Intent()
        intent.setClass(context, MainActivity::class.java)
        intent.putExtra("kind", KIND)
        intent.putExtra("hostId", hostId)
        if (action != null) intent.putExtra("action", action)
        val code = id * 31 + (if (action == null) 0 else 1)
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
