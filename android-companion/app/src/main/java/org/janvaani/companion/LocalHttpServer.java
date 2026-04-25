package org.janvaani.companion;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LocalHttpServer {
    private static final int PORT = 8765;

    private final BleAdvertiserManager advertiserManager;
    private final BleScannerManager scannerManager;
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private volatile boolean running;
    private ServerSocket serverSocket;

    public LocalHttpServer(BleAdvertiserManager advertiserManager, BleScannerManager scannerManager) {
        this.advertiserManager = advertiserManager;
        this.scannerManager = scannerManager;
    }

    public void startServer() {
        if (running) {
            return;
        }

        running = true;
        executor.execute(this::runServer);
    }

    public void stopServer() {
        running = false;

        try {
            if (serverSocket != null) {
                serverSocket.close();
            }
        } catch (IOException ignored) {
        }

        executor.shutdownNow();
    }

    private void runServer() {
        try {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));

            while (running) {
                Socket socket = serverSocket.accept();
                executor.execute(() -> handleSocket(socket));
            }
        } catch (IOException ignored) {
            running = false;
        }
    }

    private void handleSocket(Socket socket) {
        try (Socket closeable = socket;
             BufferedReader reader = new BufferedReader(new InputStreamReader(closeable.getInputStream(), StandardCharsets.UTF_8));
             OutputStream output = closeable.getOutputStream()) {

            Request request = readRequest(reader);

            if (request == null) {
                writeJson(output, 400, error("BAD_REQUEST"));
                return;
            }

            if ("OPTIONS".equals(request.method)) {
                writeOptions(output);
                return;
            }

            JSONObject response;
            try {
                response = route(request);
            } catch (JSONException error) {
                writeJson(output, 400, error("BAD_JSON"));
                return;
            }
            int statusCode = response.optInt("_status", 200);
            response.remove("_status");
            writeJson(output, statusCode, response);
        } catch (Exception ignored) {
        }
    }

    private Request readRequest(BufferedReader reader) throws IOException {
        String requestLine = reader.readLine();

        if (requestLine == null || requestLine.trim().isEmpty()) {
            return null;
        }

        String[] parts = requestLine.split(" ");

        if (parts.length < 2) {
            return null;
        }

        Map<String, String> headers = new HashMap<>();
        String headerLine;

        while ((headerLine = reader.readLine()) != null && !headerLine.isEmpty()) {
            int colon = headerLine.indexOf(':');

            if (colon > 0) {
                headers.put(
                        headerLine.substring(0, colon).trim().toLowerCase(Locale.US),
                        headerLine.substring(colon + 1).trim()
                );
            }
        }

        int contentLength = 0;

        try {
            contentLength = Integer.parseInt(headers.getOrDefault("content-length", "0"));
        } catch (NumberFormatException ignored) {
            contentLength = 0;
        }

        char[] bodyChars = new char[Math.max(0, contentLength)];
        int read = 0;

        while (read < contentLength) {
            int count = reader.read(bodyChars, read, contentLength - read);

            if (count < 0) {
                break;
            }

            read += count;
        }

        return new Request(parts[0].trim().toUpperCase(Locale.US), parts[1].trim(), new String(bodyChars, 0, read));
    }

    private JSONObject route(Request request) throws JSONException {
        String path = request.path.split("\\?", 2)[0];

        if ("GET".equals(request.method) && "/status".equals(path)) {
            JSONObject status = advertiserManager.getStatus();
            status.put("scanSupported", scannerManager.isScanSupported());
            status.put("currentlyScanning", scannerManager.isScanning());
            return status;
        }

        if ("POST".equals(request.method) && "/advertise".equals(path)) {
            JSONObject body = parseBody(request.body);
            return advertiserManager.startAdvertising(
                    body.optString("name", ""),
                    body.optInt("ttlMinutes", 60)
            );
        }

        if ("POST".equals(request.method) && "/stop".equals(path)) {
            return advertiserManager.stopAdvertising();
        }

        if ("POST".equals(request.method) && "/scan/start".equals(path)) {
            return scannerManager.startScan();
        }

        if ("POST".equals(request.method) && "/scan/stop".equals(path)) {
            return scannerManager.stopScan();
        }

        if ("GET".equals(request.method) && "/scan/status".equals(path)) {
            return scannerManager.getStatus();
        }

        if ("GET".equals(request.method) && "/alerts".equals(path)) {
            return scannerManager.getAlerts();
        }

        JSONObject notFound = error("NOT_FOUND");
        notFound.put("_status", 404);
        return notFound;
    }

    private JSONObject parseBody(String body) throws JSONException {
        if (body == null || body.trim().isEmpty()) {
            return new JSONObject();
        }

        return new JSONObject(body);
    }

    private JSONObject error(String message) throws JSONException {
        JSONObject response = new JSONObject();
        response.put("ok", false);
        response.put("error", message);
        return response;
    }

    private void writeOptions(OutputStream output) throws IOException {
        String headers = "HTTP/1.1 204 No Content\r\n"
                + corsHeaders()
                + "Content-Length: 0\r\n"
                + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private void writeJson(OutputStream output, int statusCode, JSONObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 " + statusCode + " " + reason(statusCode) + "\r\n"
                + corsHeaders()
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.write(bytes);
        output.flush();
    }

    private String corsHeaders() {
        return "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Content-Type\r\n";
    }

    private String reason(int statusCode) {
        if (statusCode == 204) return "No Content";
        if (statusCode == 400) return "Bad Request";
        if (statusCode == 404) return "Not Found";
        return "OK";
    }

    private static final class Request {
        final String method;
        final String path;
        final String body;

        Request(String method, String path, String body) {
            this.method = method;
            this.path = path;
            this.body = body;
        }
    }
}
