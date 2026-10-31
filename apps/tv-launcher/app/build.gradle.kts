plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A versão vem do arquivo VERSION da raiz do repositório (a mesma fonte do web, da API e do agente): o
// release-version já confere esse arquivo e assim o launcher não precisa de uma linha própria lá.
val repoVersion: String = rootProject.file("../../VERSION").readText().trim()
val versionParts = repoVersion.split(".").map { it.toInt() }
require(versionParts.size == 3) { "VERSION deve ser SemVer simples (x.y.z), veio '$repoVersion'" }

// Chave própria opcional. Sem estas quatro propriedades (ou variáveis de ambiente) o release é assinado com a
// chave de depuração do Android da máquina, de propósito: a esteira monta o APK sem ter segredo nenhum.
fun signingValue(name: String): String? =
    (project.findProperty(name) as String?) ?: System.getenv(name)

val customStore = signingValue("UNIOVER_TV_STORE_FILE")

android {
    namespace = "br.uniover.launcher"
    compileSdk = 35

    defaultConfig {
        applicationId = "br.uniover.launcher"
        // Android TV 9 (API 28) é o piso combinado para o módulo. Nada do código exige mais que a API 26;
        // subir ou descer o piso é só mudar esta linha, mas só a API 28 em diante tem o caminho de instalação
        // documentado e ensaiado.
        minSdk = 28
        targetSdk = 35
        versionCode = versionParts[0] * 10_000 + versionParts[1] * 100 + versionParts[2]
        versionName = repoVersion
        manifestPlaceholders["hwAccel"] = (project.findProperty("hwAccel") as String?) ?: "true"
    }

    signingConfigs {
        if (customStore != null) {
            create("project") {
                storeFile = file(customStore)
                storePassword = signingValue("UNIOVER_TV_STORE_PASSWORD")
                keyAlias = signingValue("UNIOVER_TV_KEY_ALIAS")
                keyPassword = signingValue("UNIOVER_TV_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig =
                if (customStore != null) signingConfigs.getByName("project")
                else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Metadados que só servem à loja ficam de fora: menos bytes no APK.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
    packaging {
        // Os .kotlin_builtins só servem à reflexão do Kotlin, que o app não usa.
        resources.excludes += setOf("/META-INF/*.version", "/META-INF/*.kotlin_module", "DebugProbesKt.bin", "/kotlin/**", "/kotlin-tooling-metadata.json")
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                it.systemProperty("contracts.dir", rootProject.file("../../contracts/tv-launcher").absolutePath)
                it.maxHeapSize = "768m"
            }
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    // Sem AndroidX, sem Compose, sem Material: só o framework. É isto que mantém o APK em dezenas de KB e a
    // memória na casa de poucos MB (a TV do dono tem ~48 MB livres).
    testImplementation("junit:junit:4.13.2")
    // O org.json do android.jar é só um esqueleto nos testes de JVM; este é o de verdade.
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.16.1")
}
