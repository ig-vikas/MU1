package org.janvaani.companion;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

public class BleScannerManager {
    private static final Pattern VALID_NAME = Pattern.compile("^JV_[A-Z0-9_]{1,21}$");
    private static final int MAX_DETECTED = 100;

    private final Context context;
    private final LinkedHashMap<String, DetectedAlert> detectedAlerts = new LinkedHashMap<>();

    private ScanCallback scanCallback;
    private boolean scanning;
    private String lastError;
    private long lastDetectedAt;

    public BleScannerManager(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized JSONObject startScan() throws JSONException {
        JSONObject response = new JSONObject();

        if (!PermissionUtils.hasRequiredBlePermissions(context)) {
            return fail(response, "BLUETOOTH_PERMISSION_MISSING");
        }

        BluetoothAdapter adapter = getAdapter();

        if (adapter == null || !isBleSupported()) {
            return fail(response, "BLE_UNSUPPORTED");
        }

        if (!isBluetoothEnabled()) {
            return fail(response, "BLUETOOTH_DISABLED");
        }

        BluetoothLeScanner scanner = getScanner(adapter);

        if (scanner == null) {
            return fail(response, "BLE_SCANNER_UNAVAILABLE");
        }

        if (scanning) {
            response.put("ok", true);
            response.put("scanning", true);
            return response;
        }

        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                handleScanResult(result);
            }

            @Override
            public void onBatchScanResults(java.util.List<ScanResult> results) {
                for (ScanResult result : results) {
                    handleScanResult(result);
                }
            }

            @Override
            public void onScanFailed(int errorCode) {
                synchronized (BleScannerManager.this) {
                    lastError = scanErrorToString(errorCode);
                    scanning = false;
                }
            }
        };

        try {
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
            scanner.startScan(null, settings, scanCallback);
            scanning = true;
            lastError = null;
            response.put("ok", true);
            response.put("scanning", true);
            return response;
        } catch (SecurityException error) {
            scanCallback = null;
            return fail(response, "BLUETOOTH_PERMISSION_MISSING");
        } catch (RuntimeException error) {
            scanCallback = null;
            return fail(response, "ANDROID_BLOCKED_SCANNING");
        }
    }

    public synchronized JSONObject stopScan() throws JSONException {
        BluetoothAdapter adapter = getAdapter();
        BluetoothLeScanner scanner = adapter == null ? null : getScanner(adapter);

        if (scanner != null && scanCallback != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (SecurityException error) {
                lastError = "BLUETOOTH_PERMISSION_MISSING";
            } catch (RuntimeException error) {
                lastError = "ANDROID_BLOCKED_SCANNING";
            }
        }

        scanCallback = null;
        scanning = false;

        JSONObject response = new JSONObject();
        response.put("ok", true);
        response.put("scanning", false);
        return response;
    }

    public synchronized JSONObject getStatus() throws JSONException {
        JSONObject response = new JSONObject();
        response.put("scanning", scanning);
        response.put("detectedCount", detectedAlerts.size());
        response.put("lastDetectedAt", lastDetectedAt > 0 ? lastDetectedAt : JSONObject.NULL);
        response.put("error", lastError == null ? JSONObject.NULL : lastError);
        return response;
    }

    public synchronized JSONObject getAlerts() throws JSONException {
        JSONArray alerts = new JSONArray();

        for (DetectedAlert alert : detectedAlerts.values()) {
            JSONObject item = new JSONObject();
            item.put("name", alert.name);
            item.put("seenAt", alert.seenAt);
            item.put("rssi", alert.rssi);
            alerts.put(item);
        }

        JSONObject response = new JSONObject();
        response.put("alerts", alerts);
        return response;
    }

    public boolean isScanSupported() {
        BluetoothAdapter adapter = getAdapter();
        return PermissionUtils.hasRequiredBlePermissions(context)
                && isBleSupported()
                && adapter != null
                && getScanner(adapter) != null;
    }

    public synchronized boolean isScanning() {
        return scanning;
    }

    private synchronized void handleScanResult(ScanResult result) {
        String name = extractName(result);

        if (name == null) {
            return;
        }

        String normalized = name.trim().toUpperCase();

        if (!VALID_NAME.matcher(normalized).matches()) {
            return;
        }

        long now = System.currentTimeMillis();
        detectedAlerts.put(normalized, new DetectedAlert(normalized, now, result.getRssi()));
        lastDetectedAt = now;

        while (detectedAlerts.size() > MAX_DETECTED) {
            String firstKey = detectedAlerts.keySet().iterator().next();
            detectedAlerts.remove(firstKey);
        }
    }

    private String extractName(ScanResult result) {
        if (result == null) {
            return null;
        }

        if (result.getScanRecord() != null && result.getScanRecord().getDeviceName() != null) {
            return result.getScanRecord().getDeviceName();
        }

        BluetoothDevice device = result.getDevice();

        if (device == null) {
            return null;
        }

        try {
            return device.getName();
        } catch (SecurityException error) {
            lastError = "BLUETOOTH_PERMISSION_MISSING";
            return null;
        }
    }

    private BluetoothAdapter getAdapter() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean isBleSupported() {
        return context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && getAdapter() != null;
    }

    private boolean isBluetoothEnabled() {
        BluetoothAdapter adapter = getAdapter();

        try {
            return adapter != null && adapter.isEnabled();
        } catch (SecurityException error) {
            lastError = "BLUETOOTH_PERMISSION_MISSING";
            return false;
        }
    }

    private BluetoothLeScanner getScanner(BluetoothAdapter adapter) {
        try {
            return adapter == null ? null : adapter.getBluetoothLeScanner();
        } catch (SecurityException error) {
            lastError = "BLUETOOTH_PERMISSION_MISSING";
            return null;
        }
    }

    private JSONObject fail(JSONObject response, String error) throws JSONException {
        lastError = error;
        response.put("ok", false);
        response.put("error", error);
        return response;
    }

    private String scanErrorToString(int errorCode) {
        switch (errorCode) {
            case ScanCallback.SCAN_FAILED_ALREADY_STARTED:
                return "BLE_SCAN_ALREADY_STARTED";
            case ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED:
                return "BLE_SCAN_REGISTRATION_FAILED";
            case ScanCallback.SCAN_FAILED_INTERNAL_ERROR:
                return "BLE_SCAN_INTERNAL_ERROR";
            case ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED:
                return "BLE_SCAN_UNSUPPORTED";
            default:
                return "ANDROID_BLOCKED_SCANNING";
        }
    }

    private static final class DetectedAlert {
        final String name;
        final long seenAt;
        final int rssi;

        DetectedAlert(String name, long seenAt, int rssi) {
            this.name = name;
            this.seenAt = seenAt;
            this.rssi = rssi;
        }
    }
}
