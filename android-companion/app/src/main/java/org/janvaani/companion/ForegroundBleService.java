package org.janvaani.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

public class ForegroundBleService extends Service {
    private static final String CHANNEL_ID = "janvaani_ble_bridge";
    private static final int NOTIFICATION_ID = 8765;

    private BleAdvertiserManager advertiserManager;
    private BleScannerManager scannerManager;
    private LocalHttpServer httpServer;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());

        advertiserManager = new BleAdvertiserManager(this);
        scannerManager = new BleScannerManager(this);
        httpServer = new LocalHttpServer(advertiserManager, scannerManager);
        httpServer.startServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (httpServer != null) {
            httpServer.stopServer();
        }

        if (scannerManager != null) {
            scannerManager.stopScan();
        }

        if (advertiserManager != null) {
            advertiserManager.stopAdvertising();
        }

        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("JanVaani BLE Bridge running")
                .setContentText("Localhost bridge active on 127.0.0.1:8765")
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "JanVaani BLE Bridge",
                NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = getSystemService(NotificationManager.class);

        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }
}
