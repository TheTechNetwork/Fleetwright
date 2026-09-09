package network.thetech.fleetwright

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * A button on a notification, pressed.
 *
 * A BROADCAST RECEIVER RATHER THAN AN ACTIVITY, which is the whole point: the
 * answer is sent without the app coming to the front. Answering a session from
 * a lock screen and being dropped into a session list is not answering it from
 * a lock screen, it is being made to open the app with an extra step in front.
 *
 * The receiver is also why `goAsync` is here. A receiver's process may be killed
 * the moment `onReceive` returns, and this one has a network round trip to
 * finish; without it the answer is a coin flip on how busy the phone is.
 */
class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val data = intent.extras?.let { extras ->
            KEYS.mapNotNull { key -> extras.getString(key)?.let { key to it } }.toMap()
        } ?: emptyMap()
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)

        // THE NOTIFICATION GOES AWAY ON THE PRESS, not when the answer lands.
        // Leaving it up while the request is in flight invites a second press,
        // and a second press is a second answer to a question that now has one.
        // Whatever happens next arrives as its own notice.
        if (notificationId != 0) NotificationManagerCompat.from(context).cancel(notificationId)

        when (val decision = NotificationAnswers.decide(intent.action, data)) {
            is NotificationAnswers.Decision.Answer -> send(context, decision)
            is NotificationAnswers.Decision.Stale -> {
                // SAID, NOT SWALLOWED. A button that quietly does nothing is
                // worse than no button: somebody presses it, the screen goes
                // off, and they believe they have answered. docs/psychology.md
                // §6 — what is wrong AND what to do — and the session is one
                // tap away rather than a search.
                LocalNotice.post(
                    context,
                    decision.name,
                    "That question is more than an hour old, so it was not answered from here. " +
                        "Open the session to see what it is asking now.",
                )
                open(context, decision.name)
            }
            is NotificationAnswers.Decision.Open -> open(context, decision.name)
        }
    }

    /**
     * Send it, and say so when it does not land.
     *
     * NOT THROUGH THE OUTBOX, which is the one place this path deliberately
     * differs from the same answer given inside the app. `Outbox` holds a
     * command so a lift or a tunnel does not lose it — right for `start` and
     * `stop`, wrong for this: an answer queued from a lock screen and delivered
     * hours later is the exact thing the hour exists to prevent, and it would
     * arrive with nobody watching. Sent now or not at all.
     */
    private fun send(context: Context, decision: NotificationAnswers.Decision.Answer) {
        val settings = Settings(context.applicationContext)
        if (!settings.configured) return open(context, decision.name)

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val reply = Fleet(settings).answer(decision.name, decision.option, decision.promptId)
                // THE HOST GETS THE LAST WORD. `promptId` is checked against the
                // live pane there, so a refusal here is a question that moved on
                // in the seconds this took — the case the id exists for, and the
                // case somebody has to be told about rather than left to assume.
                if (!reply.ok) {
                    LocalNotice.post(
                        context,
                        decision.name,
                        reply.text.ifBlank { "That answer was not accepted." },
                    )
                    open(context, decision.name)
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not answer ${decision.name}: ${e.message}")
                LocalNotice.post(
                    context,
                    decision.name,
                    "The fleet could not be reached, so that answer was not sent. Open the session to try again.",
                )
                open(context, decision.name)
            } finally {
                pending.finish()
            }
        }
    }

    private fun open(context: Context, name: String?) {
        context.startActivity(
            Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (name != null) putExtra("name", name)
            },
        )
    }

    companion object {
        const val EXTRA_NOTIFICATION_ID = "notificationId"

        /**
         * The payload fields a button needs, named rather than copied wholesale.
         *
         * The extras on this intent are built from a push whose contents this
         * app does not control, and everything not on this list stops at the
         * notification. It is also what `decide` reads, so the two cannot drift
         * into a button that depends on a field nobody put in the intent.
         */
        val KEYS = listOf("name", "promptId", "answers", "sentAt")

        private const val TAG = "Fleetwright"
    }
}
