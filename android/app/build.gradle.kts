import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* Release signing: the key lives outside the repository (it must never be committed).
   Its location comes from ~/.ekrani/signing.properties: storeFile, storePassword, keyAlias, keyPassword.
   Every release must be signed with the same key, or Android refuses to install it over the previous one. */
val signingProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".ekrani/signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

/* versionName/versionCode come from android/version.properties (bumped by tools/build-android.js) */
val ver = Properties().apply { rootProject.file("version.properties").inputStream().use { load(it) } }

android {
    namespace = "com.ekrani.iptv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ekrani.iptv"
        minSdk = 21
        targetSdk = 35
        versionCode = ver.getProperty("code").toInt()
        versionName = ver.getProperty("name")
    }

    signingConfigs {
        if (signingProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = File(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // the web app is copied in by tools/build-android.js; keep its files as they are
    androidResources {
        noCompress += listOf("js", "css", "html", "json", "woff2", "png")
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~"
    }
}

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-exoplayer-dash:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("androidx.core:core:1.13.1")
}
