plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "dev.agentfleet.app"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.agentfleet.app"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
  }

  // Only declared when the environment actually has a keystore. A signingConfig
  // pointing at a file that is not there fails the whole configuration phase,
  // which would break the debug build too — and the debug build is the one
  // every contributor runs.
  val keystoreFile = System.getenv("ANDROID_KEYSTORE_FILE")
  if (!keystoreFile.isNullOrBlank()) {
    signingConfigs {
      create("release") {
        storeFile = file(keystoreFile)
        storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
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
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { compose = true }
  // No composeOptions block: the Compose compiler comes from the Kotlin plugin
  // above, at the Kotlin version, so there is nothing to keep in step.
}

dependencies {
  implementation("androidx.core:core-ktx:1.17.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
  implementation("androidx.activity:activity-compose:1.13.0")
  implementation(platform("androidx.compose:compose-bom:2025.08.00"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-core")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

  // Firebase Cloud Messaging is deliberately NOT here yet — it needs a
  // google-services.json from your Firebase project, and the Google Services
  // Gradle plugin FAILS THE BUILD when that file is absent. Adding it now would
  // mean nobody can build the app until Firebase exists. See apps/android/README.md
  // for the four lines that turn it on; the server side is already done.
}
