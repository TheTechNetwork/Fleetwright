package network.thetech.fleetwright

import android.util.Log
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
     * Notifications arrive as a `notification` payload, which the system tray
     * displays on its own while the app is backgrounded — the case that matters,
     * since the point is a phone in a pocket. This only runs in the foreground,
     * where there is nothing to add: the session list is already on screen.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        Log.i(TAG, "push while foregrounded: ${message.notification?.title ?: message.data}")
    }

    private companion object {
        const val TAG = "Fleetwright"
    }
}
