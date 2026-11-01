package io.github.yachi.jlpt;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * A short haptic tick when an answer is graded.
 *
 * View.performHapticFeedback rather than the Vibrator API (which is what
 * the @capacitor/haptics plugin uses on Android): it needs no VIBRATE
 * permission, it plays the phone's own tuned effects, and it does nothing
 * when the learner turned touch feedback off in system settings. Android's
 * haptics guidance prefers exactly this for UI feedback.
 */
@CapacitorPlugin(name = "Feedback")
public class FeedbackPlugin extends Plugin {

    @PluginMethod
    public void haptic(PluginCall call) {
        String kind = call.getString("kind", "tick");
        final int effect;
        if ("confirm".equals(kind)) {
            effect = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
        } else if ("reject".equals(kind)) {
            effect = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
        } else {
            effect = HapticFeedbackConstants.CLOCK_TICK;
        }
        getActivity().runOnUiThread(() -> {
            View view = getBridge().getWebView();
            if (view != null) view.performHapticFeedback(effect);
            call.resolve();
        });
    }
}
