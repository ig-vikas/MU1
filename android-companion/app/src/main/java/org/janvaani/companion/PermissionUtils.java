package org.janvaani.companion;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

final class PermissionUtils {
    private PermissionUtils() {
    }

    static boolean hasRequiredBlePermissions(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return hasPermission(context, Manifest.permission.BLUETOOTH_ADVERTISE)
                    && hasPermission(context, Manifest.permission.BLUETOOTH_SCAN)
                    && hasPermission(context, Manifest.permission.BLUETOOTH_CONNECT);
        }

        return hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION);
    }

    static boolean hasPermission(Context context, String permission) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }

        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }
}
