/**
 * Drives the installed debug APK on an Android emulator and checks the voice
 * buttons do something. Run by .github/workflows/android-emulator.yml.
 *
 * A browser test cannot catch this class of bug: on a real phone the
 * "Install Japanese voice data" button did nothing, because the native call
 * behind it resolved without opening any screen. Here the real WebView, the
 * real plugin and the real Android intent resolution are exercised, and the
 * check is on Android's own record of the foreground activity.
 *
 * Writes screenshots and a log to e2e-out/ for the workflow to upload.
 */
const { _android: android } = require("playwright");
const fs = require("node:fs");

const PKG = "io.github.yachi.jlpt";
const OUT = "e2e-out";
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const line = a.join(" "); console.log(line); fs.appendFileSync(`${OUT}/log.txt`, line + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resumed(device) {
  const out = (await device.shell("dumpsys activity activities")).toString();
  const m = out.match(/(?:mResumedActivity|topResumedActivity|ResumedActivity)[^\n]*?\s([\w.]+)\/([\w.$]+)/);
  return m ? `${m[1]}/${m[2]}` : "unknown";
}

/**
 * The WebView's first page can be replaced while Capacitor boots, which closes
 * the Playwright page we attached to, so keep re-attaching until the app's
 * tab bar is up. First launch also seeds 5,257 cards, slow on an emulator.
 */
async function openApp(device) {
  await device.shell(`am start -W -n ${PKG}/.MainActivity`);
  const deadline = Date.now() + 180_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const webview = await device.webView({ pkg: PKG }, { timeout: 30_000 });
      const page = await webview.page();
      page.on("console", (m) => log(`console.${m.type()}: ${m.text()}`));
      page.on("pageerror", (err) => log(`pageerror: ${err.message}`));
      try {
        await page.waitForSelector("nav.tabbar", { timeout: 20_000 });
        return page;
      } catch (e) {
        // Say what IS on screen: a stuck splash, a startup error, or nothing.
        const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : "(no body)").catch(() => "(page gone)");
        log(`screen text: ${String(text).replace(/\s+/g, " ")}`);
        throw e;
      }
    } catch (e) {
      last = e;
      log(`waiting for app UI: ${String(e && e.message || e).split("\n")[0]}`);
      await sleep(2000);
    }
  }
  throw last;
}

/** Tap `button` and assert Android moved some other activity to the front. */
async function expectLeavesApp(device, page, button, name, shot) {
  await button.click();
  let top = "unknown";
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    top = await resumed(device);
    if (!top.startsWith(PKG)) break;
  }
  log(`${name}: foreground after tap = ${top}`);
  fs.writeFileSync(`${OUT}/${shot}.png`, await device.screenshot());
  if (top.startsWith(PKG) || top === "unknown") throw new Error(`${name} did not open any screen (foreground: ${top})`);
  await device.shell("input keyevent KEYCODE_BACK");
  await sleep(1500);
  if (!(await resumed(device)).startsWith(PKG)) await device.shell(`am start -n ${PKG}/.MainActivity`);
  await sleep(1500);
}

(async () => {
  const [device] = await android.devices();
  if (!device) throw new Error("no adb device");
  log(`device: ${device.model()} serial ${device.serial()}`);
  let page = await openApp(device);
  fs.writeFileSync(`${OUT}/01-study.png`, await device.screenshot());

  // Settings: the diagnosis line comes from the native status() call, so a
  // non-empty engine list here also proves the <queries> visibility fix.
  await page.getByRole("button", { name: /Settings/ }).click();
  const voiceField = page.locator(".field", { hasText: "Japanese voice" });
  await voiceField.waitFor({ timeout: 20_000 });
  await sleep(1500);
  log(`settings voice field: ${(await voiceField.innerText()).replace(/\s+/g, " ")}`);
  fs.writeFileSync(`${OUT}/02-settings.png`, await device.screenshot());

  await expectLeavesApp(device, page, voiceField.getByRole("button", { name: "Open voice settings" }),
    "Open voice settings", "03-voice-settings-opened");

  // The Study screen's link, shown only when no Japanese voice was found.
  await page.getByRole("button", { name: /Study/ }).click();
  await sleep(1500);
  const link = page.getByRole("button", { name: "Install Japanese voice data" });
  if (await link.count()) {
    await expectLeavesApp(device, page, link.first(), "Install Japanese voice data", "04-install-link-opened");
  } else {
    log("Study screen shows no 'Install Japanese voice data' link: a Japanese voice was found.");
  }
  log("PASS");
  await device.close();
})().catch(async (e) => {
  log(`FAIL: ${e && e.stack || e}`);
  // On failure, keep what explains it: the screen and the app's own log.
  try {
    const [device] = await android.devices();
    fs.writeFileSync(`${OUT}/failure.png`, await device.screenshot());
    const lc = (await device.shell("logcat -d -t 5000")).toString();
    fs.writeFileSync(`${OUT}/logcat.txt`, lc);
    // Artifacts are not always reachable, so print the lines that explain a crash.
    const keep = lc.split("\n").filter((l) => /FATAL|AndroidRuntime|Capacitor|chromium|Console|jlpt|lowmemorykiller|ANR|am_crash|WebView/i.test(l));
    console.log("---- logcat (filtered) ----\n" + keep.slice(-150).join("\n"));
  } catch { /* nothing more to save */ }
  process.exit(1);
});
