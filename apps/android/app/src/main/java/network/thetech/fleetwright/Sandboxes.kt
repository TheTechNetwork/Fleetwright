package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/*
 * Machines rented from a sandbox provider (docs/api-engines.md, "A machine
 * from a sandbox provider"): the provider's key and templates in your own
 * vault, and the words every screen says about a machine made there.
 *
 * A THIRD KIND OF PLACE A MACHINE CAN BE MADE, beside the two hypervisors.
 * To the fleet it is one more source of machine images, so making one,
 * ending one and giving one more time are the screens that already exist:
 * New session offers its templates, Hypervisors lists it, and a machine made
 * there has a page. What is new is here: how its key is kept, and the
 * sentences that say a rented machine is not one of yours.
 *
 * NOTHING KEPT IS READ BACK. A vault answers with names and never with
 * values, so there is no editing a kept provider: replacing it is the form
 * again, empty, and the form says so.
 *
 * AND A FOURTH, WHICH IS NOT RENTED AT ALL (docs/api-engines.md, "A machine
 * on a box of your own"): one of your own machines making a machine out of a
 * container of its own. It comes through the same seam, as the same kind of
 * place, image and machine, marked `own`, so the same screens draw it. No
 * key is kept for it and nothing here adds one: its operator turns it on on
 * that machine. Every sentence above that says rented, a cloud or who can
 * read it is false of it, so it has its own, at the foot of [SandboxWords].
 *
 * The same words as iOS (Sandboxes.swift) and the signing page, held equal
 * by test/api-engines-in-apps.test.js.
 */

/** A provider machines can be rented from, as the fleet's own table has it (`SANDBOX_PROVIDER_NAMES` in src/fleet/protocol/sandboxes.js). */
data class SandboxProvider(val id: String, val says: String)

/** The providers there are. One, so the form says it as text and offers no picker of one. */
val SANDBOX_PROVIDERS = listOf(SandboxProvider(id = "e2b", says = "E2B"))

/** How many templates one provider's record offers, and how long a template's name may be, as the vault keeps them. */
const val SANDBOX_TEMPLATE_LIMIT = 12
const val SANDBOX_TEMPLATE_NAME_LIMIT = 60

/**
 * What a template's id may be, as the vault reads one. CHECKED HERE AS WELL,
 * because the vault drops a template whose id it cannot read and keeps the
 * rest without a word: a person would see "Kept" over a list one short.
 */
const val SANDBOX_TEMPLATE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"

/** One template to offer: the provider's own id for it, and what New session calls it. */
data class SandboxTemplate(val id: String, val name: String)

/** Whether this is an id the vault will keep. */
fun isSandboxTemplateId(id: String): Boolean = Regex(SANDBOX_TEMPLATE_ID_PATTERN).matches(id)

/**
 * The provider a vault item is the record of, by name ("E2B"), or null for
 * any other item and for a provider this build has never met.
 */
fun sandboxProviderNameOfItem(item: String): String? {
    if (!item.startsWith("sandbox:")) return null
    val id = item.removePrefix("sandbox:")
    return SANDBOX_PROVIDERS.firstOrNull { it.id == id }?.says
}

/**
 * A provider's record as the vault keeps it: JSON text holding the key and
 * the templates, each an id and a name. Null with no key or no template,
 * which is never sent: a machine is made from a template, so a record with
 * none could make nothing.
 */
fun sandboxRecordText(key: String, templates: List<SandboxTemplate>): String? {
    val secret = key.trim()
    if (secret.isEmpty() || templates.isEmpty()) return null
    val listed = JSONArray()
    for (template in templates) listed.put(JSONObject().put("id", template.id).put("name", template.name))
    return JSONObject().put("key", secret).put("templates", listed).toString()
}

/** The words, in one place because five screens say them. */
object SandboxWords {
    /** What a row on Hypervisors calls it, where a hypervisor says its kind. */
    const val KIND = "Sandbox provider"

    /** The heading over rented machines in the list of machines. */
    const val RENTED_HEADER = "At a sandbox provider"
    const val NEEDS_GITHUB = "Sign in to GitHub under You › Account first. That is how your saved credentials are reached."
    const val NEEDS_TEMPLATE = "Add at least one template. A machine is made from one."
    const val NEEDS_KEY = "Enter the API key."
    const val REPLACE_LINE = "Nothing kept is shown. Enter the key and every template again."
    const val BAD_TEMPLATE_ID = "A template id is letters, digits, dots, dashes and underscores, starting with a letter or a digit, up to 64."
    const val TEMPLATE_TWICE = "That template is already in the list."

    /**
     * What to know before the key is kept, one line each: what the key is,
     * where a machine made with it runs and who can read it, that it ends,
     * what a template has to do, and whose switch it waits on.
     */
    fun before(provider: String): List<String> = listOf(
        "The key is your whole $provider account.",
        "A machine made there is on ${provider}’s cloud, and $provider can read what runs on it.",
        "It ends on a timer.",
        "A template has to be built to join your fleet. One that is not stays up, unused, until its time runs out.",
        "One of your machines makes these, and only after its operator turned $provider on there.",
    )

    fun templatesFooter(provider: String): String =
        "The id is the template’s own, from $provider. The name is what New session calls it. At most $SANDBOX_TEMPLATE_LIMIT."

    /** Under New session › Where, for a template: what kind of machine it is and how it ends. */
    fun rented(provider: String): String =
        "A rented machine on ${provider}’s cloud. It ends when its time runs out, with everything on it."

    /** On a rented machine's own page, under what it is. */
    fun machineFooter(provider: String): String =
        "Rented from $provider, on its cloud. $provider can read what runs on it."

    /**
     * Under More time: the provider counts from now, so a time shorter than
     * what is left ends it sooner, and the page says which it is.
     */
    fun timeFooter(provider: String): String = "The time is counted from now, as $provider counts it."

    /** The row on a machine's own page that opens its page at the provider. */
    fun hostLink(provider: String): String = "At $provider: more time and end"

    /** How many templates a provider offers, for its page. */
    fun templates(count: Int): String = if (count == 1) "1 template" else "$count templates"

    // A BOX OF YOUR OWN (docs/api-engines.md, part three). The place, its
    // image and a machine made there are marked `own` by the fleet, and then
    // `provider` is that machine's name and not a company's. Nothing here
    // says rented, a cloud, a template or who can read it: none is true of a
    // container on a machine you enrolled.

    /** What a row on Hypervisors calls it, where a provider says its kind. */
    const val OWN_KIND = "One of your machines"

    /** The heading over machines made on one, in the list of machines. */
    const val OWN_HEADER = "On one of your machines"

    /** Where the machine's name would go, when the fleet sent none. */
    const val OWN_UNNAMED = "one of your machines"

    /** On a machine's page there: what a container has not got, said once where the controls for them would be on a hypervisor's machine. */
    const val OWN_NEEDS_HYPERVISOR = "A network, a lab, a restart, a resize and a console need a hypervisor."

    /** Under More time: the box adds the minutes to the end it already had, where a provider counts from now. */
    const val OWN_TIME_FOOTER = "The time is added to when it would have ended."

    /** Under New session › Where, for an image there: what kind of machine it is and how it ends. */
    fun ownMachine(box: String): String =
        "A container on $box, one of your own machines. It ends when its time runs out, with everything on it."

    /** On a machine's own page there, under what it is. */
    fun ownMachineFooter(box: String): String = "A container on $box, one of your own machines."

    /** The row on a machine's own page that opens its page on the box. */
    fun ownHostLink(box: String): String = "On $box: more time and end"

    /**
     * On the place's page: whose switch it is, because no screen here turns
     * it on or off. With no name sent, the sentence has no owner to put an
     * apostrophe on, so it starts another way.
     */
    fun ownSwitch(box: String?): String =
        if (box == null) "Its operator turned this on, on that machine, and turns it off there."
        else "${box}’s operator turned this on, on that machine, and turns it off there."
}

/**
 * Add a sandbox provider, or replace or forget the one kept: its API key and
 * the templates to offer, in your own vault as `sandbox:<provider>`. Reached
 * from Hypervisors, which is where the places a machine can be made are
 * listed. iOS's SandboxProviderView, in the same order and the same words.
 *
 * A SHORT FORM, AND WHAT IT COSTS BEFORE THE BUTTON. The key is the whole
 * account at the provider, and a machine made with it is on somebody else's
 * cloud, so the five things to know are said above Keep and not in a hint
 * under it.
 *
 * THE KEY IS TYPED INTO A FIELD THAT HIDES IT, emptied when the vault took
 * it and when this screen is left, and never saved with the screen's state.
 * The templates are not secret and stay until it is kept, so a refusal can
 * be read against them.
 *
 * FIVE STATES: this phone has no GitHub sign-in to reach the vault with, the
 * vault has not answered yet, it did not answer, it keeps none (the form),
 * and it keeps one (its row, with Replace and Forget).
 */
@Composable
internal fun SandboxProviderScreen(settings: Settings, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val vault = remember { PhoneVault(settings) }
    val provider = SANDBOX_PROVIDERS[0]
    val itemName = "sandbox:${provider.id}"
    val title = PhoneVault.label(itemName)
    val signedIn = PhoneGitHub(settings).signedIn
    // When one was kept, or null for none; `answered` is whether the vault
    // has said, since null before it has is unknown.
    var keptAt by remember { mutableStateOf<Long?>(null) }
    var isKept by remember { mutableStateOf(false) }
    var answered by remember { mutableStateOf(false) }
    var loadFailed by remember { mutableStateOf<String?>(null) }
    // `asked` is bumped by Try again, which runs the load again.
    var asked by remember { mutableIntStateOf(0) }
    // Replace was pressed, so the form is drawn under the kept row.
    var replacing by remember { mutableStateOf(false) }
    // `remember`, never rememberSaveable: a typed key must not be written
    // into the saved state of a screen.
    var key by remember { mutableStateOf("") }
    var templates by remember { mutableStateOf(listOf<SandboxTemplate>()) }
    var newId by remember { mutableStateOf("") }
    var newName by remember { mutableStateOf("") }
    var templateProblem by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var forgetting by remember { mutableStateOf(false) }
    val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
    // LEAVING THE SCREEN EMPTIES THE FIELD, so a key typed and not kept is
    // not waiting there for the next person to open this page.
    DisposableEffect(Unit) { onDispose { key = "" } }

    suspend fun load() {
        if (!signedIn) return
        runCatching { vault.list(Fleet(settings)) }
            .onSuccess { contents ->
                val kept = contents.items.firstOrNull { it.name == itemName }
                isKept = kept != null
                keptAt = kept?.at
                loadFailed = null
                answered = true
            }
            // A VAULT THAT DID NOT ANSWER IS NOT ONE THAT KEEPS NONE: the
            // form is not drawn over a provider that may be kept.
            .onFailure { loadFailed = it.message ?: "no answer" }
    }

    LaunchedEffect(asked) { load() }

    if (forgetting) {
        AlertDialog(
            onDismissRequest = { forgetting = false },
            title = { Text("Forget $title?") },
            text = { Text(PhoneVault.forgetting(itemName)) },
            confirmButton = {
                TextButton(onClick = {
                    forgetting = false
                    scope.launch {
                        busy = true
                        message = ""
                        val r = vault.forget(Fleet(settings), itemName)
                        failed = r.isFailure
                        message = r.getOrElse { it.message ?: "That did not work." }
                        if (r.isSuccess) replacing = false
                        load()
                        busy = false
                    }
                }) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { forgetting = false }) { Text("Cancel") } },
        )
    }

    FullScreen(title = SandboxWords.KIND, onDismiss = onDismiss) {
        val why = loadFailed
        when {
            !signedIn -> Hint(SandboxWords.NEEDS_GITHUB)
            why != null -> {
                Hint("Could not load your saved credentials.", color = Design.Palette.bad.now)
                SelectionContainer { Hint(why) }
                OutlinedButton(onClick = { asked++ }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Try again") }
            }
            !answered -> Hint("Asking your vault…")
            else -> {
                // THE KEPT ONE, in the shape every kept item has: its name,
                // that it is kept and since when, and what can be done
                // about it.
                if (isKept) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text(title, style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                        Text("Kept", style = Design.Style.label, color = Design.Palette.inkDim.now)
                        TextButton(
                            enabled = !busy,
                            onClick = { replacing = !replacing },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Replace $title" },
                        ) { Text("Replace") }
                        TextButton(
                            enabled = !busy,
                            onClick = { forgetting = true },
                            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Forget $title" },
                        ) { Text("Forget", color = Design.Palette.bad.now) }
                    }
                    taskTime(keptAt)?.let { Text("Since $it", style = Design.Style.label, color = Design.Palette.ink.now) }
                }
                if (!isKept || replacing) {
                    // WHICH PROVIDER, as text because there is one, and its key.
                    SectionHead(if (isKept) "Replace it" else "Add a sandbox provider")
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {},
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                    ) {
                        Text("Provider", style = Design.Style.body, color = Design.Palette.ink.now, modifier = Modifier.weight(1f))
                        Text(provider.says, style = Design.Style.label, color = Design.Palette.ink.now)
                    }
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it.trim() },
                        label = { Text("${provider.says} API key") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = plain,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (isKept) Hint(SandboxWords.REPLACE_LINE)

                    // THE TEMPLATES TO OFFER, every one a row of the same
                    // shape, and the two fields that add one. Not offered
                    // past the twelve the vault keeps.
                    SectionHead("Templates")
                    if (templates.isEmpty()) Hint("No templates yet.")
                    templates.forEach { template ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(template.name, style = Design.Style.body, color = Design.Palette.ink.now)
                                if (template.name != template.id) {
                                    Text(template.id, style = Design.Style.label, fontFamily = FontFamily.Monospace, color = Design.Palette.inkDim.now)
                                }
                            }
                            TextButton(
                                enabled = !busy,
                                onClick = {
                                    templates = templates.filter { it.id != template.id }
                                    message = ""
                                },
                                modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Remove ${template.name}" },
                            ) { Text("Remove", color = Design.Palette.bad.now) }
                        }
                    }
                    if (templates.size < SANDBOX_TEMPLATE_LIMIT) {
                        OutlinedTextField(
                            value = newId,
                            onValueChange = { newId = it.trim() },
                            label = { Text("Template id") },
                            placeholder = { Text("As ${provider.says} names it") },
                            singleLine = true,
                            keyboardOptions = plain,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = newName,
                            onValueChange = { newName = it },
                            label = { Text("Name") },
                            placeholder = { Text("Optional") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (templateProblem.isNotEmpty()) Hint(templateProblem, color = Design.Palette.bad.now)
                        OutlinedButton(
                            enabled = !busy && newId.isNotBlank(),
                            // Put on the list, once. An id the vault would
                            // drop is refused here, in a sentence, and the
                            // fields are left as typed.
                            onClick = {
                                val id = newId.trim()
                                when {
                                    !isSandboxTemplateId(id) -> templateProblem = SandboxWords.BAD_TEMPLATE_ID
                                    templates.any { it.id == id } -> templateProblem = SandboxWords.TEMPLATE_TWICE
                                    else -> {
                                        // A name the vault would cut is cut
                                        // here, where it can be seen.
                                        val named = newName.trim().take(SANDBOX_TEMPLATE_NAME_LIMIT)
                                        templates = templates + SandboxTemplate(id, named.ifEmpty { id })
                                        newId = ""
                                        newName = ""
                                        templateProblem = ""
                                        message = ""
                                    }
                                }
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text("Add the template") }
                    } else {
                        Hint("That is all $SANDBOX_TEMPLATE_LIMIT. Remove one to add another.")
                    }
                    Hint(SandboxWords.templatesFooter(provider.says))

                    // WHAT IT COSTS, THEN THE BUTTON. Keep is not offered
                    // without a key or without a template, and the line
                    // under it says which is missing.
                    SectionHead("Before you keep it")
                    SandboxWords.before(provider.says).forEach { line ->
                        Text(line, style = Design.Style.bodySmall, color = Design.Palette.ink.now)
                    }
                    OutlinedButton(
                        enabled = !busy && key.isNotBlank() && templates.isNotEmpty(),
                        // The key and every template, then what the vault
                        // said, then the vault as it is now. The key is
                        // emptied only once it was taken.
                        onClick = {
                            scope.launch {
                                busy = true
                                message = ""
                                val r = vault.keepSandbox(Fleet(settings), provider.id, key, templates)
                                failed = r.isFailure
                                message = r.getOrElse { it.message ?: "That did not work." }
                                if (r.isSuccess) {
                                    key = ""
                                    templates = emptyList()
                                    replacing = false
                                    load()
                                }
                                busy = false
                            }
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(if (busy) "Keeping…" else "Keep in your vault") }
                    if (templates.isEmpty()) Hint(SandboxWords.NEEDS_TEMPLATE)
                }
            }
        }
        if (message.isNotBlank()) {
            SelectionContainer { Hint(message, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now) }
        }
    }
}
