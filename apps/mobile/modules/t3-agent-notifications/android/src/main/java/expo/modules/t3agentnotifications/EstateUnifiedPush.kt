package expo.modules.t3agentnotifications

import android.app.BroadcastOptions
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** ntfy 1.25.2's raw-byte UnifiedPush compatibility protocol, not encrypted WebPush. */
class EstateUnifiedPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val prefs = context.getSharedPreferences(EstateUnifiedPush.STORE, Context.MODE_PRIVATE)
    val token = prefs.getString("token", null) ?: return
    if (!prefs.getBoolean("enabled", false) || intent.getStringExtra("token") != token) return
    when (intent.action) {
      EstateUnifiedPush.NEW_ENDPOINT -> {
        val endpoint = intent.getStringExtra("endpoint") ?: return
        if (!EstateUnifiedPush.validEndpoint(endpoint)) {
          prefs.edit().putString("status", "failed").apply(); return
        }
        prefs.edit().putString("endpoint", endpoint).putString("status", "pending").commit()
        // Keep this receiver alive for the bounded PUT + GET reconciliation.
        val pending = goAsync()
        EstateUnifiedPush.sync(context) { pending?.finish() }
      }
      EstateUnifiedPush.MESSAGE -> {
        val message = intent.getByteArrayExtra("bytesMessage") ?: return
        if (message.size !in 1..4096) return
        EstateUnifiedPush.receive(context, message)
      }
      EstateUnifiedPush.UNREGISTERED, EstateUnifiedPush.REGISTRATION_FAILED ->
        prefs.edit().remove("endpoint").putString("status", "failed").apply()
    }
  }
}

object EstateUnifiedPush {
  const val STORE = "estate-unified-push"
  const val NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
  const val MESSAGE = "org.unifiedpush.android.connector.MESSAGE"
  const val UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED"
  const val REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
  private const val REGISTER = "org.unifiedpush.android.distributor.REGISTER"
  private const val UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
  private const val KEY_ALIAS = "estate-push-credential-v1"
  private val executor = Executors.newSingleThreadScheduledExecutor()
  @Volatile private var generation = 0L
  // Internal seam for scoped native registration tests; not exported to JS.
  internal var transport: (JSONObject, String, String, JSONObject?) -> JSONObject = ::request

  fun isEnabled(context: Context): Boolean = prefs(context).getBoolean("enabled", false)
  fun registrationFailed(context: Context): String {
    prefs(context).edit().putString("status", "failed").apply()
    return state(context)
  }

  fun validEndpoint(endpoint: String): Boolean = try {
    val uri = URI(endpoint)
    endpoint.toByteArray().size <= 1000 && uri.scheme == "https" &&
      uri.host == "ntfy.sol.pharos.zone" && uri.port in listOf(-1, 443) &&
      uri.userInfo == null && uri.fragment == null && uri.path.length > 1
  } catch (_: Exception) { false }

  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return (store.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
    ).apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }

  private fun encrypt(value: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
  }

  private fun decrypt(value: String): String {
    val bytes = Base64.decode(value, Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
  }

  fun state(context: Context): String {
    val p = prefs(context)
    return JSONObject().put("enabled", p.getBoolean("enabled", false))
      .put("status", p.getString("status", "disabled"))
      .put("distributor", p.getString("distributor", null))
      .put("pendingRemoval", p.contains("deleteConfig")).toString()
  }

  @Synchronized
  fun configure(context: Context, configuration: String, credential: String): String {
    val config = JSONObject(configuration)
    val base = URI(config.getString("api_base"))
    require(base.scheme == "https" && base.host == "t3.sol.pharos.zone" &&
      base.port in listOf(-1, 443) && base.userInfo == null && base.query == null &&
      base.fragment == null && base.path == "/estate-push")
    require(config.getString("device_id").matches(Regex("[A-Za-z0-9_.:-]{1,128}")))
    require(credential.isNotBlank())
    val p = prefs(context)
    val changed = !p.getBoolean("enabled", false) || p.getString("configuration", null) != configuration
    val token = p.getString("token", null) ?: UUID.randomUUID().toString()
    val distributor = distributors(context).firstOrNull()
    if (distributor == null) {
      p.edit().putString("status", "distributor-missing").apply(); return state(context)
    }
    // Avoid repeatedly replacing the encrypted credential and restarting retries
    // on a settings remount. Foreground still reconciles the paired token.
    generation++
    p.edit().putBoolean("enabled", true).putString("token", token)
      .putString("device", config.getString("device_id")).putString("scheme", config.getString("scheme"))
      .putString("preferences", config.getJSONObject("preferences").toString())
      .putString("configuration", configuration).putString("credential", encrypt(credential))
      .putString("distributor", distributor)
      .apply()
    if (changed) p.edit().putString("status", "pending").apply()
    sync(context)
    val registration = Intent(REGISTER).setPackage(distributor).putExtra("application", context.packageName)
      .putExtra("token", token).putExtra("message", "T3 Code (Sol)")
      .putExtra("pi", PendingIntent.getBroadcast(context, 73003, Intent(context, EstateUnifiedPushReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    if (Build.VERSION.SDK_INT >= 34) {
      context.sendBroadcast(registration, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
    } else context.sendBroadcast(registration)
    return state(context)
  }

  @Suppress("DEPRECATION")
  private fun distributors(context: Context): List<String> = context.packageManager
    .queryBroadcastReceivers(Intent(REGISTER), 0).map { it.activityInfo.packageName }.distinct()
    .filter { it == "io.heckel.ntfy" || it == "io.heckel.ntfy.fdroid" }.sortedBy { it != "io.heckel.ntfy" }

  @Synchronized
  fun disable(context: Context) {
    val p = prefs(context)
    val config = p.getString("configuration", null)
    val credential = p.getString("credential", null)
    generation++
    if (config != null && credential != null) p.edit().putString("deleteConfig", config).putString("deleteCredential", credential).apply()
    p.getString("distributor", null)?.let { distributor ->
      context.sendBroadcast(Intent(UNREGISTER).setPackage(distributor).putExtra("token", p.getString("token", null)))
    }
    p.edit().putBoolean("enabled", false).putString("status", "disabled")
      .remove("token").remove("endpoint").remove("configuration").remove("credential").apply()
    AgentNotifications.clear(context)
    sync(context)
  }

  fun sync(context: Context, finish: (() -> Unit)? = null) {
    val app = context.applicationContext
    executor.execute { try { reconcile(app, generation, 0) } finally { finish?.invoke() } }
  }

  private fun request(config: JSONObject, encryptedCredential: String, method: String, body: JSONObject? = null): JSONObject {
    val device = config.getString("device_id")
    require(device.matches(Regex("[A-Za-z0-9_.:-]{1,128}")))
    val url = URI(config.getString("api_base") + "/v1/apps/zone.pharos.t3code/registrations/" + device).toURL()
    val connection = url.openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 3000; connection.readTimeout = 3000; connection.requestMethod = method
    connection.setRequestProperty("Authorization", "Bearer " + decrypt(encryptedCredential))
    connection.setRequestProperty("Content-Type", "application/json")
    try {
      if (body != null) { connection.doOutput = true; connection.outputStream.use { it.write(body.toString().toByteArray()) } }
      check(connection.responseCode in 200..299)
      return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    } finally { connection.disconnect() }
  }

  internal fun reconcile(context: Context, expected: Long = generation, attempt: Int = 0) {
    val p = prefs(context)
    try {
      p.getString("deleteConfig", null)?.let { config ->
        val credential = p.getString("deleteCredential", null) ?: return@let
        transport(JSONObject(config), credential, "DELETE", null)
        synchronized(this) { if (p.getString("deleteConfig", null) == config) p.edit().remove("deleteConfig").remove("deleteCredential").apply() }
      }
      if (expected != generation || !p.getBoolean("enabled", false)) return
      val endpoint = p.getString("endpoint", null) ?: return
      val config = JSONObject(p.getString("configuration", null) ?: return)
      val credential = p.getString("credential", null) ?: return
      val body = JSONObject().put("app_id", "zone.pharos.t3code").put("device_id", config.getString("device_id"))
        .put("endpoint", endpoint).put("preferences", config.getJSONObject("preferences"))
      transport(config, credential, "PUT", body)
      check(transport(config, credential, "GET", null).optBoolean("registered", false))
      synchronized(this) {
        if (expected == generation && endpoint == p.getString("endpoint", null)) p.edit().putString("status", "registered").apply()
      }
    } catch (_: Exception) {
      synchronized(this) { if (expected == generation && p.getBoolean("enabled", false)) p.edit().putString("status", "failed").apply() }
      if (attempt < 4) executor.schedule({ reconcile(context, expected, attempt+1) }, listOf(5L, 15L, 60L, 300L)[attempt], TimeUnit.SECONDS)
    }
  }

  @Synchronized
  fun receive(context: Context, bytes: ByteArray) {
    try {
      val p = prefs(context)
      val data = JSONObject(String(bytes, Charsets.UTF_8))
      if (!p.getBoolean("enabled", false) || data.optInt("version") != 1 ||
        data.optString("app_id") != "zone.pharos.t3code" || data.optString("device_id") != p.getString("device", null)) return
      val id = data.getString("event_id")
      if (!id.matches(Regex("[A-Za-z0-9_.:-]{1,128}"))) return
      val kind = data.getString("kind")
      val bodies = mapOf("approval" to "An agent needs your approval.", "input" to "An agent needs your input.",
        "completed" to "The agent run completed.", "failed" to "The agent run failed.")
      val body = bodies[kind] ?: return
      if (!JSONObject(p.getString("preferences", "{}")!!).optBoolean(kind, false)) return
      val timestamp = (data.getDouble("occurred_at") * 1000).toLong()
      if (System.currentTimeMillis() - timestamp !in -60000L..600000L) return
      val route = data.getString("route")
      if (route != "/" && !route.matches(Regex("/threads/[A-Za-z0-9_.:%-]+/[A-Za-z0-9_.:%-]+"))) return
      val seen = p.getString("seen", "")!!.split('\n').filter { it.isNotEmpty() }
      if (id in seen) return
      val manager = androidx.core.app.NotificationManagerCompat.from(context)
      if (!manager.areNotificationsEnabled()) return
      val device = p.getString("device", "")!!
      AgentNotifications.configure(context, device, "estate:$device", p.getString("scheme", "t3code-sol")!!, false)
      AgentNotifications.receive(context, mapOf("device_id" to device, "user_id" to "estate:$device",
        "updated_at" to timestamp.toString(), "alert_id" to id, "alert_title" to "T3 Code (Sol)",
        "alert_body" to body, "alert_path" to route, "alert_group" to route))
      p.edit().putString("seen", (seen.takeLast(255) + id).joinToString("\n")).commit()
    } catch (_: Exception) { /* malformed messages never reach notification presentation */ }
  }
}
