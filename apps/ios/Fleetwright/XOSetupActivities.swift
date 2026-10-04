import ActivityKit
import Foundation

/// The Live Activity for a hypervisor being added: started here once the
/// sign-in is on its way, kept moving by the coordinator's pushes while the
/// app is closed, and ended by whichever side learns the job is over first.
/// docs/hypervisors.md; the view that draws it is in the FleetwrightActivity
/// extension, and the type both share is XOSetupAttributes.
///
/// WHY AN ACTIVITY AND NOT THE SCREEN. The setup takes minutes on a machine
/// in the fleet, and the whole point of running it there is that the phone
/// does not have to stay awake for it. The screen polls while it is open; the
/// Lock Screen and the Dynamic Island carry on when it is not, fed by the
/// coordinator (#onSetupProgress in src/fleet/coordinator/core.js) through
/// the push token registered below.
///
/// NO `#available` GUARDS. The push-token path needs iOS 16.2 and the
/// deployment target is 26 (project.yml), so a guard would be unreachable,
/// which is the rule FleetwrightApp states for the same case.
enum XOSetupActivities {
    /// Start one for a job whose sign-in was just accepted, and keep the
    /// coordinator told where its updates go.
    ///
    /// A FAILURE TO START IS NOT A FAILURE OF THE SETUP. Activities can be
    /// turned off in Settings, and the system refuses one when it already
    /// has as many as it will show. The screen keeps polling either way, so
    /// nothing here throws and nothing is said.
    @MainActor
    static func start(fleet: Fleet, job: String, hostId: String, address: String, progress: Fleet.SetupState?) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = XOSetupAttributes(job: job, hostId: hostId, address: address)
        // Before the first step is reported there is no count to show, so the
        // first content says what is happening and no number: `of` 0 draws no
        // bar and no ordinal (XOSetupWords.ordinal), rather than a bar that
        // claims a length nobody has reported.
        let first = contentState(progress)
            ?? XOSetupAttributes.ContentState(step: 0, of: 0, phase: "connect", state: "running")
        let activity: Activity<XOSetupAttributes>
        do {
            activity = try Activity<XOSetupAttributes>.request(
                attributes: attributes,
                content: ActivityContent(state: first, staleDate: nil),
                pushType: .token
            )
        } catch {
            return
        }
        // THE TOKEN, EVERY TIME IT CHANGES. iOS hands an activity a push
        // token shortly after it starts and may rotate it; the coordinator
        // keeps the last four per job and drops the ones APNs says are dead.
        // Hex, as the device token is sent (Fleet.registerDevice), and the
        // answer carries where the job already is, so an activity that
        // registered late starts right rather than at step one.
        Task {
            for await token in activity.pushTokenUpdates {
                let hex = token.map { String(format: "%02x", $0) }.joined()
                guard let latest = try? await fleet.registerSetupActivity(job: job, token: hex),
                      latest.ok == true,
                      let state = contentState(latest.progress)
                else { continue }
                await activity.update(ActivityContent(state: state, staleDate: nil))
            }
        }
    }

    /// What the screen learned by polling, applied to the activity for that
    /// job as well, so the two never disagree while both are visible. A job
    /// that is over ends the activity with its last state showing, and the
    /// Lock Screen keeps it for a quarter of an hour, which is the time the
    /// coordinator's own `end` push gives it (#onSetupProgress).
    static func apply(job: String, progress: Fleet.SetupState) async {
        guard let state = contentState(progress) else { return }
        for activity in Activity<XOSetupAttributes>.activities where activity.attributes.job == job {
            let content = ActivityContent(state: state, staleDate: nil)
            if XOSetupWords.isLive(state.state) {
                await activity.update(content)
            } else {
                await activity.end(content, dismissalPolicy: .after(Date(timeIntervalSinceNow: 15 * 60)))
            }
        }
    }

    /// The activity's content from a reply, or nil when the reply has not
    /// said where the job is: `begin`'s answer, or an older coordinator's.
    static func contentState(_ progress: Fleet.SetupState?) -> XOSetupAttributes.ContentState? {
        guard let progress, let step = progress.step, let of = progress.of,
              let phase = progress.phase, let state = progress.state
        else { return nil }
        return XOSetupAttributes.ContentState(step: step, of: of, phase: phase, state: state)
    }
}
