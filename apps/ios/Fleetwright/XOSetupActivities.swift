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
    /// How long content this phone wrote is believed before the Lock Screen
    /// says it has heard nothing. A step takes seconds and the whole setup
    /// minutes, so twenty of them without a word is a job that has gone
    /// quiet, not a slow one; the coordinator forgets a job after a day.
    static let staleAfter: TimeInterval = 20 * 60

    /// The activities whose push tokens this process is already relaying,
    /// by activity id, so a credential change or a second launch path does
    /// not start a second loop for the same one.
    @MainActor private static var followed = Set<String>()

    /// Start one for a job whose sign-in was just accepted, and keep the
    /// coordinator told where its updates go.
    ///
    /// A FAILURE TO START IS NOT A FAILURE OF THE SETUP. Activities can be
    /// turned off in Settings, and the system refuses one when it already
    /// has as many as it will show. The screen keeps polling either way, so
    /// nothing here throws and nothing is said.
    ///
    /// A POLICY JOB GETS ONE when its choice is sent (`purpose: "policy"`),
    /// because that is when it may go on for minutes building the edge
    /// router; until then the person is on the open screen choosing. Asked
    /// for: the first version started one only for adding a pool, and the
    /// router's download left nothing on the Lock Screen.
    @MainActor
    static func start(fleet: Fleet, job: String, hostId: String, address: String, progress: Fleet.SetupState?,
                      purpose: String? = nil, otherwise: XOSetupAttributes.ContentState? = nil) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // One per job: a second Apply on the same job is the same change.
        guard !Activity<XOSetupAttributes>.activities.contains(where: { $0.attributes.job == job }) else { return }
        let attributes = XOSetupAttributes(job: job, hostId: hostId, address: address, purpose: purpose)
        // Before the first step is reported there is no count to show, so the
        // first content says what is happening and no number: `of` 0 draws no
        // bar and no ordinal (XOSetupWords.ordinal), rather than a bar that
        // claims a length nobody has reported. A reply that is not live (a
        // policy job still saying `choosing`) is not where the job is going.
        let reported = contentState(progress).flatMap { XOSetupWords.isLive($0.state) ? $0 : nil }
        let first = reported ?? otherwise
            ?? XOSetupAttributes.ContentState(step: 0, of: 0, phase: "connect", state: "running", since: Date())
        let activity: Activity<XOSetupAttributes>
        do {
            activity = try Activity<XOSetupAttributes>.request(
                attributes: attributes,
                content: content(first),
                pushType: .token
            )
        } catch {
            return
        }
        follow(activity, fleet: fleet)
    }

    /// At launch: every activity this app left on the Lock Screen gets its
    /// token relayed again. The loop in `follow` dies with the process, and
    /// iOS may hand a surviving activity a new token after a relaunch; a
    /// coordinator that is never told it pushes to a token nobody reads, and
    /// the Lock Screen keeps saying whatever it said when the app was killed.
    @MainActor
    static func resume(fleet: Fleet) {
        for activity in Activity<XOSetupAttributes>.activities {
            follow(activity, fleet: fleet)
        }
    }

    /// THE TOKEN, EVERY TIME IT CHANGES. iOS hands an activity a push token
    /// shortly after it starts and may rotate it; the coordinator keeps the
    /// last four per job and drops the ones APNs says are dead. Hex, as the
    /// device token is sent (Fleet.registerDevice), and the answer carries
    /// where the job already is, so an activity that registered late starts
    /// right rather than at step one.
    ///
    /// The token it already holds goes first, because on a relaunch the
    /// sequence reports changes and the current one is not a change.
    @MainActor
    private static func follow(_ activity: Activity<XOSetupAttributes>, fleet: Fleet) {
        guard !followed.contains(activity.id) else { return }
        followed.insert(activity.id)
        let job = activity.attributes.job
        Task {
            if let token = activity.pushToken {
                await register(token, for: job, on: activity, fleet: fleet)
            }
            for await token in activity.pushTokenUpdates {
                await register(token, for: job, on: activity, fleet: fleet)
            }
        }
    }

    private static func register(_ token: Data, for job: String, on activity: Activity<XOSetupAttributes>, fleet: Fleet) async {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard let latest = try? await fleet.registerSetupActivity(job: job, token: hex),
              latest.ok == true,
              let state = contentState(latest.progress)
        else { return }
        await show(state, on: activity)
    }

    /// What the screen learned by polling, applied to the activity for that
    /// job as well, so the two never disagree while both are visible. A job
    /// that is over ends the activity with its last state showing, and the
    /// Lock Screen keeps it for a quarter of an hour, which is the time the
    /// coordinator's own `end` push gives it (#onSetupProgress).
    ///
    /// A REPLY WITH A STATE AND NO STEP STILL ENDS IT. When the coordinator
    /// no longer knows the job the screen declares it failed with no step
    /// behind the word, and the first version of this returned on the
    /// missing step, so the Lock Screen went on saying "running" for a job
    /// the app had just called dead. Now the activity keeps the step it last
    /// showed and takes the new state. A live state with no step is still
    /// nothing new to say.
    static func apply(job: String, progress: Fleet.SetupState) async {
        guard let newState = progress.state else { return }
        let fresh = contentState(progress)
        if fresh == nil, XOSetupWords.isLive(newState) { return }
        for activity in Activity<XOSetupAttributes>.activities where activity.attributes.job == job {
            var state = fresh ?? activity.content.state
            state.state = newState
            state.since = Date()
            await show(state, on: activity)
        }
    }

    /// Update while it is live, end once it is not. One place, so the token
    /// loop and the screen's polling cannot disagree about which.
    private static func show(_ state: XOSetupAttributes.ContentState, on activity: Activity<XOSetupAttributes>) async {
        let content = content(state)
        if XOSetupWords.isLive(state.state) {
            await activity.update(content)
        } else {
            await activity.end(content, dismissalPolicy: .after(Date(timeIntervalSinceNow: 15 * 60)))
        }
    }

    /// The content, with the date it goes stale: twenty minutes on, while
    /// the job is live, after which the Lock Screen says it has heard nothing
    /// (`context.isStale` in FleetwrightActivity). A finished job is not
    /// waiting for word, so its content never goes stale.
    static func content(_ state: XOSetupAttributes.ContentState) -> ActivityContent<XOSetupAttributes.ContentState> {
        ActivityContent(state: state, staleDate: XOSetupWords.isLive(state.state) ? Date(timeIntervalSinceNow: staleAfter) : nil)
    }

    /// The activity's content from a reply, or nil when the reply has not
    /// said where the job is: `begin`'s answer, or an older coordinator's.
    /// Stamped with now, because this phone just heard it.
    static func contentState(_ progress: Fleet.SetupState?) -> XOSetupAttributes.ContentState? {
        guard let progress, let step = progress.step, let of = progress.of,
              let phase = progress.phase, let state = progress.state
        else { return nil }
        return XOSetupAttributes.ContentState(step: step, of: of, phase: phase, state: state, since: Date(),
                                              fill: state == "running" ? progress.part?.fill : nil)
    }
}
