#!/usr/bin/env node
/* =========================================================
   KI-Sprachaufnahmen für englisch.html erzeugen

   Das Skript öffnet englisch.html in Chrome, holt alle Texte, die das Spiel
   sprechen kann (audioTexts()), lässt die fehlenden von Microsoft Azure
   sprechen und legt sie als MP3 in den Ordner audio/. Dazu schreibt es
   audio/manifest.js – daran erkennt das Spiel, welche Aufnahmen es gibt.

   Einmalig:
     1. Bei https://portal.azure.com ein (kostenloses) Konto anlegen und eine
        Ressource „Speech“ (Speech Services) erstellen, Preisstufe „Free F0“.
     2. tts-config.example.json nach tts-config.json kopieren und Schlüssel
        und Region (z.B. „westeurope“) der Speech-Ressource eintragen.
        tts-config.json bleibt lokal (steht in .gitignore).
     3. cd tools && npm install

   Aufnahmen erzeugen (nur was noch fehlt, darum beliebig oft aufrufbar):
     node make-audio.js            alles Fehlende erzeugen
     node make-audio.js --limit 20 nur 20 Stück, zum Ausprobieren
     node make-audio.js --prune    zusätzlich Aufnahmen löschen, deren Text
                                   es im Spiel nicht mehr gibt
     node make-audio.js --list     nur zählen, nichts erzeugen

   Ändert sich ein Text im Spiel, einfach nochmals laufen lassen.
   ========================================================= */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "audio");
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;

/* Stimmen je Sprecher. Alle Azure-Stimmen: https://aka.ms/speech/voices
   rate/pitch in Prozent, z.B. "-8%". In tts-config.json überschreibbar. */
const VOICES = {
  en:   { voice: "en-GB-SoniaNeural",  rate: "-10%", pitch: "0%" },   // Erzählerin: Wörter, Lob
  bear: { voice: "en-GB-RyanNeural",   rate: "-8%",  pitch: "-6%" },  // Teddy, der Bär
  kid:  { voice: "en-GB-MaisieNeural", rate: "-8%",  pitch: "0%" },   // das Kind
  de:   { voice: "de-CH-LeniNeural",   rate: "0%",   pitch: "0%" }    // Anweisungen auf Deutsch
};

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ];
  const found = candidates.find(p => p && fs.existsSync(p));
  if (!found) throw new Error("Chrome nicht gefunden – Pfad mit CHROME=… angeben.");
  return found;
}

/* Alle Texte direkt aus dem Spiel holen – so passt die Liste immer. */
async function loadTexts() {
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("file://" + path.join(ROOT, "englisch.html"));
    return await page.evaluate(() => audioTexts());
  } finally {
    await browser.close();
  }
}

function xml(s) {
  return s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

async function azure(cfg, item) {
  const v = Object.assign({}, VOICES[item.role], (cfg.voices || {})[item.role]);
  const locale = v.voice.split("-").slice(0, 2).join("-");
  const ssml =
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + locale + '">' +
    '<voice name="' + v.voice + '"><prosody rate="' + v.rate + '" pitch="' + v.pitch + '">' +
    xml(item.t) + "</prosody></voice></speak>";

  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://" + cfg.region + ".tts.speech.microsoft.com/cognitiveservices/v1", {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": cfg.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "kids-englisch"
      },
      body: ssml
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    // Zu viele Anfragen auf einmal (Gratisstufe) oder Serverfehler: kurz warten
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error("Azure antwortet " + res.status + " " + res.statusText + " " + body.slice(0, 200) +
      (res.status === 401 ? " – Schlüssel oder Region in tts-config.json prüfen." : ""));
  }
}

function writeManifest(keys) {
  const files = fs.readdirSync(OUT).filter(f => /^[0-9a-f]{8}\.mp3$/.test(f));
  const have = {};
  for (const f of files) {
    const k = f.slice(0, 8);
    if (keys.has(k)) have[k] = f;
  }
  fs.writeFileSync(path.join(OUT, "manifest.js"),
    "/* Erzeugt von tools/make-audio.js – nicht von Hand ändern. */\n" +
    "window.AUDIO_FILES = " + JSON.stringify(have) + ";\n");
  return Object.keys(have).length;
}

(async () => {
  const items = await loadTexts();
  fs.mkdirSync(OUT, { recursive: true });
  const keys = new Set(items.map(i => i.k));
  const missing = items.filter(i => !fs.existsSync(path.join(OUT, i.k + ".mp3")));
  const chars = missing.reduce((n, i) => n + i.t.length, 0);
  console.log(items.length + " Texte im Spiel, davon fehlen " + missing.length + " (" + chars + " Zeichen).");

  if (flag("--prune")) {
    for (const f of fs.readdirSync(OUT)) {
      if (/^[0-9a-f]{8}\.mp3$/.test(f) && !keys.has(f.slice(0, 8))) {
        fs.unlinkSync(path.join(OUT, f));
        console.log("gelöscht (Text gibt es nicht mehr): " + f);
      }
    }
  }

  if (flag("--list")) {
    for (const i of missing) console.log(i.k, i.role.padEnd(4), i.t);
    console.log(writeManifest(keys) + " Aufnahmen im Manifest.");
    return;
  }

  const todo = missing.slice(0, LIMIT);
  if (todo.length) {
    const cfgPath = path.join(__dirname, "tts-config.json");
    if (!fs.existsSync(cfgPath)) throw new Error("tools/tts-config.json fehlt – siehe Anleitung oben in diesem Skript.");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg.key || !cfg.region) throw new Error("In tts-config.json fehlen key oder region.");

    // Ein paar Anfragen gleichzeitig – die Gratisstufe erlaubt nicht viel mehr.
    let next = 0, done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const item = todo[next++];
        const mp3 = await azure(cfg, item);
        fs.writeFileSync(path.join(OUT, item.k + ".mp3"), mp3);
        done++;
        process.stdout.write("\r" + done + "/" + todo.length + "  " + item.t.slice(0, 50).padEnd(50));
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
    } finally {
      process.stdout.write("\n");
      // Auch nach einem Abbruch: was schon da ist, kommt ins Manifest.
      console.log(writeManifest(keys) + " Aufnahmen im Manifest.");
    }
  } else {
    console.log(writeManifest(keys) + " Aufnahmen im Manifest.");
  }
})().catch(e => {
  console.error("\nFehler: " + e.message);
  process.exit(1);
});
