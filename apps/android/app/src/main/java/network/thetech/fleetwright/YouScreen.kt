package network.thetech.fleetwright

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * The You tab: who you are on this fleet, what your sessions may use, how the
 * app reaches you, and the setup that is done once.
 *
 * FIRST RUN IS ONE BLOCK, IN ORDER: the fleet's address, the sign-in under it,
 * and the demo. It was a Save button that closed the panel and said "Now sign
 * in." to nobody, then three sections (Fleet, Siri, People) between the URL and
 * the sign-in, then two near-identical hints about the URL drawn together.
 * Signed in, the address is a fact with "Sign out to change it".
 *
 * Each finished piece of setup is one row: Credentials, Temporary machines,
 * Linked repositories, Devices. What only an admin can do (People)
 * is drawn for an admin and nobody else.
 */
@Composable
fun YouScreen(
    settings: Settings,
    /** The real role, which is what offers the switch. */
    admin: Boolean?,
    viewAsMember: Boolean,
    onViewAsMember: (Boolean) -> Unit,
    onSignedIn: () -> Unit,
    onSignedOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Saved, so a rotation mid-typing does not reset the field.
    var url by rememberSaveable { mutableStateOf(settings.coordinatorUrl) }
    var signedIn by rememberSaveable { mutableStateOf(settings.credential.isNotBlank()) }
    var identity by rememberSaveable { mutableStateOf(settings.signedInAs) }
    var signInResult by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var pushResult by rememberSaveable { mutableStateOf("") }
    var runnersAnswered by remember { mutableStateOf(false) }
    var runnersSaved by remember { mutableStateOf<String?>(null) }
    var runnersFleet by remember { mutableStateOf<String?>(null) }
    // How many roles this person has linked a repository for, once the fleet
    // has said; null until then, and the row is not drawn.
    var linkedCount by remember { mutableStateOf<Int?>(null) }
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    val inDemo = signedIn && Demo.isActive(settings.coordinatorUrl)

    LaunchedEffect(signedIn) {
        if (!signedIn) return@LaunchedEffect
        Fleet(settings).runnerRepoSetting().onSuccess { got ->
            if (got.ok != false) {
                runnersAnswered = true
                runnersSaved = got.repo
                runnersFleet = got.fleet
            }
        }
        Fleet(settings).linkedRepos().onSuccess { got ->
            if (got.ok != false) linkedCount = got.links.size
        }
    }

    when (open) {
        "credentials" -> CredentialsScreen(settings, onDismiss = { open = null })
        "temporary" -> TemporaryMachinesSheet(settings, onDismiss = { open = null })
        "linked" -> LinkedReposSheet(settings, onDismiss = { open = null })
        "devices" -> DevicesSheet(settings, if (viewAsMember) false else admin, onDismiss = { open = null })
        "kinds" -> KindsSheet(settings = settings, onDismiss = { open = null })
        "people" -> PeopleSheet(settings = settings, onDismiss = { open = null })
    }

    fun signOut() {
        settings.credential = ""
        settings.signedInAs = ""
        signedIn = false
        identity = ""
        onSignedOut()
    }

    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Design.Space.page, vertical = Design.Space.groupTight),
        verticalArrangement = Arrangement.spacedBy(Design.Space.inside),
    ) {
        if (!signedIn) {
            SectionHead("Your fleet")
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Coordinator URL") },
                placeholder = { Text("https://fleet.thetech.network") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                enabled = url.isNotBlank() && !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        signInResult = "signing in…"
                        // Saved first: signing in against a URL that has been
                        // typed but not saved would sign in to the wrong fleet.
                        settings.coordinatorUrl = url
                        try {
                            val idToken = SignIn.googleIdToken(context)
                            val (token, email) = Fleet(settings).signIn(
                                idToken = idToken,
                                deviceName = "${Build.MANUFACTURER} ${Build.MODEL}",
                            )
                            settings.credential = token
                            settings.signedInAs = email
                            signedIn = true
                            identity = email
                            signInResult = ""
                            onSignedIn()
                        } catch (e: SignIn.Cancelled) {
                            signInResult = ""
                        } catch (e: Exception) {
                            signInResult = e.message ?: "sign-in failed"
                        }
                        busy = false
                    }
                },
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Sign in with Google") }
            // WHY IT IS GREY, SAID OUT LOUD, about the field that really is just
            // above it now. Sign-in exchanges an identity with one fleet.
            if (url.isBlank()) {
                Hint("Enter your fleet's address first — signing in means signing in to a fleet.")
            }
            if (signInResult.isNotBlank()) Hint(signInResult)
            // ONE TAP INTO A FLEET THAT ISN'T REAL. The real coordinator is
            // REMEMBERED rather than discarded.
            TextButton(onClick = {
                if (settings.coordinatorUrl.isNotBlank() && !Demo.isActive(settings.coordinatorUrl)) {
                    settings.urlBeforeDemo = settings.coordinatorUrl
                }
                settings.coordinatorUrl = Demo.COORDINATOR_URL
                url = Demo.COORDINATOR_URL
                settings.signedInAs = Demo.LABEL
                settings.credential = Demo.CREDENTIAL
                identity = Demo.LABEL
                signedIn = true
                onSignedIn()
            }) { Text("Look around the demo fleet") }
            Hint(
                "This device gets a credential of its own, kept encrypted with a key that never leaves " +
                    "the phone's keystore. A fleet allows people by email address.",
            )
        } else if (inDemo) {
            SectionHead("You")
            // Said plainly, and never as "signed in".
            Text("Demo — invented hosts and sessions", style = Design.Style.body, color = Design.Palette.ink.now)
            OutlinedButton(onClick = {
                settings.coordinatorUrl = settings.urlBeforeDemo
                url = settings.urlBeforeDemo
                settings.urlBeforeDemo = ""
                signOut()
            }) { Text("Leave the demo") }
        } else {
            SectionHead("Account")
            Text("Signed in as ${identity.ifBlank { "this device" }}", style = Design.Style.body, color = Design.Palette.ink.now)
            OpenRow("Devices") { open = "devices" }
            TextButton(onClick = { signOut() }) { Text("Sign out", color = Design.Palette.bad.now) }

            // THE OTHER ACCOUNT THIS PHONE HOLDS. It starts your temporary
            // machines and it is how your vault knows you.
            SectionHead("GitHub on this phone")
            PhoneGitHubSignIn(settings)

            Column {
                OpenRow("Credentials") { open = "credentials" }
                OpenRow(
                    "Temporary machines",
                    value = if (runnersAnswered) describeTemporaryMachines(runnersSaved, runnersFleet) else null,
                ) { open = "temporary" }
                // THE THREE ROLES A REPOSITORY CAN BE LINKED FOR, in one place
                // (#346). Drawn only once the fleet has answered for this
                // person: an older coordinator, or a credential that is not a
                // person's, has nothing it could link.
                linkedCount?.let { count ->
                    OpenRow("Linked repositories", value = describeLinkedRepos(count)) { open = "linked" }
                }
            }
        }

        if (signedIn) {
            SectionHead("Notifications")
            OutlinedButton(
                onClick = {
                    scope.launch {
                        pushResult = "sending…"
                        pushResult = Fleet(settings).testPush(null).text
                    }
                },
            ) { Text("Send a test notification") }
            if (pushResult.isNotBlank()) Hint(pushResult)
        }

        OpenRow("Siri and Assistant") { open = "kinds" }

        if (signedIn) {
            SectionHead("This fleet")
            SelectionContainer {
                Text(settings.coordinatorUrl, style = Design.Style.label, color = Design.Palette.ink.now)
            }
            // WHO ELSE IS ALLOWED IN, for the one person who can say. A member
            // was shown this and refused after the tap.
            if (admin == true && !viewAsMember && !inDemo) OpenRow("People") { open = "people" }
            // WHAT THE PEOPLE YOU INVITE SEE, for the one person who can ask.
            // The coordinator answers as it would a member, so this is their
            // view rather than this one with rows hidden.
            if (admin == true && !inDemo) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("View as a member", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                    Switch(checked = viewAsMember, onCheckedChange = onViewAsMember)
                }
                if (viewAsMember) {
                    Hint("Every screen shows what a member of this fleet sees: their own sessions, no People, no revoking. Your credential is still an admin's.")
                }
            }
            Hint("Sign out to point this app at a different fleet.")
        }
        // WHICH BUILD THIS IS. versionName is the same across every build of a
        // release; versionCode is the number that differs.
        Text(
            "Fleetwright ${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})",
            style = Design.Style.micro,
            color = Design.Palette.inkDim.now,
        )
    }
}

/**
 * Credentials: everything a session of yours may use, in one place, VAULT
 * FIRST. Android had no fleet-wide screen at all: "Your credentials" opened
 * from one host's card and fanned tokens out to every box from there.
 */
@Composable
private fun CredentialsScreen(settings: Settings, onDismiss: () -> Unit) {
    var linked by remember { mutableStateOf(false) }
    var sshKeys by remember { mutableStateOf(false) }
    // Bumped by the sign-in below, so the vault appears the moment it can.
    var generation by remember { mutableIntStateOf(0) }
    if (linked) CredentialsSheet(settings, host = null, onDismiss = { linked = false }, linkedOnly = true)
    if (sshKeys) SshKeysScreen(settings, onDismiss = { sshKeys = false })
    FullScreen(title = "Credentials", onDismiss = onDismiss) {
        SectionHead("Your vault")
        if (generation >= 0 && PhoneGitHub(settings).signedIn) {
            YourVault(settings)
            // FOR THE MACHINES ON YOUR HYPERVISOR: kept like any secret,
            // given its own row because it is pasted, not typed.
            OpenRow("SSH keys") { sshKeys = true }
        } else {
            // The vault knows a person by this phone's GitHub sign-in, so the
            // sign-in is offered at the point it is needed.
            PhoneGitHubSignIn(settings, onChanged = { generation++ })
        }
        OpenRow("Linked on machines") { linked = true }
        Hint(
            "A token goes to every machine in the fleet, because it is yours rather than any one box's. " +
                "Claude is per person too: a session runs on the account of whoever started it.",
        )
    }
}

/**
 * Setting up temporary machines, once: where they come from, and who starts
 * them. Drawn inline in the Hosts section until now, as tall finished as
 * unfinished.
 */
@Composable
internal fun TemporaryMachinesSheet(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    // `answered` stays false until the coordinator has said, and for a
    // credential that is not a person's, which cannot have one.
    var runnerRepoAnswered by remember { mutableStateOf(false) }
    var runnerRepoSaved by remember { mutableStateOf<String?>(null) }
    var runnerRepoFleet by remember { mutableStateOf<String?>(null) }
    var runnerRepoDraft by remember { mutableStateOf("") }
    var runnerRepoMessage by remember { mutableStateOf("") }
    var runnerCheck by remember { mutableStateOf<Fleet.RunnerRepoCheck?>(null) }
    var busy by remember { mutableStateOf(false) }
    val phone = remember { PhoneGitHub(settings) }

    LaunchedEffect(Unit) {
        Fleet(settings).runnerRepoSetting().onSuccess { got ->
            if (got.ok != false) {
                runnerRepoAnswered = true
                runnerRepoSaved = got.repo
                runnerRepoFleet = got.fleet
                if (runnerRepoDraft.isBlank()) runnerRepoDraft = got.repo ?: ""
            }
        }
    }

    FullScreen(title = "Temporary machines", onDismiss = onDismiss) {
        SectionHead("Where they come from")
        // WHERE YOUR MACHINES COME FROM. Saved only after it has been checked:
        // by the fleet's minting Worker as the GitHub App, or by a permanent
        // box with your GitHub connection where there is no minter.
        if (runnerRepoAnswered) {
            OutlinedTextField(
                value = runnerRepoDraft,
                onValueChange = { runnerRepoDraft = it.trim() },
                label = { Text("Your runner repository (owner/repo)") },
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
                    enabled = !busy && runnerRepoDraft.isNotBlank(),
                    onClick = {
                        scope.launch {
                            busy = true
                            runnerRepoMessage = ""
                            Fleet(settings).setRunnerRepo(runnerRepoDraft)
                                .onSuccess { r ->
                                    runnerCheck = r.runnerRepo
                                    runnerRepoMessage = r.text ?: ""
                                    if (r.ok == true && r.repo != null) {
                                        runnerRepoSaved = r.repo
                                        runnerRepoDraft = r.repo
                                    }
                                }
                                .onFailure { runnerRepoMessage = it.message ?: "that did not work" }
                            busy = false
                        }
                    },
                ) { Text(if (busy) "Checking…" else "Check and save") }
                if (runnerRepoSaved != null) {
                    // Says what clearing leads to: the fleet's repository when
                    // there is one, and nothing at all when not.
                    TextButton(
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                busy = true
                                Fleet(settings).clearRunnerRepo()
                                    .onSuccess { r ->
                                        runnerRepoMessage = r.text ?: ""
                                        runnerRepoSaved = null
                                        runnerCheck = null
                                        runnerRepoDraft = ""
                                    }
                                    .onFailure { runnerRepoMessage = it.message ?: "that did not work" }
                                busy = false
                            }
                        },
                    ) {
                        Text(if (runnerRepoFleet == null) "Remove your runner repository" else "Use the fleet's repository instead")
                    }
                }
            }
            Hint(describeRunnerRepoSetting(runnerRepoSaved, runnerRepoFleet))
            runnerCheck?.let { check ->
                Text(
                    describeRunnerCheck(check),
                    style = Design.Style.label,
                    fontFamily = FontFamily.Monospace,
                    color = if (check.ok) Design.Palette.ink.now else Design.Palette.bad.now,
                )
            }
            if (runnerRepoMessage.isNotBlank()) {
                Hint(runnerRepoMessage, color = if (runnerCheck?.ok == false) Design.Palette.bad.now else Design.Palette.ink.now)
            }
        } else {
            Hint("Asking the fleet…")
        }

        SectionHead("Who starts them")
        Hint(
            if (phone.signedIn) "This phone starts them itself, as ${phone.signIn?.login ?: "you"} on GitHub."
            else "A permanent box with your GitHub connection starts them. Sign in to GitHub on this phone under You, and the phone starts them itself.",
        )
        Hint(
            "Ask for one under New session, in Where. Sessions on it are lost when it goes, and it spends Actions minutes. " +
                "Windows runners are written and not yet proven.",
        )
    }
}

/** "from owner/repo", or how it is not set up, for the row under You. */
fun describeTemporaryMachines(saved: String?, fleet: String?): String = when {
    saved != null -> "from $saved"
    fleet != null -> "from $fleet"
    else -> "not set up"
}

/**
 * The devices holding a credential for this fleet. Revoking is the fleet
 * admin's: the coordinator refuses it to anybody else, so for anybody else
 * there is no button to refuse.
 */
@Composable
private fun DevicesSheet(settings: Settings, admin: Boolean?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var clients by remember { mutableStateOf<List<Fleet.Client>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var confirmRevoke by remember { mutableStateOf<Fleet.Client?>(null) }
    val canRevoke = admin == true

    LaunchedEffect(Unit) {
        clients = Fleet(settings).clients()
        loaded = true
    }

    confirmRevoke?.let { c ->
        AlertDialog(
            onDismissRequest = { confirmRevoke = null },
            title = { Text("Revoke ${c.name ?: "this device"}?") },
            text = {
                Text(
                    "That device stops being able to reach this fleet, and its push " +
                        "notifications stop. Every other device keeps working. Signing in " +
                        "again on it mints a new one.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = c
                    confirmRevoke = null
                    scope.launch {
                        // The refusal reaches the screen: a discarded error reads
                        // as "it came back".
                        result = Fleet(settings).revokeClient(target.id).text
                        clients = Fleet(settings).clients()
                    }
                }) { Text("Revoke") }
            },
            dismissButton = { TextButton(onClick = { confirmRevoke = null }) { Text("Cancel") } },
        )
    }

    FullScreen(title = "Devices", onDismiss = onDismiss) {
        Hint(
            if (canRevoke) "Each sign-in mints a credential for that device alone, so revoking one leaves the others working."
            else "Each sign-in mints a credential for that device alone. Lost one? This fleet's admin can revoke it.",
        )
        if (clients.isEmpty()) Hint(if (loaded) "No devices reported." else "Asking the fleet…")
        // IN USE FIRST, newest first; the abandoned ones last.
        val ordered = clients.filter { it.lastSeenAt != null }.sortedByDescending { it.lastSeenAt } +
            clients.filter { it.lastSeenAt == null }
        for (c in ordered) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(c.name ?: "unnamed device", style = Design.Style.body, color = Design.Palette.ink.now)
                    Hint(describeClient(c, settings.signedInAs, canRevoke))
                }
                if (canRevoke) TextButton(onClick = { confirmRevoke = c }) { Text("Revoke") }
            }
        }
        if (result.isNotBlank()) Hint(result)
    }
}

/**
 * "last used 2 hours ago", and the address only when it is somebody else's:
 * the name already carries it, and rows printing it twice told nothing apart.
 */
private fun describeClient(c: Fleet.Client, me: String, canRevoke: Boolean): String {
    val parts = mutableListOf<String>()
    c.email?.takeIf { it.isNotBlank() && it != me }?.let { parts.add(it) }
    parts.add(c.lastSeenAt?.let { "last used ${relative(it)}" } ?: if (canRevoke) "never used — safe to revoke" else "never used")
    return parts.joinToString(" · ")
}
