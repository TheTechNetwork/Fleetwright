package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.launch

/**
 * Runners from this phone: the minter key, this phone's GitHub sign-in, and
 * your Claude login for your runners. See PhoneGitHub for how each works and
 * why nothing between here and the minter can read what this sends.
 *
 * In the order a person needs them. The key comes first because the other two
 * seal to it; the GitHub sign-in second because it is what starts a machine and
 * what proves whose Claude login this is; the Claude login last, because it is
 * optional and the runner repository's API key covers anybody who skips it.
 *
 * Every control does something or is not drawn: the sign-in button appears
 * only once a key is saved, the Claude login only once GitHub is signed in.
 * The same sentences as iOS (RunnersFromPhone.swift), which
 * test/runners-from-phone-in-apps.test.js holds them to.
 */
@Composable
internal fun RunnersFromPhone(settings: Settings) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val phone = remember { PhoneGitHub(settings) }
    var pin by remember { mutableStateOf(settings.minterPin) }
    var pinDraft by remember { mutableStateOf(settings.minterPin) }
    var signedInAs by remember { mutableStateOf(phone.signIn?.login) }
    var signedIn by remember { mutableStateOf(phone.signedIn) }
    var claudeDraft by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }

    /** Run one action, showing its sentence either way. */
    fun act(block: suspend () -> Result<String>) {
        scope.launch {
            busy = true
            result = ""
            val r = block()
            failed = r.isFailure
            result = r.getOrElse { it.message ?: "That did not work." }
            busy = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
        Text("Runners from this phone", style = MaterialTheme.typography.titleSmall)
        Text(
            "Sign in to GitHub here and this phone starts your machines itself, with no permanent box. " +
                "The minter key makes sure what this phone sends can be read by your fleet's minter and nothing in between.",
            style = MaterialTheme.typography.bodySmall,
            color = Design.Palette.inkDim.now,
        )

        OutlinedTextField(
            value = pinDraft,
            onValueChange = { pinDraft = it.trim() },
            label = { Text("Minter key from whoever runs your fleet") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
            ),
        )
        OutlinedButton(
            enabled = !busy && pinDraft.isNotBlank() && pinDraft != pin,
            onClick = {
                act {
                    phone.checkPin(Fleet(settings), pinDraft).onSuccess { pin = settings.minterPin }
                }
            },
        ) { Text(if (busy) "Checking…" else "Check and save key") }

        if (pin.isNotBlank()) {
            if (signedIn) {
                Text(
                    signedInAs?.takeIf { it.isNotBlank() }?.let { "Signed in to GitHub as $it." } ?: "Signed in to GitHub.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Design.Palette.ink.now,
                )
                TextButton(
                    enabled = !busy,
                    onClick = {
                        phone.signOut()
                        signedIn = false
                        signedInAs = null
                        result = "Signed out of GitHub on this phone. Machines you start now go through a permanent box."
                        failed = false
                    },
                ) { Text("Sign out of GitHub") }
            } else {
                OutlinedButton(
                    enabled = !busy,
                    onClick = {
                        act {
                            phone.signInWith(context, Fleet(settings)).onSuccess {
                                signedIn = phone.signedIn
                                signedInAs = phone.signIn?.login
                            }
                        }
                    },
                ) { Text("Sign in to GitHub") }
            }
        }

        if (signedIn) {
            Text(
                "Runners you start can use your Claude subscription instead of the runner repository's API key. " +
                    "Make the token on a computer with claude setup-token, and paste it here.",
                style = MaterialTheme.typography.bodySmall,
                color = Design.Palette.inkDim.now,
            )
            OutlinedTextField(
                value = claudeDraft,
                onValueChange = { claudeDraft = it.trim() },
                label = { Text("Token from claude setup-token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Password,
                ),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Design.Space.insideTight)) {
                OutlinedButton(
                    enabled = !busy && claudeDraft.isNotBlank(),
                    onClick = {
                        act {
                            phone.depositClaudeLogin(Fleet(settings), claudeDraft).onSuccess { claudeDraft = "" }
                        }
                    },
                ) { Text("Keep for my runners") }
                TextButton(
                    enabled = !busy,
                    onClick = { act { phone.depositClaudeLogin(Fleet(settings), null) } },
                ) { Text("Forget my Claude login") }
            }
        }

        if (result.isNotBlank()) {
            Text(
                result,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Default,
                color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now,
            )
        }
    }
}
