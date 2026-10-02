package network.thetech.fleetwright

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.launch

/**
 * This phone's own GitHub sign-in, and the minter key it seals to. See
 * PhoneGitHub for how each works and why nothing between here and the minter
 * can read what this sends.
 *
 * ONE PLACE, UNDER YOU › ACCOUNT. It was drawn inside the Hosts section as
 * "Runners from this phone", which hid an account this phone holds behind a
 * heading about machines, and the vault (which knows a person by this same
 * sign-in) one level further down. Two features use it, runners and the vault,
 * and each says so where it is used.
 *
 * In the order a person needs them: the minter's key first, because the
 * sign-in seals to it, and the phone finds it itself at the fleet's address
 * ([PhoneGitHub.minterKey]); the field to paste one is drawn only when nothing
 * answers there. Every control does something or is not drawn.
 *
 * The same sentences as iOS (RunnersFromPhone.swift), which
 * test/runners-from-phone-in-apps.test.js holds them to.
 *
 * @param onChanged told when the sign-in starts or ends, so a screen whose
 *   contents depend on it (Credentials) can redraw.
 */
@Composable
internal fun PhoneGitHubSignIn(settings: Settings, onChanged: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val phone = remember { PhoneGitHub(settings) }
    var pin by remember { mutableStateOf(settings.minterPin) }
    var pinDraft by remember { mutableStateOf(settings.minterPin) }
    // Did the minter answer for its own key? Null while asking: CANNOT TELL
    // yet, which draws neither the sign-in nor the field to paste a key.
    var minterFound by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(settings.coordinatorUrl) { minterFound = Fleet(settings).minterOwnKey() != null }
    val haveKey = pin.isNotBlank() || minterFound == true
    var signedInAs by remember { mutableStateOf(phone.signIn?.login) }
    var signedIn by remember { mutableStateOf(phone.signedIn) }
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
        if (signedIn) {
            Text(
                signedInAs?.takeIf { it.isNotBlank() }?.let { "Signed in to GitHub as $it." } ?: "Signed in to GitHub.",
                style = Design.Style.body,
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
                    onChanged()
                },
            ) { Text("Sign out of GitHub") }
        } else {
            Hint(
                "Sign in to GitHub here and this phone starts your machines itself, with no permanent box. " +
                    "What this phone sends is sealed to your fleet's minter, so nothing in between can read it.",
            )

            if (minterFound == null && pin.isBlank()) {
                Hint("Looking for your fleet's minter…")
            }

            if (minterFound == false) {
                Hint("This fleet's minter does not answer for its own key. Paste the key whoever runs your fleet gave you.")
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
            }

            if (haveKey) {
                OutlinedButton(
                    enabled = !busy,
                    onClick = {
                        act {
                            phone.signInWith(context, Fleet(settings)).onSuccess {
                                signedIn = phone.signedIn
                                signedInAs = phone.signIn?.login
                                onChanged()
                            }
                        }
                    },
                ) { Text("Sign in to GitHub") }
            }
        }

        if (result.isNotBlank()) {
            Hint(result, color = if (failed) Design.Palette.bad.now else Design.Palette.ink.now)
        }
    }
}
