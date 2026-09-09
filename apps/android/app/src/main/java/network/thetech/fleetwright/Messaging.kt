package network.thetech.fleetwright

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Keeps the coordinator's idea of this device current.
 *
 * The address is not stable. FCM reissues it on reinstall, on a data clear, and
 * occasionally on its own — and a coordinator holding a stale one has no way to
 * tell that from a phone that is simply asleep. It sends, FCM accepts, and
 * nothing arrives. So the only correct place to re-register is here, where the
 * SDK says it changed.
 *
 * `onRegistered` RATHER THAN `onNewToken`. firebase-messaging 25.1.0 deprecated
 * getToken, deleteToken and onNewToken together: FCM is moving from a
 * registration token to the Firebase installation ID, and the FID is now the
 * thing a message is addressed to. The callback is also better than the one it
 * replaces — it fires on routine syncs at startup as well as on change, so a
 * phone whose registration quietly lapsed re-registers on its own rather than
 * waiting for a rotation that may never come.
 */
class Messaging : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        val token = installationId
        val settings = Settings(applicationContext)
        if (!settings.configured) return
        // Fire and forget: this runs on a service thread with no lifecycle to
        // tie to, and a failure means the next app launch registers instead.
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Fleet(settings).registerDevice(token) }
                .onFailure { Log.w(TAG, "could not register the new token: ${it.message}") }
        }
    }

    /**
     * Most notifications arrive as a `notification` payload, which the system
     * tray displays on its own while the app is backgrounded — the case that
     * matters, since the point is a phone in a pocket. For those this only runs
     * in the foreground, where there is nothing to add: the session list is
     * already on screen.
     *
     * A NOTIFICATION WITH ANSWERS ON IT IS THE EXCEPTION, and the exception is
     * why this method now does something. The tray cannot draw actions, and it
     * draws the message before the app is consulted — so the coordinator sends
     * those data-only (see the `notification` block in `src/fleet/push.js`) and
     * the app builds them here. That is what buys the two buttons, and it costs
     * what the comment over there says it costs: a force-stopped app gets
     * nothing, and Doze may delay it.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        val words = NotificationAnswers.titlesFor(message.data["category"])
        if (words == null) {
            Log.i(TAG, "push while foregrounded: ${message.notification?.title ?: message.data}")
            return
        }
        post(applicationContext, message.data, words)
    }

    private companion object {
        const val TAG = "Fleetwright"
        const val CHANNEL = "fleetwright.asks"

        /**
         * The notification the tray would have drawn, plus the two buttons it
         * could not.
         *
         * ONE PER SESSION, by name, which is the same rule `collapse_key` and
         * `apns-collapse-id` already follow on the sending side: a newer word
         * about a session replaces the older one rather than stacking under it.
         * Two live questions about one session, only one of them current, is
         * the pile the id was never going to save anybody from.
         */
        fun post(context: Context, data: Map<String, String>, words: NotificationAnswers.Answers) {
            // Silent when permission was never granted, for the reason
            // LocalNotice gives: somebody who declined notifications is not
            // asking to be interrupted by this either. POST_NOTIFICATIONS is a
            // runtime grant on Android 13+ and posting without it throws.
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) return

            context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Sessions asking", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A session needs a decision before it can carry on."
                },
            )

            val name = data["name"].orEmpty()
            val id = if (name.isEmpty()) data.hashCode() else name.hashCode()
            val title = listOfNotNull(name.ifEmpty { null }, data["hostId"]).joinToString(" on ")

            val notification = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title.ifEmpty { "Fleetwright" })
                .setContentText(data["body"].orEmpty())
                .setStyle(NotificationCompat.BigTextStyle().bigText(data["body"].orEmpty()))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setAutoCancel(true)
                .setContentIntent(button(context, null, data, id))
                .addAction(0, words.a, button(context, NotificationAnswers.slotA, data, id))
                .addAction(0, words.b, button(context, NotificationAnswers.slotB, data, id))
                .build()
            NotificationManagerCompat.from(context).notify(id, notification)
        }

        /**
         * One button, or the body of the notification when `action` is null.
         *
         * `FLAG_IMMUTABLE`, and it is not a formality: a mutable PendingIntent
         * hands any app that can reach it the ability to fill in the extras —
         * which here are the session name, the prompt id and the digit. That is
         * the whole of an answer, filled in by somebody else.
         *
         * The request code is the notification's id combined with the action,
         * so two live questions do not share one PendingIntent and answer each
         * other's.
         */
        fun button(context: Context, action: String?, data: Map<String, String>, id: Int): PendingIntent {
            val intent = if (action == null) {
                Intent(context, MainActivity::class.java)
                    .apply { data["name"]?.let { putExtra("name", it) } }
            } else {
                Intent(context, AnswerReceiver::class.java).setAction(action).apply {
                    for (key in AnswerReceiver.KEYS) data[key]?.let { putExtra(key, it) }
                    putExtra(AnswerReceiver.EXTRA_NOTIFICATION_ID, id)
                }
            }
            val code = id * 31 + (action?.hashCode() ?: 0)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            return if (action == null) {
                PendingIntent.getActivity(context, code, intent, flags)
            } else {
                PendingIntent.getBroadcast(context, code, intent, flags)
            }
        }
    }
}
