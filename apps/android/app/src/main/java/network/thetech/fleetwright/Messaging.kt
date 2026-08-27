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
 * The token is not stable. FCM reissues it on reinstall, on a data clear, and
 * occasionally on its own — and a coordinator holding a stale one has no way to
 * tell that from a phone that is simply asleep. It sends, FCM accepts, and
 * nothing arrives. So the only correct place to re-register is here, where the
 * SDK says the token changed.
 */
class Messaging : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
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
