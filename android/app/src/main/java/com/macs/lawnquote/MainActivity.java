package com.macs.lawnquote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.SslErrorHandler;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://macs.rctrusts.com/crew.html";
    private static final String LOGIN_URL = "https://macs.rctrusts.com/admin.html";
    private static final String APP_HOST = "macs.rctrusts.com";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int LOCATION_REQUEST = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private GeolocationPermissions.Callback geolocationCallback;
    private String geolocationOrigin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(0xFFF7F4EC);
        window.setNavigationBarColor(0xFFF7F4EC);
        useDarkSystemBarIcons(window);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top = statusBarInset(insets);
            int bottom = navigationBarInset(insets);
            view.setPadding(0, top, 0, 0);
            webView.evaluateJavascript(
                "(function(){document.documentElement.style.setProperty('--android-nav-inset','" + bottom + "px');})()",
                null
            );
            return insets;
        });
        root.requestApplyInsets();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " MACS-LawnQuote-Android/" + appVersionName());
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    showOfflineScreen();
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showOfflineScreen();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.contains("admin.html") && url.contains("logout=1")) {
                    clearWebSession();
                    view.clearHistory();
                }
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> openExternal(Uri.parse(url)));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception error) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                    return;
                }
                geolocationOrigin = origin;
                geolocationCallback = callback;
                requestPermissions(new String[] {
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                }, LOCATION_REQUEST);
            }
        });

        clearWebSession();
        webView.loadUrl(LOGIN_URL + "?android=1&fresh=1&t=" + System.currentTimeMillis());
    }

    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if ("sms".equalsIgnoreCase(scheme) || "tel".equalsIgnoreCase(scheme) || "geo".equalsIgnoreCase(scheme)) {
            openExternal(uri);
            return true;
        }
        String host = uri.getHost() == null ? "" : uri.getHost();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            if (!APP_HOST.equalsIgnoreCase(host)) {
                openExternal(uri);
                return true;
            }
            String path = uri.getPath() == null ? "/" : uri.getPath();
            if (path.endsWith(".apk")) {
                openExternal(uri);
                return true;
            }
            if (!path.endsWith("/crew.html")
                && !path.endsWith("/schedule.html")
                && !path.endsWith("/customers.html")
                && !path.endsWith("/invoices.html")
                && !path.endsWith("/reports.html")
                && !path.endsWith("/security.html")
                && !path.endsWith("/quote.html")
                && !path.endsWith("/index.html")
                && !path.endsWith("/profile.html")
                && !path.endsWith("/more.html")
                && !path.endsWith("/downloads.html")
                && !path.endsWith("/admin.html")) {
                webView.loadUrl(LOGIN_URL + "?android=1&t=" + System.currentTimeMillis());
                return true;
            }
        }
        return false;
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (Exception ignored) {
        }
    }

    private void clearWebSession() {
        try {
            CookieManager cookieManager = CookieManager.getInstance();
            cookieManager.removeSessionCookies(null);
            cookieManager.removeAllCookies(null);
            cookieManager.flush();
        } catch (Exception ignored) {
        }
        try {
            WebStorage.getInstance().deleteAllData();
        } catch (Exception ignored) {
        }
        try {
            webView.clearCache(true);
            webView.clearFormData();
            webView.clearHistory();
            webView.clearSslPreferences();
        } catch (Exception ignored) {
        }
    }

    private String appVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "0";
        }
    }

    private void showOfflineScreen() {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;font-family:sans-serif;background:#fffdf7;color:#17231d}"
            + "main{min-height:100vh;display:grid;place-items:center;padding:24px}"
            + "section{max-width:420px;border:1px solid #d7d0c1;border-radius:8px;padding:18px;background:#fff;box-shadow:0 12px 36px rgba(41,35,24,.11)}"
            + "p{color:#66736b;font-weight:700;line-height:1.45}button{min-height:48px;border:0;border-radius:8px;background:#1f7a4f;color:white;font-weight:900;padding:0 18px}</style>"
            + "</head><body><main><section><p>MACS Field App</p><h1>Connection needed</h1>"
            + "<p>The login screen could not load. Check mobile data or Wi-Fi, then retry.</p>"
            + "<button onclick=\"location.href='" + LOGIN_URL + "?android=1'\">Retry login</button></section></main></body></html>";
        webView.loadDataWithBaseURL(LOGIN_URL, html, "text/html", "UTF-8", null);
    }

    private void useDarkSystemBarIcons(Window window) {
        int flags = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        if (flags != 0) {
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }

    private int statusBarInset(WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return insets.getInsets(WindowInsets.Type.statusBars()).top;
        }
        return insets.getSystemWindowInsetTop();
    }

    private int navigationBarInset(WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
        }
        return insets.getSystemWindowInsetBottom();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;
        Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != LOCATION_REQUEST || geolocationCallback == null) return;
        boolean granted = false;
        for (int result : grantResults) {
            if (result == PackageManager.PERMISSION_GRANTED) {
                granted = true;
                break;
            }
        }
        geolocationCallback.invoke(geolocationOrigin, granted, false);
        geolocationCallback = null;
        geolocationOrigin = null;
    }
}
