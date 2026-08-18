plugins {
  id("com.android.application") version "9.3.1" apply false
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
}
