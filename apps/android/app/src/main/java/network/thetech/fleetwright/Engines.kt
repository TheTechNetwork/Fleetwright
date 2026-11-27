package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/*
 * Engines: what runs a member, and how a turn ended (docs/engines.md).
 *
 * A member names up to three engines in the order to try them. A session
 * starts on the first one its machine runs, and when a turn ends on that
 * account's limit its machine starts the member's next engine in the same
 * workspace. These are the words for all of it, in one file, because six
 * screens say them: the member's page and its form, a member's Credentials,
 * a session's sheet and its row, a task's page, a machine's page and New
 * session.
 *
 * THE SENTENCES ARE THE FLEET'S OWN. How a turn ended is said here exactly
 * as `turnWords` says it in src/fleet/protocol/engines.js, so a person reads
 * one sentence on the phone, in a notification and in a terminal.
 * test/engines-in-apps.test.js imports that file and compares, and reads iOS
 * (Engines.swift) for the same words.
 *
 * A SESSION THAT NAMES NO ENGINES IS CLAUDE CODE, AS BEFORE, and every
 * function here answers null for it, so nothing new is drawn. Null is never
 * turned into a name.
 */

/**
 * One engine a member names, and the model it is asked for, when one is.
 * Each engine is named once in a list.
 */
data class EngineChoice(val engine: String, val model: String? = null)

/** The engines there are, in the order they were built, as the fleet's own table has them (`ENGINES`). */
val ENGINE_IDS = listOf("claude-code", "codex", "opencode")

/** The engine every machine runs, and the one a member has when it names none. */
const val ENGINE_DEFAULT = "claude-code"

/** How many a member names. One of each is all there are. */
const val ENGINE_LIMIT = 3

/**
 * The vault items an engine other than Claude Code runs on, by the names the
 * vault keeps them under: the two sign-ins, then one API key for each
 * provider below (`ENGINE_ITEM_KINDS` in src/fleet/minter/vault.js).
 */
val ENGINE_VAULT_ITEMS = listOf("codex", "copilot", "apikey:openrouter", "apikey:ai-gateway")

/**
 * A provider an OpenCode model may bill by the token, with an API key kept
 * in the member's vault (docs/api-engines.md). [prefix] is OpenCode's own
 * name for it, which is how a model on it starts; [item] is the vault item
 * its key is kept under.
 */
data class ApiProvider(val id: String, val says: String, val prefix: String, val item: String)

/**
 * The providers there are, as the fleet's own table has them (`API_PROVIDERS`
 * in src/fleet/protocol/engines.js). A model on any other prefix is your
 * fleet's to refuse, in its own sentence.
 */
val API_PROVIDERS = listOf(
    ApiProvider(id = "openrouter", says = "OpenRouter", prefix = "openrouter", item = "apikey:openrouter"),
    ApiProvider(id = "ai-gateway", says = "Vercel AI Gateway", prefix = "vercel", item = "apikey:ai-gateway"),
)

/** The provider a vault item is the API key of, or null for any other item. */
fun apiProviderOfItem(item: String): ApiProvider? = API_PROVIDERS.firstOrNull { it.item == item }

/**
 * The provider an engine bills, or null for one that runs on a sign-in: only
 * OpenCode, and only when its model starts with a provider's prefix
 * (`providerOf`, the same rule).
 */
fun apiProviderOf(choice: EngineChoice): ApiProvider? {
    if (choice.engine != "opencode") return null
    val model = choice.model ?: return null
    val prefix = model.substringBefore("/")
    return API_PROVIDERS.firstOrNull { it.prefix == prefix }
}

/** What a provider is called. One this build has never met is shown as the fleet sent it (C-5). */
fun apiProviderName(id: String): String = API_PROVIDERS.firstOrNull { it.id == id }?.says ?: id

/**
 * The line under an API key's paste field: who bills, where its limit is
 * set, and that no budget here sees it. The one thing to know before a key
 * is kept, said where it is pasted.
 */
fun apiKeyBillingLine(provider: ApiProvider): String =
    "Billed by the token. What it may spend is set at ${provider.says}, and no budget here counts it."

/** What an engine is called. One this build has never met is shown as the fleet sent it (C-5). */
fun engineName(id: String): String = when (id) {
    "claude-code" -> "Claude Code"
    "codex" -> "Codex"
    "opencode" -> "OpenCode"
    else -> id.ifEmpty { "an engine" }
}

/** The vault item an engine runs on, or null for one this build has not met. */
fun engineVaultItem(id: String): String? = when (id) {
    "claude-code" -> "claude"
    "codex" -> "codex"
    "opencode" -> "copilot"
    else -> null
}

/**
 * The vault item one of a member's engines runs on: the key of the provider
 * its model names, or the engine's own sign-in (`credentialOf`, the same
 * rule). An OpenCode on OpenRouter runs on that key and not on a Copilot
 * token, so it is the key's row that is offered for it.
 */
fun engineVaultItemOf(choice: EngineChoice): String? = apiProviderOf(choice)?.item ?: engineVaultItem(choice.engine)

/** A list as it is said: "Claude Code, then Codex (gpt-5.1-codex)". */
fun engineListWords(engines: List<EngineChoice>): String =
    engines.joinToString(", then ") { choice ->
        val model = choice.model.orEmpty()
        if (model.isEmpty()) engineName(choice.engine) else "${engineName(choice.engine)} ($model)"
    }

/**
 * Which of its engines a session is on: "On Codex (2 of 3)". Null when its
 * machine did not say, or named one that is not in the list.
 */
fun engineOnLine(engines: List<EngineChoice>, at: Int?): String? {
    if (at == null) return null
    val choice = engines.getOrNull(at) ?: return null
    val name = engineName(choice.engine)
    return if (engines.size > 1) "On $name (${at + 1} of ${engines.size})" else "On $name"
}

/**
 * How a turn ended, as a sentence, or null for one that simply ended: a turn
 * that finished is the ordinary case and says nothing.
 *
 * `turnWords` in src/fleet/protocol/engines.js, word for word, with one
 * difference: when a limit lifts is said in this phone's own time format.
 * A reason this build has never met is shown as itself.
 */
fun engineTurnWords(engine: String?, reason: String?, detail: String? = null, model: String? = null, resetsAt: Long? = null): String? {
    if (reason.isNullOrEmpty() || reason == "done") return null
    val who = engineName(engine.orEmpty())
    return when (reason) {
        "limit" -> {
            val lifts = taskTime(resetsAt)?.let { " It says the limit lifts at $it." }.orEmpty()
            "$who stopped at its account’s limit.$lifts"
        }
        "auth" -> "$who is not signed in on this machine, or its sign-in has ended."
        "model" -> {
            val said = if (model.isNullOrEmpty()) ", or did not say which it was on" else ": it said $model"
            "$who was not on the model that was asked for$said, so nothing was asked of it."
        }
        "refused" -> "${who}’s provider declined the work."
        "cut" -> "$who ran out of room in its turn."
        "cancelled" -> "${who}’s turn was stopped."
        "error" -> {
            val what = if (detail.isNullOrEmpty()) "" else ": $detail"
            "$who stopped on an error$what."
        }
        else -> "$who stopped: $reason."
    }
}

/**
 * Why one engine gave way to the next, as the words after the colon. The
 * three endings another engine is the answer to, in `turnWords`' own words;
 * anything else is shown as the fleet sent it.
 */
fun engineMoveWhy(reason: String?): String = when (reason) {
    "limit" -> "stopped at its account’s limit"
    "auth" -> "not signed in on this machine, or its sign-in has ended"
    "model" -> "not on the model that was asked for"
    else -> reason.orEmpty()
}

/**
 * One move from an engine to the member's next, as a sentence: "Moved from
 * Claude Code to Codex: stopped at its account’s limit".
 */
fun engineMoveWords(from: String?, to: String?, reason: String?): String {
    val moved = "Moved from ${engineName(from.orEmpty())} to ${engineName(to.orEmpty())}"
    val why = engineMoveWhy(reason)
    return if (why.isEmpty()) moved else "$moved: $why"
}

/**
 * The engines a machine runs, Claude Code first: every machine runs it, and
 * one that names no engines is from before this and runs it alone.
 */
fun machineEngines(reported: List<String>?): List<String> {
    val out = mutableListOf(ENGINE_DEFAULT)
    for (id in reported.orEmpty()) {
        if (id.isNotEmpty() && id !in out) out.add(id)
    }
    return out
}

/**
 * "Runs: Claude Code, Codex", for a machine's page. Null when the machine
 * has reported nothing about itself: that is unknown, and not "Claude Code".
 */
fun machineRunsLine(host: Fleet.FleetHost): String? {
    val reported = host.engines ?: return null
    return "Runs: " + machineEngines(reported).joinToString(", ") { engineName(it) }
}

/**
 * "API keys turned on for: OpenRouter", for a machine's page: the providers
 * its operator turned on, by name (docs/api-engines.md). Null when it names
 * none, and then nothing is drawn: off is what every machine is until its
 * operator says otherwise, and a line saying so would be on every page.
 */
fun machineApiProvidersLine(reported: List<String>?): String? {
    val named = reported.orEmpty().filter { it.isNotEmpty() }
    if (named.isEmpty()) return null
    return "API keys turned on for: " + named.joinToString(", ") { apiProviderName(it) }
}

/**
 * What New session says before a start as a member is sent to a machine
 * that does not run the member's first engine: which engines the session
 * will have there. Null when the first engine runs there, when the member
 * names none, and when the machine has reported nothing to judge by.
 *
 * SAID, NOT ENFORCED. Your fleet cuts the list to what the machine runs and
 * refuses a start with none left, and its sentence is shown after the start.
 */
fun engineStartNote(member: Fleet.Member, host: Fleet.FleetHost): String? {
    val reported = host.engines ?: return null
    val wanted = member.engines
    val first = wanted.firstOrNull() ?: return null
    val runs = machineEngines(reported)
    if (first.engine in runs) return null
    val kept = wanted.filter { it.engine in runs }
    if (kept.isEmpty()) {
        val has = runs.joinToString(", ") { engineName(it) }
        return "${host.hostId} runs $has. ${member.name} has ${engineListWords(wanted)}, so a session there has no engine to run on."
    }
    return "${host.hostId} does not run ${engineName(first.engine)}. A session as ${member.name} there runs on ${engineListWords(kept)}."
}

/**
 * Which of the engine items a vault's screen offers: the ones an engine in
 * this list runs on, and any the vault already keeps, so a kept one can
 * always be forgotten. A Codex row for a member with no Codex engine, or an
 * OpenRouter key's for one with no model on OpenRouter, would be a button
 * for nothing (C-2).
 */
fun engineItemsOffered(engines: List<EngineChoice>, kept: List<String>): List<String> =
    ENGINE_VAULT_ITEMS.filter { item -> item in kept || engines.any { engineVaultItemOf(it) == item } }

/**
 * Which machine holds a kept Codex sign-in. It is given to one machine and
 * no other, so the row says which, or that none has asked for it yet.
 */
fun codexHeldLine(heldBy: String?): String =
    if (heldBy.isNullOrEmpty()) "Not handed to a machine yet" else "Held by $heldBy"

/**
 * A list of engines as the fleet sends one, on a member or on a session:
 * each entry an engine and, when one is named, its model. An entry with no
 * engine is dropped, and never read as Claude Code.
 */
internal fun parseEngineChoices(array: JSONArray?): List<EngineChoice> =
    (0 until (array?.length() ?: 0)).mapNotNull { i ->
        array?.optJSONObject(i)?.let { o ->
            val id = if (o.isNull("engine")) "" else o.optString("engine")
            val model = if (o.isNull("model")) "" else o.optString("model")
            if (id.isBlank()) null else EngineChoice(id, model.takeIf { it.isNotBlank() })
        }
    }

/**
 * The line under OpenCode's model: the three ways one is written, and what
 * each runs on. The model is also who pays, and two of the three bill by the
 * token, so it is said before the member is saved.
 */
const val OPENCODE_MODEL_LINE = "OpenCode needs a model. Written github-copilot/<model>, it runs on the member’s Copilot token. Written openrouter/<model> or vercel/<model>, it runs on an API key and is billed by the token."

/**
 * What a member's engines are sent as. [list] is null when the list cannot
 * be sent as it stands, and then [problem] is the sentence to show.
 */
data class EnginesToSend(val list: JSONArray?, val problem: String?)

/**
 * A member's engines as the fleet takes them: the list in its order, each
 * with its model when one is named. Not sent empty, because a member has at
 * least one engine, and not with an OpenCode that names no model. Every
 * other rule is your fleet's to refuse, a model on a provider it has no row
 * for included.
 */
fun memberEnginesToSend(engines: List<EngineChoice>): EnginesToSend {
    if (engines.isEmpty()) return EnginesToSend(null, "A member has at least one engine.")
    val list = JSONArray()
    for (choice in engines) {
        val model = choice.model.orEmpty().trim()
        if (choice.engine == "opencode" && model.isEmpty()) {
            return EnginesToSend(null, "OpenCode needs a model.")
        }
        val entry = JSONObject().put("engine", choice.engine)
        if (model.isNotEmpty()) entry.put("model", model)
        list.put(entry)
    }
    return EnginesToSend(list, null)
}

/**
 * The engine a session is on, for its sheet: which one, the list in order,
 * each move from one to the next with its time, and how its last turn ended
 * when it did not simply end. Draws nothing for a session whose machine
 * named no engines: that one is Claude Code, as before.
 */
@Composable
internal fun SessionEngineLines(session: Fleet.Session) {
    val list = session.engines?.takeIf { it.isNotEmpty() } ?: return
    Text("Engine", style = Design.Style.section, color = Design.Palette.ink.now)
    engineOnLine(list, session.engineAt)?.let { Text(it, style = Design.Style.body, color = Design.Palette.ink.now) }
    if (list.size > 1) Text(engineListWords(list), style = Design.Style.label, color = Design.Palette.inkDim.now)
    session.engineLog.forEach { move ->
        Column {
            Text(engineMoveWords(move.from, move.to, move.reason), style = Design.Style.label, color = Design.Palette.ink.now)
            taskTime(move.at)?.let { Text(it, style = Design.Style.micro, color = Design.Palette.inkDim.now) }
        }
    }
    session.turn?.let { turn ->
        engineTurnWords(turn.engine, turn.reason, turn.detail, turn.model, turn.resetsAt)?.let { ended ->
            SelectionContainer { Text(ended, style = Design.Style.label, color = Design.Palette.ink.now) }
        }
    }
}

/**
 * One engine's item in a vault: the Codex sign-in, the GitHub Copilot token,
 * or a provider's API key. Whether it is kept and since when, the way to
 * keep or replace it by pasting, and Forget, which asks first on the screen
 * around this.
 *
 * WHAT IS PASTED IS NEVER SHOWN AGAIN. The field is emptied when the vault
 * took it and when this row leaves the screen, it is never saved with the
 * screen's state, and nothing here reads a kept value back: a vault answers
 * with names and never with values.
 *
 * THE CODEX SIGN-IN GOES TO ONE MACHINE, because Codex renews it there and
 * a renewal ends every other copy. So the row says which machine holds it,
 * that pasting it again moves it, and, where it is pasted, that the paste
 * is itself a copy of a file still on somebody's computer.
 *
 * AN API KEY SPENDS MONEY NO BUDGET HERE COUNTS, so where one is pasted the
 * row says who bills and where its limit is set ([apiKeyBillingLine]).
 *
 * PASTING A SIGN-IN IS THE WAY ROUND, NOT THE WAY IN. Codex and Copilot are
 * signed in on a machine ([EngineMachineSignIn], drawn above this row), so
 * the paste field for either is behind a button that says it is the other
 * way, with one sentence for when to use it. An API key has no other way
 * in, and its Keep stays on the row.
 *
 * [name] is "codex", "copilot" or a provider's key, as the vault names it; [item] is the kept
 * one, or null when the vault keeps none. [keep] answers true when the
 * vault took what was pasted.
 */
@Composable
internal fun EngineSignInRow(
    name: String,
    item: PhoneVault.Item?,
    busy: Boolean,
    keep: suspend (String) -> Boolean,
    forget: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var pasting by remember { mutableStateOf(false) }
    // `remember`, never rememberSaveable: a pasted sign-in must not be
    // written into the saved state of a screen.
    var pasted by remember { mutableStateOf("") }
    // LEAVING THE SCREEN EMPTIES THE FIELD, so a sign-in pasted and not sent
    // is not waiting there for the next person to open this page.
    DisposableEffect(Unit) { onDispose { pasted = "" } }
    // Whether the pasted auth.json is shown. Not until Show is pressed.
    var revealed by remember { mutableStateOf(false) }
    val title = PhoneVault.label(name)
    // EVERY FIELD HERE TAKES A CREDENTIAL, so the keyboard is told each is
    // a password: it offers no suggestions and learns nothing typed into
    // one. The masked fields had the default text keyboard, which may do both.
    val secret = KeyboardOptions(keyboardType = KeyboardType.Password, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
    // The provider this row is the key of, or null for one of the sign-ins.
    val provider = apiProviderOfItem(name)
    // Whether this is one of the two sign-ins a machine makes itself, and so
    // one that is pasted only when that cannot be done.
    val madeOnAMachine = EngineSignin.engineOfItem(name) != null

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.hair)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
        ) {
            Text(title, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
            // PASTED, NOT KEPT, FOR A SIGN-IN: the block above this row may
            // say it is signed in on a machine, and "Not kept" under that
            // would read as its opposite. What this row knows is whether
            // one was pasted.
            if (madeOnAMachine) {
                Text(if (item == null) "None pasted" else "Pasted", style = Design.Style.label, color = Design.Palette.inkDim.now)
            } else {
                Text(if (item == null) "Not kept" else "Kept", style = Design.Style.label, color = Design.Palette.inkDim.now)
                TextButton(
                    enabled = !busy,
                    onClick = { pasting = !pasting },
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = if (item == null) "Keep $title" else "Replace $title" },
                ) { Text(if (item == null) "Keep" else "Replace") }
            }
            if (item != null) {
                TextButton(
                    enabled = !busy,
                    onClick = forget,
                    modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Forget $title" },
                ) { Text("Forget") }
            }
        }
        if (item != null) {
            // When it was kept and, for Codex, which machine holds it.
            val sinceAndWhere = listOfNotNull(
                taskTime(item.at)?.let { "Since $it" },
                if (name == "codex") codexHeldLine(item.heldBy) else null,
            ).joinToString(" · ")
            if (sinceAndWhere.isNotEmpty()) Text(sinceAndWhere, style = Design.Style.label, color = Design.Palette.ink.now)
        }
        // ABOUT A PASTED ONE, so said where one is kept or being pasted.
        if (name == "codex" && (item != null || pasting)) Hint("Goes to one machine. Pasting it again moves it.")
        if (madeOnAMachine) {
            // ON A LINE OF ITS OWN, because its words are longer than a row
            // has room for beside a name at a large font scale.
            TextButton(
                enabled = !busy,
                onClick = { pasting = !pasting },
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(enginePasteInstead(name)) }
        }
        if (pasting) {
            val whenToPaste = enginePasteWhen(name)
            if (whenToPaste != null) Hint(whenToPaste)
            if (name == "codex") {
                Text(
                    "Paste the whole of ~/.codex/auth.json, the file codex login leaves.",
                    style = Design.Style.bodySmall,
                    color = Design.Palette.ink.now,
                )
                Text(
                    "What you paste is a copy. Whichever of the two renews first ends the other.",
                    style = Design.Style.bodySmall,
                    color = Design.Palette.ink.now,
                )
                // HIDDEN ONCE IT IS PASTED. The file holds a refresh token,
                // and this field showed all of it, in plain letters, for as
                // long as the page was open. A key and a token beside it
                // were always hidden. So the field is there to paste into,
                // and what was pasted is a count of characters until Show
                // is pressed. The count is how somebody sees the whole file
                // arrived.
                //
                // Many lines when it is shown, because the file is: a
                // one-line field would show its first forty characters and
                // no more.
                if (pasted.isEmpty() || revealed) {
                    OutlinedTextField(
                        value = pasted,
                        // TYPING IS NOT PASTING. The field hid itself at
                        // the first character, so somebody typing lost the
                        // field under their thumb and read "1 characters".
                        // What arrives one character at a time into an
                        // empty field is shown; a paste is hidden.
                        onValueChange = { typed ->
                            if (pasted.isEmpty() && typed.length == 1) revealed = true
                            pasted = typed
                        },
                        label = { Text("auth.json") },
                        minLines = 3,
                        maxLines = 8,
                        textStyle = Design.Style.label.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = secret,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text(pastedHiddenLine(pasted.length), style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                }
                if (pasted.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                        TextButton(
                            onClick = { revealed = !revealed },
                            modifier = Modifier.heightIn(min = 48.dp).semantics {
                                contentDescription = if (revealed) "Hide the pasted file" else "Show the pasted file"
                            },
                        ) { Text(if (revealed) "Hide" else "Show") }
                        TextButton(
                            onClick = {
                                pasted = ""
                                revealed = false
                            },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Clear the pasted file" },
                        ) { Text("Clear") }
                    }
                }
            } else if (provider != null) {
                Text(
                    "Paste one ${provider.says} API key. OpenCode runs on it.",
                    style = Design.Style.bodySmall,
                    color = Design.Palette.ink.now,
                )
                OutlinedTextField(
                    value = pasted,
                    onValueChange = { pasted = it.trim() },
                    label = { Text("${provider.says} API key") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = secret,
                    modifier = Modifier.fillMaxWidth(),
                )
                Hint(apiKeyBillingLine(provider))
            } else {
                Text(
                    "Paste one GitHub Copilot token. OpenCode runs on it.",
                    style = Design.Style.bodySmall,
                    color = Design.Palette.ink.now,
                )
                // WHICH TOKEN. GitHub makes several kinds, and the field
                // said "a Copilot token" without saying that only one of
                // them is one OpenCode can use, or where it is found.
                SelectionContainer {
                    Text(COPILOT_TOKEN_LINE, style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                }
                OutlinedTextField(
                    value = pasted,
                    onValueChange = { pasted = it.trim() },
                    label = { Text("GitHub Copilot token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = secret,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            OutlinedButton(
                enabled = !busy && pasted.isNotBlank(),
                onClick = {
                    scope.launch {
                        // Emptied only once the vault took it: a file it
                        // refused is still there to be looked at and pasted
                        // again whole.
                        if (keep(pasted)) {
                            pasted = ""
                            revealed = false
                            pasting = false
                        }
                    }
                },
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(if (item == null) "Keep it" else "Replace it") }
        }
    }
}

/**
 * The button a sign-in's paste field is behind: the other way in, named as
 * that. The same words as iOS.
 */
fun enginePasteInstead(item: String): String = if (item == "codex") "Paste a sign-in instead" else "Paste a token instead"

/**
 * When to paste a sign-in and not sign in on a machine, in one sentence, or
 * null for an item that is only ever pasted. OpenAI lets an account or a
 * whole workspace turn device codes off, and Codex then says so; for Copilot
 * nothing more is known than that some account may not be able to.
 */
fun enginePasteWhen(item: String): String? = when (item) {
    "codex" -> "Use this when the account cannot sign in on a machine: OpenAI lets an account or its workspace switch device codes off."
    "copilot" -> "Use this when the account cannot sign in on a machine."
    else -> null
}

/**
 * Which GitHub token is a Copilot token OpenCode can use, and where it is
 * (docs/engines.md, "A pasted sign-in, the fallback"): the one OpenCode's
 * own login makes. A personal access token, or one another app made, is
 * kept without complaint and then fails at the first turn.
 */
const val COPILOT_TOKEN_LINE = "It is the refresh value under github-copilot in ~/.local/share/opencode/auth.json, on a computer where opencode auth login signed in to Copilot. No other GitHub token works."

/**
 * What stands in the field's place while a pasted auth.json is hidden. The
 * same sentence as iOS.
 */
fun pastedHiddenLine(count: Int): String = if (count == 1) "Pasted and hidden: 1 character." else "Pasted and hidden: $count characters."

/**
 * A member's engines, on its form: an ordered list to add to, remove from
 * and reorder, with a model under each.
 *
 * MOVE UP AND MOVE DOWN ARE BUTTONS, not a drag alone, so a keyboard and a
 * switch control can reorder the list, and each says what it moves. Remove
 * is not drawn for the last engine, because a member has at least one, and
 * Add offers only an engine the list does not have yet (C-2).
 */
@Composable
internal fun MemberEnginesEditor(engines: List<EngineChoice>, onChange: (List<EngineChoice>) -> Unit) {
    val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
    engines.forEachIndexed { index, choice ->
        // BY THE ENGINE AND NOT BY ITS PLACE. Each engine is named once, so
        // it is the row's identity, and a row keeps its field as it moves.
        key(choice.engine) {
            val name = engineName(choice.engine)
            Text("${index + 1}. $name", style = Design.Style.body, color = Design.Palette.ink.now)
            OutlinedTextField(
                value = choice.model.orEmpty(),
                onValueChange = { now ->
                    val named = now.trim()
                    onChange(engines.mapIndexed { i, e -> if (i == index) e.copy(model = named.ifEmpty { null }) else e })
                },
                label = { Text("Model") },
                // OpenCode's model also says whose account pays, so it is
                // required and the field shows the shape it takes. Which
                // providers there are, and what each runs on, is the line
                // under it.
                placeholder = { Text(if (choice.engine == "opencode") "provider/<model>" else "Optional") },
                singleLine = true,
                keyboardOptions = plain,
                modifier = Modifier.fillMaxWidth(),
            )
            if (choice.engine == "opencode") Hint(OPENCODE_MODEL_LINE)
            if (engines.size > 1) {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                ) {
                    TextButton(
                        enabled = index > 0,
                        onClick = { onChange(engineMoved(engines, index, index - 1)) },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Move $name up" },
                    ) { Text("Up") }
                    TextButton(
                        enabled = index < engines.size - 1,
                        onClick = { onChange(engineMoved(engines, index, index + 1)) },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Move $name down" },
                    ) { Text("Down") }
                    Spacer(Modifier.weight(1f))
                    TextButton(
                        onClick = { onChange(engines.filter { it.engine != choice.engine }) },
                        modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Remove $name" },
                    ) { Text("Remove", color = Design.Palette.bad.now) }
                }
            }
        }
    }
    // The engines the list does not name yet. None at three.
    val addable = if (engines.size >= ENGINE_LIMIT) emptyList() else ENGINE_IDS.filter { id -> engines.none { it.engine == id } }
    addable.forEach { id ->
        OutlinedButton(
            onClick = { onChange(engines + EngineChoice(id)) },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text("Add ${engineName(id)}") }
    }
    Hint("A session starts on the first of these its machine runs, and moves to the next when one stops at its limit.")
}

/** The list with the engine at [from] moved to [to], or the list as it was when either is outside it. */
internal fun engineMoved(engines: List<EngineChoice>, from: Int, to: Int): List<EngineChoice> {
    if (from !in engines.indices || to !in engines.indices) return engines
    val out = engines.toMutableList()
    val moving = out.removeAt(from)
    out.add(to, moving)
    return out
}
