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
                .setContentIntent(openIntent(context, data, id))
                .addAction(0, words.a, answerIntent(context, NotificationAnswers.slotA, data, id))
                .addAction(0, words.b, answerIntent(context, NotificationAnswers.slotB, data, id))
                .build()
            NotificationManagerCompat.from(context).notify(id, notification)
        }

        // --- what a press starts -------------------------------------------
        //
        // Every PendingIntent below names the class it starts, in the
        // constructor, and holds it in a local that nothing reassigns.
        //
        // THE SHAPE IS THE POINT, and it is worth a paragraph because the
        // previous version was correct and did not look it. One function took
        // `action: String?` with null meaning "the body rather than a button",
        // branched to build the intent, chained `.setAction(...).apply { }`
        // onto the constructor, and branched again to choose getActivity or
        // getBroadcast. The component was set the whole time — the constructor
        // does it — but it was set on the first link of a fluent chain and read
        // off the last, which is the shape CodeQL's implicit-PendingIntent
        // query cannot follow. It reported a High on the `notify` call above.
        //
        // An implicit PendingIntent is a real thing to be afraid of: it is a
        // blank cheque handed to whichever app resolves the intent. This was
        // never one. But "the scanner is wrong" is a claim every person who
        // meets the alert has to re-derive, and a suppression comment is a
        // thing nobody re-examines — so the code says what it does plainly
        // instead: one function per destination, no chain for the component to
        // get lost in, and nothing left to be unsure about.

        /**
         * `FLAG_IMMUTABLE` is the mitigation that was always here, and it is
         * the one that would matter if any of this were implicit: the extras
         * are a session name, a prompt id and the digit to type, which together
         * are an answer, and a mutable PendingIntent would let whatever holds
         * it fill those in.
         *
         * `val` rather than `const val`: these are Java `static final` ints, so
         * `or` on them is constant-folded anyway, and `const` would be a
         * promise about compile-time evaluation this does not need to make.
         */
        private val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        /** Tapping the notification itself: open the app on that session. */
        fun openIntent(context: Context, data: Map<String, String>, id: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
            data["name"]?.let { intent.putExtra("name", it) }
            return PendingIntent.getActivity(context, id * 31, intent, FLAGS)
        }

        /**
         * One button.
         *
         * The request code carries the action as well as the notification's id,
         * because `FLAG_UPDATE_CURRENT` matches on request code and action and
         * NOT on extras — two buttons that differed only in what they carry
         * would be one PendingIntent, and the second would quietly become the
         * first.
         */
        fun answerIntent(context: Context, action: String, data: Map<String, String>, id: Int): PendingIntent {
            val intent = Intent(context, AnswerReceiver::class.java)
            intent.action = action
            for (key in AnswerReceiver.KEYS) data[key]?.let { intent.putExtra(key, it) }
            intent.putExtra(AnswerReceiver.EXTRA_NOTIFICATION_ID, id)
            return PendingIntent.getBroadcast(context, id * 31 + action.hashCode(), intent, FLAGS)
        }
    }
}
