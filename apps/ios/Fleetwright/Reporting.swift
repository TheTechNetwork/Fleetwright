import Foundation

/// Whether this launch is one whose crashes are worth anybody's attention, and
/// what to call it when it is.
///
/// WHY THIS EXISTS. The first three hangs this project ever received read, in
/// the tracker, as `environment: production` on `iPhone18,1` — an app frozen for
/// three seconds in somebody's hand. Every one of them was CI:
///
///   - the binary is `Fleetwright.debug.dylib`, under
///     `/Users/runner/Library/Developer/CoreSimulator/…` — a GitHub Actions
///     runner, building Debug, running the simulator;
///   - `build_type: simulator`, `device.simulator: True`;
///   - one of the three has `XCTestCore` on the main thread between UIKit and
///     the `write` it was blocked in, which is `xcodebuild test` writing its
///     own log;
///   - and two of the three have no app code above the run loop at all. The
///     stack is `main` → SwiftUI → `UIApplicationMain` → `CFRunLoopRun` →
///     `mach_msg`, which is an app sitting still. What was slow was a
///     three-core runner with 117 MB free running a simulator.
///
/// Sentry's app-hang threshold is two seconds of a blocked main thread. That is
/// a fair number for a phone and a meaningless one for a virtualised runner
/// under full load, so the reports were real measurements of the wrong machine
/// — and they arrive labelled exactly like the ones that would matter, which is
/// the part that costs something. This project's iOS tracker has had four
/// events in it and three of them are the build system, which is a tracker
/// nobody reads by the fifth.
///
/// THE FOURTH IS NOT THIS, and is left alone deliberately: a watchdog
/// termination from a real TestFlight build (`0.2.3+328`), with no stack, no
/// breadcrumbs and nothing in this app's own code to point at — the polling
/// loops are cancellable `Task.sleep`, the one keychain read happens once at
/// launch, and no view body does file or network work. It is unexplained. What
/// changes for it is only that the next one will not be sitting among CI runs.
///
/// WHAT THIS DOES NOT CLAIM. Refusing these does not make the app faster and is
/// not a fix for a hang; there was no hang. It makes the next report mean what
/// it says, which is the only way anybody will be able to tell.
enum Reporting {
    /// Should this launch start the reporter at all?
    ///
    /// A SIMULATOR IS NEVER A USER. It is CI, or it is somebody at a Mac with
    /// the console already open and Xcode already attached — neither of whom
    /// learns anything from an event landing in a web app tomorrow. The check
    /// is `#if targetEnvironment(simulator)` rather than a runtime flag
    /// because it is settled at compile time and cannot be wrong.
    ///
    /// A TEST RUN IS NEVER A USER EITHER, and needs the runtime check rather
    /// than a compile-time one: the unit tests are hosted by this app, so the
    /// process `xcodebuild test` launches is this process. Run on a device
    /// instead of a simulator it is a Debug build being driven by a test
    /// runner, and the run-loop stalls that produces belong to the runner.
    static var wanted: Bool {
        if forced { return true }
        #if targetEnvironment(simulator)
        return false
        #else
        return !isTestRun
        #endif
    }

    /// The escape hatch, because a reporter nobody can exercise is a reporter
    /// nobody can fix.
    ///
    /// `docs/error-reporting.md` says to raise `sessionSampleRate` while
    /// testing the replay, and until now the only place to do that was a
    /// signed build on a real phone. This makes a simulator run report when
    /// somebody asks it to, and only then — same shape as the launch arguments
    /// in `Screenshots.swift`, and like those it can turn something on and
    /// cannot point it anywhere.
    static var forced: Bool {
        ProcessInfo.processInfo.arguments.contains("-fleetwright-report")
    }

    /// Is this process being driven by XCTest?
    ///
    /// The variable is set by the test runner in the host app's environment;
    /// it is the same check every crash reporter makes, for the same reason.
    static var isTestRun: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    /// What to file these under.
    ///
    /// From the build configuration by way of `Info.plist`, the way the DSN and
    /// `aps-environment` already are — `project.yml` sets it per configuration,
    /// so it follows the build rather than needing anyone to remember. Debug is
    /// `development` there and Release is `production`, and the archive that
    /// goes to TestFlight is a Release build, so beta and store builds share a
    /// label. Their version numbers already separate them.
    ///
    /// UNSET IS `unknown`, NOT `production`. An empty key means the build
    /// setting did not reach the plist, which is a fact about our packaging and
    /// not evidence about where the app is running. Guessing the commoner
    /// answer is how the CI reports came to be labelled the way they were.
    static var environment: String {
        let named = Bundle.main.object(forInfoDictionaryKey: "SentryEnvironment") as? String ?? ""
        return named.isEmpty ? "unknown" : named
    }
}
