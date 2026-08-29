package network.thetech.fleetwright

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * A notification this device raises itself, for work it started.
 *
 * NOT a replacement for push. Push is how the FLEET tells you something — a
 * session is waiting for an answer, on a box you were not looking at. This is
 * how the APP finishes a sentence it began: you asked for a session, the answer
 * took a minute, and by then you had put the phone down.
 *
 * Local because it needs no server, no token and no round trip, and because the
 * thing being reported is already known here.
 */
object LocalNotice {
    private const val CHANNEL = "fleetwright.local"
    private var ensured = false

    fun post(context: Context, title: String, body: String) {
        // Silent when permission was never granted, which is the right failure:
        // somebody who declined notifications is not asking to be interrupted
        // by this either. Checked rather than assumed — POST_NOTIFICATIONS is
        // a runtime grant on Android 13+, and posting without it throws.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        if (!ensured) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Fleetwright", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Answers to things you asked this app to do."
                },
            )
            ensured = true
        }

        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .build()
        // A stable-ish id per post: a second answer should not silently replace
        // the first one somebody has not read yet.
        NotificationManagerCompat.from(context).notify(title.hashCode() + body.hashCode(), notification)
    }
}
