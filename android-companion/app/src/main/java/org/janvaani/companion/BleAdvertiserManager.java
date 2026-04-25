package org.janvaani.companion;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

public class BleAdvertiserManager {
    private static final Pattern VALID_NAME = Pattern.compile("^JV_[A-Z0-9_]{1,21}$");
    private static final int MAX_TTL_MINUTES = 120;

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private AdvertiseCallback advertiseCallback;
    private String currentName;
    private String originalName;
    private long expiresAt;
    private boolean advertising;
    private boolean lastNameChangeSupported = true;
    private String lastError;
    private Runnable expiryRunnable;

    public BleAdvertiserManager(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized JSONObject getStatus() throws JSONException {
        JSONObject status = new JSONObject();
        boolean permissionsGranted = PermissionUtils.hasRequiredBlePermissions(context);

        status.put("running", true);
        status.put("bleSupported", isBleSupported());
        status.put("advertiseSupported", permissionsGranted && isAdvertiseSupported());
        status.put("permissionsGranted", permissionsGranted);
        status.put("bluetoothEnabled", permissionsGranted && isBluetoothEnabled());
        status.put("nameChangeSupported", lastNameChangeSupported);
        status.put("advertising", advertising);
        status.put("currentName", currentName == null ? JSONObject.NULL : currentName);
        status.put("originalName", originalName == null ? JSONObject.NULL : originalName);
        status.put("expiresAt", expiresAt > 0 ? expiresAt : JSONObject.NULL);
        status.put("error", lastError == null ? JSONObject.NULL : lastError);
        return status;
    }

    public synchronized JSONObject startAdvertising(String name, int ttlMinutes) throws JSONException {
        JSONObject response = new JSONObject();
        String normalizedName = name == null ? "" : name.trim().toUpperCase();

        if (!VALID_NAME.matcher(normalizedName).matches()) {
            return fail(response, "INVALID_JV_ALERT_NAME");
        }

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

        if (!isAdvertiseSupported()) {
            return fail(response, "BLE_ADVERTISING_UNSUPPORTED");
        }

        BluetoothLeAdvertiser advertiser = getAdvertiser(adapter);

        if (advertiser == null) {
            return fail(response, "BLE_ADVERTISER_UNAVAILABLE");
        }

        int safeTtl = Math.max(1, Math.min(MAX_TTL_MINUTES, ttlMinutes));
        stopAdvertisingInternal(false);

        try {
            originalName = adapter.getName();
            boolean nameSet = adapter.setName(normalizedName);
            lastNameChangeSupported = nameSet;

            if (!nameSet) {
                restoreOriginalName();
                return fail(response, "ANDROID_BLOCKED_NAME_CHANGE");
            }
        } catch (SecurityException error) {
            lastNameChangeSupported = false;
            restoreOriginalName();
            return fail(response, "BLUETOOTH_PERMISSION_MISSING");
        }

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(false)
                .setTimeout(0)
                .build();
        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .build();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> failure = new AtomicReference<>(null);
        AtomicInteger success = new AtomicInteger(0);

        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                success.set(1);
                latch.countDown();
            }

            @Override
            public void onStartFailure(int errorCode) {
                failure.set(advertiseErrorToString(errorCode));
                latch.countDown();
            }
        };

        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
            boolean completed = latch.await(3, TimeUnit.SECONDS);

            if (!completed || success.get() != 1) {
                stopAdvertiserOnly(advertiser);
                restoreOriginalName();
                return fail(response, failure.get() == null ? "ANDROID_BLOCKED_ADVERTISING" : failure.get());
            }
        } catch (SecurityException error) {
            stopAdvertiserOnly(advertiser);
            restoreOriginalName();
            return fail(response, "BLUETOOTH_PERMISSION_MISSING");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            stopAdvertiserOnly(advertiser);
            restoreOriginalName();
            return fail(response, "ANDROID_ADVERTISING_INTERRUPTED");
        }

        advertising = true;
        currentName = normalizedName;
        expiresAt = System.currentTimeMillis() + safeTtl * 60_000L;
        lastError = null;
        scheduleExpiry();

        response.put("ok", true);
        response.put("advertising", true);
        response.put("name", normalizedName);
        response.put("expiresAt", expiresAt);
        return response;
    }

    public synchronized JSONObject stopAdvertising() throws JSONException {
        boolean restored = stopAdvertisingInternal(true);
        JSONObject response = new JSONObject();
        response.put("ok", true);
        response.put("advertising", false);
        response.put("restoredOriginalName", restored);
        return response;
    }

    private boolean stopAdvertisingInternal(boolean restoreName) {
        BluetoothAdapter adapter = getAdapter();
        BluetoothLeAdvertiser advertiser = adapter == null ? null : getAdvertiser(adapter);

        if (expiryRunnable != null) {
            mainHandler.removeCallbacks(expiryRunnable);
            expiryRunnable = null;
        }

        stopAdvertiserOnly(advertiser);
        advertising = false;
        currentName = null;
        expiresAt = 0L;

        return !restoreName || restoreOriginalName();
    }

    private void stopAdvertiserOnly(BluetoothLeAdvertiser advertiser) {
        if (advertiser == null || advertiseCallback == null) {
            advertiseCallback = null;
            return;
        }

        try {
            advertiser.stopAdvertising(advertiseCallback);
        } catch (SecurityException ignored) {
            lastError = "BLUETOOTH_PERMISSION_MISSING";
        } catch (RuntimeException ignored) {
            lastError = "ANDROID_BLOCKED_ADVERTISING";
        } finally {
            advertiseCallback = null;
        }
    }

    private boolean restoreOriginalName() {
        if (originalName == null) {
            return true;
        }

        BluetoothAdapter adapter = getAdapter();

        if (adapter == null || !isBluetoothEnabled()) {
            return false;
        }

        try {
            return adapter.setName(originalName);
        } catch (SecurityException error) {
            lastError = "BLUETOOTH_PERMISSION_MISSING";
            return false;
        }
    }

    private void scheduleExpiry() {
        expiryRunnable = () -> {
            synchronized (BleAdvertiserManager.this) {
                stopAdvertisingInternal(true);
            }
        };
        mainHandler.postDelayed(expiryRunnable, Math.max(1L, expiresAt - System.currentTimeMillis()));
    }

    private BluetoothAdapter getAdapter() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean isBleSupported() {
        return context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && getAdapter() != null;
    }

    private boolean isAdvertiseSupported() {
        BluetoothAdapter adapter = getAdapter();
        try {
            return adapter != null && adapter.isMultipleAdvertisementSupported();
        } catch (SecurityException error) {
            lastError = "BLUETOOTH_PERMISSION_MISSING";
            return false;
        }
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

    private BluetoothLeAdvertiser getAdvertiser(BluetoothAdapter adapter) {
        try {
            return adapter == null ? null : adapter.getBluetoothLeAdvertiser();
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

    private String advertiseErrorToString(int errorCode) {
        switch (errorCode) {
            case AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE:
                return "BLE_ADVERTISEMENT_TOO_LARGE";
            case AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS:
                return "BLE_TOO_MANY_ADVERTISERS";
            case AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED:
                return "BLE_ADVERTISING_ALREADY_STARTED";
            case AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR:
                return "BLE_ADVERTISING_INTERNAL_ERROR";
            case AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED:
                return "BLE_ADVERTISING_UNSUPPORTED";
            default:
                return "ANDROID_BLOCKED_ADVERTISING";
        }
    }
}
