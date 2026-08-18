plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.agentfleet.app"
  compileSdk = 34

  defaultConfig {
    applicationId = "dev.agentfleet.app"
    minSdk = 26
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0"
  }

  buildTypes {
    // Debug only for now: a release build wants a signing key, and an unsigned
    // release APK is not installable, which makes it worse than useless for
    // testing.
    getByName("debug") {
      isMinifyEnabled = false
      applicationIdSuffix = ".debug"
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { compose = true }
  composeOptions { kotlinCompilerExtensionVersion = "1.5.15" }
}

dependencies {
  implementation("androidx.core:core-ktx:1.19.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
  implementation("androidx.activity:activity-compose:1.13.0")
  implementation(platform("androidx.compose:compose-bom:2024.06.00"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-core")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

  // Firebase Cloud Messaging is deliberately NOT here yet — it needs a
  // google-services.json from your Firebase project, and the Google Services
  // Gradle plugin FAILS THE BUILD when that file is absent. Adding it now would
  // mean nobody can build the app until Firebase exists. See apps/android/README.md
  // for the four lines that turn it on; the server side is already done.
}
