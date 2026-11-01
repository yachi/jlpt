package io.github.yachi.jlpt;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.speech.tts.TextToSpeech;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * Opens the phone's text-to-speech settings and reports why Japanese is or is
 * not available.
 *
 * The community TTS plugin's openInstall() fires ACTION_CHECK_TTS_DATA, which
 * is meant for startActivityForResult and shows no screen, and it silently does
 * nothing when the intent does not resolve. On a real phone the "Install
 * Japanese voice data" button therefore did nothing at all. This plugin opens
 * a screen the learner can actually use, and rejects when none exists so the
 * UI can say so instead of ignoring the tap.
 */
@CapacitorPlugin(name = "VoiceSettings")
public class VoiceSettingsPlugin extends Plugin {

    /** Tried in order. The first is the system TTS output screen: engine choice plus each engine's "Install voice data". */
    private static final String[] ACTIONS = {
        "com.android.settings.TTS_SETTINGS",
        TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA,
        android.provider.Settings.ACTION_SETTINGS,
    };

    @PluginMethod
    public void open(PluginCall call) {
        for (String action : ACTIONS) {
            Intent intent = new Intent(action);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getActivity().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("opened", action);
                call.resolve(ret);
                return;
            } catch (ActivityNotFoundException | SecurityException e) {
                // try the next one
            }
        }
        call.reject("No settings screen could be opened on this device");
    }

    /**
     * Binds a fresh engine and reports what it knows about Japanese. The
     * difference between "missing data" and "not supported" is what tells the
     * learner whether downloading voice data will help or a different engine
     * is needed.
     */
    @PluginMethod
    public void status(PluginCall call) {
        final TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(getContext(), status -> {
            TextToSpeech tts = holder[0];
            JSObject ret = new JSObject();
            ret.put("initialized", status == TextToSpeech.SUCCESS);
            JSArray engines = new JSArray();
            try {
                for (TextToSpeech.EngineInfo e : tts.getEngines()) {
                    JSObject o = new JSObject();
                    o.put("name", e.name);
                    o.put("label", e.label);
                    engines.put(o);
                }
                ret.put("defaultEngine", tts.getDefaultEngine());
                if (status == TextToSpeech.SUCCESS) {
                    int ja = tts.isLanguageAvailable(Locale.JAPAN);
                    ret.put("japanese", ja >= TextToSpeech.LANG_AVAILABLE ? "available"
                        : ja == TextToSpeech.LANG_MISSING_DATA ? "missing-data" : "not-supported");
                } else {
                    ret.put("japanese", "no-engine");
                }
            } catch (Exception e) {
                ret.put("error", e.getMessage());
            }
            ret.put("engines", engines);
            tts.shutdown();
            call.resolve(ret);
        });
    }
}
