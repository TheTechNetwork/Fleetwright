plugins {
  // AGP 9 has built-in Kotlin support — it registers the `kotlin` extension
  // itself, so applying org.jetbrains.kotlin.android on top of it fails with
  // "Cannot add extension with name 'kotlin'". The Compose plugin is still
  // applied separately; it is a compiler plugin rather than language support.
  id("com.android.application")
  id("org.jetbrains.kotlin.plugin.compose")
}

// Firebase, only when there is a config to read.
//
// The Google Services plugin FAILS THE BUILD when google-services.json is
// absent, which would mean a fork, a fresh clone or anybody without a Firebase
// project could not build the app at all. Conditional application keeps the
// repository buildable by people who are not us, and push simply does nothing
// for them — which is the honest outcome rather than a broken build.
if (file("google-services.json").exists()) {
  apply(plugin = "com.google.gms.google-services")
}

// THE GOOGLE WEB CLIENT ID, READ HERE RATHER THAN LOOKED UP AT RUNTIME.
//
// SignIn.kt used to find it with
//
//     resources.getIdentifier("default_web_client_id", "string", context.packageName)
//
// which is the line every tutorial has and which is WRONG ON ANY BUILD WITH AN
// applicationIdSuffix. Resources are compiled under the `namespace`; the debug
// build's applicationId is namespace + ".debug"; so getIdentifier looked in a
// package that has no resources, returned 0, and the app reported "this build
// has no Google sign-in configured" — naming a Firebase problem that did not
// exist. The release build worked, which is exactly what made it hard to see:
// the failure only appears on the build a tester is handed.
//
// Reading it here removes the lookup. It is the same value the coordinator
// verifies as the token's `aud` (AGENT_FLEET_AUTH_AUDIENCES), so the two halves
// of sign-in come from one file.
val googleWebClientId: String? = run {
  val f = file("google-services.json")
  if (!f.exists()) return@run null
  @Suppress("UNCHECKED_CAST")
  val json = groovy.json.JsonSlurper().parse(f) as Map<String, Any>
  val clients = json["client"] as? List<Map<String, Any>> ?: emptyList()
  clients.asSequence()
    .flatMap { (it["oauth_client"] as? List<Map<String, Any>> ?: emptyList()).asSequence() }
    // client_type 3 is the WEB client. The type 1 entries beside it are the
    // Android clients, which authorise the request and are not what the token
    // is issued for — handing one of those to setServerClientId produces a
    // token the coordinator refuses, with a message about audiences.
    .firstOrNull { (it["client_type"] as? Number)?.toInt() == 3 }
    ?.get("client_id") as? String
}

android {
  namespace = "network.thetech.fleetwright"
  compileSdk = 37

  defaultConfig {
    applicationId = "network.thetech.fleetwright"
    // null, not "", when there is no google-services.json — a fork building
    // without Firebase gets a clear refusal at the button rather than a
    // sign-in attempt with an empty client id.
    buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", googleWebClientId?.let { "\"$it\"" } ?: "null")
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
    versionName = "0.1.1"
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
      // R8, on. The comment here used to say this was left off because Compose
      // needs keep rules arrived at by testing what breaks — which is true of
      // apps that use reflection, and this one does not: no Gson or Moshi, no
      // dependency injection, no class names built from strings. Compose and
      // AndroidX ship their own consumer rules.
      //
      // Play was explicit about the cost of leaving it off: "No R8 metadata
      // included. Use R8 to get the best performance", an optimisation score of
      // Low, and an unshrunk bundle.
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(
        // -optimize, not the plain one. The default android.txt disables the
        // optimisation passes for historical reasons that stopped applying
        // several R8 versions ago.
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
      if (!keystoreFile.isNullOrBlank()) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
  }
  buildFeatures {
    compose = true
    // For GOOGLE_WEB_CLIENT_ID above. Off by default since AGP 8.
    buildConfig = true
  }
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

  // Firebase Cloud Messaging. The BOM pins every Firebase artifact to one
  // release train, which is the only way a set of libraries that ship
  // separately stay compatible.
  implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
  implementation("com.google.firebase:firebase-messaging")
  // Declared even though firebase-messaging pulls it in transitively. The app
  // calls FirebaseInstallations directly now that the FID is the push address,
  // and a direct call on a transitive dependency breaks the day the library
  // that happened to carry it stops.
  implementation("com.google.firebase:firebase-installations")

  // Firebase drags in androidx.fragment 1.1.0 transitively, and lint fails a
  // RELEASE build on it: registerForActivityResult needs 1.3.0 or newer, and
  // below that the callback can be lost when the activity is recreated —
  // which for this app means the notification permission prompt silently
  // never answering.
  //
  // A constraint rather than a dependency: this app uses no fragments at all,
  // so it should raise the floor for whoever does pull it in rather than
  // claiming to depend on it.
  constraints {
    implementation("androidx.fragment:fragment:1.9.0") {
      because("Firebase brings 1.1.0; registerForActivityResult requires >= 1.3.0")
    }
  }
  implementation("androidx.compose.material:material-icons-core")

  // Signing in. The system account picker, not a screen this app draws — there
  // is no password here to phish, and the ID token it returns is verified at
  // the coordinator against Google's published keys.
  //
  // All three are Google-maintained and stable: androidx.credentials is the
  // platform API that replaced GoogleSignInClient, credentials-play-services-auth
  // is the Play Services provider behind it, and googleid is the small shim that
  // turns a returned credential into a typed ID token. They are pinned rather
  // than floated for the same reason `jose` is on the server — see
  // docs/dependencies.md.
  implementation("androidx.credentials:credentials:1.6.0")
  implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
  implementation("com.google.android.libraries.identity.googleid:googleid:1.2.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

  // Custom Tabs: the provider's authorization page, opened inside the app and
  // closing itself when it redirects back. See WebAuth.kt for why this is a
  // real browser rather than a WebView. Pinned, like everything else here.
  implementation("androidx.browser:browser:1.10.0")

  // Firebase Cloud Messaging is deliberately NOT here yet — it needs a
  // google-services.json from your Firebase project, and the Google Services
  // Gradle plugin FAILS THE BUILD when that file is absent. Adding it now would
  // mean nobody can build the app until Firebase exists. See apps/android/README.md
  // for the four lines that turn it on; the server side is already done.
}
