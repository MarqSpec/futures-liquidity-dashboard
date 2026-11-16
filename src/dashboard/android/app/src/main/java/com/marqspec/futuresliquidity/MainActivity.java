package com.marqspec.futuresliquidity;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Release keeps mixed content off. A debuggable build allows it so an opted-in http LAN server
        // can open ws:// from the https WebView origin. Cleartext itself is the debug network security config.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable || getBridge() == null) {
            return;
        }
        getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }
}
