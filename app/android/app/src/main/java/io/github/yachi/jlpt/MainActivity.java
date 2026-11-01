package io.github.yachi.jlpt;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(VoiceSettingsPlugin.class);
        registerPlugin(FeedbackPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
