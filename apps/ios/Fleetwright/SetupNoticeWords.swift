import Foundation

/// The words of a hypervisor setup's end notification, drawn by this phone
/// from the job's `state`, `phase` and `purpose` rather than read off the
/// push.
///
/// THE COORDINATOR'S PUSH CARRIES THE JOB'S SENTENCE as its body: what the
/// machine running the job last said, a path, a release and the end of a
/// build log among it. That is the setup page's to show (SetupResultView),
/// not the Lock Screen's: the notification says how it ended and where, in
/// the words the Live Activity and the screen already use for the same
/// state (XOSetupWords.headline), and a tap opens the page with the sentence
/// on it. Android has drawn its notification this way since it drew progress
/// (XoSetupNotice.kt); these are the same words, held equal by
/// test/reasons-in-apps.test.js.
///
/// IN THE NOTIFICATION SERVICE EXTENSION (NotificationService.swift), which
/// is why this is a file of its own with nothing but Foundation in it: the
/// extension's target compiles this and PushCrypto.swift and no other part of
/// the app. A phone with no push key sent gets the push unsealed, where no
/// extension runs, and shows the coordinator's title and sentence as before.
enum SetupNoticeWords {
    /// The notification's title, by what the job was for and how it ended.
    /// The ended ones are the coordinator's own tables (SETUP_TITLES,
    /// POLICY_TITLES, DEPLOY_TITLES, RECONNECT_TITLES, WATCHDOG_TITLES,
    /// PVE_TITLES in core.js), so the banner and the screen say one thing.
    static func title(purpose: String?, state: String) -> String {
        switch purpose {
        case "reconnect":
            switch state {
            case "done": return "Pools back"
            case "failed": return "The pools did not come back"
            case "cancelled": return "Reconnecting cancelled"
            default: return "Reconnecting Xen Orchestra’s servers"
            }
        case "pve":
            switch state {
            case "done": return "Proxmox VE set up"
            case "failed": return "Proxmox VE was not set up"
            case "cancelled": return "Setting up Proxmox VE cancelled"
            default: return "Setting up Proxmox VE"
            }
        case "watchdog":
            switch state {
            case "done": return "Watchdog added"
            case "failed": return "The watchdog was not added"
            case "cancelled": return "Adding the watchdog cancelled"
            default: return "Adding the reconnect watchdog"
            }
        case "deploy":
            switch state {
            case "done": return "Xen Orchestra installed and added"
            case "failed": return "Installing Xen Orchestra stopped"
            case "cancelled": return "Installing Xen Orchestra cancelled"
            default: return "Installing Xen Orchestra"
            }
        case "policy":
            switch state {
            case "done": return "What the fleet may use is changed"
            case "failed": return "The change stopped"
            case "cancelled": return "The change was cancelled"
            default: return "Changing what the fleet may use"
            }
        default:
            switch state {
            case "done": return "Hypervisor added"
            case "failed": return "Hypervisor setup stopped"
            case "cancelled": return "Hypervisor setup cancelled"
            default: return "Adding a hypervisor"
            }
        }
    }

    /// The notification's body: the result and where, never the machine's
    /// sentence. A failed job says to open it, because what stopped it is on
    /// the page; a done one names the machine that finished. The same words
    /// as Android's XoSetupNotice, state by state.
    static func body(purpose: String?, state: String, hostId: String, step: Int, of: Int) -> String {
        let named = !hostId.isEmpty
        switch state {
        case "done":
            switch purpose {
            case "reconnect": return "Open to see what each server came to."
            case "pve": return named ? "\(hostId) set up the node." : "The node is set up."
            case "watchdog": return named ? "\(hostId) finished. Open to see how Xen Orchestra was left." : "Open to see how Xen Orchestra was left."
            case "policy": return named ? "\(hostId) applied it." : "Applied."
            default: return named ? "\(hostId) finished. The pool is added." : "The pool is added."
            }
        case "failed":
            return named ? "Open to see what stopped it on \(hostId)." : "Open to see what stopped it."
        case "cancelled":
            return "Stopped between steps, as asked."
        case "waiting":
            switch purpose {
            case "deploy": return "Waiting for the passwords"
            case "watchdog", "pve": return "Waiting for the root password"
            default: return "Waiting for the sign-in"
            }
        default:
            // iOS hears a job's end and draws its progress as a Live Activity,
            // so a running step reaching here is a coordinator that sent one
            // anyway: the number it knows, and where (C-5).
            let line = "Step \(min(step + 1, max(of, 1))) of \(max(of, 1))"
            return named ? "\(line) · on \(hostId)" : line
        }
    }
}
