package network.thetech.fleetwright

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * A provider authorization that happens inside the app and comes back by
 * itself.
 *
 * "Why is update or login two clicks when we can do one in an embedded
 * browser." It was two because the app launched the system browser and then
 * had nothing to do but wait: a separate "Done" button existed purely so
 * somebody could tell the app the thing that had already happened. The app was
 * asking the person to be the callback.
 *
 * TWO HALVES, and Android splits them where iOS does not. A Custom Tab opens
 * the page; the redirect to `fleetwright://connected` arrives as a fresh
 * Intent on the activity, because the manifest already claims that scheme.
 * [returned] is what joins them back up — the activity publishes what came
 * back, and whatever screen started the flow is listening.
 *
 * A CUSTOM TAB, NOT A WEBVIEW, and this matters more than the tap does. It is
 * the real browser: real address bar, real padlock, its own process, and the
 * user's own cookies — so somebody already signed in to GitHub is not asked
 * again, and somebody who is not can see exactly whose page they are typing a
 * password into. A WebView would look tidier and would be a login form drawn
 * by the app that is asking for it, which is the shape of every
 * credential-phishing screen ever built.
 */
object WebAuth {

    private val _returned = MutableSharedFlow<Uri>(extraBufferCapacity = 4)

    /**
     * Callbacks that have come back from a provider.
     *
     * TRUSTED FOR NOTHING. A custom scheme is unverified — any app on the
     * phone may claim it — so `ok=1` in the query is a nudge to go and ask the
     * host, never a fact to display. Which is why this carries the whole Uri
     * and no parsed verdict: there is no verdict here to parse.
     *
     * A SharedFlow rather than a StateFlow: a screen opening later must not
     * replay a callback from an hour ago and announce a connection nobody just
     * made.
     */
    val returned: SharedFlow<Uri> = _returned

    /** Called by the activity when an Intent arrives on our scheme. */
    fun deliver(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "fleetwright" || data.host != "connected") return
        _returned.tryEmit(data)
    }

    /**
     * Open [url] in a Custom Tab.
     *
     * Falls back to whatever handles the link if no browser supports Custom
     * Tabs — a person on a phone with an unusual browser gets the old two-step
     * flow rather than a button that does nothing, which is the right way for
     * this to degrade.
     */
    fun open(context: Context, url: String) {
        val uri = Uri.parse(url)
        try {
            CustomTabsIntent.Builder()
                .setShowTitle(true)
                // The page is a means, not a destination. Closing it after the
                // redirect is what makes this one tap instead of two.
                .build()
                .launchUrl(context, uri)
        } catch (_: Exception) {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        }
    }
}
