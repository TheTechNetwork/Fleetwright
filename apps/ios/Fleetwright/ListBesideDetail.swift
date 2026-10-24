import SwiftUI

/// A list with the page it opens beside it, wherever there is room for both.
/// docs/watch-and-duo.md, "iPhone Duo".
///
/// WHY A SPLIT VIEW AND NOT A STACK. Unfolded, an iPhone Duo is 669 points
/// wide and reports regular width, and a stack there is a phone layout
/// stretched: opening a session replaced the list, so the sessions somebody
/// unfolded the phone to watch went off screen the moment they looked at one.
/// Calm recedes and trouble comes forward is easier to keep when the list that
/// carries the attention ring stays in view.
///
/// NO SIZE-CLASS BRANCH, ON PURPOSE. NavigationSplitView collapses to one stack
/// at compact width on its own, so the outer display, every other iPhone, and
/// a narrow Split View are exactly the stack they were; and unfolded it keeps
/// its columns clear of the fold. One design with two arrangements, which is
/// the system's to choose, not this file's.
///
/// The rows keep their own NavigationLinks and navigationDestinations: in the
/// sidebar column those open in the detail column, and collapsed they push as
/// they always did, so no screen behind a row needed to change.
struct ListBesideDetail<Rows: View>: View {
    /// What the detail column says before anything in the list is open.
    let nothingOpen: LocalizedStringKey
    let systemImage: String
    let hint: LocalizedStringKey
    @ViewBuilder let list: () -> Rows

    var body: some View {
        NavigationSplitView {
            list()
                // NARROW ENOUGH THAT THE PAGE IS STILL A PHONE'S WIDTH. Unfolded
                // in portrait the Duo is 669 points, so 300 here leaves the page
                // about 368, a small iPhone's width, which every page behind a
                // row was already laid out for. A wider list made the page
                // narrower than any phone. In landscape the page gets the rest.
                .navigationSplitViewColumnWidth(min: 280, ideal: 300, max: 360)
        } detail: {
            NavigationStack {
                ContentUnavailableView {
                    Label(nothingOpen, systemImage: systemImage)
                } description: {
                    Text(hint)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Design.Palette.bg)
            }
        }
        // BALANCED, so the list is never slid away to make room for the page.
        // The default lets the detail cover the sidebar in portrait, which on
        // a 669-point screen is the stack this replaced.
        .navigationSplitViewStyle(.balanced)
    }
}
