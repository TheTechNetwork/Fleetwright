package network.thetech.fleetwright

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * Budgets and approvals: what a member has spent this month, and the starts
 * that wait for a person (docs/budgets.md).
 *
 * Your fleet counts what each member's sessions cost. A start that would
 * take a member past its budget, or that an admin named as risky, is refused
 * until somebody who manages that member approves it. Nothing is held: once
 * the approval is given, the same start is sent again.
 *
 * THE SENTENCES ARE THE FLEET'S OWN. What a member has spent is `words`, a
 * refusal is `text`, and why a start needs approval is each reason's `text`,
 * drawn exactly as sent. A figure can be a floor ("At least $3.00", when a
 * session reported no cost), and what a member has spent is told only to
 * whoever may see it, so a line this phone rebuilt from a number could say a
 * floor as a total, or a figure to somebody who was not sent one (C-5). No
 * screen here reads a dollar amount.
 *
 * THE PHONE DECIDES NOTHING. Who may answer an approval is the fleet's word
 * (`mayAnswer`), who may change the rules is the fleet's word (`you.admin`),
 * and every control is drawn from one of those and nothing else (C-2). A
 * refusal is shown in the fleet's sentence.
 *
 * The same words as iOS (Budgets.swift), held equal by
 * test/budgets-in-apps.test.js.
 */

/**
 * What happens at a budget, in the order it is offered: off first, because
 * it is what a fleet does until an admin says otherwise.
 */
val BUDGET_MODES = listOf("off", "ask", "refuse")

/**
 * A choice's name. One this build has never met is shown as the fleet sent
 * it (C-5).
 */
fun budgetModeName(mode: String): String = when (mode) {
    "off" -> "Count only"
    "ask" -> "Ask first"
    "refuse" -> "Refuse"
    else -> mode
}

/** The one line under a choice. */
fun budgetModeLine(mode: String): String = when (mode) {
    "off" -> "Budgets are shown and stop nothing."
    "ask" -> "A start past a member’s budget waits for approval."
    "refuse" -> "A start past a member’s budget is refused until the month turns or the budget is raised."
    else -> ""
}

/** The switch for a session that runs commands without asking first. */
const val BUDGET_DANGEROUS_LABEL = "Ask before a session that skips permission prompts"

/**
 * The switch for a start as a member with an engine on an API key
 * (docs/api-engines.md), and the one line under it: why it starts on.
 */
const val BUDGET_PAID_API_LABEL = "Ask before a session on a paid API key"
const val BUDGET_PAID_API_LINE = "A key is billed by the token and no budget here counts it, so this is on until an admin turns it off."

/** What counting is, and what it never does, said on the rules whoever is reading them. */
const val BUDGET_COUNTING_LINE = "Counting is at API prices, as each session counts its own cost. Sessions already running are not stopped."

/** How many kinds of work an admin may name, as the fleet takes them. */
const val BUDGET_WORK_TYPE_LIMIT = 20

/** A note beside a decline, in bytes of UTF-8, as the fleet measures it. */
const val APPROVAL_NOTE_LIMIT = 300

/**
 * Whether an approval is asking this person something: it is waiting, and
 * the fleet says it is theirs to answer. Approve and Decline are drawn for
 * these and no others, and these are the ones that come first.
 */
fun approvalWaitsOnYou(approval: Fleet.Approval): Boolean = approval.state == "waiting" && approval.mayAnswer

/**
 * What is being asked for: a session, and as whom. The member is named
 * where the fleet named it and shown by id where it did not.
 */
fun approvalAskWords(approval: Fleet.Approval): String {
    val name = approval.memberName ?: approval.member.orEmpty()
    return if (name.isEmpty()) "Start a session" else "Start a session as $name"
}

/** Who asked, and when the fleet said when. */
fun approvalAskedLine(by: String?, at: String?): String {
    val who = if (by.isNullOrEmpty()) "Asked" else "Asked by $by"
    return if (at == null) who else "$who, $at"
}

/**
 * Where an approval stands, in words. A state this build has never met is
 * shown as the fleet sent it, and nobody is named who the fleet did not
 * name (C-5). The same sentences on both phones.
 */
fun approvalStateWords(state: String?, decidedBy: String?, mayAnswer: Boolean): String {
    val who = decidedBy.orEmpty()
    val by = if (who.isEmpty()) "" else " by $who"
    return when (state) {
        "waiting" -> if (mayAnswer) "Waiting on you" else "Waiting for an answer"
        "approved" -> "Approved$by, for one start within the hour"
        "declined" -> "Declined$by"
        "used" -> "Approved$by and used"
        "expired" -> if (who.isEmpty()) "Ran out before it was answered" else "Approved$by, and ran out before it was used"
        else -> state.orEmpty()
    }
}

/**
 * What approving does, said before it is done: the reasons, each in the
 * fleet's own sentence, and that it is for one start.
 */
fun approvalConfirmWords(approval: Fleet.Approval): String =
    (approval.reasons.map { it.text } + "Approving is for this one start, within the hour.").joinToString(" ")

/**
 * The row under Organization: how many approvals wait on this person. Null
 * when none do, and then the row says nothing beside its name.
 */
fun describeApprovals(waitingOnYou: Int): String? = if (waitingOnYou == 0) null else "$waitingOnYou waiting on you"

/**
 * A member's spend as the line under "This month": the fleet's sentence, and
 * "Over budget" in words before it when the fleet says so. Never the colour
 * alone.
 */
fun memberSpendLine(over: Boolean, words: String): String = if (over) "Over budget. $words" else words

/**
 * The names a notification gives two pages among the pages under You:
 * "approvals", and "member:" with a member's id.
 */
const val APPROVALS_PAGE = "approvals"
const val MEMBER_PAGE_PREFIX = "member:"

private val MEMBER_PAGE_ID = Regex("[a-z0-9-]{1,40}")

/**
 * The member a page name asks for, or null when it names something else.
 *
 * THE ID CAME FROM A NOTIFICATION'S EXTRAS, which any app can send this one.
 * So it is held to what a member's id is: lowercase letters, digits and
 * hyphens, at most 40.
 */
fun memberPageId(page: String?): String? {
    if (page == null || !page.startsWith(MEMBER_PAGE_PREFIX)) return null
    return page.removePrefix(MEMBER_PAGE_PREFIX).takeIf { MEMBER_PAGE_ID.matches(it) }
}

/**
 * A start your fleet refused at a budget or for want of approval: what was
 * sent, the fleet's sentence, and the approval it waits on when there is
 * one. [code] is "needs_approval" or "over_budget".
 */
data class RefusedStart(val request: StartRequest, val text: String, val code: String, val approval: Fleet.Approval?) {
    /** The approval this person may give themselves, when the fleet says so. */
    val mine: Fleet.Approval? get() = approval?.takeIf { it.mayAnswer }
}

/**
 * The refused start in a start's answer, or null for every other answer: a
 * screen draws one only for the two refusals it is about, by the fleet's own
 * code and never by its wording.
 */
fun refusedStartOf(request: StartRequest, reply: Fleet.Reply, text: String): RefusedStart? {
    val code = reply.code ?: return null
    if (reply.ok || (code != "needs_approval" && code != "over_budget")) return null
    return RefusedStart(request, text, code, if (code == "needs_approval") reply.approval else null)
}

/**
 * Give the approval, then send the same start, once. A refusal to approve is
 * the fleet's sentence, returned to be shown, and then no start is sent.
 *
 * ONE APPROVE, ONE RETRY. Whatever the second answer is, the screen that
 * sends starts shows it as it shows any start's answer. Nothing here sends a
 * third request.
 */
private suspend fun approveAndStart(settings: Settings, approval: Fleet.Approval, again: () -> Unit): String {
    val reply = Fleet(settings).answerApproval(approval.id, "approve").getOrElse { return it.message ?: "that did not work" }
    if (reply.ok != true) return reply.text ?: "Your fleet refused that."
    again()
    return ""
}

/**
 * A refused start, where the start's answer is drawn: the fleet's sentence,
 * and what this person can do about it.
 *
 * THREE SHAPES, FROM THE FLEET'S ANSWER (C-2). Where it says the approval is
 * this person's to give: Approve and start, and the card wears the attention
 * ring, because it is the one card here asking them something. Where
 * somebody else must give it: nothing to approve, since the sentence already
 * says who can, and Try again for once they have. At a budget the fleet
 * refuses outright: the sentence, and nothing to press, because nothing
 * pressed here changes a month or a budget.
 */
@Composable
internal fun RefusedStartCard(settings: Settings, refused: RefusedStart, again: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember(refused) { mutableStateOf(false) }
    var problem by remember(refused) { mutableStateOf("") }
    val mine = refused.mine
    Column(
        Modifier
            .fillMaxWidth()
            .fleetCard(
                radius = Design.Radius.row,
                fill = Design.Palette.inner.now,
                ring = if (mine != null) Design.Palette.attention.now else Design.Palette.ring.now,
            )
            .padding(Design.Space.inside),
        verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        SelectionContainer {
            Text(refused.text, style = Design.Style.bodySmall, color = Design.Palette.ink.now)
        }
        if (mine != null) {
            OutlinedButton(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        problem = approveAndStart(settings, mine, again)
                        busy = false
                    }
                },
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(if (busy) "Approving…" else "Approve and start") }
            Hint("Approves this one start and sends it again.")
        } else if (refused.code == "needs_approval") {
            OutlinedButton(
                onClick = again,
                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Try again: sends the same start again" },
            ) { Text("Try again") }
        }
        if (problem.isNotBlank()) {
            SelectionContainer { Hint(problem, color = Design.Palette.bad.now) }
        }
    }
}

/**
 * "This month" on a member's page: what the fleet counted against its
 * budget, in the fleet's sentence.
 *
 * ONLY WHEN THE FLEET LISTED THIS MEMBER. Its answer holds the members this
 * person may see the spending of, so a member who is not in it gets no line
 * at all, never "$0.00", which would be a figure nobody sent (C-5). While
 * the answer is on its way there is nothing to say and nothing is drawn; a
 * load that failed says so. A fleet from before budgets answers with no list
 * and no sentence, and that draws nothing either.
 */
@Composable
internal fun MemberSpendLine(settings: Settings, memberId: String) {
    var failed by remember(memberId) { mutableStateOf<String?>(null) }
    var spend by remember(memberId) { mutableStateOf<Fleet.MemberSpend?>(null) }

    LaunchedEffect(memberId) {
        failed = null
        val got = Fleet(settings).budgets().getOrElse {
            failed = it.message ?: "no answer"
            return@LaunchedEffect
        }
        val listed = got.members
        if (got.ok == false || listed == null) {
            // A refusal has a sentence. An answer with neither is a fleet
            // from before budgets, which has nothing to say here.
            failed = got.text
            return@LaunchedEffect
        }
        spend = listed.firstOrNull { it.member == memberId }
    }

    val why = failed
    val shown = spend
    val words = shown?.words
    if (why != null) {
        Text("Spending could not be loaded.", style = Design.Style.bodySmall, color = Design.Palette.ink.now)
        SelectionContainer { Hint(why) }
    } else if (shown != null && words != null) {
        Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
            Text("This month", style = Design.Style.label, color = Design.Palette.inkDim.now)
            // THE PAGE'S ONE ATTENTION COLOUR, and only past the budget. The
            // words say it first.
            Text(
                memberSpendLine(shown.over, words),
                style = Design.Style.body,
                color = if (shown.over) Design.Palette.attention.now else Design.Palette.ink.now,
            )
        }
    }
}

/**
 * Approvals: the starts waiting on this person, then this person's own
 * asks, then the ones that are over. Reached from Organization.
 *
 * WAITING ON YOU IS FIRST, because those are asking a question, and they are
 * the only ones whose state takes the attention colour. Every approval is
 * the same shape: what is asked, who asked, each reason in the fleet's
 * sentence, the task when there is one, and where it stands in words.
 *
 * APPROVE AND DECLINE ONLY WHERE THE FLEET WOULD TAKE THEM (C-2): on one
 * that is waiting and that the fleet says is this person's to answer.
 * Approve asks once, with the reasons in front of it. Decline opens a page
 * for a note, which is optional and is told to whoever asked.
 *
 * FOUR STATES: loading, could not load, loaded (which may be empty, and says
 * so), and a fleet that answered with no list and no sentence, which is one
 * from before approvals.
 */
@Composable
internal fun ApprovalsScreen(settings: Settings, onDismiss: () -> Unit, onStart: (StartRequest) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    // `asked` is bumped by Try again and by every answer, which runs the
    // load again.
    var failed by remember { mutableStateOf<String?>(null) }
    var absent by remember { mutableStateOf(false) }
    var asked by remember { mutableIntStateOf(0) }
    // Null until the fleet answers with a list.
    var approvals by remember { mutableStateOf<List<Fleet.Approval>?>(null) }
    var finishedOpen by remember { mutableStateOf(false) }
    // Approve is waiting on its dialog for this one, and Decline on its page.
    var approving by remember { mutableStateOf<Fleet.Approval?>(null) }
    var declining by remember { mutableStateOf<Fleet.Approval?>(null) }
    // The task whose page is open, by id, and whether the rules are.
    var taskOpen by remember { mutableStateOf<String?>(null) }
    var rules by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var refused by remember { mutableStateOf(false) }

    LaunchedEffect(asked) {
        failed = null
        absent = false
        val got = Fleet(settings).approvals().getOrElse {
            failed = it.message ?: "no answer"
            return@LaunchedEffect
        }
        val list = got.approvals
        if (got.ok == false || list == null) {
            // A REFUSAL HAS A SENTENCE, and that is a failure to load. An
            // answer with no list and no sentence is a fleet from before
            // approvals.
            val said = got.text
            if (said != null) failed = said else absent = true
            return@LaunchedEffect
        }
        approvals = list
    }

    /**
     * What the fleet said of an answer is the page's line, a refusal's
     * sentence included, and then the list as the fleet has it now.
     */
    fun show(reply: Fleet.ApprovalReply) {
        refused = reply.ok != true
        result = reply.text ?: if (reply.ok == true) "Answered." else "Your fleet refused that."
        asked++
    }

    // APPROVE ASKS ONCE, with the reasons in front of it and what an
    // approval is good for.
    approving?.let { approval ->
        AlertDialog(
            onDismissRequest = { approving = null },
            title = { Text(approvalAskWords(approval) + "?") },
            text = { Text(approvalConfirmWords(approval)) },
            confirmButton = {
                TextButton(onClick = {
                    approving = null
                    scope.launch {
                        busy = true
                        result = ""
                        Fleet(settings).answerApproval(approval.id, "approve")
                            .onSuccess { show(it) }
                            .onFailure {
                                refused = true
                                result = it.message ?: "that did not work"
                            }
                        busy = false
                    }
                }) { Text("Approve") }
            },
            dismissButton = { TextButton(onClick = { approving = null }) { Text("Cancel") } },
        )
    }
    declining?.let { approval ->
        ApprovalDeclinePage(
            settings = settings,
            approval = approval,
            onDismiss = { declining = null },
            onAnswered = {
                declining = null
                show(it)
            },
        )
    }
    // THE TASK A START IS ON, which the page then asks the fleet about itself.
    taskOpen?.let { id ->
        TaskPage(settings = settings, id = id, onDismiss = { taskOpen = null }, onStart = onStart)
    }
    // WHAT NEEDS APPROVAL, one tap away, as Routing is from Organization.
    if (rules) BudgetSettingsScreen(settings, onDismiss = { rules = false })

    FullScreen(title = "Approvals", onDismiss = onDismiss) {
        val why = failed
        val list = approvals
        when {
            why != null -> {
                Hint("Could not load the approvals.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }
            // NOT A FAILURE, AND NOT "NONE". The fleet answered with no list
            // and nothing to say about it, which is what one from before
            // approvals does (C-5).
            absent -> Hint("Approvals are not on this fleet yet. It may need an update.")
            list == null -> Hint("Loading…")
            else -> {
                val onYou = list.filter { approvalWaitsOnYou(it) }
                // Waiting, and somebody else's to answer: this person's own asks.
                val mine = list.filter { it.state == "waiting" && !it.mayAnswer }
                val finished = list.filter { it.state != "waiting" }
                if (list.isEmpty()) {
                    Hint("No approvals yet. A start that needs one is listed here.")
                } else {
                    // THE ONES ASKING THIS PERSON, each the same shape with
                    // its two answers under it. With none, the page says so
                    // in the calm colour: nothing waiting is the answer most
                    // people open this for.
                    SectionHead("Waiting on you")
                    if (onYou.isEmpty()) Hint("Nothing is waiting on you.")
                    onYou.forEach { approval ->
                        ApprovalFacts(approval) { taskOpen = it }
                        if (approvalWaitsOnYou(approval)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                                OutlinedButton(
                                    enabled = !busy,
                                    onClick = { approving = approval },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text("Approve") }
                                TextButton(
                                    enabled = !busy,
                                    onClick = { declining = approval },
                                    modifier = Modifier.heightIn(min = 48.dp),
                                ) { Text("Decline") }
                            }
                        }
                    }
                    if (mine.isNotEmpty()) {
                        SectionHead("Your asks")
                        mine.forEach { approval -> ApprovalFacts(approval) { taskOpen = it } }
                    }
                    // APPROVED, DECLINED, USED AND RUN OUT, behind one row.
                    if (finished.isNotEmpty()) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clickable(
                                    role = Role.Button,
                                    onClickLabel = if (finishedOpen) "Hide finished approvals" else "Show finished approvals",
                                ) { finishedOpen = !finishedOpen },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Finished", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                            Text(if (finishedOpen) "Hide" else "Show", style = Design.Style.label, color = Design.Palette.inkDim.now)
                        }
                        if (finishedOpen) finished.forEach { approval -> ApprovalFacts(approval) { taskOpen = it } }
                    }
                }
                if (result.isNotBlank()) {
                    SelectionContainer {
                        Hint(result, color = if (refused) Design.Palette.bad.now else Design.Palette.ink.now)
                    }
                }
                // The row is for everybody, and its page draws a control
                // only for an admin.
                OpenRow("What needs approval") { rules = true }
            }
        }
    }
}

/**
 * One approval, the same shape wherever it is listed: what is asked, who
 * asked, each reason as the fleet's sentence, a note when there is one, and
 * where it stands in words. The attention colour is on the ones asking this
 * person and on nothing else. A task opens its page; the id is read as a
 * task's id or not at all.
 */
@Composable
private fun ApprovalFacts(approval: Fleet.Approval, onTask: (String) -> Unit) {
    val onYou = approvalWaitsOnYou(approval)
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Text(approvalAskWords(approval), style = Design.Style.body, color = Design.Palette.ink.now)
        Text(approvalAskedLine(approval.askedBy, taskTime(approval.askedAt)), style = Design.Style.label, color = Design.Palette.inkDim.now)
        // EACH REASON IS THE FLEET'S SENTENCE, as sent.
        approval.reasons.forEach { reason ->
            Text(reason.text, style = Design.Style.label, color = Design.Palette.ink.now)
        }
        approval.note?.let { note ->
            Text("Note: $note", style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
        Text(
            approvalStateWords(approval.state, approval.decidedBy, approval.mayAnswer),
            style = Design.Style.label,
            color = if (onYou) Design.Palette.attention.now else Design.Palette.inkDim.now,
        )
    }
    taskPageId(TASK_PAGE_PREFIX + approval.task.orEmpty())?.let { id ->
        OpenRow("Task $id") { onTask(id) }
    }
}

/**
 * Decline one start, with a note or without.
 *
 * THE NOTE IS OPTIONAL AND IT IS NOT PRIVATE: the fleet tells it to whoever
 * asked, and the page says so before anything is typed. It is counted as the
 * fleet counts it, in bytes of UTF-8, and Decline waits while it is over: a
 * note the fleet would refuse is not sent to find out.
 */
@Composable
private fun ApprovalDeclinePage(
    settings: Settings,
    approval: Fleet.Approval,
    onDismiss: () -> Unit,
    onAnswered: (Fleet.ApprovalReply) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    val noteBytes = taskBytes(note.trim())
    val over = noteBytes > APPROVAL_NOTE_LIMIT

    FullScreen(title = approvalAskWords(approval), onDismiss = onDismiss) {
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note") },
            placeholder = { Text("Why, if you want to say") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            if (over) "$noteBytes of $APPROVAL_NOTE_LIMIT bytes, ${noteBytes - APPROVAL_NOTE_LIMIT} too many" else "$noteBytes of $APPROVAL_NOTE_LIMIT bytes",
            style = Design.Style.micro,
            color = if (over) Design.Palette.bad.now else Design.Palette.inkDim.now,
        )
        Hint("Optional. The note is told to the person who asked.")

        OutlinedButton(
            enabled = !busy && !over,
            onClick = {
                scope.launch {
                    busy = true
                    result = ""
                    Fleet(settings).answerApproval(approval.id, "decline", note.trim())
                        .onSuccess { reply ->
                            // A refusal keeps the page open with the fleet's
                            // sentence on it.
                            if (reply.ok != true) {
                                result = reply.text ?: "Your fleet refused that."
                            } else {
                                onAnswered(reply)
                            }
                        }
                        .onFailure { result = it.message ?: "that did not work" }
                    busy = false
                }
            },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (busy) "Declining…" else "Decline") }
        if (result.isNotBlank()) {
            SelectionContainer { Hint(result, color = Design.Palette.bad.now) }
        }
    }
}

/**
 * What needs approval: what your fleet does at a member's budget, and what
 * else it asks a person about before a start. One tap from Approvals.
 *
 * EVERYBODY READS IT AND AN ADMIN EDITS IT, as Routing is read and edited.
 * Whether this person is an admin is the fleet's answer (`you.admin`), and
 * every control here is drawn from that answer and nothing else (C-2).
 * Somebody who is not one sees the same page: the choice marked, the switch
 * as a word, the kinds of work listed, no control, and one line saying who
 * sets it.
 *
 * NOTHING IS SENT UNTIL Save, AND THEN ALL OF IT: the page keeps a draft,
 * says when the draft differs from what the fleet has, and shows what the
 * fleet said of a save, a refusal's sentence included.
 *
 * FOUR STATES: loading, could not load, loaded, and a fleet that answered
 * with no setting and no sentence, which is one from before budgets.
 *
 * THE PAID-KEY SWITCH IS DRAWN ONLY FOR A FLEET THAT SENT IT
 * (docs/api-engines.md). One from before the guard sends no `paidApi`, and
 * that is unknown, never off: no switch, no word, and nothing about it in
 * what Save sends (C-5).
 */
@Composable
internal fun BudgetSettingsScreen(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    // `asked` is bumped by Try again, which runs the load again.
    var failed by remember { mutableStateOf<String?>(null) }
    var absent by remember { mutableStateOf(false) }
    var asked by remember { mutableIntStateOf(0) }
    // The setting as the fleet last sent it. The draft is held against it.
    var saved by remember { mutableStateOf<Fleet.BudgetSettings?>(null) }
    var isAdmin by remember { mutableStateOf(false) }
    // The draft: what Save would send.
    var mode by remember { mutableStateOf("off") }
    var dangerous by remember { mutableStateOf(false) }
    // Null when the fleet sent no such switch, and then none is drawn.
    var paidApi by remember { mutableStateOf<Boolean?>(null) }
    var workTypes by remember { mutableStateOf(listOf<String>()) }
    var newKind by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var refused by remember { mutableStateOf(false) }

    /** The fleet's setting becomes the draft. */
    fun take(now: Fleet.BudgetSettings) {
        saved = now
        mode = now.budgets
        dangerous = now.dangerous
        paidApi = now.paidApi
        workTypes = now.workTypes
    }

    LaunchedEffect(asked) {
        failed = null
        absent = false
        val got = Fleet(settings).budgets().getOrElse {
            failed = it.message ?: "no answer"
            return@LaunchedEffect
        }
        val now = got.settings
        if (got.ok == false || now == null) {
            // A REFUSAL HAS A SENTENCE, and that is a failure to load. An
            // answer with no setting and no sentence is a fleet from before
            // budgets, which is a different thing to say.
            val said = got.text
            if (said != null) failed = said else absent = true
            return@LaunchedEffect
        }
        take(now)
        isAdmin = got.admin == true
        result = ""
    }

    val current = saved
    // Whether the draft differs from what the fleet has.
    val changed = current != null &&
        (mode != current.budgets || dangerous != current.dangerous || workTypes != current.workTypes || paidApi != current.paidApi)
    val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)

    FullScreen(title = "What needs approval", onDismiss = onDismiss) {
        val why = failed
        when {
            why != null -> {
                Hint("Could not load what needs approval.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }
            // NOT A FAILURE, AND NOT "COUNT ONLY". No choice is drawn that
            // nobody sent (C-5).
            absent -> Hint("Budgets are not on this fleet yet. It may need an update.")
            current == null -> Hint("Loading…")
            else -> {
                // WHAT HAPPENS AT A BUDGET, as three choices of the same
                // shape, each with what it does under its name. For an admin
                // each is a radio button; for anybody else the same rows are
                // text, with a word on the one the fleet is set to.
                SectionHead("When a member is past its budget")
                BUDGET_MODES.forEach { id ->
                    if (isAdmin) {
                        BudgetModeChoice(id, selected = mode == id, enabled = !busy) { mode = id }
                    } else {
                        BudgetModeFact(id, selected = mode == id)
                    }
                }
                if (!isAdmin) Hint("A fleet admin sets these. Anybody can read them.")
                current.updatedBy?.let { who ->
                    Text(routingSetLine(who, taskTime(current.updatedAt)), style = Design.Style.micro, color = Design.Palette.inkDim.now)
                }
                Hint(BUDGET_COUNTING_LINE)

                // A SESSION THAT RUNS COMMANDS WITHOUT ASKING FIRST: a switch
                // for an admin, and for anybody else the same words with On
                // or Off beside them.
                SectionHead("Before a start")
                if (isAdmin) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .toggleable(value = dangerous, enabled = !busy, role = Role.Switch, onValueChange = { dangerous = it }),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(BUDGET_DANGEROUS_LABEL, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                        Switch(checked = dangerous, onCheckedChange = null, enabled = !busy)
                    }
                } else {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {},
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(BUDGET_DANGEROUS_LABEL, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                        Text(if (dangerous) "On" else "Off", style = Design.Style.label, color = Design.Palette.inkDim.now)
                    }
                }
                // A PAID API KEY, in the same two shapes, and only when the
                // fleet sent the switch: `paid` is its answer or the draft
                // made from it, never a default of this phone's.
                val paid = paidApi
                if (paid != null) {
                    if (isAdmin) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .toggleable(value = paid, enabled = !busy, role = Role.Switch, onValueChange = { paidApi = it }),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            Text(BUDGET_PAID_API_LABEL, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                            Switch(checked = paid, onCheckedChange = null, enabled = !busy)
                        }
                    } else {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {},
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            Text(BUDGET_PAID_API_LABEL, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                            Text(if (paid) "On" else "Off", style = Design.Style.label, color = Design.Palette.inkDim.now)
                        }
                    }
                    Hint(BUDGET_PAID_API_LINE)
                }

                // THE KINDS OF WORK whose tasks are asked about, every one a
                // row of the same shape. Remove is an admin's.
                SectionHead("Kinds of work that need approval")
                Hint("A start on a task of one of these kinds waits for approval.")
                if (workTypes.isEmpty()) Hint("No kinds of work yet.")
                workTypes.forEach { kind ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(kind, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                        if (isAdmin) {
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    workTypes = workTypes.filter { it != kind }
                                    result = ""
                                },
                                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Remove $kind" },
                            ) { Text("Remove", color = Design.Palette.bad.now) }
                        }
                    }
                }

                // AN ADMIN'S CONTROLS, and nobody else's: naming a kind of
                // work, and sending the draft.
                if (isAdmin) {
                    // Not offered past the twenty the fleet takes, and the
                    // line says why.
                    if (workTypes.size < BUDGET_WORK_TYPE_LIMIT) {
                        OutlinedTextField(
                            value = newKind,
                            onValueChange = { newKind = it.trim().lowercase() },
                            label = { Text("Kind of work") },
                            placeholder = { Text("deploy") },
                            singleLine = true,
                            keyboardOptions = plain,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(
                            enabled = !busy && newKind.isNotBlank(),
                            // Put on the draft, once. Whether the word is
                            // one the fleet takes is its to say when the
                            // draft is saved.
                            onClick = {
                                val kind = newKind.trim().lowercase()
                                if (kind.isNotEmpty() && kind !in workTypes) workTypes = workTypes + kind
                                newKind = ""
                                result = ""
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text("Add the kind") }
                    } else {
                        Hint("That is all $BUDGET_WORK_TYPE_LIMIT. Remove one to add another.")
                    }
                    Hint("A kind of work is a short word, like deploy or billing. At most $BUDGET_WORK_TYPE_LIMIT.")

                    OutlinedButton(
                        enabled = !busy && changed,
                        // The choice, the switch and every kind of work, then
                        // the paid-key switch where there is one, and then
                        // what the fleet said. Its sentence is the line
                        // either way, and a refusal's is all there is.
                        onClick = {
                            scope.launch {
                                busy = true
                                result = ""
                                var sent = Fleet(settings).setBudgetSettings(mode, dangerous, workTypes)
                                // THE PAID-KEY SWITCH GOES IN A REQUEST OF ITS
                                // OWN, after the three, and only when the fleet
                                // sent the switch and the draft moved it. The
                                // three are the fleet's by then, so they stop
                                // being a draft whatever it says of the switch,
                                // and its answer carries the whole setting and
                                // is the one shown.
                                val first = sent.getOrNull()
                                val kept = first?.settings
                                val wanted = paidApi
                                if (first?.ok == true && kept != null && wanted != null && wanted != kept.paidApi) {
                                    saved = kept
                                    sent = Fleet(settings).setPaidApiApproval(wanted)
                                }
                                sent
                                    .onSuccess { r ->
                                        refused = r.ok != true
                                        result = r.text ?: if (r.ok == true) "Saved." else "Your fleet refused that."
                                        val now = r.settings
                                        if (r.ok == true && now != null) take(now)
                                    }
                                    .onFailure {
                                        refused = true
                                        result = it.message ?: "that did not work"
                                    }
                                busy = false
                            }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (busy) "Saving…" else "Save") }
                    // A DRAFT IS NOT THE FLEET'S SETTING, and the page says
                    // which one is on the screen.
                    if (changed) Hint("Not saved yet.")
                    if (result.isNotBlank()) {
                        SelectionContainer {
                            Hint(result, color = if (refused) Design.Palette.bad.now else Design.Palette.ink.now)
                        }
                    }
                }
            }
        }
    }
}

/** One choice's name and its line. */
@Composable
private fun BudgetModeWords(mode: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(budgetModeName(mode), style = Design.Style.body, color = Design.Palette.ink.now)
        Text(budgetModeLine(mode), style = Design.Style.label, color = Design.Palette.inkDim.now)
    }
}

/**
 * One choice as an admin's: 48dp tall, its radio button saying which is
 * chosen, and said to TalkBack as one choice of several.
 */
@Composable
private fun BudgetModeChoice(mode: String, selected: Boolean, enabled: Boolean, onPick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onPick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        BudgetModeWords(mode, Modifier.weight(1f))
    }
}

/**
 * One choice as a fact, for somebody who is not an admin: the same words, no
 * control, and "Chosen" in words on the one the fleet is set to. Never the
 * colour alone.
 */
@Composable
private fun BudgetModeFact(mode: String, selected: Boolean) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        BudgetModeWords(mode, Modifier.weight(1f))
        if (selected) Text("Chosen", style = Design.Style.label, color = Design.Palette.ink.now)
    }
}
