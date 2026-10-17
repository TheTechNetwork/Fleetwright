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

/** Where a pool's notification goes when tapped: its page, or, from Reconnect, the reconnect for its address on the machine that noticed. */
data class PoolTap(val address: String, val hostId: String?, val reconnect: Boolean)

/**
 * A pool whose servers Xen Orchestra lost, and the word that it is back.
 *
 * The coordinator notices a box's token no longer seeing a pool it saw, or
 * seeing none, for five minutes, and pushes `kind: "pool-lost"` to the
 * owner's and the admins' phones, with the address and the box that noticed
 * (`hostId`). Both pushes are sent `drawnByApp`, so both arrive here as data
 * and this draws them, under one id: the tray cannot draw the one action,
 * and a tray-drawn "back" could not replace an app-drawn "lost". To an admin
 * the lost one carries `category: "fleet.pool.reconnect"`, and only then is
 * Reconnect on it. When the pool shows again, `kind: "pool-back"` comes under
 * the same `name` and replaces the first, with no action: there is nothing
 * left to do.
 *
 * RECONNECT OPENS THE APP. It is an activity PendingIntent, never a
 * broadcast: what it starts is the admin sign-in opened with a fingerprint
 * or face (XoSaved), and that prompt needs a screen. A tap on the body opens
 * the pool's page instead. Both are read by MainActivity from the extras
 * below. Should the tray ever draw one (a coordinator from before
 * `drawnByApp`), it carries the same `kind`, `address` and `hostId` as
 * launcher extras, so its tap lands on the same page.
 */
internal object PoolNotice {
    const val CHANNEL = "fleetwright.pools"

    const val LOST = "pool-lost"
    const val BACK = "pool-back"

    /** The category an admin's lost-pool push carries, and the one action under it. */
    const val CATEGORY = "fleet.pool.reconnect"
    const val ACTION = "reconnect"
    const val ACTION_TITLE = "Reconnect"

    /** The extras a tap carries, read by MainActivity. [EXTRA_ACTION] is [ACTION] on the button's intent only. */
    const val EXTRA_KIND = "kind"
    const val EXTRA_ADDRESS = "address"
    const val EXTRA_HOST = "hostId"
    const val EXTRA_ACTION = "action"

    /** Whether a push is one of these. */
    fun handles(kind: String?): Boolean = kind == LOST || kind == BACK

    /**
     * A tap from a notification's extras, or null when it is not one of
     * these. Reconnect only from a lost pool's button: a pool that is back,
     * or a body tap, opens its page.
     */
    fun tap(kind: String?, address: String?, hostId: String?, action: String?): PoolTap? {
        if (!handles(kind)) return null
        val where = address?.takeIf { XoSetup.ADDRESS_RE.matches(it) } ?: return null
        return PoolTap(where, hostId?.takeIf { it.isNotBlank() }, reconnect = kind == LOST && action == ACTION)
    }

    /**
     * Draw it, or replace the one already drawn for the same pool. [title]
     * and [body] are the coordinator's words, carried in `data` when the app
     * draws it and in the notification block when the tray would have.
     */
    fun post(context: Context, data: Map<String, String>, title: String?, body: String?) {
        // Silent when permission was never granted, for the reason LocalNotice
        // gives. POST_NOTIFICATIONS is a runtime grant on Android 13+ and
        // posting without it throws.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return
        val kind = data[EXTRA_KIND]?.takeIf { handles(it) } ?: return
        val address = data[EXTRA_ADDRESS]?.takeIf { XoSetup.ADDRESS_RE.matches(it) } ?: return
        val hostId = data[EXTRA_HOST].orEmpty()

        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(CHANNEL, "Pools", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A pool Xen Orchestra stopped showing, and when it shows again."
            },
        )

        // ONE PER POOL, by name: `pool-lost-<address>` for both, so the word
        // that it is back replaces the word that it went.
        val id = (data["name"]?.takeIf { it.isNotBlank() } ?: "$LOST-$address").hashCode()
        val words = body?.takeIf { it.isNotBlank() }.orEmpty()
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title?.takeIf { it.isNotBlank() } ?: address)
            .setContentText(words)
            .setStyle(NotificationCompat.BigTextStyle().bigText(words))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, kind, address, hostId, id, action = null))
        // THE BUTTON ONLY WHERE IT CAN BE PRESSED (C-2): a lost pool, pushed
        // to an admin. A member could not run it, and a pool that is back
        // has nothing to reconnect.
        if (kind == LOST && data["category"] == CATEGORY) {
            builder.addAction(0, ACTION_TITLE, openIntent(context, kind, address, hostId, id, action = ACTION))
        }
        NotificationManagerCompat.from(context).notify(id, builder.build())
    }

    /**
     * Explicit in a call and immutable, for the reasons Messaging.kt gives
     * over its PendingIntents. The request code carries the action, because
     * FLAG_UPDATE_CURRENT matches on it and not on extras: the button and the
     * body would otherwise be one PendingIntent.
     */
    private fun openIntent(context: Context, kind: String, address: String, hostId: String, id: Int, action: String?): PendingIntent {
        val intent = Intent()
        intent.setClass(context, MainActivity::class.java)
        intent.putExtra(EXTRA_KIND, kind)
        intent.putExtra(EXTRA_ADDRESS, address)
        if (hostId.isNotBlank()) intent.putExtra(EXTRA_HOST, hostId)
        if (action != null) intent.putExtra(EXTRA_ACTION, action)
        val code = id * 31 + (if (action == null) 0 else 1)
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
