package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
 * Routing: which member a task with no member goes to (docs/routing.md).
 *
 * A task somebody gave to a member is that member's. For one given to
 * nobody, the fleet can work it out in a fixed order: the owner's rule for
 * that kind of work, then the only member who takes it, then a pick among
 * several, by the fleet's model or by a person on their phone. It writes
 * down how it decided, and that record is what these screens say.
 *
 * THE SENTENCES ARE THE FLEET'S OWN. A decision is said here exactly as
 * `routeWords` says it in src/fleet/protocol/routing.js, head for head, so
 * a person reads one sentence on the phone, in a notification and in a
 * terminal. test/routing-in-apps.test.js imports that file and compares,
 * and reads iOS (Routing.swift) for the same words.
 *
 * THE PHONE DECIDES NOTHING. It shows the record, sends an admin's setting,
 * asks for a task to be routed, and sends a person's answer to "which
 * member". Who may be chosen, and whether a choice is allowed, are the
 * fleet's to say, and a refusal is shown in the fleet's own sentence.
 */

/**
 * The three modes, in the order they are offered: off first, because it is
 * what a fleet is until an admin says otherwise.
 */
val ROUTING_MODES = listOf("off", "manual", "auto")

/**
 * A mode's name as a choice. One this build has never met is shown as the
 * fleet sent it (C-5).
 */
fun routingModeName(mode: String): String = when (mode) {
    "off" -> "Off"
    "manual" -> "Ask me"
    "auto" -> "Choose for me"
    else -> mode
}

/**
 * The one line under a mode on the fleet's own setting, where "below" is
 * the list of rules on the same page.
 */
fun routingModeLine(mode: String): String = when (mode) {
    "off" -> "A task with no member stays with nobody."
    "manual" -> "The rules below place a task. When several members could take it, whoever asked chooses."
    "auto" -> "The same, and the fleet’s model picks among several."
    else -> ""
}

/**
 * Under "Choose for me" on a fleet whose model is not on. The choice stays
 * a choice: the fleet accepts it, and asks a person until its operator
 * turns the model on.
 */
const val ROUTING_NO_MODEL_LINE = "This fleet has no model turned on, so a person is asked. Its operator turns the model on."

/** What routing never does, said on the setting whoever is reading it. */
const val ROUTING_ALWAYS_LINE = "A task somebody was given is never moved. Routing chooses only among members the person asking could have assigned by hand."

/** A task's own choice that names no mode: it follows the fleet's setting. */
const val ROUTING_AS_FLEET = "As your fleet is set"

/**
 * The assignee choice that is not a member and not Nobody. Never a member's
 * id, which is a slug with no colon in it.
 */
const val TASK_FLEET_CHOOSES = "fleet:chooses"

/**
 * How a decision was reached, as the head of its sentence: the fleet's
 * `HOW_WORDS`, word for word. A way of deciding this build has never met is
 * shown as itself, and no words are made up for it (C-5).
 */
fun routeHead(how: String?): String = when (how) {
    "pinned" -> "Given to its member by hand"
    "rule" -> "Routed by the fleet’s rule"
    "only" -> "Routed to the only member who takes it"
    "model" -> "Routed by the fleet’s model"
    "person" -> "Chosen by a person"
    "waiting" -> "Waiting for a person to choose"
    "nobody" -> "No member takes this kind of work"
    else -> how.orEmpty()
}

/**
 * A decision as the sentences a person reads on a task: the head, the
 * member it chose after a colon, why, and while it waits, whom to choose
 * among. Members are named where the organization names them and shown by
 * id where it does not.
 */
fun routeWords(route: Fleet.OrgTask.Route, roster: List<Fleet.Member>): String {
    val chose = taskMemberName(route.member, roster)?.let { ": $it" }.orEmpty()
    val listed = route.candidates.map { taskMemberName(it, roster) ?: it }
    val among = if (route.how == "waiting" && listed.isNotEmpty()) {
        " Choose among " + listed.joinToString(", ") + (if (route.more > 0) " and ${route.more} more" else "") + "."
    } else {
        ""
    }
    return "${routeHead(route.how)}$chose. ${route.why.orEmpty()}$among".trim()
}

/**
 * One routing decision in a task's history: the same head, and whom it
 * chose when it chose somebody. Who asked and when are the line under it.
 */
fun routedHandoffWords(how: String?, to: String?): String =
    if (to.isNullOrEmpty()) routeHead(how) else "${routeHead(how)}: $to"

/**
 * Whether a task is waiting on a person to say which member it goes to: the
 * fleet's last decision was to ask, and nobody has it yet.
 */
fun taskWaitsForMember(task: Fleet.OrgTask): Boolean =
    task.state == "open" && task.route?.how == "waiting" && task.assignee.isNullOrBlank()

/**
 * Whether a task is asking somebody something: it came back with a result
 * to judge, or it waits for a member to be chosen. These are the rows that
 * come forward in the list, and the only ones that take the attention colour.
 */
fun taskAsks(task: Fleet.OrgTask): Boolean = task.state == "returned" || taskWaitsForMember(task)

/** Who last set the fleet's routing, and when the fleet said when. */
fun routingSetLine(by: String, at: String?): String =
    if (at == null) "Last set by $by" else "Last set by $by, $at"

/**
 * The fleet's routing: the mode in three plain choices, and the rules by
 * kind of work. Reached from Organization.
 *
 * EVERYBODY READS IT AND AN ADMIN EDITS IT. Whether this person is an admin
 * is the fleet's answer (`you.admin`), and every control here is drawn from
 * that answer and nothing else (C-2). Somebody who is not one sees the same
 * page, with the mode marked and the rules listed, no control, and one line
 * saying who sets it.
 *
 * NOTHING IS SENT UNTIL Save, AND THEN ALL OF IT. The fleet replaces its
 * list of rules with the one it is given, so the page keeps a draft and
 * sends the mode and the whole list together. A draft that differs from
 * what the fleet has says so. What the fleet refuses, it says why: a second
 * rule for one kind of work is its refusal to make, in its own sentence,
 * and the draft stays as it was so the rule can be taken out.
 *
 * FOUR STATES: loading, could not load, loaded, and a fleet that answered
 * with no routing record and no sentence, which is one from before routing.
 */
@Composable
internal fun RoutingScreen(
    settings: Settings,
    /**
     * Everybody, for the name of the member a rule goes to and for whom a
     * new rule may name. The Organization behind this page loaded them.
     */
    members: List<Fleet.Member>,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    // `asked` is bumped by Try again, which runs the load again.
    var failed by remember { mutableStateOf<String?>(null) }
    var absent by remember { mutableStateOf(false) }
    var asked by remember { mutableIntStateOf(0) }
    // The record as the fleet last sent it. The draft is held against it.
    var saved by remember { mutableStateOf<Fleet.Routing?>(null) }
    // Whether a pick among several can be the fleet's model's.
    var modelOn by remember { mutableStateOf(false) }
    var isAdmin by remember { mutableStateOf(false) }
    // The draft: what Save would send.
    var mode by remember { mutableStateOf("off") }
    var rules by remember { mutableStateOf(listOf<Fleet.RoutingRule>()) }
    var newKind by remember { mutableStateOf("") }
    var newMember by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var refused by remember { mutableStateOf(false) }

    /** The fleet's record becomes the draft. */
    fun take(now: Fleet.Routing) {
        saved = now
        mode = now.mode
        rules = now.rules
    }

    LaunchedEffect(asked) {
        failed = null
        absent = false
        val got = Fleet(settings).routing().getOrElse {
            failed = it.message ?: "no answer"
            return@LaunchedEffect
        }
        val now = got.routing
        if (got.ok == false || now == null) {
            // A REFUSAL HAS A SENTENCE, and that is a failure to load. An
            // answer with no record and no sentence is a fleet from before
            // routing, which is a different thing to say.
            val said = got.text
            if (said != null) failed = said else absent = true
            return@LaunchedEffect
        }
        take(now)
        modelOn = got.model == true
        isAdmin = got.admin == true
        result = ""
    }

    val current = saved
    // Whether the draft differs from what the fleet has.
    val changed = current != null && (mode != current.mode || rules != current.rules)
    val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)

    FullScreen(title = "Routing", onDismiss = onDismiss) {
        val why = failed
        when {
            why != null -> {
                // The result, then the reason smaller under it, as the
                // Organization says it: the reason is there to be copied.
                Hint("Could not load the routing.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }
            // NOT A FAILURE, AND NOT "OFF". The fleet answered, with no
            // routing record and nothing to say about it, which is what one
            // from before routing does. Said as that, in the calm colour,
            // with no mode drawn that nobody sent (C-5).
            absent -> Hint("Routing is not on this fleet yet. It may need an update.")
            current == null -> Hint("Loading…")
            else -> {
                // THE MODE, as three choices of the same shape, each with
                // what it does under its name. For an admin each is a radio
                // button; for anybody else the same rows are text, with a
                // word on the one the fleet is set to.
                SectionHead("When a task has no member")
                ROUTING_MODES.forEach { id ->
                    if (isAdmin) {
                        RoutingModeChoice(id, selected = mode == id, modelOn = modelOn, enabled = !busy) { mode = id }
                    } else {
                        RoutingModeFact(id, selected = mode == id, modelOn = modelOn)
                    }
                }
                if (!isAdmin) Hint("An admin sets this. Anybody can read it.")
                current.updatedBy?.let { who ->
                    Text(routingSetLine(who, taskTime(current.updatedAt)), style = Design.Style.micro, color = Design.Palette.inkDim.now)
                }
                Hint(ROUTING_ALWAYS_LINE)

                // THE RULES, every one a row of the same shape: the kind of
                // work, and whom it goes to under it. Remove is an admin's.
                SectionHead("Rules")
                if (rules.isEmpty()) Hint("No rules yet.")
                // BY PLACE, because a draft can hold two rules for one kind
                // of work until the fleet refuses it, and a kind is then no
                // identity.
                rules.forEachIndexed { index, rule ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                            Text(rule.workType, style = Design.Style.body, color = Design.Palette.ink.now)
                            Text(
                                "Goes to ${taskMemberName(rule.member, members) ?: rule.member}",
                                style = Design.Style.label,
                                color = Design.Palette.inkDim.now,
                            )
                        }
                        if (isAdmin) {
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    rules = rules.filterIndexed { i, _ -> i != index }
                                    result = ""
                                },
                                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Remove the rule for ${rule.workType}" },
                            ) { Text("Remove", color = Design.Palette.bad.now) }
                        }
                    }
                }

                // AN ADMIN'S CONTROLS, and nobody else's: adding a rule, and
                // sending the draft.
                if (isAdmin) {
                    SectionHead("Add a rule")
                    OutlinedTextField(
                        value = newKind,
                        onValueChange = { newKind = it.trim().lowercase() },
                        label = { Text("Kind of work") },
                        placeholder = { Text("backend") },
                        singleLine = true,
                        keyboardOptions = plain,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("Goes to", style = Design.Style.label, color = Design.Palette.inkDim.now)
                    members.forEach { member ->
                        RoutingMemberChoice(member.name, role = member.role, selected = newMember == member.id) { newMember = member.id }
                    }
                    Hint("A kind of work is a short word, like backend or review. Each kind goes to one member.")
                    OutlinedButton(
                        enabled = !busy && newKind.isNotBlank() && newMember.isNotEmpty(),
                        // Put on the draft. Whether a kind may have it is
                        // the fleet's to say when the draft is saved.
                        onClick = {
                            rules = rules + Fleet.RoutingRule(newKind.trim().lowercase(), newMember)
                            newKind = ""
                            newMember = ""
                            result = ""
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("Add the rule") }

                    OutlinedButton(
                        enabled = !busy && changed,
                        // The mode and every rule, and then what the fleet
                        // said. Its sentence is the line either way, and a
                        // refusal's is all there is.
                        onClick = {
                            scope.launch {
                                busy = true
                                result = ""
                                Fleet(settings).setRouting(mode, rules)
                                    .onSuccess { r ->
                                        refused = r.ok != true
                                        result = r.text ?: if (r.ok == true) "Saved." else "Your fleet refused that."
                                        val now = r.routing
                                        if (r.ok == true && now != null) {
                                            take(now)
                                            r.model?.let { modelOn = it }
                                        }
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

/**
 * One mode's name, its line, and under "Choose for me" on a fleet with no
 * model on, that a person is asked. SAID, AND STILL A CHOICE: the fleet
 * takes that mode with no model on, and asks a person until there is one.
 */
@Composable
private fun RoutingModeWords(mode: String, modelOn: Boolean, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(routingModeName(mode), style = Design.Style.body, color = Design.Palette.ink.now)
        Text(routingModeLine(mode), style = Design.Style.label, color = Design.Palette.inkDim.now)
        if (mode == "auto" && !modelOn) {
            Text(ROUTING_NO_MODEL_LINE, style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
    }
}

/**
 * One mode as an admin's choice: 48dp tall, its radio button saying which is
 * chosen, and said to TalkBack as one choice of several.
 */
@Composable
private fun RoutingModeChoice(mode: String, selected: Boolean, modelOn: Boolean, enabled: Boolean, onPick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onPick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        RoutingModeWords(mode, modelOn, Modifier.weight(1f))
    }
}

/**
 * One mode as a fact, for somebody who is not an admin: the same words, no
 * control, and "Chosen" in words on the one the fleet is set to. Never the
 * colour alone.
 */
@Composable
private fun RoutingModeFact(mode: String, selected: Boolean, modelOn: Boolean) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        RoutingModeWords(mode, modelOn, Modifier.weight(1f))
        if (selected) Text("Chosen", style = Design.Style.label, color = Design.Palette.ink.now)
    }
}

/**
 * One member a new rule may go to: the name, the role under it, and a radio
 * button on the one chosen, 48dp tall.
 */
@Composable
private fun RoutingMemberChoice(name: String, role: String?, selected: Boolean, onPick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = selected, enabled = true, role = Role.RadioButton, onClick = onPick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(Modifier.weight(1f)) {
            Text(name, style = Design.Style.body, color = Design.Palette.ink.now)
            if (!role.isNullOrBlank()) Text(role, style = Design.Style.label, color = Design.Palette.inkDim.now)
        }
    }
}
