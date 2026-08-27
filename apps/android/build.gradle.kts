plugins {
  id("com.android.application") version "9.3.2" apply false
  // From Kotlin 2.0 the Compose compiler ships WITH Kotlin and is applied as a
  // plugin, instead of being pinned separately in composeOptions. That pairing
  // is not a tidy-up: the old arrangement coupled two independently-released
  // versions, and CI broke the first time a bot bumped one of them —
  //
  //   e: This version (1.5.15) of the Compose Compiler requires Kotlin version
  //      1.9.25 but you appear to be using Kotlin version 1.9.24
  //
  // Versioned together, that mismatch cannot be expressed.
  id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
  // Reads google-services.json and generates the Firebase config the SDK looks
  // for at runtime. Applied conditionally in app/build.gradle.kts, not here —
  // see the comment there.
  id("com.google.gms.google-services") version "4.5.0" apply false
}
