package expo.modules.t3agentnotifications

import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class EstateUnifiedPushTest {
  private lateinit var context: Application
  private lateinit var manager: NotificationManager
  private val realTransport = EstateUnifiedPush.transport
  @After fun restoreTransport() { EstateUnifiedPush.transport = realTransport }
  @Before fun setup() {
    context = RuntimeEnvironment.getApplication()
    manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)
    context.getSharedPreferences(EstateUnifiedPush.STORE, 0).edit().clear()
      .putBoolean("enabled", true).putString("token", "connection-token")
      .putString("device", "device").putString("scheme", "t3code-sol")
      .putString("preferences", "{\"approval\":true,\"input\":true,\"completed\":true,\"failed\":true}").commit()
    AgentNotifications.clear(context)
    AgentNotifications.setThreadOnScreen(null)
  }
  private fun payload(id: String = "event", age: Long = 0) = JSONObject()
    .put("version", 1).put("app_id", "zone.pharos.t3code").put("device_id", "device")
    .put("event_id", id).put("kind", "failed").put("occurred_at", (System.currentTimeMillis()-age)/1000.0)
    .put("title", "PRIVATE TITLE").put("body", "PRIVATE ERROR").put("route", "/threads/env/thread")
  private fun receive(data: JSONObject, token: String = "connection-token") {
    EstateUnifiedPushReceiver().onReceive(context, Intent(EstateUnifiedPush.MESSAGE)
      .putExtra("token", token).putExtra("bytesMessage", data.toString().toByteArray()))
  }
  @Test fun validPushUsesAppPresentationAndRedactsUntrustedText() {
    receive(payload())
    val notification = manager.activeNotifications.single().notification
    assertEquals("T3 Code (Sol)", notification.extras.getString("android.title"))
    assertEquals("The agent run failed.", notification.extras.getString("android.text"))
  }
  @Test fun rejectsUnknownConnectorToken() { receive(payload(), "wrong"); assertTrue(manager.activeNotifications.isEmpty()) }
  @Test fun rejectsOtherDevice() { receive(payload().put("device_id", "other")); assertTrue(manager.activeNotifications.isEmpty()) }
  @Test fun rejectsOldMessage() { receive(payload(age = 601000)); assertTrue(manager.activeNotifications.isEmpty()) }
  @Test fun rejectsUnknownVersion() { receive(payload().put("version", 2)); assertTrue(manager.activeNotifications.isEmpty()) }
  @Test fun rejectsExternalNavigation() { receive(payload().put("route", "https://evil.example")); assertTrue(manager.activeNotifications.isEmpty()) }
  @Test fun disabledAppIgnoresPush() {
    context.getSharedPreferences(EstateUnifiedPush.STORE, 0).edit().putBoolean("enabled", false).commit()
    receive(payload()); assertTrue(manager.activeNotifications.isEmpty())
  }
  @Test fun eventPreferenceSuppressesPush() {
    context.getSharedPreferences(EstateUnifiedPush.STORE, 0).edit().putString("preferences", "{\"failed\":false}").commit()
    receive(payload()); assertTrue(manager.activeNotifications.isEmpty())
  }
  @Test fun eventDedupeSurvivesNativePresentationReset() {
    receive(payload()); AgentNotifications.clear(context); receive(payload())
    assertTrue(manager.activeNotifications.isEmpty())
  }
  @Test fun endpointRotationPersistedOnlyForMatchingToken() {
    val intent = Intent(EstateUnifiedPush.NEW_ENDPOINT).putExtra("token", "wrong")
      .putExtra("endpoint", "https://ntfy.sol.pharos.zone/up123?up=1")
    EstateUnifiedPushReceiver().onReceive(context, intent)
    assertNull(context.getSharedPreferences(EstateUnifiedPush.STORE, 0).getString("endpoint", null))
    intent.putExtra("token", "connection-token")
    EstateUnifiedPushReceiver().onReceive(context, intent)
    assertEquals("https://ntfy.sol.pharos.zone/up123?up=1", context.getSharedPreferences(EstateUnifiedPush.STORE, 0).getString("endpoint", null))
  }
  @Test fun unsafeEndpointRejected() {
    EstateUnifiedPushReceiver().onReceive(context, Intent(EstateUnifiedPush.NEW_ENDPOINT)
      .putExtra("token", "connection-token").putExtra("endpoint", "https://ntfy.sh/up123?up=1"))
    assertNull(context.getSharedPreferences(EstateUnifiedPush.STORE, 0).getString("endpoint", null))
  }
  @Test fun disableImmediatelyInvalidatesDistributorToken() {
    receive(payload())
    EstateUnifiedPush.disable(context)
    assertFalse(JSONObject(EstateUnifiedPush.state(context)).getBoolean("enabled"))
    assertNull(context.getSharedPreferences(EstateUnifiedPush.STORE, 0).getString("token", null))
    receive(payload("later")); assertTrue(manager.activeNotifications.isEmpty())
  }
  @Test fun missingAndroidPermissionDoesNotClaimShownNotification() {
    shadowOf(manager).setNotificationsEnabled(false)
    receive(payload()); assertTrue(manager.activeNotifications.isEmpty())
    assertFalse(context.getSharedPreferences(EstateUnifiedPush.STORE, 0).getString("seen", "")!!.contains("event"))
  }
  private fun configureReconciliation() {
    val configuration = JSONObject().put("api_base", "https://t3.sol.pharos.zone/estate-push")
      .put("device_id", "device").put("preferences", JSONObject("{\"approval\":true,\"input\":false,\"completed\":true,\"failed\":true}"))
    context.getSharedPreferences(EstateUnifiedPush.STORE, 0).edit()
      .putString("configuration", configuration.toString()).putString("credential", "encrypted-test-value")
      .putString("endpoint", "https://ntfy.sol.pharos.zone/up123?up=1").commit()
  }
  @Test fun registrationRequiresExactReadback() {
    configureReconciliation()
    val methods = mutableListOf<String>()
    EstateUnifiedPush.transport = { _, _, method, body ->
      methods.add(method)
      if (method == "PUT") {
        assertEquals("https://ntfy.sol.pharos.zone/up123?up=1", body!!.getString("endpoint"))
        assertFalse(body.getJSONObject("preferences").getBoolean("input"))
      }
      JSONObject().put("registered", true)
    }
    EstateUnifiedPush.reconcile(context)
    assertEquals(listOf("PUT", "GET"), methods)
    assertEquals("registered", JSONObject(EstateUnifiedPush.state(context)).getString("status"))
  }
  @Test fun unregisteredReadbackCannotReportSuccess() {
    configureReconciliation()
    EstateUnifiedPush.transport = { _, _, _, _ -> JSONObject().put("registered", false) }
    EstateUnifiedPush.reconcile(context)
    assertEquals("failed", JSONObject(EstateUnifiedPush.state(context)).getString("status"))
  }
  @Test fun eventPreferenceRemovalImmediatelySuppressesAnInflightPush() {
    configureReconciliation()
    val p = context.getSharedPreferences(EstateUnifiedPush.STORE, 0)
    val config = JSONObject(p.getString("configuration", null)!!)
    config.getJSONObject("preferences").put("failed", false)
    // configure() updates these atomically; this fixture avoids Android Keystore.
    p.edit().putString("configuration", config.toString())
      .putString("preferences", config.getJSONObject("preferences").toString()).commit()
    receive(payload()); assertTrue(manager.activeNotifications.isEmpty())
  }
}
