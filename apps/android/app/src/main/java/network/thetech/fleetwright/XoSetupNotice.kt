package network.thetech.fleetwright

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * A hypervisor setup's progress while the app is closed: one notification per
 * job, kept up to date, then replaced by one that says how it ended.
 *
 * The coordinator pushes every step of a job to its owner's Android phones
 * (`#onSetupProgress` in src/fleet/coordinator/core.js) as data with
 * `kind: "xosetup"`: the job, the machine, the step and how many there are,
 * the step's key and the state. Numbers and a key, no address and no name,
 * because the same update goes to an iPhone's Lock Screen where it cannot be
 * sealed. The words for each key are XoSetup.STEPS, so the notification says
 * the same sentence the screen does.
 *
 * ONE NOTIFICATION, NOT ONE PER STEP. The id is the job's, so each update
 * replaces the last rather than stacking eight of them; the progress channel
 * is low importance, so a step does not buzz the phone; it is ongoing while
 * the machine is running, so it cannot be swiped away mid-job and then wondered
 * about. The end is a different thing: dismissible, on a channel that may make
 * a sound, because "it finished" is what the person was waiting to hear.
 *
 * ON ANDROID 16 IT IS A LIVE UPDATE: the platform's own progress style, which
 * the status bar and the lock screen promote, behind an SDK check. Older
 * phones get the same bar from NotificationCompat.
 */
internal object XoSetupNotice {
    const val PROGRESS_CHANNEL = "fleetwright.setup"
    const val RESULT_CHANNEL = "fleetwright.setup.done"

    /** The intent extras a tap carries, read by MainActivity to open the job's progress. */
    const val EXTRA_KIND = "kind"
    const val EXTRA_JOB = "job"
    const val KIND = "xosetup"

    /**
     * The newest `sentAt` shown per job. Pushes can arrive out of order, and a
     * step three update landing after step five would move the bar backwards
     * and lie about where the machine is. In memory only: a restart forgets,
     * and the next update is then simply shown.
     */
    private val lastShown = HashMap<String, Long>()

    fun post(context: Context, data: Map<String, String>) {
        // Silent when permission was never granted, for the reason LocalNotice
        // gives: somebody who declined notifications is not asking for this.
        // POST_NOTIFICATIONS is a runtime grant on Android 13+ and posting
        // without it throws.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val job = data["job"]?.takeIf { XoSetup.JOB_RE.matches(it) } ?: return
        val sentAt = data["sentAt"]?.toLongOrNull() ?: 0L
        synchronized(lastShown) {
            if ((lastShown[job] ?: 0L) > sentAt) return
            lastShown[job] = sentAt
        }
        val state = data["state"].orEmpty()
        val of = data["of"]?.toIntOrNull()?.coerceIn(1, 32) ?: XoSetup.STEPS.size
        val step = data["step"]?.toIntOrNull()?.coerceIn(0, of) ?: 0
        val hostId = data["hostId"].orEmpty()
        val id = ("xosetup-$job").hashCode()

        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(PROGRESS_CHANNEL, "Setup progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Each step of a hypervisor being added, in one notification that updates."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(RESULT_CHANNEL, "Setup finished", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A hypervisor was added, or its setup stopped."
            },
        )

        val running = state == "running" || state == "waiting"
        val title = when (state) {
            "done" -> "Hypervisor added"
            "failed" -> "Hypervisor setup stopped"
            "cancelled" -> "Hypervisor setup cancelled"
            else -> "Adding a hypervisor"
        }
        val body = when (state) {
            "done" -> if (hostId.isBlank()) "The pool is in the fleet." else "$hostId finished. The pool is in the fleet."
            "failed" -> if (hostId.isBlank()) "Open to see what stopped it." else "Open to see what stopped it on $hostId."
            "cancelled" -> "Stopped between steps, as asked."
            "waiting" -> "Waiting for the sign-in"
            else -> XoSetup.stepWords(data["phase"], step, of) + if (hostId.isBlank()) "" else " · on $hostId"
        }

        val tap = openIntent(context, job, id)
        val notification = if (running && Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
            // A LIVE UPDATE. The platform draws the bar in the status bar
            // and on the lock screen while it is promoted; the segment is the
            // whole job and the progress is the step.
            Notification.Builder(context, PROGRESS_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(body)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setRequestPromotedOngoing(true)
                .setShortCriticalText("${(step + 1).coerceAtMost(of)}/$of")
                .setContentIntent(tap)
                .setStyle(
                    Notification.ProgressStyle()
                        .setProgressSegments(listOf(Notification.ProgressStyle.Segment(of)))
                        .setProgress(step)
                        .setStyledByProgress(true),
                )
                .build()
        } else {
            NotificationCompat.Builder(context, if (running) PROGRESS_CHANNEL else RESULT_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(if (running) NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_STATUS)
                .setOngoing(running)
                .setOnlyAlertOnce(running)
                .setAutoCancel(!running)
                .setContentIntent(tap)
                .apply { if (running) setProgress(of, step, false) }
                .build()
        }
        // THE SAME ID WHETHER RUNNING OR ENDED: the result replaces the
        // progress, which is what "it finished" should do to "it is running".
        NotificationManagerCompat.from(context).notify(id, notification)
    }

    /**
     * Tapping it opens the app on the job's progress. Explicit in a call, and
     * immutable, for the reasons Messaging.kt gives over its PendingIntents.
     */
    private fun openIntent(context: Context, job: String, id: Int): PendingIntent {
        val intent = Intent()
        intent.setClass(context, MainActivity::class.java)
        intent.putExtra(EXTRA_KIND, KIND)
        intent.putExtra(EXTRA_JOB, job)
        return PendingIntent.getActivity(context, id * 31, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
