package org.janvaani.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final int REQUEST_BLE_PERMISSIONS = 7001;
    private TextView statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        requestMissingPermissions();
        startBridgeService();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 32, 32, 32);

        TextView title = new TextView(this);
        title.setText("JanVaani BLE Bridge");
        title.setTextSize(22);
        title.setPadding(0, 0, 0, 16);
        root.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        statusText = new TextView(this);
        statusText.setTextSize(15);
        statusText.setPadding(0, 0, 0, 24);
        root.addView(statusText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        Button permissionsButton = new Button(this);
        permissionsButton.setText("Grant Bluetooth Permissions");
        permissionsButton.setOnClickListener(view -> requestMissingPermissions());
        root.addView(permissionsButton);

        Button startButton = new Button(this);
        startButton.setText("Start Local BLE Bridge");
        startButton.setOnClickListener(view -> {
            requestMissingPermissions();
            startBridgeService();
            updateStatus();
        });
        root.addView(startButton);

        Button stopButton = new Button(this);
        stopButton.setText("Stop Local BLE Bridge");
        stopButton.setOnClickListener(view -> {
            stopService(new Intent(this, ForegroundBleService.class));
            updateStatus();
        });
        root.addView(stopButton);

        setContentView(root);
    }

    private void updateStatus() {
        boolean granted = PermissionUtils.hasRequiredBlePermissions(this);
        statusText.setText(
                "Local API: http://127.0.0.1:8765/status\n" +
                        "Server binds only to 127.0.0.1.\n" +
                        "Permissions granted: " + granted + "\n" +
                        "Keep this app open or running while the PWA advertises/scans."
        );
    }

    private void startBridgeService() {
        Intent intent = new Intent(this, ForegroundBleService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void requestMissingPermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return;
        }

        List<String> permissions = new ArrayList<>();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            addIfMissing(permissions, Manifest.permission.BLUETOOTH_ADVERTISE);
            addIfMissing(permissions, Manifest.permission.BLUETOOTH_SCAN);
            addIfMissing(permissions, Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            addIfMissing(permissions, Manifest.permission.ACCESS_FINE_LOCATION);
        }

        if (Build.VERSION.SDK_INT >= 33) {
            addIfMissing(permissions, Manifest.permission.POST_NOTIFICATIONS);
        }

        if (!permissions.isEmpty()) {
            requestPermissions(permissions.toArray(new String[0]), REQUEST_BLE_PERMISSIONS);
        }
    }

    private void addIfMissing(List<String> permissions, String permission) {
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(permission);
        }
    }
}
