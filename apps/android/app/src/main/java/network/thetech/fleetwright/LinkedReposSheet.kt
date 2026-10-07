package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.launch

/**
 * Linked repositories: three roles, one place (#346).
 *
 * ONE LIST WITH A ROLE ON EACH LINK, because the three want different things
 * and a single "linked repo" field meaning all of them is how somebody
 * bootstraps a private thing onto a public repository because "scratch"
 * sounded temporary:
 *
 *   Archive     PRIVATE. Where each session you start is pushed, on a branch
 *               of its own, before it stops and every ten minutes while it
 *               runs. A public one is refused, not warned about.
 *   Runners     PUBLIC. Where your temporary machines start: free Actions
 *               minutes are a public repository's. World-readable, logs
 *               included, so it is a launcher and nothing else. The same
 *               setting as Temporary machines, reached from here as well.
 *   Templates   EITHER. Skills, presets, configs and workflows a session can
 *               read when asked. Nothing in it runs by itself.
 *
 * What each role means is said where it is linked, before the button, which
 * is the point the issue asks for the warning to be at. Linked only once the
 * fleet's check for that role passes, and the check's answers are shown
 * either way. Unlink is drawn only for a role that has a link (C-2). The
 * same words as iOS's LinkedReposView, held equal by
 * test/linked-repos-in-apps.test.js.
 */
@Composable
internal fun LinkedReposSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    // Three states, each said: asking (neither set), answered, and failed with
    // the reason. `asked` is bumped by Ask again, which runs the load again.
    var failed by remember { mutableStateOf<String?>(null) }
    var answered by remember { mutableStateOf(false) }
    var asked by remember { mutableIntStateOf(0) }
    val links = remember { mutableStateMapOf<String, String>() }
    var fleetRunners by remember { mutableStateOf<String?>(null) }
    val drafts = remember { mutableStateMapOf<String, String>() }
    val messages = remember { mutableStateMapOf<String, String>() }
    val checks = remember { mutableStateMapOf<String, Fleet.LinkedRepoCheck>() }
    var busy by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(asked) {
        failed = null
        Fleet(settings).linkedRepos()
            .onSuccess { got ->
                links.clear()
                links.putAll(got.links)
                fleetRunners = got.fleetRunners
                for (role in linkedRoles) if (drafts[role].isNullOrBlank()) drafts[role] = got.links[role] ?: ""
                answered = true
            }
            .onFailure { failed = it.message ?: "no answer" }
    }

    FullScreen(title = "Linked repositories", onDismiss = onDismiss) {
        val why = failed
        when {
            why != null -> {
                Hint("The fleet did not say what you have linked: $why", color = Design.Palette.bad.now)
                OutlinedButton(onClick = { asked++ }) { Text("Ask again") }
            }
            !answered -> Hint("Asking the fleet…")
            else -> linkedRoles.forEach { role ->
                SectionHead(linkedRoleTitle(role))
                Hint(linkedRoleSentence(role))
                OutlinedTextField(
                    value = drafts[role] ?: "",
                    onValueChange = { drafts[role] = it.trim() },
                    label = { Text(linkedRoleField(role)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                    OutlinedButton(
                        enabled = busy == null && !drafts[role].isNullOrBlank(),
                        onClick = {
                            scope.launch {
                                busy = role
                                messages[role] = ""
                                Fleet(settings).linkRepo(role, drafts[role] ?: "")
                                    .onSuccess { r ->
                                        val check = r.linkedRepo
                                        if (check != null) checks[role] = check else checks.remove(role)
                                        messages[role] = r.text ?: ""
                                        if (r.ok == true && r.repo != null) {
                                            links[role] = r.repo
                                            drafts[role] = r.repo
                                        }
                                    }
                                    .onFailure { messages[role] = it.message ?: "that did not work" }
                                busy = null
                            }
                        },
                    ) { Text(if (busy == role) "Checking…" else "Check and link") }
                    if (links[role] != null) {
                        TextButton(
                            enabled = busy == null,
                            onClick = {
                                scope.launch {
                                    busy = role
                                    Fleet(settings).unlinkRepo(role)
                                        .onSuccess { r ->
                                            messages[role] = r.text ?: ""
                                            links.remove(role)
                                            checks.remove(role)
                                            drafts[role] = ""
                                        }
                                        .onFailure { messages[role] = it.message ?: "that did not work" }
                                    busy = null
                                }
                            },
                        ) { Text("Unlink", color = Design.Palette.bad.now) }
                    }
                }
                Text(describeLinkedRole(role, links[role], fleetRunners), style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                checks[role]?.let { check ->
                    Text(
                        describeLinkedCheck(check),
                        style = Design.Style.label,
                        fontFamily = FontFamily.Monospace,
                        color = if (check.ok) Design.Palette.ink.now else Design.Palette.bad.now,
                    )
                }
                messages[role]?.takeIf { it.isNotBlank() }?.let { message ->
                    SelectionContainer {
                        Hint(message, color = if (checks[role]?.ok == false) Design.Palette.bad.now else Design.Palette.ink.now)
                    }
                }
            }
        }
    }
}

/** The roles, in the order the screen draws them. Append only, like the
 * protocol's: a role this app has never heard of is not drawn. */
val linkedRoles = listOf("archive", "runners", "templates")

/** The section heading for a role. */
fun linkedRoleTitle(role: String): String = when (role) {
    "archive" -> "Archive"
    "runners" -> "Runners"
    "templates" -> "Templates"
    else -> role
}

/** What a role is for, and what linking it means, said before the button. */
fun linkedRoleSentence(role: String): String = when (role) {
    "archive" -> "Private. Each session you start is pushed here, on a branch of its own, before it stops and every ten minutes while it runs. A public repository is refused: this is your work, and possibly a client's."
    "runners" -> "Public, because Actions minutes are free only there. Your temporary machines start here. Anyone can read it, logs included, so it is a launcher and nothing else: no session writes into it."
    "templates" -> "Public or private. Skills, presets, configs and workflows a session can read when you ask it to. Nothing in it runs by itself."
    else -> ""
}

/** The field's label for a role. */
fun linkedRoleField(role: String): String =
    "Your ${if (role == "runners") "runner" else if (role == "templates") "templates" else "archive"} repository (owner/repo)"

/** What is linked for a role now, in one sentence. For runners, the fleet's
 * repository is what applies with none of your own, as Temporary machines says. */
fun describeLinkedRole(role: String, linked: String?, fleetRunners: String?): String = when {
    role == "runners" -> describeRunnerRepoSetting(linked, fleetRunners)
    linked != null -> "Linked: $linked."
    role == "archive" -> "Nothing linked. Sessions you start are not pushed anywhere when they stop."
    else -> "Nothing linked."
}

/** What a check found, one answer per fact, "can't tell" kept apart from "no". */
fun describeLinkedCheck(check: Fleet.LinkedRepoCheck): String {
    val runner = check.runnerRepo
    if (check.role == "runners" && runner != null) return describeRunnerCheck(runner)
    fun word(value: Boolean?): String = when (value) {
        true -> "yes"
        false -> "no"
        null -> "can't tell"
    }
    val visibility = if (check.role == "archive") "Private: ${word(check.isPublic?.not())}" else "Public: ${word(check.isPublic)}"
    val parts = mutableListOf(visibility, "GitHub app: ${word(check.installed)}")
    if (check.role == "archive") {
        parts += "Can write: ${word(check.contents?.let { it == "write" })}"
        parts += "You can push: ${word(check.push)}"
    } else {
        parts += "Can read: ${word(check.contents?.let { it != "none" })}"
        check.carries?.let { parts += "Carries: ${if (it.isEmpty()) "none of the known shapes" else it.joinToString(", ")}" }
    }
    return parts.joinToString(" · ")
}

/** The row under You: how many roles are linked, or that none are. */
fun describeLinkedRepos(count: Int): String = if (count == 0) "none linked" else "$count of ${linkedRoles.size} linked"
