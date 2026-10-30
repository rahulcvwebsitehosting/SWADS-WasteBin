package com.swads.wastebin

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.UUID

object Notifications {
    @Synchronized
    fun installationId(context: Context): String {
        val preferences = context.getSharedPreferences("swads_notifications", Context.MODE_PRIVATE)
        return preferences.getString("installation_id", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("installation_id", it).apply()
        }
    }

    fun saveToken(context: Context, token: String): Task<Void> {
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return Tasks.forResult<Void>(null)
        return FirebaseDatabase.getInstance().getReference("swads/v1/users/$uid/fcmTokens")
            .child(installationId(context)).setValue(token)
    }

    fun syncToken(context: Context): Task<Void> = FirebaseMessaging.getInstance().token.continueWithTask { task ->
        if (!task.isSuccessful) Tasks.forException(task.exception ?: IllegalStateException("Notification token unavailable"))
        else saveToken(context, task.result)
    }

    fun unregister(context: Context, uid: String): Task<Void> = FirebaseDatabase.getInstance()
        .getReference("swads/v1/users/$uid/fcmTokens").child(installationId(context)).removeValue()
}

class SWADSMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Notifications.saveToken(this, token).addOnFailureListener { Log.w("SWADS", "Token sync will retry on next app launch", it) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Data-only FCM keeps this check in force in both foreground and
        // background, including when old tokens remain after an offline logout.
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return
        if (message.data["ownerUid"] != uid) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("swads_alerts", "SWADS alerts", NotificationManager.IMPORTANCE_HIGH))
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "swads_alerts")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(message.data["title"] ?: "SWADS alert")
            .setContentText(message.data["body"] ?: "Open SWADS for details.")
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.data["body"]))
            .setContentIntent(pending).setAutoCancel(true).build()
        manager.notify((message.data["binId"] ?: message.messageId ?: "swads").hashCode(), notification)
    }
}
