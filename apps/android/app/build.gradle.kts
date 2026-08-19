plugins {
  // AGP 9 has built-in Kotlin support — it registers the `kotlin` extension
  // itself, so applying org.jetbrains.kotlin.android on top of it fails with
  // "Cannot add extension with name 'kotlin'". The Compose plugin is still
  // applied separately; it is a compiler plugin rather than language support.
  id("com.android.application")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "network.thetech.fleetwright"
  compileSdk = 37

  defaultConfig {
    applicationId = "network.thetech.fleetwright"
    // One version back, deliberately. This is a first build with no installed
    // base to keep working, and every API level supported below this is a
    // compatibility path somebody has to reason about forever. The cost is
    // real and worth stating: it excludes most phones in the field today.
    minSdk = 36
    targetSdk = 37
    // Play refuses a versionCode it has already seen, so a constant allows
    // exactly one upload ever — the same trap as CURRENT_PROJECT_VERSION on
    // iOS. The CI run number only increases and is already past 99, so it
    // stays ahead of anything uploaded by hand while this was 1.
    versionCode = providers.environmentVariable("ANDROID_VERSION_CODE").orNull?.toInt() ?: 1
    versionName = "0.1.0"
  }

  // Only declared when the environment actually has a keystore. A signingConfig
  // pointing at a file that is not there fails the whole configuration phase,
  // which would break the debug build too — and the debug build is the one
  // every contributor runs.
  //
  // providers.environmentVariable rather than System.getenv, because the
  // configuration cache has to know which variables the configuration phase
  // read in order to know when to throw the cache away. A bare System.getenv
  // is an untracked read: Gradle reports it as a problem and, worse, would
  // happily reuse a cached configuration carrying the previous versionCode or
  // the previous keystore.
  val env = { name: String -> providers.environmentVariable(name).orNull }
  val keystoreFile = env("ANDROID_KEYSTORE_FILE")
  if (!keystoreFile.isNullOrBlank()) {
    signingConfigs {
      create("release") {
        storeFile = file(keystoreFile)
        storePassword = env("ANDROID_KEYSTORE_PASSWORD")
        keyAlias = env("ANDROID_KEY_ALIAS")
        keyPassword = env("ANDROID_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    getByName("debug") {
      isMinifyEnabled = false
      // So a debug build can sit next to a release one on the same phone.
      applicationIdSuffix = ".debug"
    }
    getByName("release") {
      // Left off deliberately. R8 on a Compose app needs keep rules that have
      // to be arrived at by testing what breaks, and shipping a release nobody
      // has exercised is how you find out in the store review queue.
      isMinifyEnabled = false
      if (!keystoreFile.isNullOrBlank()) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
  }
  buildFeatures { compose = true }
  // No composeOptions block: the Compose compiler comes from the Kotlin plugin
  // above, at the Kotlin version, so there is nothing to keep in step.
}

// AGP 9 removed android.kotlinOptions. jvmTarget lives here now, and has to
// agree with compileOptions above or the two toolchains disagree about what
// they are producing.
kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.19.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
  implementation("androidx.activity:activity-compose:1.13.0")
  implementation(platform("androidx.compose:compose-bom:2026.08.00"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-core")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

  // Firebase Cloud Messaging is deliberately NOT here yet — it needs a
  // google-services.json from your Firebase project, and the Google Services
  // Gradle plugin FAILS THE BUILD when that file is absent. Adding it now would
  // mean nobody can build the app until Firebase exists. See apps/android/README.md
  // for the four lines that turn it on; the server side is already done.
}
