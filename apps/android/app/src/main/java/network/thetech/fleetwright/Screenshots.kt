package network.thetech.fleetwright

import android.content.Intent

/**
 * Starting the app on the demo fleet, so store screenshots show a fleet.
 *
 * WHY THIS EXISTS AT ALL. `scripts/ios-screenshots.sh` retakes the App Store
 * pictures from a script, and `Screenshots.swift` is what lets it: the app is
 * launched with an argument, seeds itself onto the demo, and the pictures show
 * sessions instead of an empty state with a Connect button. Android had the
 * uploader (`tools/play-release.mjs`) and neither half of what feeds it — so
 * the Play screenshots were taken by hand, and went stale the first time the
 * shell was redesigned (#268) while the App Store ones did not.
 *
 * Retaking them by hand is not just tedious, it is the reason they drift: it
 * means signing in, enrolling hosts and starting sessions on an emulator
 * before the first picture. This turns that into a launch flag.
 *
 * IT WRITES EXACTLY WHAT THE DEMO BUTTON WRITES, which is the same argument
 * Screenshots.swift makes. The three constants live in Demo.kt and are checked
 * against the Worker's copy by `test/demo-button.test.js`; a second definition
 * of "the demo" here would be a fourth copy with nothing holding it equal.
 *
 * DEBUG BUILDS ONLY, and this is the one place Android must be stricter than
 * iOS rather than mirroring it. An iOS launch argument is delivered by Xcode
 * and is not reachable on a device somebody is holding. An Intent extra is:
 * `adb shell am start --ez` reaches it on any phone with USB debugging on, and
 * so can any app that is allowed to start this activity. Seeding a credential
 * from an untrusted Intent is not a thing to leave compiled into a release
 * build and rely on nobody finding — so `BuildConfig.DEBUG` removes it from
 * one entirely, and the release APK has no such path to reach.
 */
object Screenshots {
    /** `adb shell am start -n … --ez fleetwright-demo true` */
    private const val EXTRA_DEMO = "fleetwright-demo"

    /**
     * Put this app on the demo fleet, if this build allows it and the Intent
     * asked.
     *
     * Returns whether it seeded, so a caller can say so in the log rather than
     * a screenshot run failing silently and producing five pictures of an
     * empty state — which is the failure that looks like success.
     */
    fun seedIfAsked(intent: Intent?, settings: Settings): Boolean {
        if (!BuildConfig.DEBUG) return false
        if (intent?.getBooleanExtra(EXTRA_DEMO, false) != true) return false
        settings.coordinatorUrl = Demo.COORDINATOR_URL
        settings.signedInAs = Demo.LABEL
        settings.credential = Demo.CREDENTIAL
        return true
    }
}
