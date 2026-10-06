package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Alignment
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What the sheet collected. Handed up rather than sent from here, so the
 * request outlives the dialog that described it.
 */
data class StartRequest(
    val title: String?,
    val brief: String?,
    val mode: String?,
    val host: String?,
    /**
     * WHAT IT WILL DO, by name. Null means the session comes up idle at an
     * empty prompt and somebody has to drive it — which is what every session
     * did before protocol v3, and what nothing said out loud.
     */
    val profile: String? = null,
    /** OR WHAT IT WILL DO, in words (protocol v7): its first message. Either this or `profile`. */
    val task: String? = null,
    /**
     * WHAT IT MAY REACH, by name. Null grants nothing. The value never travels
     * with this — the host resolves the name and the session fetches the value
     * at runtime over the broker. See docs/trust.md.
     */
    val secret: String? = null,
    /**
     * A NEW TEMPORARY MACHINE to start it on, by operating system, or null for
     * a machine the fleet already has. When set, `host`, `profile` and
     * `secret` are null: the machine does not exist yet, and a runner holds no
     * task profiles or secrets of its own. `task` travels: it is how a machine
     * minutes old is given its job.
     */
    val platform: String? = null,
    /** How long that machine stays, in minutes. Only with `platform`. */
    val minutes: Int? = null,
    /**
     * For platform "vm": the machine image on your hypervisor it is cloned
     * from, and what to call it in a sentence.
     */
    val template: String? = null,
    val imageLabel: String? = null,
)

/**
 * The machines the New session sheet can ask for, by the operating system a
 * runner repository has a workflow for. The same four words and order as the
 * temporary-machine control in settings, and on iOS.
 */
data class NewMachineChoice(val platform: String, val label: String)

val newMachineChoices = listOf(
    NewMachineChoice("linux", "New Linux machine"),
    NewMachineChoice("macos", "New macOS machine"),
    NewMachineChoice("windows", "New Windows machine"),
    NewMachineChoice("android", "New Android emulator"),
)

/**
 * Starting a session without asking anybody to name a thing they have not done.
 *
 *   ordinary form:  [ Name ______ ] [ Start ]     <- stalls here
 *   this one:       [ What is this about? ____ ]
 *                   [ Title: suggested, editable ]
 *                   [ Start ]
 *
 * The brief comes first because it is recall — you already know what you are
 * about to do. The title is composition, which is harder, so it is offered
 * rather than demanded. Start is enabled from the first moment: leaving both
 * blank is a perfectly good answer and gets exactly what the app did before.
 */
@Composable
fun StartSheet(
    settings: Settings,
    preselectedKindId: String? = null,
    onDismiss: () -> Unit,
    onStart: (StartRequest) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val kinds = remember { SessionKinds.all(context) }

    var brief by remember { mutableStateOf("") }
    var task by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var lastSuggested by remember { mutableStateOf("") }
    var titleUntouched by remember { mutableStateOf(true) }
    var kind by remember {
        mutableStateOf(preselectedKindId?.let { id -> kinds.firstOrNull { it.id == id } })
    }
    var host by remember { mutableStateOf("") }
    var hosts by remember { mutableStateOf(listOf<String>()) }
    // NULL UNTIL THE FLEET ANSWERS, and that is the whole reason it is nullable
    // rather than an empty list. Rendering a picker while the request is in
    // flight offers "Nothing yet" as if it were the fleet's answer, and
    // somebody taps Start.
    var profiles by remember { mutableStateOf<List<Fleet.Profile>?>(null) }
    var profile by remember { mutableStateOf("") }
    // Nullable for the same reason as profiles: null is nobody-answered (a host
    // too old to know the verb), empty is this fleet holds none — and only the
    // second should show a picker.
    var secrets by remember { mutableStateOf<List<Fleet.Secret>?>(null) }
    var secret by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    // Whether this fleet can start a machine for this person at all, from the
    // snapshot. The new-machine choices are drawn from this and only this, so
    // a fleet with no runner repository offers none (C-2).
    var canStartMachine by remember { mutableStateOf(false) }
    /**
     * Whether a Claude login is kept for this person's runners. A new machine
     * started without one, and with no API key in the runner repository,
     * refuses the session it was started for, so this sheet says so.
     */
    var claude by remember { mutableStateOf<ClaudeKept?>(null) }
    // The operating system when a new machine is chosen, else empty: "vm"
    // for one from your hypervisor, with the image in `template`.
    var platform by remember { mutableStateOf("") }
    var template by remember { mutableStateOf("") }
    // The machine images on your own pools a new machine can come from, from
    // the snapshot. Drawn from this and only this (C-2).
    var images by remember { mutableStateOf<List<Fleet.VmImage>>(emptyList()) }
    var machineMinutes by remember { mutableIntStateOf(60) }

    // Suggest once the typing stops, not on every keystroke. A suggestion that
    // changes under the cursor while somebody is still writing makes them stop
    // to read it, lose the sentence, and costs them the thing it was meant to
    // save. Restarted by LaunchedEffect's key rather than by cancelling a job
    // by hand, which is the same debounce with less to get wrong.
    // From the brief when there is one, else the task, which says what the
    // session is about just as well.
    val suggestionSource = brief.ifBlank { task }
    LaunchedEffect(suggestionSource) {
        if (!titleUntouched || suggestionSource.isBlank()) return@LaunchedEffect
        delay(700)
        val suggested = Naming.suggest(suggestionSource)
        // The text may have moved on. Applying a title for text that is no
        // longer there is worse than applying none.
        if (titleUntouched) {
            lastSuggested = suggested
            title = suggested
        }
    }

    LaunchedEffect(Unit) {
        // The enrolled list the settings screen already uses. Loaded here so
        // the sheet works from every entry point, launcher shortcuts included.
        hosts = runCatching { Fleet(settings).enrolledHosts().map { it.hostId } }.getOrDefault(emptyList())
        // Nullable all the way through: Fleet.profiles() answers null when
        // nobody could say — an old coordinator, or hosts that refuse the verb
        // by name — and that is not the same as a fleet with no profiles.
        profiles = Fleet(settings).profiles()
        // Same nullable rule: null is "nobody answered", so an old fleet shows
        // no secret picker rather than a wrong one.
        secrets = Fleet(settings).secrets()
        // Whether a new machine can be offered. A failure offers none, which
        // is the safe way round for a control that spends money.
        canStartMachine = Fleet(settings).runners().getOrNull() != null
        images = Fleet(settings).vmImages().getOrDefault(emptyList())
        if (canStartMachine || images.isNotEmpty()) claude = claudeKept(settings)
    }

    AlertDialog(
        onDismissRequest = { onDismiss() },
        title = { Text("New session") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
            ) {
                OutlinedTextField(
                    value = brief,
                    onValueChange = { brief = it },
                    label = { Text("What is this about?") },
                    supportingText = { Text("Optional. Helps you recognise this session later.") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = title,
                    onValueChange = {
                        title = it
                        // Compared against the last suggestion rather than a
                        // plain did-it-change flag: setting the field
                        // programmatically also changes it, which would mark our
                        // own suggestion as edited and stop every later one.
                        if (it != lastSuggested) titleUntouched = false
                    },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                // WHAT IT WILL DO, and it is above Kind and Where because it
                // is the question that decides whether starting is worth doing
                // at all. A session with nothing to do comes up idle: correct,
                // sometimes wanted, and never what somebody expects from a
                // button labelled Start.
                //
                // THE WORDS FIRST, always offered: since protocol v7 a session
                // can be handed its job in words, and a new machine in no other
                // way. A profile a host has written down is the alternative,
                // offered once the fleet has answered that it has some. Writing
                // a task clears a chosen profile: two first messages is one too
                // many, and the host refuses the pair.
                val offered = profiles.orEmpty()
                Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
                    OutlinedTextField(
                        value = task,
                        onValueChange = {
                            task = it
                            if (it.isNotBlank()) profile = ""
                        },
                        label = { Text("What should it do?") },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (offered.isNotEmpty() && platform.isEmpty() && task.isBlank()) {
                        Text("Or one written on a host", style = MaterialTheme.typography.labelMedium)
                        AssistChip(
                            onClick = { profile = "" },
                            label = { Text(if (profile.isEmpty()) "None \u2713" else "None") },
                        )
                        offered.forEach { p ->
                            AssistChip(
                                onClick = {
                                    profile = if (profile == p.name) "" else p.name
                                    // Where it can run is decided by where the
                                    // file IS. A profile only one box has pins
                                    // the host, because `start` elsewhere is
                                    // refused — and a refusal a person cannot
                                    // act on is worse than a picker that moved
                                    // on its own.
                                    val owners = offered.filter { it.name == profile }.mapNotNull { it.hostId }.toSet()
                                    if (owners.size == 1) host = owners.first()
                                },
                                // The summary, not the name: the name is a
                                // filename and the summary is the sentence
                                // somebody wrote to be recognised by.
                                label = {
                                    val shown = p.summary.ifBlank { p.name }
                                    Text(if (profile == p.name) "$shown \u2713" else shown)
                                },
                            )
                        }
                    }
                    Text(
                        when {
                            task.isNotBlank() ->
                                "It starts with these words and gets to work. Say what to do, where, and what to report back: nothing can be added once it is going."
                            profile.isEmpty() -> "Leave it empty and it starts idle, waiting for you."
                            else -> "It starts with this as its first message. The words are kept on the host."
                        },
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                // WHAT IT MAY REACH, optional. Shown only when a box actually
                // holds a secret — an empty picker offers a control for a
                // capability nobody set up. Names only: the value stays on the
                // host and this app never sees it.
                val secretsOffered = secrets.orEmpty()
                if (secretsOffered.isNotEmpty() && platform.isEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
                        Text("Secret", style = MaterialTheme.typography.labelMedium)
                        AssistChip(
                            onClick = { secret = "" },
                            label = { Text(if (secret.isEmpty()) "None ✓" else "None") },
                        )
                        secretsOffered.forEach { s ->
                            AssistChip(
                                onClick = {
                                    secret = if (secret == s.name) "" else s.name
                                    // Pins the host like a profile: a secret is
                                    // on one box, and `start --secret` elsewhere
                                    // is refused.
                                    val owners = secretsOffered.filter { it.name == secret }.mapNotNull { it.hostId }.toSet()
                                    if (owners.size == 1) host = owners.first()
                                },
                                label = { Text(if (secret == s.name) "${s.name} ✓" else s.name) },
                            )
                        }
                        Text(
                            if (secret.isEmpty())
                                "Optional. Grant a named secret and the session can fetch its value at runtime."
                            else
                                "It may fetch this secret's value while it runs. The value stays on the host — this app never sees it.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                if (kinds.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
                        Text("Kind", style = MaterialTheme.typography.labelMedium)
                        kinds.forEach { k ->
                            AssistChip(
                                onClick = {
                                    kind = if (kind?.id == k.id) null else k
                                    // A kind that names a host or a task fills
                                    // both pickers, and they stay editable: a
                                    // kind is a default, not a decision made
                                    // last month that cannot be revisited.
                                    kind?.let { chosen ->
                                        if (chosen.host.isNotBlank()) host = chosen.host
                                        // Only if the fleet still has it — a
                                        // kind naming a deleted profile would
                                        // otherwise pre-fill a refused start.
                                        if (task.isBlank() && offered.any { it.name == chosen.profile }) profile = chosen.profile
                                    }
                                },
                                label = { Text(if (kind?.id == k.id) "${k.displayName} ✓" else k.displayName) },
                            )
                        }
                    }
                }
                // Only when there is a choice. One host is not a decision,
                // and a picker with one entry is furniture. A fleet that can
                // start a machine always has a choice: here, or a new one.
                if (hosts.size > 1 || canStartMachine || images.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
                        Text("Where", style = MaterialTheme.typography.labelMedium)
                        AssistChip(
                            onClick = { host = ""; platform = ""; template = "" },
                            label = { Text(if (host.isEmpty() && platform.isEmpty()) "Wherever fits \u2713" else "Wherever fits") },
                        )
                        hosts.forEach { h ->
                            AssistChip(
                                onClick = { host = if (host == h) "" else h; platform = ""; template = "" },
                                label = { Text(if (host == h) "$h \u2713" else h) },
                            )
                        }
                        // FROM YOUR OWN HYPERVISOR, first among the new
                        // machines: up in a minute or two, and billed to
                        // nobody. Asked for: "Still can't run sessions on it".
                        images.forEach { image ->
                            AssistChip(
                                onClick = {
                                    if (template == image.template) {
                                        template = ""
                                        platform = ""
                                    } else {
                                        template = image.template
                                        platform = "vm"
                                        host = ""
                                        profile = ""
                                        secret = ""
                                    }
                                },
                                label = { Text(if (template == image.template) "${image.label} \u2713" else image.label) },
                            )
                        }
                        if (canStartMachine) {
                            newMachineChoices.forEach { choice ->
                                AssistChip(
                                    onClick = {
                                        template = ""
                                        platform = if (platform == choice.platform) "" else choice.platform
                                        // A machine that does not exist yet has
                                        // nothing to do a host, a profile or a
                                        // secret with, so choosing one clears
                                        // all three rather than leaving a start
                                        // that is refused.
                                        if (platform.isNotEmpty()) { host = ""; profile = ""; secret = "" }
                                    },
                                    label = { Text(if (platform == choice.platform) "${choice.label} \u2713" else choice.label) },
                                )
                            }
                        }
                        if (platform.isNotEmpty()) {
                            // Five-minute steps between the protocol's bounds,
                            // the same as iOS: a stepper cannot ask for 4 or 351.
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                            ) {
                                TextButton(enabled = machineMinutes > 5, onClick = { machineMinutes -= 5 }) { Text("Less") }
                                Text("For $machineMinutes minutes", style = MaterialTheme.typography.bodyMedium)
                                TextButton(enabled = machineMinutes < 350, onClick = { machineMinutes += 5 }) { Text("More") }
                            }
                            // NO LINK PROMISED. A runner's credential cannot open
                            // Remote Control, so the notification that matters
                            // is the one when its task is done.
                            if (platform == "vm") {
                                Text(
                                    "It is cloned from your machine image and joins in a minute or two. The session starts on it then" +
                                        (if (task.isBlank()) ", idle, with nothing to do. Give it a task above to put it to work."
                                        else " and works on your task. You get a notification when it is back at its prompt.") +
                                        " It powers off when the time runs out and is removed, with everything on it.",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            } else {
                                Text(
                                    "It takes a few minutes to boot. The session starts on it when it joins" +
                                        (if (task.isBlank()) ", idle, with nothing to do. Give it a task above to put it to work."
                                        else " and works on your task. You get a notification when it is back at its prompt.") +
                                        " Everything on it is gone when the time runs out.",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            // SAID OUT LOUD, as docs/runner-central.md says it:
                            // the Windows runner is written and not yet proven.
                            if (platform == "windows") {
                                Text(
                                    "Windows runners are written and not yet proven.",
                                    style = Design.Style.bodySmall,
                                    color = Design.Palette.attention.now,
                                )
                            }
                        }
                    }
                }
                // ASKED WHERE IT MATTERS: a runner fetches its owner's Claude
                // login when it joins, and nothing said so until after it had.
                if (platform.isNotEmpty() && (claude == ClaudeKept.Missing || claude == ClaudeKept.NeedsGitHub)) {
                    SectionHead("Claude")
                    Text(
                        if (platform == "vm") {
                            "No Claude login is kept in your vault, so a machine from your hypervisor has nothing to run " +
                                "its session on. Keep one here first."
                        } else {
                            "No Claude login is kept for your runners, so this one runs on the runner repository's " +
                                "API key if it has one, and cannot start the session if it does not."
                        },
                        style = Design.Style.bodySmall,
                        color = Design.Palette.attention.now,
                    )
                    ClaudeSetup(settings, onKept = { claude = ClaudeKept.Kept })
                }
                if (error.isNotBlank()) {
                    Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            // Never disabled for an empty title or brief. Both are optional and
            // the whole point is that this is answerable without them.
            // Hand it up and close. Nobody waits.
            //
            // This used to await the whole start — a container, a fresh volume,
            // credentials and the Remote Control check, up to a minute — with
            // the dialog open throughout. Explaining that wait was still a
            // wait; nobody needs to be present for it.
            TextButton(
                enabled = settings.configured,
                onClick = {
                    var finalTitle = title.trim()
                    val prefix = kind?.titlePrefix.orEmpty()
                    if (prefix.isNotBlank() && finalTitle.isNotBlank()) finalTitle = "$prefix: $finalTitle"
                    onStart(
                        StartRequest(
                            title = finalTitle.ifBlank { null },
                            brief = brief.trim().ifBlank { null },
                            mode = kind?.mode,
                            host = host.ifBlank { null }.takeIf { platform.isEmpty() },
                            profile = profile.ifBlank { null }.takeIf { platform.isEmpty() && task.isBlank() },
                            task = task.trim().ifBlank { null },
                            secret = secret.ifBlank { null }.takeIf { platform.isEmpty() },
                            platform = platform.ifBlank { null },
                            minutes = machineMinutes.takeIf { platform.isNotEmpty() },
                            template = template.ifBlank { null }.takeIf { platform == "vm" },
                            imageLabel = images.firstOrNull { it.template == template }?.label.takeIf { platform == "vm" },
                        ),
                    )
                    onDismiss()
                },
            ) { Text("Start") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
