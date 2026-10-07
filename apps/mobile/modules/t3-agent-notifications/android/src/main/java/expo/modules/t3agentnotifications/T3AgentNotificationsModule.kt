package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    AsyncFunction("configureEstatePush") { configuration: String, credential: String ->
      appContext.reactContext?.let {
        try { EstateUnifiedPush.configure(it, configuration, credential) }
        catch (_: Exception) { EstateUnifiedPush.registrationFailed(it) }
      }
    }

    AsyncFunction("disableEstatePush") {
      appContext.reactContext?.let { EstateUnifiedPush.disable(it) }
    }

    Function("estatePushState") {
      appContext.reactContext?.let { EstateUnifiedPush.state(it) }
    }

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("clear") {
      // A cloud sign-out is not a local Sol-pairing sign-out. Estate opt-out
      // clears presentation explicitly through disableEstatePush instead.
      appContext.reactContext?.let { if (!EstateUnifiedPush.isEnabled(it)) AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
