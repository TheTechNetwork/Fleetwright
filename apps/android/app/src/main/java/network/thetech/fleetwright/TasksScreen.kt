package network.thetech.fleetwright

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Tasks: work that outlives a session (docs/tasks.md).
 *
 * A TASK IS A RECORD ABOVE SESSIONS: a title, a brief, one assignee, a
 * branch, the session that holds its lock, what came back, and every change
 * of hands. This screen is the fleet's list of them for this person, and the
 * fleet decides which those are: the ones they made, and the ones assigned
 * to a member they act for.
 *
 * THE ONES THAT CAME BACK ARE FIRST, because those are asking a question:
 * accept this, or reopen it. Then the ones being worked on, then the open
 * ones. Every row is the same shape, and what state a task is in is said in
 * words on its row; the returned ones also take the attention colour, which
 * the design system keeps for whatever is asking.
 *
 * FINISHED TASKS ARE NOT ASKED FOR UNTIL SOMEBODY OPENS Finished. A fleet
 * keeps 500 tasks with their briefs and results, and a list that opened on
 * all of them would bury the three that need a person under everything
 * already settled. So the screen asks a state at a time, and says "No
 * unfinished tasks" when those three come back empty: it has not asked
 * about the finished ones and makes no claim about them (C-5).
 *
 * The same words as iOS (TasksView.swift), held equal by
 * test/tasks-in-apps.test.js.
 */
@Composable
internal fun TasksScreen(settings: Settings, onDismiss: () -> Unit, onStart: (StartRequest) -> Unit = {}) {
    // Three states, each said: asking (neither set), answered, and failed
    // with the reason. `asked` is bumped by Try again and by every change,
    // which runs the load again.
    var failed by remember { mutableStateOf<String?>(null) }
    var answered by remember { mutableStateOf(false) }
    var asked by remember { mutableIntStateOf(0) }
    // The unfinished tasks, in the order they are drawn: returned, working, open.
    var tasks by remember { mutableStateOf(listOf<Fleet.OrgTask>()) }
    // Everybody, for an assignee's name and for whom a new task may go to.
    // Empty when the fleet did not say, and then a row shows the id.
    var members by remember { mutableStateOf(listOf<Fleet.Member>()) }
    var you by remember { mutableStateOf<Fleet.Standing?>(null) }
    // Done and cancelled, asked for when Finished is opened. Null until they
    // answer, and after a failure, which `finishedFailed` then says.
    var finishedOpen by remember { mutableStateOf(false) }
    var finished by remember { mutableStateOf<List<Fleet.OrgTask>?>(null) }
    var finishedFailed by remember { mutableStateOf<String?>(null) }
    // The task whose page is open, by id, and the one just made, which the
    // list behind its page may not have yet.
    var opened by remember { mutableStateOf<String?>(null) }
    var made by remember { mutableStateOf<Fleet.OrgTask?>(null) }
    var adding by remember { mutableStateOf(false) }

    LaunchedEffect(asked) {
        failed = null
        val fleet = Fleet(settings)
        val unfinished = mutableListOf<Fleet.OrgTask>()
        // RETURNED, THEN WORKING, THEN OPEN: the order they are drawn in. One
        // state that did not answer fails the whole list, because two thirds
        // of a list drawn as the list would hide the tasks that are waiting
        // on somebody (C-5).
        for (state in TASK_UNFINISHED_STATES) {
            val got = fleet.tasks(state).getOrElse {
                failed = it.message ?: "no answer"
                return@LaunchedEffect
            }
            // Only an answer that carries the list is one: a fleet older
            // than tasks answers without it, and that is not "none".
            val list = got.tasks
            if (got.ok == false || list == null) {
                failed = got.text ?: "Your fleet did not send its tasks. It may need an update."
                return@LaunchedEffect
            }
            unfinished += list
        }
        tasks = unfinished
        answered = true
        // NAMES ARE THE ORGANIZATION'S. Without them every row still says
        // whose it is, by id.
        fleet.members().onSuccess { org ->
            if (org.ok != false) {
                members = org.members.orEmpty()
                you = org.you
            }
        }
    }

    LaunchedEffect(finishedOpen, asked) {
        if (!finishedOpen) return@LaunchedEffect
        finishedFailed = null
        val fleet = Fleet(settings)
        val list = mutableListOf<Fleet.OrgTask>()
        for (state in TASK_FINISHED_STATES) {
            val got = fleet.tasks(state).getOrElse {
                finished = null
                finishedFailed = it.message ?: "no answer"
                return@LaunchedEffect
            }
            val part = got.tasks
            if (got.ok == false || part == null) {
                finished = null
                finishedFailed = got.text ?: "Your fleet did not send its tasks. It may need an update."
                return@LaunchedEffect
            }
            list += part
        }
        finished = list
    }

    // THE PAGE OF THE TASK THAT WAS TAPPED, seeded with what the list has,
    // which the page then asks the fleet about itself.
    opened?.let { id ->
        TaskPage(
            settings = settings,
            id = id,
            seed = (tasks + finished.orEmpty()).firstOrNull { it.id == id } ?: made?.takeIf { it.id == id },
            members = members,
            you = you,
            onDismiss = { opened = null },
            onChanged = { asked++ },
            onStart = onStart,
        )
    }
    if (adding) {
        TaskForm(
            settings = settings,
            existing = null,
            members = members,
            you = you,
            onDismiss = { adding = false },
            // THE NEW TASK'S PAGE, in place of the form that made it: closing
            // it is the list, and never a filled form that would make the
            // same task twice.
            onSaved = { reply ->
                adding = false
                made = reply.task
                opened = reply.task?.id
                asked++
            },
        )
    }

    FullScreen(title = "Tasks", onDismiss = onDismiss) {
        val why = failed
        when {
            why != null -> {
                // The result, then the reason smaller under it, as the
                // Organization says it: the reason is there to be copied.
                Hint("Could not load the tasks.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }
            !answered -> Hint("Loading…")
            else -> {
                if (tasks.isEmpty()) Hint("No unfinished tasks. New task makes one.")
                tasks.forEach { task -> TaskRow(task, members) { opened = task.id } }
                OpenRow("New task") { adding = true }

                // DONE AND CANCELLED, behind one row, asked for when it is opened.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable(
                            role = Role.Button,
                            onClickLabel = if (finishedOpen) "Hide finished tasks" else "Show finished tasks",
                        ) { finishedOpen = !finishedOpen },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Finished", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                    Text(if (finishedOpen) "Hide" else "Show", style = Design.Style.label, color = Design.Palette.inkDim.now)
                }
                if (finishedOpen) {
                    val done = finished
                    val finishedWhy = finishedFailed
                    when {
                        finishedWhy != null -> {
                            Hint("Could not load the finished tasks.", color = Design.Palette.bad.now)
                            SelectionContainer { Hint(finishedWhy) }
                            OutlinedButton(onClick = { asked++ }) { Text("Try again") }
                        }
                        done == null -> Hint("Loading…")
                        else -> {
                            if (done.isEmpty()) Hint("No finished tasks.")
                            done.forEach { task -> TaskRow(task, members) { opened = task.id } }
                        }
                    }
                }
            }
        }
    }
}

/**
 * One task in a list: the title, its id and whose it is, and its state in
 * words, with 48dp of target whatever the type size. Every row is this shape
 * whatever the state, so a row that looks different means something: the
 * attention colour is on a task that came back and on nothing else, and the
 * words under it say the same thing to somebody who cannot see the colour.
 */
@Composable
private fun TaskRow(task: Fleet.OrgTask, roster: List<Fleet.Member>, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
    ) {
        Column(Modifier.weight(1f)) {
            Text(task.title ?: task.id, style = Design.Style.body, color = Design.Palette.ink.now)
            Text(taskRowFacts(task, roster), style = Design.Style.label, color = Design.Palette.inkDim.now)
            // A CHANGE OF STATE IS NEWS, and reads as a change: the words
            // crossfade, which is the one movement animations-off keeps.
            AnimatedContent(
                targetState = taskStateWords(task),
                transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
                label = "task state",
            ) { words ->
                Text(
                    words,
                    style = Design.Style.label,
                    color = if (task.state == "returned") Design.Palette.attention.now else Design.Palette.inkDim.now,
                )
            }
        }
        Text("›", style = Design.Style.body, color = Design.Palette.inkDim.now)
    }
}

/**
 * One fact about a task: its name, and the value under it. Stacked and not
 * side by side, so a long name wraps on a narrow screen and never pushes its
 * own label off the row.
 */
@Composable
private fun TaskFact(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = Design.Style.label, color = Design.Palette.inkDim.now)
        Text(value, style = Design.Style.body, color = Design.Palette.ink.now)
    }
}

/**
 * One choice of several: the name, the role under it, and a radio button on
 * the one chosen, 48dp tall and said to TalkBack as a choice of several.
 */
@Composable
private fun TaskChoice(name: String, role: String?, selected: Boolean, onPick: () -> Unit) {
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

/**
 * A field's count, once it is worth saying. Over the limit it takes the
 * error colour, and the line itself says how far over: never the colour alone.
 */
@Composable
private fun TaskCount(line: String?, over: Boolean) {
    if (line != null) {
        Text(line, style = Design.Style.micro, color = if (over) Design.Palette.bad.now else Design.Palette.inkDim.now)
    }
}

/**
 * One task: what it is, where it stands, and what this person may do next.
 *
 * THE PAGE ASKS THE TASK'S OWN ROUTE THE MOMENT IT OPENS, whatever the list
 * handed it, because only that route says whether the task can be started
 * now (`start`) and Start is drawn from that answer and nothing else (C-2).
 * Opened from a session, it has only the id and asks for everything.
 *
 * EVERY ACTION IS DRAWN ONLY WHERE THE FLEET WOULD TAKE IT (docs/tasks.md,
 * the table of changes): Start with something to sign, Reassign on an open
 * task nobody holds, Release with a lock to end, Accept on a task that came
 * back, Reopen on one that came back or is done, Cancel and Edit until it is
 * finished. A refusal is still possible, since somebody else can act first,
 * and then the fleet's own sentence is what the page shows.
 *
 * WHAT A SESSION SAID IS SHOWN AS WHAT A SESSION SAID. The branch is what
 * sessions are told, never a link: nothing checks that it exists. The result
 * is the session's own account, and the page says so under it.
 */
@Composable
internal fun TaskPage(
    settings: Settings,
    id: String,
    /** What the list behind this page has of the task, or null when it was opened with only an id. */
    seed: Fleet.OrgTask? = null,
    members: List<Fleet.Member> = emptyList(),
    you: Fleet.Standing? = null,
    onDismiss: () -> Unit,
    /** Told when the task changed, so the list behind this page asks again. */
    onChanged: () -> Unit = {},
    /** A start on this task, handed to whoever sends starts. */
    onStart: (StartRequest) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val fleet = remember { Fleet(settings) }
    // The task as the fleet last sent it. Null until it answers, when the
    // page was opened with only an id, and after the fleet says there is no
    // such task for this person.
    var task by remember { mutableStateOf(seed) }
    // What to sign to start a session on it, exactly as the fleet sent it.
    // Null when nobody can start it now, and until the fleet has answered.
    var start by remember { mutableStateOf<Map<String, String>?>(null) }
    var loadFailed by remember { mutableStateOf<String?>(null) }
    var roster by remember { mutableStateOf(members) }
    var standing by remember { mutableStateOf(you) }
    // The session that holds the lock, when this phone's own list has it.
    var lockSession by remember { mutableStateOf<Fleet.Session?>(null) }
    var hosts by remember { mutableStateOf(listOf<Fleet.FleetHost>()) }
    var asked by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    // Release and Cancel are each waiting on their question.
    var confirmingRelease by remember { mutableStateOf(false) }
    var confirmingCancel by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var reassigning by remember { mutableStateOf(false) }
    var reopening by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    // The lock's session, opened on its own sheet, and its workspace from there.
    var inspecting by remember { mutableStateOf<Fleet.Session?>(null) }
    var browsing by remember { mutableStateOf<Fleet.Session?>(null) }

    LaunchedEffect(id, asked) {
        val got = fleet.task(id).getOrElse {
            // NOT REACHED. What the list had stays, said as that, and Start
            // goes: it is drawn only from an answer.
            start = null
            loadFailed = it.message ?: "no answer"
            return@LaunchedEffect
        }
        // THE FLEET SAYS THERE IS NO SUCH TASK FOR THIS PERSON, in its own
        // sentence. Whatever the list handed this page is dropped with it: a
        // task somebody may not see is not drawn from memory.
        val now = got.task
        if (got.ok == false || now == null) {
            task = null
            start = null
            loadFailed = got.text ?: "Your fleet did not send this task. It may need an update."
            return@LaunchedEffect
        }
        task = now
        start = got.start
        loadFailed = null
        if (standing == null) {
            fleet.members().onSuccess { org ->
                if (org.ok != false) {
                    roster = org.members.orEmpty()
                    standing = org.you
                }
            }
        }
        // WHETHER THIS PHONE CAN OPEN THE SESSION THAT HOLDS THE LOCK: only
        // if the fleet lists that session, on that machine, for this person.
        val lock = now.lock
        val name = lock?.session
        val found = if (lock == null || name.isNullOrBlank()) {
            null
        } else {
            runCatching { fleet.list() }.getOrNull()?.sessions?.firstOrNull { it.name == name && it.hostId == lock.hostId }
        }
        lockSession = found
        // What the session's sheet reads off its machine: whether Resume is
        // kept from it.
        if (found != null && hosts.isEmpty()) hosts = fleet.fleetHosts()
    }

    /**
     * What the fleet answered a change with. Its sentence is the line on the
     * page either way, and a refusal's is all there is: the page adds nothing
     * of its own to an answer that came.
     */
    fun answered(r: Fleet.TaskReply) {
        failed = r.ok != true
        result = r.text ?: if (r.ok == true) "Saved." else "Your fleet refused that."
        val now = r.task
        if (r.ok == true && now != null) {
            task = now
            start = r.start
            if (now.lock?.session.isNullOrBlank()) lockSession = null
            onChanged()
        }
    }

    /** Release, accept or cancel, and show what the fleet said. */
    fun act(action: String) {
        scope.launch {
            busy = true
            result = ""
            fleet.actOnTask(id, action)
                .onSuccess { answered(it) }
                .onFailure {
                    failed = true
                    result = it.message ?: "that did not work"
                }
            busy = false
        }
    }

    val shown = task
    val signable = start
    if (starting && signable != null) {
        TaskStartPage(
            settings = settings,
            taskId = id,
            start = signable,
            assigneeName = taskMemberName(signable["member"], roster) ?: "its assignee",
            onDismiss = { starting = false },
            // HANDED UP, NOT SENT FROM HERE: a start waits out its machine,
            // and a job scoped to a page that has closed is one that may not
            // finish. Its answer is on Sessions, where a start's always is.
            onStart = { host ->
                starting = false
                onStart(StartRequest(title = null, brief = null, mode = null, host = host, task = signable["task"], onTask = signable))
            },
        )
    }
    if (reassigning && shown != null) {
        TaskReassignPage(
            settings = settings,
            task = shown,
            members = roster,
            you = standing,
            onDismiss = { reassigning = false },
            onDone = {
                reassigning = false
                answered(it)
            },
        )
    }
    if (reopening) {
        TaskReopenPage(
            settings = settings,
            taskId = id,
            onDismiss = { reopening = false },
            onDone = {
                reopening = false
                answered(it)
            },
        )
    }
    if (editing && shown != null) {
        TaskForm(
            settings = settings,
            existing = shown,
            members = roster,
            you = standing,
            onDismiss = { editing = false },
            onSaved = {
                editing = false
                answered(it)
            },
        )
    }
    // RELEASE ASKS FIRST, and says what it does not do: the lock ends, the
    // session carries on until somebody stops it.
    if (confirmingRelease) {
        AlertDialog(
            onDismissRequest = { confirmingRelease = false },
            title = { Text("Release $id?") },
            text = { Text("Ends the lock, so another session can be started on it. This does not stop the session that holds it.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingRelease = false
                    act("release")
                }) { Text("Release") }
            },
            dismissButton = { TextButton(onClick = { confirmingRelease = false }) { Text("Cancel") } },
        )
    }
    // CANCEL ASKS FIRST. Its own dismissal is "Keep it", since a dialog
    // offering Cancel task beside Cancel says nothing.
    if (confirmingCancel) {
        AlertDialog(
            onDismissRequest = { confirmingCancel = false },
            title = { Text("Cancel $id?") },
            text = { Text("Closes the task. A session still working on it is not stopped.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingCancel = false
                    act("cancel")
                }) { Text("Cancel task", color = Design.Palette.bad.now) }
            },
            dismissButton = { TextButton(onClick = { confirmingCancel = false }) { Text("Keep it") } },
        )
    }
    inspecting?.let { session ->
        SessionSheet(
            fleet = fleet,
            initial = session,
            resumeKept = hosts.firstOrNull { it.hostId == session.hostId }?.resumeKept,
            onDismiss = { inspecting = null },
            onChanged = { asked++ },
            onFiles = { browsing = session },
        )
    }
    browsing?.let { session ->
        FilesSheet(
            fleet = fleet,
            session = session.name,
            // The host explicitly: a session lives on ONE box.
            host = session.hostId,
            onDismiss = { browsing = null },
        )
    }

    FullScreen(title = "Task $id", onDismiss = onDismiss) {
        val why = loadFailed
        if (shown == null) {
            if (why != null) {
                Hint("Could not load this task.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            } else {
                Hint("Loading…")
            }
        } else {
            Text(shown.title ?: shown.id, style = Design.Style.title, color = Design.Palette.ink.now)
            // THE STATE, IN WORDS, under the title and before anything else.
            // A change crossfades (animations-off keeps that one).
            AnimatedContent(
                targetState = taskStateWords(shown),
                transitionSpec = { fadeIn(Design.Motion.change()) togetherWith fadeOut(Design.Motion.change()) },
                label = "task state",
            ) { words ->
                Text(
                    words,
                    style = Design.Style.body,
                    color = if (shown.state == "returned") Design.Palette.attention.now else Design.Palette.ink.now,
                )
            }
            TaskFact("Assigned to", taskMemberName(shown.assignee, roster) ?: "Nobody")
            shown.workType?.takeIf { it.isNotBlank() }?.let { TaskFact("Kind of work", it) }
            shown.parent?.takeIf { it.isNotBlank() }?.let { TaskFact("Delegated from", it) }
            // WHAT ITS SESSIONS ARE TOLD, never a link and never a fact: a
            // session's workspace is its own, and nothing looks for the
            // branch (docs/tasks.md, "The branch").
            shown.branch?.takeIf { it.isNotBlank() }?.let { branch ->
                SelectionContainer { Hint(taskBranchLine(branch, shown.repo)) }
            }
            // THE FLEET WAS NOT REACHED JUST NOW, so this is the task as the
            // list last had it, and the page says so instead of passing an
            // old record off as the present one (C-5).
            if (why != null) {
                Hint("Could not reach your fleet. This is the task as the list last had it.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }) { Text("Try again") }
            }

            // THE BRIEF, in a frame of its own that scrolls: 2400 bytes of
            // it would otherwise push the result and every action off the
            // screen.
            shown.brief?.takeIf { it.isNotBlank() }?.let { brief ->
                SectionHead("Brief")
                SelectionContainer {
                    Text(
                        brief,
                        style = Design.Style.label,
                        color = Design.Palette.ink.now,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
                    )
                }
            }

            // THE LOCK: which session holds the task, on which machine,
            // since when and started by whom. A MACHINE THAT IS NOT CONNECTED
            // IS CANNOT TELL, which the page says as "unknown"
            // (docs/design-system.md, Words) and keeps the lock: the fleet
            // does, too, and Release is how a person overrides it. Back at its prompt with no result is said as
            // that, and never as a result.
            shown.lock?.let { lock ->
                SectionHead("Session")
                val name = lock.session
                val session = lockSession
                if (name.isNullOrBlank()) {
                    Text(
                        "A session is starting on ${lock.hostId ?: "a machine"}. The machine has not answered yet.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.ink.now,
                    )
                } else if (session != null) {
                    // THE SESSION'S OWN SHEET, when this phone's list has the
                    // session. The fleet lists a person only what they may
                    // see, so a session it left out is named here and opens
                    // nothing.
                    OpenRow(taskSessionPlace(name, lock.hostId)) { inspecting = session }
                } else {
                    SelectionContainer {
                        Text(taskSessionPlace(name, lock.hostId), style = Design.Style.body, color = Design.Palette.ink.now)
                    }
                }
                taskLockSince(lock)?.let { Hint(it) }
                if (lock.connected == false) {
                    Hint(
                        "${lock.hostId ?: "Its machine"} is not connected, so whether the session is still working is unknown.",
                        color = Design.Palette.attention.now,
                    )
                }
                if (lock.readyAt != null) {
                    Text(
                        "The session is back at its prompt and wrote no result.",
                        style = Design.Style.bodySmall,
                        color = Design.Palette.ink.now,
                    )
                }
            }

            // WHAT CAME BACK, as the session wrote it.
            shown.result?.let { returned ->
                SectionHead("Result")
                Text(taskOutcomeWord(returned.outcome), style = Design.Style.bodyStrong, color = Design.Palette.ink.now)
                SelectionContainer {
                    Text(
                        returned.summary,
                        style = Design.Style.label,
                        color = Design.Palette.ink.now,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                    )
                }
                if (returned.truncated) Hint("Cut at 4000 bytes. The rest is in RESULT.md in the session's workspace.")
                taskResultFrom(returned)?.let { Text(it, style = Design.Style.micro, color = Design.Palette.inkDim.now) }
                Hint("This is the session's own account. Nothing checked it.")
            }

            // In the order it happened: the brief, what came back, and then
            // why that was not the end of it.
            shown.note?.takeIf { it.isNotBlank() }?.let { note ->
                SectionHead("Why it was reopened")
                SelectionContainer { Text(note, style = Design.Style.label, color = Design.Palette.ink.now) }
                Hint("The next session is told this.")
            }

            // START, only with something to sign: the fleet sends `start`
            // when the task is open, assigned and unlocked, and null otherwise.
            start?.let {
                OutlinedButton(onClick = { starting = true }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Start a session")
                }
            }
            // REASSIGN, only on an open task nobody holds: work in flight is
            // released or comes back first.
            if (shown.lock == null && shown.state == "open") {
                OpenRow("Reassign") { reassigning = true }
            }
            // ACCEPT is a person's judgement of a result, so it is offered
            // only where there is one waiting.
            if (shown.state == "returned") {
                OutlinedButton(onClick = { act("accept") }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Accept the result")
                }
            }
            if (shown.state == "returned" || shown.state == "done") {
                OpenRow("Reopen") { reopening = true }
            }
            if (shown.lock != null) {
                OutlinedButton(onClick = { confirmingRelease = true }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Release")
                }
            }
            if (shown.state != "done" && shown.state != "cancelled") {
                OpenRow("Edit") { editing = true }
                TextButton(onClick = { confirmingCancel = true }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Cancel task", color = Design.Palette.bad.now)
                }
            }
            if (result.isNotBlank()) {
                SelectionContainer {
                    Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
                }
            }

            // EVERY CHANGE OF HANDS, oldest first, each a sentence with when
            // and who.
            if (shown.handoffs.isNotEmpty()) {
                SectionHead("History")
                shown.handoffs.forEach { handoff ->
                    Column(Modifier.fillMaxWidth()) {
                        Text(taskHandoffWords(handoff, roster), style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                        Text(taskHandoffWho(handoff), style = Design.Style.micro, color = Design.Palette.inkDim.now)
                    }
                }
            }
        }
    }
}

/**
 * What a session on this task will be told, shown before it is signed.
 *
 * THE WORDS ARE THE FLEET'S AND THE PHONE SIGNS EXACTLY THEM (docs/tasks.md,
 * "Starting on a task"). So they are on the screen first, whole, and the
 * button under them says what pressing it does. Where it runs is a choice
 * beside the start, never part of what is signed, and is asked only when
 * there is more than one machine to choose from.
 */
@Composable
private fun TaskStartPage(
    settings: Settings,
    taskId: String,
    /** `start`'s own parameters, as the fleet sent them. */
    start: Map<String, String>,
    assigneeName: String,
    onDismiss: () -> Unit,
    /** Sends the start: the machine chosen, or null for wherever fits. */
    onStart: (String?) -> Unit,
) {
    var hosts by remember { mutableStateOf(listOf<String>()) }
    var host by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        // Only the machines a start would reach, as New session offers them:
        // none offline, none degraded, never a pool's own machine.
        hosts = Fleet(settings).fleetHosts()
            .filter { !it.holder && (it.takesSessions ?: (it.state == "healthy")) }
            .map { it.hostId }
    }

    FullScreen(title = "Start $taskId", onDismiss = onDismiss) {
        SectionHead("What the session is told")
        SelectionContainer {
            Text(
                start["task"].orEmpty(),
                style = Design.Style.label,
                color = Design.Palette.ink.now,
                modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
            )
        }
        Hint("Your phone signs these words. The session gets them after $assigneeName's instructions.")

        TaskFact("As", assigneeName)
        start["taskBranch"]?.takeIf { it.isNotBlank() }?.let { branch ->
            Hint(taskBranchLine(branch, start["taskRepo"]))
        }
        Hint("Runs on $assigneeName's sign-ins, on a machine its custodians approved.")

        // Only when there is a choice to make. One machine is not a
        // decision, and a picker with one entry is furniture.
        if (hosts.size > 1) {
            Text("Machine", style = Design.Style.label, color = Design.Palette.inkDim.now)
            TaskChoice("Wherever fits", role = null, selected = host.isEmpty()) { host = "" }
            hosts.forEach { h -> TaskChoice(h, role = null, selected = host == h) { host = h } }
        }

        OutlinedButton(
            enabled = settings.configured,
            onClick = { onStart(host.ifBlank { null }) },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text("Sign and start") }
    }
}

/**
 * Hand an open task to somebody else, or to nobody, with a note for the
 * record. A reassignment is a change of hands and the task's history keeps
 * it, with who did it and what they wrote.
 *
 * WHO IS OFFERED IS WHO THE FLEET WILL TAKE from this person (C-2): the
 * members they manage and the ones they may start a session as, and Nobody.
 */
@Composable
private fun TaskReassignPage(
    settings: Settings,
    task: Fleet.OrgTask,
    members: List<Fleet.Member>,
    you: Fleet.Standing?,
    onDismiss: () -> Unit,
    onDone: (Fleet.TaskReply) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var assignee by remember { mutableStateOf(task.assignee.orEmpty()) }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    val noteBytes = taskBytes(note.trim())

    FullScreen(title = "Reassign ${task.id}", onDismiss = onDismiss) {
        SectionHead("Assign to")
        TaskChoice("Nobody", role = null, selected = assignee.isEmpty()) { assignee = "" }
        taskAssignable(members, you).forEach { member ->
            TaskChoice(member.name, role = member.role, selected = assignee == member.id) { assignee = member.id }
        }

        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note") },
            placeholder = { Text("Why, for the task's history") },
            minLines = 2,
            modifier = Modifier.fillMaxWidth(),
        )
        TaskCount(taskCountLine(noteBytes, TASK_NOTE_LIMIT, "bytes"), over = noteBytes > TASK_NOTE_LIMIT)

        OutlinedButton(
            enabled = !busy && assignee != task.assignee.orEmpty() && noteBytes <= TASK_NOTE_LIMIT,
            onClick = {
                scope.launch {
                    busy = true
                    result = ""
                    // An empty assignee is nobody, which the fleet reads as that.
                    val fields = JSONObject().put("assignee", assignee)
                    if (note.isNotBlank()) fields.put("note", note.trim())
                    Fleet(settings).changeTask(task.id, fields)
                        .onSuccess { r ->
                            if (r.ok == true) {
                                onDone(r)
                            } else {
                                result = r.text ?: "Your fleet refused that."
                            }
                        }
                        .onFailure { result = it.message ?: "that did not work" }
                    busy = false
                }
            },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (busy) "Reassigning…" else "Reassign") }
        if (result.isNotBlank()) {
            SelectionContainer { Hint(result, color = Design.Palette.bad.now) }
        }
    }
}

/**
 * Reopen a task that came back or is done, and say why.
 *
 * THE NOTE IS NOT OPTIONAL, because it is not for the record: it is what the
 * next session is told, after the brief. A task reopened without one would
 * send that session back to the same brief with no idea what was wrong the
 * first time. So the button waits for a note, and nothing is sent without
 * one.
 */
@Composable
private fun TaskReopenPage(
    settings: Settings,
    taskId: String,
    onDismiss: () -> Unit,
    onDone: (Fleet.TaskReply) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    val noteBytes = taskBytes(note.trim())

    FullScreen(title = "Reopen $taskId", onDismiss = onDismiss) {
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note") },
            placeholder = { Text("What is wrong, or what is left") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        TaskCount(taskCountLine(noteBytes, TASK_NOTE_LIMIT, "bytes"), over = noteBytes > TASK_NOTE_LIMIT)
        Hint("Say why. The note is what the next session is told.")

        OutlinedButton(
            enabled = !busy && note.isNotBlank() && noteBytes <= TASK_NOTE_LIMIT,
            onClick = {
                val said = note.trim()
                // NEVER WITHOUT A NOTE, whatever called this.
                if (said.isNotEmpty()) {
                    scope.launch {
                        busy = true
                        result = ""
                        Fleet(settings).actOnTask(taskId, "reopen", said)
                            .onSuccess { r ->
                                if (r.ok == true) {
                                    onDone(r)
                                } else {
                                    result = r.text ?: "Your fleet refused that."
                                }
                            }
                            .onFailure { result = it.message ?: "that did not work" }
                        busy = false
                    }
                }
            },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (busy) "Reopening…" else "Reopen") }
        if (result.isNotBlank()) {
            SelectionContainer { Hint(result, color = Design.Palette.bad.now) }
        }
    }
}

/**
 * Make a task, or change what one says.
 *
 * THE BRIEF IS ALL THE SESSION GETS, and it is short on purpose: 2400 bytes,
 * counted as the fleet counts them, in UTF-8. The count is said once it
 * matters, from four fifths of the limit, and Save waits while a field is
 * over: a brief the fleet would refuse is not sent to find that out.
 *
 * WHOSE IT IS, when it is made, is chosen from the members this person may
 * hand work to, or Nobody. After that it changes hands under Reassign, which
 * is refused while a session holds the task, so Edit does not offer it.
 */
@Composable
private fun TaskForm(
    settings: Settings,
    existing: Fleet.OrgTask?,
    members: List<Fleet.Member>,
    you: Fleet.Standing?,
    onDismiss: () -> Unit,
    onSaved: (Fleet.TaskReply) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val creating = existing == null
    var title by remember { mutableStateOf(existing?.title.orEmpty()) }
    var brief by remember { mutableStateOf(existing?.brief.orEmpty()) }
    var assignee by remember { mutableStateOf("") }
    var repo by remember { mutableStateOf(existing?.repo.orEmpty()) }
    var workType by remember { mutableStateOf(existing?.workType.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    // Counted as the fleet counts: a title in characters, a brief in bytes.
    val titleCount = title.trim().length
    val briefBytes = taskBytes(brief.trim())
    val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)

    FullScreen(title = existing?.let { "Edit ${it.id}" } ?: "New task", onDismiss = onDismiss) {
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("Title") },
            placeholder = { Text("One line that says what it is") },
            modifier = Modifier.fillMaxWidth(),
        )
        TaskCount(taskCountLine(titleCount, TASK_TITLE_LIMIT, "characters"), over = titleCount > TASK_TITLE_LIMIT)

        OutlinedTextField(
            value = brief,
            onValueChange = { brief = it },
            label = { Text("Brief") },
            placeholder = { Text("What to do, where, and what to bring back") },
            minLines = 5,
            modifier = Modifier.fillMaxWidth(),
        )
        TaskCount(taskCountLine(briefBytes, TASK_BRIEF_LIMIT, "bytes"), over = briefBytes > TASK_BRIEF_LIMIT)
        Hint("It is all the session gets.")

        if (creating) {
            Text("Assignee", style = Design.Style.label, color = Design.Palette.inkDim.now)
            TaskChoice("Nobody", role = null, selected = assignee.isEmpty()) { assignee = "" }
            taskAssignable(members, you).forEach { member ->
                TaskChoice(member.name, role = member.role, selected = assignee == member.id) { assignee = member.id }
            }
        }

        OutlinedTextField(
            value = repo,
            onValueChange = { repo = it.trim() },
            label = { Text("Repository") },
            placeholder = { Text("owner/repo") },
            singleLine = true,
            keyboardOptions = plain,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = workType,
            onValueChange = { workType = it.trim() },
            label = { Text("Kind of work") },
            placeholder = { Text("Optional") },
            singleLine = true,
            keyboardOptions = plain,
            modifier = Modifier.fillMaxWidth(),
        )
        Hint("Both optional. A kind of work is a short word, like backend or review.")

        OutlinedButton(
            enabled = !busy && title.isNotBlank() && brief.isNotBlank() && titleCount <= TASK_TITLE_LIMIT && briefBytes <= TASK_BRIEF_LIMIT,
            onClick = {
                scope.launch {
                    busy = true
                    result = ""
                    val fields = JSONObject()
                        .put("title", title.trim())
                        .put("brief", brief.trim())
                        // Sent empty as well as filled: on a change, empty is
                        // how a repository or a kind of work is taken off again.
                        .put("repo", repo.trim())
                        .put("workType", workType.trim().lowercase())
                    val fleet = Fleet(settings)
                    val sent = if (existing != null) {
                        fleet.changeTask(existing.id, fields)
                    } else {
                        if (assignee.isNotEmpty()) fields.put("assignee", assignee)
                        fleet.createTask(fields)
                    }
                    sent
                        .onSuccess { r ->
                            if (r.ok == true && r.task != null) {
                                onSaved(r)
                            } else {
                                result = r.text ?: "Your fleet refused that."
                            }
                        }
                        .onFailure { result = it.message ?: "that did not work" }
                    busy = false
                }
            },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(if (busy) "Saving…" else if (creating) "Make the task" else "Save") }
        if (result.isNotBlank()) {
            SelectionContainer { Hint(result, color = Design.Palette.bad.now) }
        }
    }
}

/**
 * The states the Tasks screen opens on, in the order it draws them, and the
 * two it asks for only under Finished.
 */
val TASK_UNFINISHED_STATES = listOf("returned", "working", "open")
val TASK_FINISHED_STATES = listOf("done", "cancelled")

/**
 * What the fleet takes of each field (src/fleet/protocol/tasks.js): a title
 * in characters, a brief and a note in bytes of UTF-8. The same numbers as
 * iOS, held to the fleet's by test/tasks-in-apps.test.js.
 */
const val TASK_TITLE_LIMIT = 120
const val TASK_BRIEF_LIMIT = 2400
const val TASK_NOTE_LIMIT = 300

/** A text's size as the fleet measures a brief and a note: bytes of UTF-8. */
fun taskBytes(text: String): Int = text.toByteArray(Charsets.UTF_8).size

/**
 * The count under a field, or null while there is room to spare: it is said
 * from four fifths of the limit, and past the limit it says by how much.
 */
fun taskCountLine(count: Int, limit: Int, unit: String): String? = when {
    count * 5 < limit * 4 -> null
    count > limit -> "$count of $limit $unit, ${count - limit} too many"
    else -> "$count of $limit $unit"
}

/**
 * A task's state, in words. The same sentences on both phones.
 *
 * AN OUTCOME OR A STATE THIS BUILD HAS NEVER MET IS SHOWN AS ITSELF, and a
 * task that came back with no result attached says only that it came back:
 * nothing is put in the place of an answer the fleet did not send (C-5).
 */
fun taskStateWords(task: Fleet.OrgTask): String = when (task.state) {
    "returned" -> when (val outcome = task.result?.outcome) {
        "done" -> "Came back: done"
        "blocked" -> "Came back: blocked"
        "failed" -> "Came back: failed"
        "unstated" -> "Came back, outcome not stated"
        null -> "Came back"
        else -> "Came back: $outcome"
    }
    "working" -> {
        val session = task.lock?.session
        val host = task.lock?.hostId
        if (session.isNullOrBlank() || host.isNullOrBlank()) "Working" else "Working, $session on $host"
    }
    "open" -> {
        // A start has been sent and its machine has not answered yet.
        val host = task.lock?.hostId
        when {
            !host.isNullOrBlank() -> "Open, a session is starting on $host"
            task.assignee.isNullOrBlank() -> "Open, assigned to nobody"
            else -> "Open"
        }
    }
    "done" -> "Done"
    "cancelled" -> "Cancelled"
    else -> task.state
}

/**
 * What a result's first line said of the work, as a word. The session wrote
 * it; "Outcome not stated" is a first line that began with none of DONE,
 * BLOCKED or FAILED.
 */
fun taskOutcomeWord(outcome: String?): String = when (outcome) {
    "done" -> "Done"
    "blocked" -> "Blocked"
    "failed" -> "Failed"
    "unstated" -> "Outcome not stated"
    null -> "Outcome not sent"
    else -> outcome
}

/**
 * A member's name for an id: the name the organization gives it, the id
 * itself where the list does not have it, and null for nobody. A name is
 * never made up for an id this phone cannot place (C-5).
 */
fun taskMemberName(id: String?, roster: List<Fleet.Member>): String? {
    if (id.isNullOrBlank()) return null
    return roster.firstOrNull { it.id == id }?.name ?: id
}

/** The line under a row's title: the task's id, and whose it is. */
fun taskRowFacts(task: Fleet.OrgTask, roster: List<Fleet.Member>): String {
    val name = taskMemberName(task.assignee, roster) ?: return task.id
    return "${task.id} · $name"
}

/** The branch, said as what its sessions are told. */
fun taskBranchLine(branch: String, repo: String?): String {
    val place = if (repo.isNullOrBlank()) "" else " in $repo"
    return "Sessions are told to work on $branch$place; nothing checks that it exists."
}

/** "cc-x on deb132", or as much of it as there is. */
fun taskSessionPlace(session: String?, host: String?): String = when {
    session.isNullOrBlank() -> host.orEmpty()
    host.isNullOrBlank() -> session
    else -> "$session on $host"
}

/** A time the fleet sent, as a date and a time, or null when it sent none. */
fun taskTime(at: Long?): String? {
    if (at == null || at <= 0) return null
    return java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(at))
}

/** Since when the lock has been held, and who started it. */
fun taskLockSince(lock: Fleet.OrgTask.Lock): String? {
    val by = lock.by.orEmpty()
    val since = taskTime(lock.at) ?: return if (by.isEmpty()) null else "Started by $by."
    return if (by.isEmpty()) "Since $since." else "Since $since, started by $by."
}

/** Which session a result came from, and when. */
fun taskResultFrom(returned: Fleet.OrgTask.Returned): String? {
    val place = taskSessionPlace(returned.session, returned.hostId)
    val at = taskTime(returned.at).orEmpty()
    if (place.isEmpty()) return at.ifEmpty { null }
    return if (at.isEmpty()) "From $place" else "From $place, $at"
}

/**
 * One change of hands as a sentence. Who did it and when are the line under
 * it ([taskHandoffWho]). A kind this build has never met is shown as itself.
 */
fun taskHandoffWords(handoff: Fleet.OrgTask.Handoff, roster: List<Fleet.Member>): String {
    val to = taskMemberName(handoff.to, roster) ?: "nobody"
    val from = taskMemberName(handoff.from, roster) ?: "nobody"
    val said = handoff.note.orEmpty()
    val note = if (said.isEmpty()) "" else ": $said"
    val place = taskSessionPlace(handoff.session, handoff.hostId)
    val fromPlace = if (place.isEmpty()) "" else " from $place"
    return when (handoff.kind) {
        "created" -> {
            val parent = handoff.task.orEmpty()
            "Made, assigned to $to" + if (parent.isEmpty()) "" else ", delegated from $parent"
        }
        "assigned" -> "Reassigned from $from to $to$note"
        "started" -> if (place.isEmpty()) "A session started as $to" else "$place started as $to"
        // The note on a return is the outcome the result's first line gave.
        "returned" -> "Came back$fromPlace" + if (said.isEmpty()) "" else ": " + taskOutcomeWord(said).lowercase()
        "released" -> "Released$fromPlace$note"
        "accepted" -> "Accepted$note"
        "reopened" -> "Reopened$note"
        "cancelled" -> "Cancelled$note"
        "delegated" -> "Delegated ${handoff.task ?: "a task"} to $to"
        else -> handoff.kind ?: "A change with no name"
    }
}

/** When a change of hands happened and who made it. */
fun taskHandoffWho(handoff: Fleet.OrgTask.Handoff): String =
    listOfNotNull(taskTime(handoff.at), handoff.by).filter { it.isNotEmpty() }.joinToString(" · ")

/**
 * Whom this person may hand a task to: the members they manage and the ones
 * they may start a session as, in the organization's order. The fleet
 * refuses anybody else, so nobody else is offered (C-2).
 */
fun taskAssignable(members: List<Fleet.Member>, you: Fleet.Standing?): List<Fleet.Member> {
    val allowed = (you?.manages.orEmpty() + you?.startAs.orEmpty()).toSet()
    return members.filter { it.id in allowed }
}

/**
 * The row under You: how many tasks have come back and are waiting on
 * somebody. Null when none have, and then the row says nothing beside its
 * name: calm recedes.
 */
fun describeTasks(returned: Int): String? = if (returned == 0) null else "$returned came back"
