# R8 keep rules.
#
# Almost empty on purpose. Compose, AndroidX and the Kotlin stdlib all ship
# their own consumer rules, so R8 already knows what to keep for them — a keep
# rule copied from a blog post usually just switches off shrinking for a whole
# package and hides the fact that nothing needed it.
#
# This app helps by having nothing R8 traditionally trips over: no reflection,
# no Gson or Moshi (JSON is org.json, read field by field), no dependency
# injection, no dynamically loaded class names. The one thing that could bite
# is the Keystore work in Fleet.kt, which reaches javax.crypto by string name —
# but those are platform classes, not app classes, and R8 does not touch them.

# Crash reports are worth reading. Without this, every frame is a line number
# in a file called SourceFile.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# SSH for a Proxmox node's setup (ProxmoxSsh.kt): sshj and BouncyCastle find
# their ciphers, key exchanges and signatures by name at run time, which R8
# cannot see, so a shrunk release would sign in to nothing.
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.sshj.** { *; }
-keep class org.bouncycastle.** { *; }
-dontwarn org.slf4j.**
-dontwarn javax.naming.**
-dontwarn org.bouncycastle.**
-dontwarn net.schmizz.sshj.**
