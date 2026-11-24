package network.thetech.fleetwright

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * The organization: who the fleet is made of, and who manages whom
 * (docs/members.md).
 *
 * A MEMBER IS A PERSON OR AN AGENT with a role, a place in a tree and
 * standing instructions. Everybody in the fleet reads the list, because it is
 * how a person learns who does what. Who may change a member comes from the
 * tree: an admin anybody, a manager their own team, and the fleet says which
 * this person is (`you`), so a control is drawn only for somebody it will
 * answer (C-2).
 *
 * TWO LISTS, IN THE ORDER A MANAGER NEEDS THEM. My team first, each member
 * with whether its vault holds a Claude sign-in, because "can it run" is the
 * question a manager opens this for. Then Everyone, as the tree, a report
 * indented under whoever it reports to. An admin manages everybody, so their
 * team is Everyone and is not drawn twice.
 *
 * A SIGN-IN'S STATE IS THE VAULT'S ANSWER AND NOTHING ELSE. "Not signed in"
 * is said only when the member's vault answered without a Claude item. A
 * vault that could not be asked is "Not checked", which is a different fact
 * (C-5), and it is what a person member's row says until they let their
 * managers in.
 *
 * The same words as iOS (OrgView.swift), held equal by
 * test/members-in-apps.test.js.
 */
@Composable
internal fun OrgScreen(settings: Settings, onDismiss: () -> Unit, onStart: (StartRequest) -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Three states, each said: asking (neither set), answered, and failed with
    // the reason. `asked` is bumped by Try again and by every change, which
    // runs the load again.
    var failed by remember { mutableStateOf<String?>(null) }
    var answered by remember { mutableStateOf(false) }
    var asked by remember { mutableIntStateOf(0) }
    var members by remember { mutableStateOf(listOf<Fleet.Member>()) }
    var you by remember { mutableStateOf<Fleet.Standing?>(null) }
    // What each team member's vault said about a Claude sign-in, by id.
    // Absent while it is being asked.
    val signIns = remember { mutableStateMapOf<String, MemberSignIn>() }
    // The member whose page is open, by id, so the page draws the record as
    // the list last had it.
    var opened by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    // Every member as a file, once an admin asked for them.
    var files by remember { mutableStateOf(listOf<Fleet.MemberFile>()) }
    var importText by remember { mutableStateOf("") }
    var fileBusy by remember { mutableStateOf(false) }
    var fileResult by remember { mutableStateOf("") }
    var fileFailed by remember { mutableStateOf(false) }

    val isAdmin = you?.admin == true
    val manages = you?.manages.orEmpty()
    // The members this person manages, in the list's order. Empty for an
    // admin, whose team is everybody.
    val team = if (isAdmin) emptyList<Fleet.Member>() else members.filter { it.id in manages }
    // Whether this person has anywhere to add a member: anywhere, for an
    // admin; under their own member or a member they manage, for a manager.
    val canAdd = isAdmin || you?.member != null || manages.isNotEmpty()

    LaunchedEffect(asked) {
        failed = null
        val got = Fleet(settings).members().getOrElse {
            failed = it.message ?: "no answer"
            return@LaunchedEffect
        }
        // Only an answer that carries the list is one: a fleet older than
        // members answers without it, and that is not "nobody".
        val list = got.members
        if (got.ok == false || list == null) {
            failed = got.text ?: "Your fleet did not send its members. It may need an update."
            return@LaunchedEffect
        }
        members = list
        you = got.you
        answered = true
        // ASK EACH TEAM MEMBER'S VAULT whether it holds a Claude sign-in. One
        // at a time, because each is a request this phone seals and the vault
        // answers under one lock. A vault that refuses, or cannot be asked
        // without this phone's GitHub sign-in, is Not checked and never Not
        // signed in (C-5).
        val managed = got.you?.manages.orEmpty()
        val mine = if (got.you?.admin == true) emptyList<Fleet.Member>() else list.filter { it.id in managed }
        if (mine.isEmpty()) return@LaunchedEffect
        if (!PhoneGitHub(settings).signedIn) {
            mine.forEach { signIns[it.id] = MemberSignIn.NotChecked }
            return@LaunchedEffect
        }
        val vault = PhoneVault(settings)
        val fleet = Fleet(settings)
        for (member in mine) {
            val contents = runCatching { vault.list(fleet, member.id) }.getOrNull()
            signIns[member.id] = when {
                contents == null -> MemberSignIn.NotChecked
                contents.items.any { it.name == "claude" } -> MemberSignIn.SignedIn
                else -> MemberSignIn.NotSignedIn
            }
        }
    }

    // THE PAGE OF THE MEMBER THAT WAS TAPPED, drawn from the list as it is
    // now, so a save shows on the page and a removed member's page closes.
    members.firstOrNull { it.id == opened }?.let { member ->
        MemberPage(
            settings = settings,
            member = member,
            roster = members,
            you = you,
            onDismiss = { opened = null },
            onChanged = { asked++ },
            onStart = onStart,
        )
    }
    if (adding) {
        MemberForm(
            settings = settings,
            existing = null,
            roster = members,
            you = you,
            onDismiss = { adding = false },
            onSaved = {
                adding = false
                asked++
            },
        )
    }

    FullScreen(title = "Organization", onDismiss = onDismiss) {
        val why = failed
        when {
            why != null -> {
                // The result, then the reason smaller under it, as Linked
                // repositories says it: the reason is there to be copied.
                Hint("Could not load the organization.", color = Design.Palette.bad.now)
                Hint(why)
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }
            !answered -> Hint("Loading…")
            else -> {
                if (team.isNotEmpty()) {
                    SectionHead("My team")
                    team.forEach { member ->
                        MemberRow(
                            member = member,
                            trailing = memberSignInWord(signIns[member.id]),
                            strong = signIns[member.id] == MemberSignIn.SignedIn,
                        ) { opened = member.id }
                    }
                }
                SectionHead("Everyone")
                if (members.isEmpty()) {
                    Hint(if (isAdmin) "No members yet. Add the first one." else "No members yet. An admin adds the first one.")
                }
                // THE TREE, a report indented under whoever it reports to,
                // and every row the same shape. Person or Agent is a word on
                // the row, never a colour.
                orgRows(members).forEach { row ->
                    MemberRow(
                        member = row.member,
                        trailing = memberKindWord(row.member.kind),
                        depth = row.depth,
                    ) { opened = row.member.id }
                }
                if (canAdd) OpenRow("Add a member") { adding = true }

                // EVERY MEMBER AS A MARKDOWN FILE, for an admin: read them
                // out, or paste one back in. A file is the record and the
                // instructions, so a member can be written in an editor and
                // reviewed like anything else.
                if (isAdmin) {
                    SectionHead("Files")
                    Hint("Each member is one markdown file: the record, then the instructions. No credential is in one.")
                    OutlinedButton(
                        enabled = !fileBusy,
                        onClick = {
                            scope.launch {
                                fileBusy = true
                                Fleet(settings).exportMembers()
                                    .onSuccess {
                                        files = it
                                        fileResult = if (it.isEmpty()) "No members to export." else ""
                                        fileFailed = false
                                    }
                                    .onFailure {
                                        fileResult = it.message ?: "that did not work"
                                        fileFailed = true
                                    }
                                fileBusy = false
                            }
                        },
                    ) { Text(if (fileBusy) "Loading…" else "Export as files") }
                    files.forEach { file ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            Text(
                                file.name,
                                style = Design.Style.label,
                                fontFamily = FontFamily.Monospace,
                                color = Design.Palette.ink.now,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(
                                onClick = {
                                    context.getSystemService(android.content.ClipboardManager::class.java)
                                        ?.setPrimaryClip(android.content.ClipData.newPlainText("Member file", file.text))
                                    fileResult = "Copied ${file.name}."
                                    fileFailed = false
                                },
                                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Copy ${file.name}" },
                            ) { Text("Copy") }
                        }
                    }
                    OutlinedTextField(
                        value = importText,
                        onValueChange = { importText = it },
                        label = { Text("Paste a member file") },
                        minLines = 3,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedButton(
                        enabled = !fileBusy && importText.isNotBlank(),
                        onClick = {
                            scope.launch {
                                fileBusy = true
                                Fleet(settings).importMember(importText)
                                    .onSuccess { r ->
                                        fileFailed = r.ok != true
                                        fileResult = r.text ?: if (r.ok == true) "Imported." else "Your fleet refused that file."
                                        if (r.ok == true) {
                                            importText = ""
                                            asked++
                                        }
                                    }
                                    .onFailure {
                                        fileResult = it.message ?: "that did not work"
                                        fileFailed = true
                                    }
                                fileBusy = false
                            }
                        },
                    ) { Text("Import a file") }
                    if (fileResult.isNotBlank()) {
                        SelectionContainer {
                            Hint(fileResult, color = if (fileFailed) Design.Palette.bad.now else Design.Palette.ink.now)
                        }
                    }
                }
            }
        }
    }
}

/**
 * One member in a list: the name, the role under it, one word at the end,
 * and 48dp of target whatever the type size. [depth] indents a report under
 * whoever it reports to.
 */
@Composable
private fun MemberRow(member: Fleet.Member, trailing: String, strong: Boolean = false, depth: Int = 0, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = Design.Space.groupTight * minOf(depth, 4)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Column(Modifier.weight(1f)) {
            Text(member.name, style = Design.Style.body, color = Design.Palette.ink.now)
            Text(member.role, style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
        Text(trailing, style = Design.Style.label, color = if (strong) Design.Palette.ink.now else Design.Palette.inkDim.now)
        Text("›", style = Design.Style.body, color = Design.Palette.inkDim.now)
    }
}

/**
 * One fact about a member: its name, and the value under it. Stacked and not
 * side by side, so an address or a list of work types wraps on a narrow
 * screen and never pushes its own name off the row.
 */
@Composable
private fun MemberFact(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = Design.Style.label, color = Design.Palette.inkDim.now)
        Text(value, style = Design.Style.body, color = Design.Palette.ink.now)
    }
}

/** One choice of several, 48dp tall, its radio button saying which is chosen. */
@Composable
private fun MemberChoice(label: String, selected: Boolean, onPick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = selected, enabled = true, role = Role.RadioButton, onClick = onPick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
    }
}

/**
 * One member: what it is, and what this person may do with it.
 *
 * THE RECORD IS THE FLEET'S AND CUSTODY IS THE VAULT'S, and this page keeps
 * them apart (docs/members.md, "A member's vault"). The facts at the top are
 * the fleet's record. The Custody section is the vault's own answer, asked
 * once when the page opens: who may act for this member's vault, by the tree
 * the vault holds. Where the two differ, the page says custody has not been
 * filed for that change and offers to file it. It never draws the fleet's
 * tree as the vault's, and when the vault could not be asked it says so and
 * offers nothing that depends on the answer.
 */
@Composable
private fun MemberPage(
    settings: Settings,
    member: Fleet.Member,
    /** Everybody, for the name of whoever this member reports to. */
    roster: List<Fleet.Member>,
    you: Fleet.Standing?,
    onDismiss: () -> Unit,
    /** Told when the record changed or went, so the list behind this page asks again. */
    onChanged: () -> Unit,
    onStart: (StartRequest) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val vault = remember { PhoneVault(settings) }
    // The organization as the vault holds it. Null while it is being asked,
    // and after a failure, which `orgFailed` then says.
    var org by remember { mutableStateOf<PhoneVault.Org?>(null) }
    var orgFailed by remember { mutableStateOf<String?>(null) }
    var asked by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var newCustodian by remember { mutableStateOf("") }
    // Remove is waiting on its dialog.
    var removing by remember { mutableStateOf(false) }
    // Whose custody of this person is being given up, while the question is open.
    var stopping by remember { mutableStateOf<String?>(null) }
    var removeResult by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf(false) }
    var credentials by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }

    val isAdmin = you?.admin == true
    val mayEdit = isAdmin || member.id in you?.manages.orEmpty()
    val mayStart = member.id in you?.startAs.orEmpty()
    // This person's fleet address, as the vault lists people.
    val me = settings.signedInAs.trim().lowercase()
    // This member as the vault holds it, once the vault has answered.
    val filed = org?.member(member.id)
    // Whether this person may open this member's vault: the vault lists them
    // for it, and it is not their own person member, whose vault is already
    // You, Credentials.
    val mayOpenCredentials = filed != null && me in filed.may &&
        !(member.kind == "person" && member.email.orEmpty().lowercase() == me)
    val reportsToName = member.reportsTo?.let { id -> roster.firstOrNull { it.id == id }?.name ?: id } ?: "Nobody"

    suspend fun askVault() {
        vault.org(Fleet(settings))
            .onSuccess {
                org = it
                orgFailed = null
            }
            .onFailure {
                org = null
                orgFailed = it.message ?: "no answer"
            }
    }

    /** Run one change in the vault, say what it said, then show the vault as it is now. */
    fun act(block: suspend () -> Result<String>) {
        scope.launch {
            busy = true
            result = ""
            val r = block()
            failed = r.isFailure
            result = r.getOrElse { it.message ?: "That did not work." }
            askVault()
            busy = false
        }
    }

    LaunchedEffect(member.id, asked) { askVault() }

    if (editing) {
        MemberForm(
            settings = settings,
            existing = member,
            roster = roster,
            you = you,
            onDismiss = { editing = false },
            onSaved = {
                editing = false
                onChanged()
                asked++
            },
        )
    }
    // THE CREDENTIALS SCREEN'S VAULT, POINTED AT THIS MEMBER'S. Every request
    // it makes names the member, and the vault decides whether this person
    // may make it.
    if (credentials) {
        FullScreen(title = "${member.name}'s credentials", onDismiss = { credentials = false }) {
            YourVault(settings, member)
        }
    }
    if (starting) {
        StartSheet(settings = settings, asMember = member, onDismiss = { starting = false }, onStart = onStart)
    }
    // REMOVE ASKS FIRST, and says what it costs before it is done.
    if (removing) {
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text("Remove ${member.name}?") },
            text = { Text("Removes ${member.name} from the organization. Its vault is not deleted; a custodian forgets what it keeps.") },
            confirmButton = {
                TextButton(onClick = {
                    removing = false
                    scope.launch {
                        busy = true
                        Fleet(settings).removeMember(member.id)
                            .onSuccess { r ->
                                if (r.ok == true) {
                                    onChanged()
                                    onDismiss()
                                } else {
                                    removeResult = r.text ?: "Your fleet refused that."
                                }
                            }
                            .onFailure { removeResult = it.message ?: "that did not work" }
                        busy = false
                    }
                }) { Text("Remove member") }
            },
            dismissButton = { TextButton(onClick = { removing = false }) { Text("Cancel") } },
        )
    }

    FullScreen(title = member.name, onDismiss = onDismiss) {
        MemberFact("Role", member.role)
        member.title?.takeIf { it.isNotBlank() }?.let { MemberFact("Title", it) }
        MemberFact("Kind", memberKindWord(member.kind))
        MemberFact("Reports to", reportsToName)
        member.email?.takeIf { it.isNotBlank() }?.let { MemberFact("Address", it) }
        member.description?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = Design.Style.body, color = Design.Palette.ink.now)
        }
        if (member.workTypes.isNotEmpty()) MemberFact("Work types", member.workTypes.joinToString(", "))
        member.tag?.takeIf { it.isNotBlank() }?.let { MemberFact("Machine tag", it) }

        // WHAT ITS SESSIONS OPEN WITH. Read here and changed under Edit; in a
        // frame of its own that scrolls, because four kilobytes of
        // instructions would otherwise push everything a person came to do
        // off the screen.
        member.instructions?.takeIf { it.isNotBlank() }?.let { text ->
            SectionHead("Instructions")
            SelectionContainer {
                Text(
                    text,
                    style = Design.Style.label,
                    color = Design.Palette.ink.now,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
                )
            }
            Hint("Its sessions open with these.")
        }

        if (mayEdit) OpenRow("Edit") { editing = true }
        // Offered only to somebody the vault itself lists for this member.
        if (mayOpenCredentials) OpenRow("Credentials") { credentials = true }
        if (mayStart) {
            OutlinedButton(onClick = { starting = true }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Start a session as ${member.name}")
            }
        }

        SectionHead("Custody")
        val held = org
        val why = orgFailed
        when {
            held == null && why != null -> {
                // CANNOT TELL, said as that (C-5). Nothing below it depends
                // on an answer that did not come.
                Text("The vault could not be asked.", style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }
            held == null -> Hint("Checking…")
            else -> {
                if (held.admins.isEmpty()) {
                    // FIRST USE. Nothing can be filed until somebody
                    // administers the organization in the vault, and the
                    // first is a fleet admin filing themselves.
                    Text(
                        "Nobody administers the organization in your vault yet.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.ink.now,
                    )
                    if (isAdmin) {
                        OutlinedButton(enabled = !busy, onClick = { act { vault.fileOrgAdmin(Fleet(settings), me) } }) {
                            Text("Become its first admin")
                        }
                    }
                } else if (filed == null || custodyDiffers(filed, member)) {
                    // THE FLEET'S RECORD AND THE VAULT'S TREE DISAGREE about
                    // this member, or the vault has never heard of it.
                    // Custody follows the vault's, so this says so and
                    // offers to file the change.
                    Text(
                        "Custody is not filed for this change yet.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.ink.now,
                    )
                    if (mayEdit) {
                        OutlinedButton(
                            enabled = !busy,
                            onClick = {
                                act {
                                    vault.fileOrgMember(Fleet(settings), member.id, member.kind, member.email, member.reportsTo, member.managers)
                                }
                            },
                        ) { Text("File it") }
                    }
                }
                if (filed != null && filed.kind == "agent") {
                    // WHO MAY ACT FOR AN AGENT MEMBER'S VAULT, as the vault
                    // lists them: its own custodians, and its managers for
                    // as long as the tree says so. Remove is on its own
                    // custodians only, since a manager's custody ends with
                    // the tree and not with a button, and adding or removing
                    // is offered only to somebody already on the list (C-2).
                    // The last custodian stays, and the vault's sentence
                    // says so.
                    Text("Custodians", style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
                    if (filed.may.isEmpty()) Hint("None yet.")
                    filed.may.forEach { address ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            Text(address, style = Design.Style.bodySmall, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                            if (address !in filed.custodians) {
                                Text("Manager", style = Design.Style.label, color = Design.Palette.inkDim.now)
                            } else if (me in filed.may) {
                                TextButton(
                                    enabled = !busy,
                                    onClick = { act { vault.setCustodian(Fleet(settings), filed.id, address, remove = true) } },
                                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Remove $address" },
                                ) { Text("Remove", color = Design.Palette.bad.now) }
                            }
                        }
                    }
                    if (me in filed.may) {
                        OutlinedTextField(
                            value = newCustodian,
                            onValueChange = { newCustodian = it.trim() },
                            label = { Text("Fleet address") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Email,
                                capitalization = KeyboardCapitalization.None,
                                autoCorrectEnabled = false,
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(
                            enabled = !busy && "@" in newCustodian,
                            onClick = {
                                val address = newCustodian.trim().lowercase()
                                act { vault.setCustodian(Fleet(settings), filed.id, address).onSuccess { newCustodian = "" } }
                            },
                        ) { Text("Add custodian") }
                    }
                } else if (filed != null) {
                    // WHOEVER ADDED THEM MANAGES WHAT THEY KEEP, as the
                    // vault lists it. Giving that up is offered to the one
                    // who holds it and to an org admin of the vault, and to
                    // nobody else (C-2).
                    filed.custodians.forEach { address ->
                        Text(
                            "$address added them, and manages their credentials.",
                            style = Design.Style.bodySmall,
                            color = Design.Palette.ink.now,
                        )
                        if (address == me || held.youAdmin) {
                            TextButton(
                                enabled = !busy,
                                onClick = { stopping = address },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text("Stop managing their credentials", color = Design.Palette.bad.now) }
                        }
                    }
                    // ASKED FIRST, because it is not given back: nobody is
                    // made a person's custodian after whoever added them.
                    stopping?.let { address ->
                        AlertDialog(
                            onDismissRequest = { stopping = null },
                            title = { Text("Stop managing their credentials?") },
                            text = { Text(STOP_MANAGING_SENTENCE) },
                            confirmButton = {
                                TextButton(onClick = {
                                    stopping = null
                                    act { vault.setCustodian(Fleet(settings), filed.id, address, remove = true) }
                                }) { Text("Stop managing") }
                            },
                            dismissButton = { TextButton(onClick = { stopping = null }) { Text("Cancel") } },
                        )
                    }
                    // EVERY OTHER MANAGER waits on the person's own switch,
                    // under You, Credentials, and this only reports where
                    // the vault says it stands.
                    Text(
                        personCustodyLine(filed.custody, added = filed.custodians.isNotEmpty()),
                        style = Design.Style.bodySmall,
                        color = Design.Palette.ink.now,
                    )
                }
            }
        }
        if (result.isNotBlank()) {
            SelectionContainer {
                Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
            }
        }

        if (mayEdit) {
            TextButton(
                enabled = !busy,
                onClick = { removing = true },
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Remove member", color = Design.Palette.bad.now) }
            if (removeResult.isNotBlank()) {
                SelectionContainer { Hint(removeResult, color = Design.Palette.bad.now) }
            }
        }
    }
}

/**
 * Make a member, or change one: the record's fields, each with its name on
 * it, because a form of twelve filled fields with only placeholders cannot
 * be read back.
 *
 * WHAT IS OFFERED IS WHAT THE FLEET WILL TAKE from this person (C-2). Kind is
 * chosen once, when the member is made, since its vault is kept under what it
 * is. Whose address a person member is, and the extra managers beside the
 * tree, are an admin's. A manager chooses Reports to from their own member
 * and the members they manage, which is the team they may place somebody in.
 * A refusal is the fleet's own sentence, shown under Save.
 */
@Composable
private fun MemberForm(
    settings: Settings,
    existing: Fleet.Member?,
    roster: List<Fleet.Member>,
    you: Fleet.Standing?,
    onDismiss: () -> Unit,
    onSaved: (Fleet.Member) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val isAdmin = you?.admin == true
    val creating = existing == null
    // A manager's new member starts under their own member, which is where
    // they may put one. An admin's starts at the top.
    val startUnder = if (isAdmin) "" else you?.member ?: you?.manages?.firstOrNull().orEmpty()
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var role by remember { mutableStateOf(existing?.role.orEmpty()) }
    var title by remember { mutableStateOf(existing?.title.orEmpty()) }
    var kind by remember { mutableStateOf(existing?.kind ?: "agent") }
    var email by remember { mutableStateOf(existing?.email.orEmpty()) }
    var reportsTo by remember { mutableStateOf(if (existing == null) startUnder else existing.reportsTo.orEmpty()) }
    var about by remember { mutableStateOf(existing?.description.orEmpty()) }
    var workTypes by remember { mutableStateOf(existing?.workTypes.orEmpty().joinToString(", ")) }
    var instructions by remember { mutableStateOf(existing?.instructions.orEmpty()) }
    var model by remember { mutableStateOf(existing?.model.orEmpty()) }
    var tag by remember { mutableStateOf(existing?.tag.orEmpty()) }
    var budget by remember { mutableStateOf(existing?.budgetUsdMonth?.let { memberBudgetText(it) }.orEmpty()) }
    var managers by remember { mutableStateOf(existing?.managers.orEmpty().joinToString(", ")) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }

    // Whom this member may be placed under by this person: anybody else, for
    // an admin; their own member and their team, for a manager.
    val allowed = you?.manages.orEmpty() + listOfNotNull(you?.member)
    val reportsToChoices = roster.filter { it.id != existing?.id && (isAdmin || it.id in allowed) }
    val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)

    FullScreen(title = existing?.let { "Edit ${it.name}" } ?: "Add a member", onDismiss = onDismiss) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (creating) {
            // The id is the member's name in every command and file, made
            // from the name once and kept.
            Hint("Id: ${memberSlug(name).ifEmpty { "from the name" }}")
        }
        OutlinedTextField(
            value = role,
            onValueChange = { role = it },
            label = { Text("Role") },
            placeholder = { Text("software engineer") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("Title") },
            placeholder = { Text("Optional") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (creating) {
            Text("Kind", style = Design.Style.label, color = Design.Palette.inkDim.now)
            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                FilterChip(selected = kind == "agent", onClick = { kind = "agent" }, label = { Text("Agent") })
                FilterChip(selected = kind == "person", onClick = { kind = "person" }, label = { Text("Person") })
            }
        }
        // A new person member needs an address from whoever makes it.
        // Changing whose address it is afterwards is an admin's.
        if (kind == "person" && (isAdmin || creating)) {
            OutlinedTextField(
                value = email,
                onValueChange = { email = it.trim() },
                label = { Text("Address") },
                placeholder = { Text("name@example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text("Reports to", style = Design.Style.label, color = Design.Palette.inkDim.now)
        if (isAdmin) MemberChoice("Nobody", selected = reportsTo.isEmpty()) { reportsTo = "" }
        reportsToChoices.forEach { choice ->
            MemberChoice(choice.name, selected = reportsTo == choice.id) { reportsTo = choice.id }
        }

        SectionHead("Description")
        OutlinedTextField(
            value = about,
            onValueChange = { about = it },
            label = { Text("What this member is for") },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = workTypes,
            onValueChange = { workTypes = it },
            label = { Text("Work types") },
            placeholder = { Text("backend, review") },
            singleLine = true,
            keyboardOptions = plain,
            modifier = Modifier.fillMaxWidth(),
        )

        SectionHead("Instructions")
        OutlinedTextField(
            value = instructions,
            onValueChange = { instructions = it },
            label = { Text("What its sessions open with") },
            minLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
        Hint("Its sessions open with these, before the task.")

        SectionHead("Where it runs")
        OutlinedTextField(
            value = model,
            onValueChange = { model = it.trim() },
            label = { Text("Model") },
            placeholder = { Text("Optional") },
            singleLine = true,
            keyboardOptions = plain,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = tag,
            onValueChange = { tag = it.trim() },
            label = { Text("Machine tag") },
            placeholder = { Text("Optional") },
            singleLine = true,
            keyboardOptions = plain,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = budget,
            onValueChange = { budget = it.trim() },
            label = { Text("Monthly budget (USD)") },
            placeholder = { Text("Optional") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        Hint("Stored. Nothing enforces it yet.")

        if (isAdmin) {
            OutlinedTextField(
                value = managers,
                onValueChange = { managers = it },
                label = { Text("Extra managers") },
                placeholder = { Text("a@example.com, b@example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Hint("Fleet addresses that manage this member beside the tree, separated by commas. At most 4.")
        }

        OutlinedButton(
            enabled = !busy && name.isNotBlank() && role.isNotBlank(),
            onClick = {
                scope.launch {
                    busy = true
                    result = ""
                    val id = existing?.id ?: memberSlug(name)
                    val budgetText = budget.trim()
                    val amount = budgetText.toDoubleOrNull()
                    when {
                        id.isEmpty() -> result = "Give the member a name with a letter or a digit in it."
                        // A new member whose id is taken would overwrite that
                        // member, since saving one is how it is changed.
                        // Refused here, by name.
                        creating && roster.any { it.id == id } -> result = "$id is already a member. Choose another name."
                        budgetText.isNotEmpty() && (amount == null || amount < 0) ->
                            result = "The monthly budget is a number of dollars, or empty."
                        else -> {
                            val fields = JSONObject()
                                .put("name", name.trim())
                                .put("kind", kind)
                                .put("role", role.trim())
                                .put("title", title.trim())
                                .put("description", about.trim())
                                .put("workTypes", JSONArray(memberList(workTypes)))
                                .put("instructions", instructions)
                                // Extra managers are an admin's; a manager sends back what was there.
                                .put("managers", JSONArray(if (isAdmin) memberList(managers) else existing?.managers.orEmpty()))
                            if (reportsTo.isNotEmpty()) fields.put("reportsTo", reportsTo)
                            if (kind == "person") {
                                fields.put("email", if (isAdmin || creating) email.trim().lowercase() else existing?.email.orEmpty())
                            }
                            val engine = JSONObject().put("engine", "claude-code")
                            if (model.isNotBlank()) engine.put("model", model.trim())
                            fields.put("engines", JSONArray().put(engine))
                            val placement = JSONObject()
                            if (tag.isNotBlank()) placement.put("tag", tag.trim())
                            fields.put("hosts", placement)
                            if (amount != null) fields.put("budgetUsdMonth", amount)
                            Fleet(settings).saveMember(id, fields)
                                .onSuccess { r ->
                                    val saved = r.member
                                    if (r.ok == true && saved != null) {
                                        onSaved(saved)
                                    } else {
                                        result = r.text ?: "Your fleet refused that."
                                    }
                                }
                                .onFailure { result = it.message ?: "that did not work" }
                        }
                    }
                    busy = false
                }
            },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (busy) "Saving…" else "Save") }
        if (result.isNotBlank()) {
            SelectionContainer { Hint(result, color = Design.Palette.bad.now) }
        }
    }
}

/** What a team member's vault said about a Claude sign-in. */
enum class MemberSignIn {
    /** The vault answered, and it holds a Claude item. */
    SignedIn,

    /** The vault answered, and it holds none. */
    NotSignedIn,

    /** The vault could not be asked, or refused: cannot tell (C-5). */
    NotChecked,
}

/**
 * The row's words for a sign-in's state. Null is still being asked. The same
 * words on both phones (test/members-in-apps.test.js).
 */
fun memberSignInWord(state: MemberSignIn?): String = when (state) {
    MemberSignIn.SignedIn -> "Signed in to Claude"
    MemberSignIn.NotSignedIn -> "Not signed in"
    MemberSignIn.NotChecked -> "Not checked"
    null -> "Checking…"
}

/** Person or Agent, as a word on the row. */
fun memberKindWord(kind: String): String = if (kind == "agent") "Agent" else "Person"

/**
 * What giving up custody of a person costs, asked before it is done. The
 * same sentence as iOS and the signing page.
 */
const val STOP_MANAGING_SENTENCE = "This is not given back. After it, managing their credentials is theirs to allow, as it is for their other managers."

/**
 * Whether a person lets their managers manage their credentials, as the
 * vault says it. Anything else is an answer this build has not met, and is
 * said as unknown and never as off (C-5). The same sentences as iOS.
 */
fun personCustodyLine(custody: String?, added: Boolean = false): String = when (custody) {
    // With somebody who added them already managing, the switch is about the rest.
    "allowed" -> if (added) "Lets their other managers manage their credentials." else "Lets their managers manage their credentials."
    "off" -> if (added) "Has not let their other managers manage their credentials." else "Has not let their managers manage their credentials."
    "no_vault" -> "Has not signed in on a phone yet, so there is no vault to manage."
    else -> "Unknown."
}

/** The row under You: how many members the organization has. */
fun describeOrganization(count: Int): String = when (count) {
    0 -> "no members yet"
    1 -> "1 member"
    else -> "$count members"
}

/** One row of the tree: a member, and how far under the top it sits. */
data class OrgRow(val member: Fleet.Member, val depth: Int)

/**
 * The members as a tree, flattened for a list: each member that reports to
 * nobody in the list, in the list's order, followed by its reports, and
 * theirs. A member caught in a loop, which the fleet refuses to save, is
 * still drawn, at the top, so nobody is ever missing from Everyone.
 */
fun orgRows(members: List<Fleet.Member>): List<OrgRow> {
    val ids = members.map { it.id }.toSet()
    val out = mutableListOf<OrgRow>()
    val placed = mutableSetOf<String>()
    fun place(member: Fleet.Member, depth: Int) {
        if (!placed.add(member.id)) return
        out += OrgRow(member, depth)
        members.filter { it.reportsTo == member.id }.forEach { place(it, depth + 1) }
    }
    members.filter { it.reportsTo.orEmpty() !in ids }.forEach { place(it, 0) }
    members.forEach { place(it, 0) }
    return out
}

/**
 * Whether the vault's place for a member differs from the fleet's record in
 * anything custody follows: what it is, whose address, whom it reports to,
 * and the managers named beside the tree.
 */
internal fun custodyDiffers(filed: PhoneVault.OrgMember, member: Fleet.Member): Boolean =
    filed.kind != member.kind ||
        filed.reportsTo.orEmpty() != member.reportsTo.orEmpty() ||
        filed.managers.map { it.lowercase() }.toSet() != member.managers.map { it.lowercase() }.toSet() ||
        filed.email.orEmpty().lowercase() != member.email.orEmpty().lowercase()

/**
 * A member's id from its name: lowercase letters, digits and single
 * hyphens, at most 40, as the fleet takes one.
 */
fun memberSlug(name: String): String {
    val out = StringBuilder()
    for (ch in name.lowercase()) {
        if (ch in 'a'..'z' || ch in '0'..'9') {
            out.append(ch)
        } else if (out.isNotEmpty() && out.last() != '-') {
            out.append('-')
        }
    }
    return out.toString().take(40).trimEnd('-')
}

/** A comma-separated field as a list: trimmed, lowercased, empties dropped. */
fun memberList(text: String): List<String> =
    text.split(",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }

/** A budget as the field shows it: whole dollars without a decimal point. */
fun memberBudgetText(amount: Double): String =
    if (amount == Math.floor(amount)) amount.toLong().toString() else amount.toString()
