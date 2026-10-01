/*
 * Ultra Scan - Oberflaeche.
 *
 * Die komplette Bildverarbeitung laeuft unveraendert in der Original-Pipeline
 * (Datei "scanner") per Pyodide im Web Worker. Diese Datei macht nur:
 * Kamera, Live-Erkennung anzeigen, automatisch ausloesen, Scans verwalten,
 * teilen.
 */
"use strict";

/* ========================== Konstanten ========================== */
var MAX_KANTE       = 1600;   // laengste Kante fuer die Pipeline
var LIVE_KANTE      = 320;    // laengste Kante fuer die Live-Erkennung
var MIN_FLAECHE     = 0.09;   // Viereck muss >= 9 % des Bildes fuellen

/* --- Automatischer Ausloeser -------------------------------------------
 * Frueher: 3 gute Frames IN FOLGE, jeder Aussetzer setzte alles auf 0
 * zurueck, und als "Bewegung" galt schon eine Helligkeitsaenderung.
 * Auf einem iPad war das praktisch nie erfuellbar.
 *
 * Jetzt: eine Bereitschaft, die waehrend ruhiger Frames WAECHST und bei
 * Stoerungen nur langsam faellt. Kurzes Wackeln kostet etwas Fortschritt,
 * wirft aber nicht zurueck auf Null. Beurteilt wird die Lage der Ecken
 * ueber ein Zeitfenster (echtes Zittern) statt der Unterschied zweier
 * aufeinanderfolgender Frames. */
var FENSTER_MS      = 420;    // Beobachtungsfenster fuer die Ruhe-Messung
var ZITTER_MAX      = 0.028;  // erlaubtes Zittern (Anteil der Diagonale)
var TEMPO_MAX       = 0.30;   // erlaubte Wanderung je Sekunde (Anteil Diag.)
var BEWEGUNG_MAX    = 0.85;   // belichtungsbereinigte Bildbewegung
var SCHAERFE_ANTEIL = 0.33;   // mind. 33 % der zuletzt besten Schaerfe
var AUFBAU_MS       = 620;    // so lange ruhig halten -> Ausloesung
var ABBAU_MS        = 1700;   // so langsam faellt die Bereitschaft wieder
var VERLUST_MS      = 520;    // so lange darf die Erkennung aussetzen
var HINWEIS_RUHE_MS = 280;    // Mindeststandzeit eines Hinweistextes

/* ========================== Elemente ============================ */
function el(id) { return document.getElementById(id); }
var video        = el("video");
var overlay      = el("overlay");
var kameraScreen = el("kamera-screen");
var galerieScreen= el("galerie-screen");
var galerieListe = el("galerie-liste");
var ladeOverlay  = el("lade-overlay");
var ladeBalken   = el("lade-balken");
var ladeText     = el("lade-text");
var ladeProzent  = el("lade-prozent");
var arbeitOverlay= el("arbeit-overlay");
var meldungOv    = el("meldung-overlay");
var meldungTitel = el("meldung-titel");
var meldungText  = el("meldung-text");
var quelleSheet  = el("quelle-sheet");
var teilenSheet  = el("teilen-sheet");
var hinweis      = el("kamera-hinweis");
var autoPille    = el("auto-pille");
var stilPille    = el("stil-pille");
var ringBox      = el("ausloeser-ring");
var ringFg       = el("ring-fg");
var zoomPille    = el("zoom-pille");
var kameraFehler = el("kamera-fehler");
var kameraFehlerText = el("kamera-fehler-text");
var topbarStatus = el("topbar-status");
var toastEl      = el("toast");

var ctx = overlay.getContext("2d");

/* ========================== Zustand ============================= */
var workerBereit  = false;
var scanLaeuft    = false;
var liveAktiv     = false;        // Erkennungsschleife laeuft
var stream        = null;
var kameraRichtung= "environment";
var zoom          = 1;
var zoomMax       = 5;
var trackZoom     = null;         // native Zoom-Faehigkeit (falls vorhanden)
var scans         = [];           // { blob, url, drehung }
var letzterQuad   = null;         // gezeichnetes (geglaettetes) Viereck
var zielQuad      = null;         // letzte Messung (Overlay-Koordinaten)
var verlauf       = [];           // Messungen im Zeitfenster
var letzteMessung = 0;
var verdaechtig   = null;         // Ausreisser, der noch bestaetigt werden muss
var schaerfeJetzt = 0, schaerfeBest = 1, schaerfeBestZeit = 0;
var bewegungJetzt = -1;
var bereitschaft  = 0;            // 0..1 Ausloese-Bereitschaft
var ringAn        = false;
var geradeAusgeloest = false;

/* ======================= Service Worker ========================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(function () {});
}

/* ========================== Worker ============================== */
var worker = new Worker("worker.js");

/* -------------------- Realistische Lade-Anzeige --------------------
 * Der Worker meldet nur grobe echte Meilensteine. Die Anzeige bewegt den
 * Balken deshalb selbst in unregelmaessigen, aber begrenzten Schritten und
 * springt erst bei echten Hintergrund-Meilensteinen in die naechste Zone. */
var ladeZustand = {
  wert: 0,
  phase: "phase1",
  raf: 0,
  timer: 0,
  token: 0,
  opencvGemeldet: false,
  pipelineGemeldet: false,
  pipelineZu95Gestartet: false,
  pipelineBei95: false,
  pipeline95Zeit: 0,
  bereitGemeldet: false,
  bereitCallback: null,
  zu100Gestartet: false
};

function ladeZufall(min, max) { return min + Math.random() * (max - min); }
function ladeClamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function ladeEaseOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function ladeEaseInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function ladeSetzen(wert) {
  var w = ladeClamp(wert, 0, 100);
  ladeZustand.wert = w;
  ladeBalken.style.width = w.toFixed(3) + "%";
  ladeText.textContent = "Wird geladen\u2026";
  if (ladeProzent) { ladeProzent.textContent = Math.round(w) + " %"; }
  if (ladeBalken.parentElement) {
    ladeBalken.parentElement.setAttribute("aria-valuenow", String(Math.round(w)));
  }
}

function ladeBewegungStoppen() {
  if (ladeZustand.raf) { cancelAnimationFrame(ladeZustand.raf); ladeZustand.raf = 0; }
  if (ladeZustand.timer) { clearTimeout(ladeZustand.timer); ladeZustand.timer = 0; }
  ladeZustand.token++;
}

function ladeAnimationStoppen() { ladeBewegungStoppen(); }

function ladeGleiteZu(ziel, dauer, easing, danach) {
  ladeBewegungStoppen();
  ziel = ladeClamp(Math.max(ziel, ladeZustand.wert), 0, 100);
  var start = ladeZustand.wert;
  var distanz = ziel - start;
  var token = ladeZustand.token;
  var startZeit = performance.now();
  var reduzierteBewegung = false;
  try { reduzierteBewegung = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (f) {}
  var laenge = reduzierteBewegung ? Math.min(90, dauer) : Math.max(1, dauer);
  if (distanz < 0.02) {
    ladeSetzen(ziel);
    if (danach) { ladeZustand.timer = setTimeout(danach, 0); }
    return;
  }
  function schritt(jetzt) {
    if (token !== ladeZustand.token) { return; }
    var t = ladeClamp((jetzt - startZeit) / laenge, 0, 1);
    var e = (easing || ladeEaseOutCubic)(t);
    ladeSetzen(start + distanz * e);
    if (t < 1) {
      ladeZustand.raf = requestAnimationFrame(schritt);
    } else {
      ladeZustand.raf = 0;
      ladeSetzen(ziel);
      if (danach) { danach(); }
    }
  }
  ladeZustand.raf = requestAnimationFrame(schritt);
}

function ladeNaechsterPhase1Schritt() {
  if (ladeZustand.phase !== "phase1" || ladeZustand.opencvGemeldet) { return; }
  var p = ladeZustand.wert;
  var inc, dauer, pause;
  if (p < 16) {
    inc = ladeZufall(7.5, 13.0); dauer = ladeZufall(120, 190); pause = ladeZufall(20, 70);
  } else if (p < 32) {
    inc = ladeZufall(4.8, 8.8); dauer = ladeZufall(150, 240); pause = ladeZufall(30, 85);
  } else if (p < 40) {
    inc = ladeZufall(2.2, 4.8); dauer = ladeZufall(190, 320); pause = ladeZufall(45, 110);
  } else if (p < 42.5) {
    inc = ladeZufall(0.7, 1.7); dauer = ladeZufall(280, 470); pause = ladeZufall(70, 150);
  } else {
    inc = ladeZufall(0.10, 0.55); dauer = ladeZufall(850, 1450); pause = ladeZufall(120, 280);
  }
  var cap = p < 42.5 ? 42.5 : 49.4;
  var ziel = Math.min(cap, p + inc);
  if (ziel <= p + 0.02) { ziel = Math.min(cap, p + 0.08); }
  ladeGleiteZu(ziel, dauer, ladeEaseInOut, function () {
    if (ladeZustand.phase !== "phase1" || ladeZustand.opencvGemeldet) { return; }
    ladeZustand.timer = setTimeout(ladeNaechsterPhase1Schritt, pause);
  });
}

function ladeNaechsterPhase2Schritt() {
  if (ladeZustand.phase !== "phase2" || ladeZustand.pipelineGemeldet) { return; }
  var p = ladeZustand.wert;
  var inc, dauer, pause;
  if (p < 66) {
    inc = ladeZufall(5.8, 10.5); dauer = ladeZufall(120, 200); pause = ladeZufall(20, 70);
  } else if (p < 78) {
    inc = ladeZufall(3.2, 6.4); dauer = ladeZufall(150, 260); pause = ladeZufall(30, 90);
  } else if (p < 84.5) {
    inc = ladeZufall(1.4, 3.3); dauer = ladeZufall(220, 380); pause = ladeZufall(45, 120);
  } else if (p < 88) {
    inc = ladeZufall(0.45, 1.35); dauer = ladeZufall(360, 680); pause = ladeZufall(80, 180);
  } else {
    inc = ladeZufall(0.10, 0.48); dauer = ladeZufall(850, 1450); pause = ladeZufall(120, 280);
  }
  var ziel = Math.min(90, p + inc);
  if (ziel <= p + 0.02) { ziel = Math.min(90, p + 0.08); }
  ladeGleiteZu(ziel, dauer, ladeEaseInOut, function () {
    if (ladeZustand.phase !== "phase2" || ladeZustand.pipelineGemeldet) { return; }
    ladeZustand.timer = setTimeout(ladeNaechsterPhase2Schritt, pause);
  });
}

function starteLadePhase1() {
  ladeZustand.phase = "phase1";
  ladeNaechsterPhase1Schritt();
}

function starteLadePhase2() {
  if (ladeZustand.pipelineGemeldet || ladeZustand.bereitGemeldet) {
    ladePipelineVorbereitenErreicht();
    return;
  }
  ladeZustand.phase = "phase2";
  ladeNaechsterPhase2Schritt();
}

function ladeOpenCVFertig() {
  if (ladeZustand.opencvGemeldet) { return; }
  ladeZustand.opencvGemeldet = true;
  ladeZustand.phase = "opencv-sprung";
  var ziel = ladeZufall(50, 60);
  ladeGleiteZu(ziel, ladeZufall(230, 360), ladeEaseOutCubic, function () {
    ladeZustand.phase = "nach-opencv";
    if (ladeZustand.pipelineGemeldet || ladeZustand.bereitGemeldet) {
      ladePipelineVorbereitenErreicht();
    } else {
      starteLadePhase2();
    }
  });
}

function ladePipelineVorbereitenErreicht() {
  ladeZustand.pipelineGemeldet = true;
  if (!ladeZustand.opencvGemeldet) {
    ladeOpenCVFertig();
    return;
  }
  if (ladeZustand.phase === "opencv-sprung") { return; }
  if (ladeZustand.pipelineZu95Gestartet || ladeZustand.pipelineBei95 || ladeZustand.zu100Gestartet) { return; }
  ladeZustand.pipelineZu95Gestartet = true;
  ladeZustand.phase = "pipeline-95";
  ladeGleiteZu(95, ladeZufall(260, 420), ladeEaseOutCubic, function () {
    ladeZustand.pipelineBei95 = true;
    ladeZustand.pipeline95Zeit = performance.now();
    ladeSetzen(95);
    if (ladeZustand.bereitGemeldet) { ladeAllesBereit(); }
  });
}

function ladeAllesBereit(danach) {
  ladeZustand.bereitGemeldet = true;
  if (danach) { ladeZustand.bereitCallback = danach; }
  if (!ladeZustand.pipelineGemeldet) {
    ladePipelineVorbereitenErreicht();
    return;
  }
  if (!ladeZustand.pipelineBei95) { return; }
  if (ladeZustand.zu100Gestartet) { return; }
  var haltBei95 = 180 - (performance.now() - ladeZustand.pipeline95Zeit);
  if (haltBei95 > 0) {
    if (ladeZustand.timer) { clearTimeout(ladeZustand.timer); }
    ladeZustand.timer = setTimeout(function () { ladeAllesBereit(); }, haltBei95);
    return;
  }
  ladeZustand.zu100Gestartet = true;
  ladeZustand.phase = "fertig-100";
  ladeGleiteZu(100, ladeZufall(280, 430), ladeEaseOutCubic, function () {
    ladeSetzen(100);
    var cb = ladeZustand.bereitCallback;
    ladeZustand.bereitCallback = null;
    if (cb) { cb(); }
  });
}

function ladeFortschrittVomWorker(n) {
  var phase = (n.phase || "").toLowerCase();
  ladeText.textContent = "Wird geladen\u2026";
  if (phase.indexOf("opencv") !== -1 || (phase && n.prozent === 55)) {
    ladeOpenCVFertig();
  }
  if (phase.indexOf("pipeline") !== -1 || (n.prozent >= 99 && phase)) {
    ladePipelineVorbereitenErreicht();
  }
}

ladeSetzen(0);
starteLadePhase1();

/* Verhindert, dass die App fuer immer bei "Wird geladen" haengen bleibt:
 * jeder Fehler (und ein "er antwortet einfach nicht mehr"-Wachhund weiter
 * unten) blendet das Lade-Overlay aus und zeigt stattdessen eine klare
 * Meldung mit Neu-laden-Knopf. */
var ladeAbgeschlossen = false; // true sobald "bereit" ODER ein Lade-Fehler kam

function ladeFehlgeschlagen(text) {
  if (ladeAbgeschlossen) { return; }
  ladeAbgeschlossen = true;
  ladeAnimationStoppen();
  clearInterval(wachhundTimer);
  ladeOverlay.classList.add("verborgen");
  zeigeMeldung("Start fehlgeschlagen",
    text || "Ultra Scan konnte nicht geladen werden. Bitte die Seite neu laden.",
    "!", /* neuLaden */ true);
}

worker.onerror = function (f) {
  if (!workerBereit) {
    ladeFehlgeschlagen("Ultra Scan konnte nicht gestartet werden. Bitte die Seite neu laden.");
    return;
  }
  zeigeMeldung("Start fehlgeschlagen", "Bitte die Seite neu laden.", "!", true);
};

/* Wachhund: wenn 45s lang KEIN Fortschritt mehr ankommt (z.B. weil das
 * Laden von Python/OpenCV im Hintergrund haengen bleibt, ohne dass ein
 * Fehler gemeldet wird), zeigen wir einen Hinweis statt endlos zu warten. */
var letzterFortschritt = Date.now();
var wachhundTimer = setInterval(function () {
  if (ladeAbgeschlossen) { return; }
  if (Date.now() - letzterFortschritt > 45000) {
    ladeFehlgeschlagen(
      "Das Laden dauert ungew\u00f6hnlich lange \u2013 vermutlich ist die " +
      "Internetverbindung unterbrochen. Bitte die Seite neu laden.");
  }
}, 3000);

worker.onmessage = function (e) {
  var n = e.data;
  if (n.typ === "fortschritt") {
    letzterFortschritt = Date.now();
    ladeFortschrittVomWorker(n);
  } else if (n.typ === "bereit") {
    workerBereit = true;
    ladeAbgeschlossen = true;
    clearInterval(wachhundTimer);
    ladeAllesBereit(function () {
      setTimeout(function () {
        ladeOverlay.classList.add("verborgen");
        starteKamera();
      }, 90);
    });
  } else if (n.typ === "ergebnis") {
    ergebnisUebernehmen(n);
  } else if (n.typ === "keindokument") {
    scanFertig();
    zeigeMeldung("Kein Dokument gefunden",
      "Auf diesem Bild ist kein Dokument zu erkennen. Versuche es mit einer Aufnahme, auf der das Blatt vollst\u00e4ndig und mit Abstand zum Untergrund zu sehen ist.", "!");
  } else if (n.typ === "fehler") {
    if (!workerBereit) {
      /* Fehler ist waehrend des Starts passiert (Pyodide/OpenCV-Ladephase):
       * das Lade-Overlay muss weg, sonst bleibt die App bei "Wird geladen". */
      ladeFehlgeschlagen(n.text);
      return;
    }
    scanFertig();
    zeigeMeldung("Das hat nicht geklappt", n.text || "Bitte noch einmal versuchen.", "!");
  }
};

/* ========================== Kamera ============================== */
function starteKamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    kameraNichtVerfuegbar("Dieser Browser gibt keine Kamera frei. W\u00e4hle unten ein Bild aus.");
    return;
  }
  stoppeKamera();
  navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: kameraRichtung },
      width:  { ideal: 1920 },
      height: { ideal: 1440 }
    },
    audio: false
  }).then(function (s) {
    stream = s;
    video.srcObject = s;
    kameraFehler.classList.add("verborgen");
    var spur = s.getVideoTracks()[0];
    trackZoom = null;
    if (spur && spur.getCapabilities) {
      var f = spur.getCapabilities();
      if (f && f.zoom) { trackZoom = { spur: spur, min: f.zoom.min || 1, max: f.zoom.max || 1 }; }
    }
    return video.play().catch(function () {});
  }).then(function () {
    passeOverlayAn();
    liveAktiv = true;
    zoomSetzen(1);
    schleife();
  }).catch(function (f) {
    kameraNichtVerfuegbar("Kein Kamerazugriff (" + (f && f.name ? f.name : "Fehler") +
      "). W\u00e4hle unten ein Bild aus.");
  });
}

function stoppeKamera() {
  liveAktiv = false;
  if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
}

function kameraNichtVerfuegbar(text) {
  liveAktiv = false;
  kameraFehlerText.textContent = text;
  kameraFehler.classList.remove("verborgen");
  hinweis.classList.add("verborgen");
}

el("btn-wechseln").addEventListener("click", function () {
  this.classList.remove("dreht");
  void this.offsetWidth;
  this.classList.add("dreht");
  kameraRichtung = (kameraRichtung === "environment") ? "user" : "environment";
  zuruecksetzenErkennung();
  starteKamera();
});

/* ------------------------- Pinch-Zoom ---------------------------- */
var pinchStart = 0, zoomStart = 1;
kameraScreen.addEventListener("touchstart", function (e) {
  if (e.touches.length === 2) {
    pinchStart = fingerAbstand(e.touches);
    zoomStart = zoom;
  }
}, { passive: true });
kameraScreen.addEventListener("touchmove", function (e) {
  if (e.touches.length === 2 && pinchStart > 0) {
    e.preventDefault();
    zoomSetzen(zoomStart * (fingerAbstand(e.touches) / pinchStart));
  }
}, { passive: false });
kameraScreen.addEventListener("touchend", function (e) {
  if (e.touches.length < 2) { pinchStart = 0; versteckeZoomPille(); }
}, { passive: true });
kameraScreen.addEventListener("dblclick", function () { zoomSetzen(zoom > 1.05 ? 1 : 2); });

function fingerAbstand(t) {
  var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

var zoomPillenTimer = null;
function zoomSetzen(z) {
  zoom = Math.min(zoomMax, Math.max(1, z));
  /* Zuerst die echte Kamera-Zoom-API versuchen (Android/Chrome).
   * iOS/Safari kennt sie nicht -> digitaler Zoom per Transform + Crop. */
  var nativ = false;
  if (trackZoom && trackZoom.max > 1) {
    var ziel = Math.min(trackZoom.max, trackZoom.min + (zoom - 1) * (trackZoom.max - trackZoom.min) / (zoomMax - 1));
    try {
      trackZoom.spur.applyConstraints({ advanced: [{ zoom: ziel }] });
      nativ = true;
    } catch (f) { nativ = false; }
  }
  video.style.transform = nativ ? "" : "scale(" + zoom.toFixed(3) + ")";
  video.dataset.digital = nativ ? "0" : "1";
  zoomPille.textContent = zoom.toFixed(1).replace(".", ",") + "\u00d7";
  zoomPille.classList.toggle("verborgen", zoom <= 1.02);
  clearTimeout(zoomPillenTimer);
  zoomPillenTimer = setTimeout(versteckeZoomPille, 1400);
}
function versteckeZoomPille() {
  if (zoom <= 1.02) { zoomPille.classList.add("verborgen"); }
}

/* ===================== Overlay / Zeichnen ======================== */
function passeOverlayAn() {
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  overlay.width  = Math.round(overlay.clientWidth  * dpr);
  overlay.height = Math.round(overlay.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", passeOverlayAn);
window.addEventListener("orientationchange", function () { setTimeout(passeOverlayAn, 300); });

/* sichtbarer Ausschnitt des Videos (object-fit: cover + digitaler Zoom) */
function sichtbarerAusschnitt() {
  var vw = video.videoWidth, vh = video.videoHeight;
  var ew = overlay.clientWidth, eh = overlay.clientHeight;
  if (!vw || !vh || !ew || !eh) { return null; }
  var digital = video.dataset.digital !== "0";
  var z = digital ? zoom : 1;
  var skal = Math.max(ew / vw, eh / vh) * z;
  var sw = Math.min(vw, ew / skal), sh = Math.min(vh, eh / skal);
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw: sw, sh: sh, ew: ew, eh: eh };
}

var liveCanvas = document.createElement("canvas");
var liveCtx = liveCanvas.getContext("2d", { willReadFrequently: true });

function liveFrame() {
  var a = sichtbarerAusschnitt();
  if (!a) { return null; }
  var f = LIVE_KANTE / Math.max(a.sw, a.sh);
  var w = Math.max(60, Math.round(a.sw * f)), h = Math.max(60, Math.round(a.sh * f));
  liveCanvas.width = w; liveCanvas.height = h;
  liveCtx.drawImage(video, a.sx, a.sy, a.sw, a.sh, 0, 0, w, h);
  return { daten: liveCtx.getImageData(0, 0, w, h), breite: w, hoehe: h, aus: a };
}

/* ================= Erkennungs-Worker (reines JS) ================
 * Die Live-Erkennung laeuft NICHT mehr ueber Python/Pyodide (das schaffte
 * nur ~5 Bilder je Sekunde und zitterte stark), sondern in detect.js in
 * einem eigenen, winzigen Worker - mit voller Bildrate. */
var erkWorker = new Worker("detect-worker.js");
var erkOffen = false;
var erkFolge = 0;
var erkAnfragen = {};
var standbildWartet = {};
var standbildMarke = 0;

erkWorker.onmessage = function (e) {
  var n = e.data;
  if (n.typ === "quad") {
    erkOffen = false;
    var info = erkAnfragen[n.folge];
    delete erkAnfragen[n.folge];
    messungAufnehmen(n, info);
  } else if (n.typ === "standbild") {
    var auftrag = standbildWartet[n.marke];
    delete standbildWartet[n.marke];
    if (auftrag) { auftrag(n.quad, n.konfidenz); }
  }
};
erkWorker.onerror = function () { erkOffen = false; };

/* ================== KI-Erkennung (neuronales Netz) ==============
 *
 * Zweiter, eigener Worker. Er schaetzt die vier Dokument-Ecken mit dem
 * DocAligner-Modell (siehe models/HERKUNFT.md) und braucht dafuer rund
 * 100-200 ms. Die schnelle Geometrie in erkWorker laeuft davon voellig
 * unbeeindruckt weiter - das zuletzt gelieferte KI-Viereck wird dort nur
 * als zusaetzlicher Kandidat mitbewertet.
 *
 * Faellt der Worker aus (altes Safari ohne Modul-Worker, Modell nicht
 * ladbar, zu wenig Speicher), arbeitet die App exakt wie vorher weiter.
 * Die KI ist eine Verbesserung, keine Voraussetzung. */
var kiWorker = null;
var kiBereit = false;
var kiOffen = false;
var kiLetzte = null;            // { quad, konf, zeit, w, h }
var kiStandbild = {};
var kiLetzteSendung = 0;
var KI_HALTBAR_MS = 700;        // aelter -> nicht mehr verwenden
var KI_ABSTAND_MS = 60;         // Mindestabstand zweier KI-Anfragen

try {
  kiWorker = new Worker("nn-worker.js", { type: "module" });
} catch (f) {
  kiWorker = null;
}

if (kiWorker) {
  kiWorker.onmessage = function (e) {
    var n = e.data;
    if (!n) { return; }
    if (n.typ === "ki-status") {
      kiBereit = !!n.bereit;
      if (!kiBereit) {
        console.warn("KI-Erkennung nicht verfuegbar:", n.meldung);
      }
      return;
    }
    if (n.typ === "ki") {
      kiOffen = false;
      if (n.quad) {
        kiLetzte = { quad: n.quad, konf: n.konfidenz, zeit: performance.now() };
      } else if (!n.uebersprungen) {
        kiLetzte = null;
      }
      return;
    }
    if (n.typ === "ki-standbild") {
      var auftrag = kiStandbild[n.marke];
      delete kiStandbild[n.marke];
      if (auftrag) { auftrag(n.quad, n.konfidenz); }
    }
  };
  kiWorker.onerror = function (f2) {
    console.warn("KI-Worker gestoppt:", f2 && f2.message);
    kiOffen = false;
    kiBereit = false;
    kiWorker = null;
  };
}

/* Frisches KI-Viereck fuer den naechsten Frame (oder null) */
function kiHinweis() {
  if (!kiLetzte) { return null; }
  if (performance.now() - kiLetzte.zeit > KI_HALTBAR_MS) { return null; }
  return kiLetzte;
}

/* Eckpunkte aus der Erkennung in Overlay-Koordinaten umrechnen */
function nachOverlay(quad, info) {
  var sx = info.ew / info.w, sy = info.eh / info.h;
  return quad.map(function (p) { return [p[0] * sx, p[1] * sy]; });
}

function overlayDiagonale() {
  return Math.hypot(overlay.clientWidth, overlay.clientHeight) || 1;
}

function quadAbstand(a, b) {
  if (!a || !b) { return 1e9; }
  var m = 0;
  for (var i = 0; i < 4; i++) {
    m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  }
  return m;
}

function messungAufnehmen(n, info) {
  var jetzt = performance.now();
  /* Schaerfe-Bestwert langsam verfallen lassen: so bleibt der Massstab
   * bei wechselndem Licht / Motiv realistisch. */
  if (typeof n.schaerfe === "number" && n.schaerfe > 0) {
    schaerfeJetzt = n.schaerfe;
    if (n.schaerfe > schaerfeBest || jetzt - schaerfeBestZeit > 2500) {
      schaerfeBest = Math.max(n.schaerfe, schaerfeBest * 0.6);
      schaerfeBestZeit = jetzt;
    }
  }
  if (typeof n.bewegung === "number") { bewegungJetzt = n.bewegung; }

  if (!n.quad || !info) { return; }
  var q = nachOverlay(n.quad, info);
  var diag = overlayDiagonale();

  /* Ausreisser-Schutz: ein einzelner Fehlgriff darf den Rahmen nicht
   * wegspringen lassen - er muss im naechsten Bild bestaetigt werden. */
  if (zielQuad && jetzt - letzteMessung < 400 &&
      quadAbstand(q, zielQuad) > 0.3 * diag) {
    if (!verdaechtig || quadAbstand(q, verdaechtig) > 0.12 * diag) {
      verdaechtig = q;
      return;
    }
  }
  verdaechtig = null;

  zielQuad = q;
  letzteMessung = jetzt;
  verlauf.push({ t: jetzt, q: q });
  while (verlauf.length > 2 && jetzt - verlauf[0].t > FENSTER_MS) { verlauf.shift(); }
}

/* Zittern (Abweichung von der mittleren Lage) und Wandergeschwindigkeit */
function ruheMasse() {
  if (verlauf.length < 3) { return null; }
  var spanne = verlauf[verlauf.length - 1].t - verlauf[0].t;
  if (spanne < 140) { return null; }
  var diag = overlayDiagonale(), i, k;
  var zitter = 0;
  for (k = 0; k < 4; k++) {
    var mx = 0, my = 0;
    for (i = 0; i < verlauf.length; i++) {
      mx += verlauf[i].q[k][0] / verlauf.length;
      my += verlauf[i].q[k][1] / verlauf.length;
    }
    for (i = 0; i < verlauf.length; i++) {
      var d = Math.hypot(verlauf[i].q[k][0] - mx, verlauf[i].q[k][1] - my);
      if (d > zitter) { zitter = d; }
    }
  }
  var weg = 0;
  for (k = 0; k < 4; k++) {
    weg += Math.hypot(verlauf[verlauf.length - 1].q[k][0] - verlauf[0].q[k][0],
                      verlauf[verlauf.length - 1].q[k][1] - verlauf[0].q[k][1]) / 4;
  }
  return { zitter: zitter / diag, tempo: (weg / diag) / (spanne / 1000) };
}

/* =========================== Schleife =========================== */
var letzteSendung = 0;
var letzterRahmen = 0;

function schleife() {
  if (!liveAktiv) { return; }
  requestAnimationFrame(schleife);
  var jetzt = performance.now();

  if (!scanLaeuft && !geradeAusgeloest && !erkOffen &&
      video.readyState >= 2 && jetzt - letzteSendung > 28) {
    var f = liveFrame();
    if (f) {
      letzteSendung = jetzt;
      erkFolge++;
      erkAnfragen[erkFolge] = { ew: f.aus.ew, eh: f.aus.eh, w: f.breite, h: f.hoehe };
      erkOffen = true;

      /* Derselbe Frame geht zusaetzlich an die KI - aber nur, wenn sie
       * gerade frei ist. Dafuer braucht sie eine eigene Kopie, weil der
       * Puffer an den Geometrie-Worker UEBERGEBEN (nicht kopiert) wird. */
      var kiKopie = null;
      if (kiWorker && kiBereit && !kiOffen && jetzt - kiLetzteSendung > KI_ABSTAND_MS) {
        kiKopie = new Uint8ClampedArray(f.daten.data);
      }

      var hinweis = kiHinweis();
      var puffer = f.daten.data.buffer;
      erkWorker.postMessage({ typ: "live", rgba: puffer, breite: f.breite,
                              hoehe: f.hoehe, folge: erkFolge,
                              kiQuad: hinweis ? hinweis.quad : null,
                              kiKonf: hinweis ? hinweis.konf : 0 }, [puffer]);

      if (kiKopie) {
        kiOffen = true;
        kiLetzteSendung = jetzt;
        kiWorker.postMessage({ typ: "live", rgba: kiKopie.buffer,
                               breite: f.breite, hoehe: f.hoehe,
                               folge: erkFolge }, [kiKopie.buffer]);
      }
    }
  }

  var dt = letzterRahmen ? Math.min(100, jetzt - letzterRahmen) : 16;
  letzterRahmen = jetzt;
  zeichne(dt);
  pruefeAusloeser(jetzt, dt);
}

function flaecheAnteil(q) {
  if (!q) { return 0; }
  var a = 0;
  for (var i = 0; i < 4; i++) {
    var p = q[i], n = q[(i + 1) % 4];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return Math.abs(a / 2) / (overlay.clientWidth * overlay.clientHeight);
}

/* ========================== Zeichnen ============================ */
var puls = 0;
function zeichne(dt) {
  var w = overlay.clientWidth, h = overlay.clientHeight;
  ctx.clearRect(0, 0, w, h);
  puls += 0.04;

  var frisch = zielQuad && (performance.now() - letzteMessung) < VERLUST_MS;
  if (!frisch) {
    /* Rahmen weich ausblenden statt hart verschwinden lassen */
    if (letzterQuad) {
      letzterQuad.alpha = (letzterQuad.alpha === undefined ? 1 : letzterQuad.alpha) - dt / 220;
      if (letzterQuad.alpha <= 0) { letzterQuad = null; }
    }
  } else if (!letzterQuad) {
    letzterQuad = zielQuad.map(function (p) { return [p[0], p[1]]; });
    letzterQuad.alpha = 1;
  } else {
    /* Adaptive Glaettung: kleine Abweichungen stark daempfen (kein
     * Zittern), grosse Bewegungen schnell nachfuehren (kein Nachziehen). */
    var diag = overlayDiagonale();
    var fehler = quadAbstand(zielQuad, letzterQuad) / diag;
    var basis = Math.min(0.85, 0.14 + 3.2 * fehler);
    var a = 1 - Math.pow(1 - basis, dt / 16.7);
    for (var i = 0; i < 4; i++) {
      letzterQuad[i][0] += (zielQuad[i][0] - letzterQuad[i][0]) * a;
      letzterQuad[i][1] += (zielQuad[i][1] - letzterQuad[i][1]) * a;
    }
    letzterQuad.alpha = Math.min(1, (letzterQuad.alpha === undefined ? 1 : letzterQuad.alpha) + dt / 160);
  }

  var q = letzterQuad;
  if (!q) { return; }

  var stark = bereitschaft > 0.12;
  var glanz = 0.5 + 0.5 * Math.sin(puls);
  var sicht = Math.max(0, Math.min(1, q.alpha === undefined ? 1 : q.alpha));

  ctx.save();
  ctx.globalAlpha = sicht;
  ctx.beginPath();
  ctx.moveTo(q[0][0], q[0][1]);
  for (var k = 1; k < 4; k++) { ctx.lineTo(q[k][0], q[k][1]); }
  ctx.closePath();

  var mitte = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
  var r = Math.max(w, h) * 0.6;
  var fl = ctx.createRadialGradient(mitte[0], mitte[1], 10, mitte[0], mitte[1], r);
  fl.addColorStop(0, stark ? "rgba(58,160,255,0.42)" : "rgba(58,160,255,0.22)");
  fl.addColorStop(1, stark ? "rgba(25,232,255,0.20)" : "rgba(25,232,255,0.10)");
  ctx.fillStyle = fl;
  ctx.fill();

  ctx.lineJoin = "round";
  ctx.strokeStyle = stark ? "rgba(140,230,255," + (0.85 + 0.15 * glanz) + ")"
                          : "rgba(180,215,255,0.68)";
  ctx.lineWidth = stark ? 4 : 2.5;
  ctx.shadowColor = "rgba(58,160,255,0.9)";
  ctx.shadowBlur = stark ? 24 + 10 * glanz : 12;
  ctx.stroke();
  ctx.restore();

  /* Ecken */
  ctx.save();
  ctx.globalAlpha = sicht;
  for (var e = 0; e < 4; e++) {
    var rad = (stark ? 9 : 6.5) + (stark ? 1.6 * glanz : 0);
    ctx.beginPath();
    ctx.arc(q[e][0], q[e][1], rad, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.shadowColor = "rgba(25,232,255,0.95)";
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

/* ==================== Automatischer Ausloeser ==================== */
function pruefeAusloeser(jetzt, dt) {
  if (scanLaeuft || geradeAusgeloest) {
    bereitschaftSetzen(0);
    setHinweis(scanLaeuft ? "" : "Dokument anvisieren", false);
    return;
  }

  var frisch = zielQuad && (jetzt - letzteMessung) < VERLUST_MS;
  if (!frisch) {
    bereitschaftAendern(-dt / ABBAU_MS);
    setHinweis("Dokument anvisieren", false);
    if (zielQuad && jetzt - letzteMessung > 1200) { verlauf.length = 0; zielQuad = null; }
    return;
  }

  if (flaecheAnteil(zielQuad) < MIN_FLAECHE) {
    bereitschaftAendern(-dt / ABBAU_MS);
    setHinweis("N\u00e4her herangehen", false);
    return;
  }

  var ruhe = ruheMasse();
  var unruhig = !ruhe || ruhe.zitter > ZITTER_MAX || ruhe.tempo > TEMPO_MAX ||
                (bewegungJetzt >= 0 && bewegungJetzt > BEWEGUNG_MAX);
  if (unruhig) {
    /* nur bruchteilhaft zurueck - kurzes Wackeln kostet keinen Neustart */
    bereitschaftAendern(-dt / ABBAU_MS);
    setHinweis(bereitschaft > 0.25 ? "Fast geschafft" : "Ruhig halten", false);
    return;
  }

  /* bewegungsunscharfe Frames nicht aufnehmen */
  if (schaerfeJetzt > 0 && schaerfeJetzt < SCHAERFE_ANTEIL * schaerfeBest) {
    bereitschaftAendern(-dt / (2 * ABBAU_MS));
    setHinweis("Sch\u00e4rfe wird gesucht", false);
    return;
  }

  bereitschaftAendern(dt / AUFBAU_MS);
  setHinweis("Dokument erkannt", true);
  if (bereitschaft >= 1) { ausloesen(); }
}

function bereitschaftAendern(delta) {
  bereitschaftSetzen(bereitschaft + delta);
}

function bereitschaftSetzen(wert) {
  bereitschaft = Math.max(0, Math.min(1, wert));
  var sichtbar = bereitschaft > 0.04;
  if (sichtbar !== ringAn) {
    ringAn = sichtbar;
    ringBox.classList.toggle("aktiv", sichtbar);
  }
  ringFg.style.strokeDashoffset = String(327 * (1 - bereitschaft));
}

/* Hinweistexte mit Beruhigung: ein Text muss sich erst "durchsetzen",
 * bevor er angezeigt wird. Sonst flackert die Zeile bei jedem Frame. */
var hinweisZiel = "", hinweisZielGut = false, hinweisSeit = 0, hinweisAktuell = null;
function setHinweis(text, gut) {
  var jetzt = performance.now();
  if (text !== hinweisZiel) { hinweisZiel = text; hinweisZielGut = gut; hinweisSeit = jetzt; }
  var reif = (jetzt - hinweisSeit) >= HINWEIS_RUHE_MS;
  if (hinweisAktuell === null || reif || text === hinweisAktuell) {
    if (hinweisAktuell !== text) { hinweisAktuell = text; }
    if (!text) { hinweis.classList.add("verborgen"); autoPille.classList.remove("scharf"); return; }
    hinweis.classList.remove("verborgen");
    if (hinweis.textContent !== text) { hinweis.textContent = text; }
    hinweis.classList.toggle("gut", !!gut);
    autoPille.classList.toggle("scharf", !!gut);
  }
}

function zuruecksetzenErkennung() {
  zielQuad = null; letzterQuad = null; verdaechtig = null;
  verlauf.length = 0; letzteMessung = 0;
  bewegungJetzt = -1; schaerfeJetzt = 0; schaerfeBest = 1; schaerfeBestZeit = 0;
  bereitschaftSetzen(0);
  hinweisAktuell = null; hinweisZiel = "";
}

function ausloesen() {
  geradeAusgeloest = true;
  bereitschaftSetzen(0);
  blitzen();
  if (navigator.vibrate) { try { navigator.vibrate(18); } catch (f) {} }
  var a = sichtbarerAusschnitt();
  if (!a) { geradeAusgeloest = false; return; }
  var f = MAX_KANTE / Math.max(a.sw, a.sh);
  if (f > 1) { f = 1; }
  var cw = Math.round(a.sw * f), ch = Math.round(a.sh * f);
  var c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  var cc = c.getContext("2d");
  cc.drawImage(video, a.sx, a.sy, a.sw, a.sh, 0, 0, cw, ch);
  var bd = cc.getImageData(0, 0, cw, ch);

  /* Das live erkannte Viereck wird in Bildkoordinaten der Aufnahme
   * umgerechnet und mitgegeben: die Pipeline muss das Dokument dann nicht
   * noch einmal von Null suchen, sondern zieht nur noch die Kanten im
   * grossen Bild nach. Das Ergebnis sitzt damit genau dort, wo der
   * Rahmen im Sucher stand. */
  var hinweisQuad = null;
  if (letzterQuad && overlay.clientWidth) {
    var sx = cw / overlay.clientWidth, sy = ch / overlay.clientHeight;
    hinweisQuad = letzterQuad.map(function (p) { return [p[0] * sx, p[1] * sy]; });
  }
  scanStarten(bd, hinweisQuad);
}

function blitzen() {
  var b = document.createElement("div");
  b.className = "blitz";
  document.body.appendChild(b);
  setTimeout(function () { b.remove(); }, 440);
}

/* ========================== Scan-Stil =========================== */
/* Drei Veredelungen, die scan_wrapper.py anbietet. "farbe" ist der
 * Normalfall: Papier wird weiss, Text bleibt vollstaendig, Farben
 * bleiben Farben. "grau" spart Platz, "sw" ist der klassische
 * Kopierer-Look (Sauvola-Schwelle) fuer reine Textseiten. */
var STILE = [
  { id: "farbe", name: "Farbe" },
  { id: "grau",  name: "Graustufen" },
  { id: "sw",    name: "Schwarz-Wei\u00df" }
];
var stilIndex = 0;

function stilLaden() {
  try {
    var g = localStorage.getItem("ultra-scan-stil");
    for (var i = 0; i < STILE.length; i++) {
      if (STILE[i].id === g) { stilIndex = i; }
    }
  } catch (e) { /* Privatmodus: dann eben Standard */ }
  stilAnzeigen();
}

function stilAnzeigen() {
  if (stilPille) { stilPille.textContent = STILE[stilIndex].name; }
}

function stilWeiter() {
  stilIndex = (stilIndex + 1) % STILE.length;
  stilAnzeigen();
  try { localStorage.setItem("ultra-scan-stil", STILE[stilIndex].id); } catch (e) { /* egal */ }
  toast(STILE[stilIndex].name);
}

if (stilPille) { stilPille.addEventListener("click", stilWeiter); }
stilLaden();

/* ========================== Scannen ============================= */
function scanStarten(bilddaten, quadHinweis) {
  scanLaeuft = true;
  zuruecksetzenErkennung();
  arbeitOverlay.classList.remove("verborgen");
  aktualisiereTopbarStatus();
  var puffer = bilddaten.data.buffer;
  worker.postMessage({
    typ: "scan", rgba: puffer,
    breite: bilddaten.width, hoehe: bilddaten.height,
    quad: quadHinweis || null,
    veredelung: STILE[stilIndex].id
  }, [puffer]);
}

/* Fuer Bilder OHNE Live-Erkennung (Foto, Datei, Zwischenablage): erst die
 * Ecken in voller Aufloesung suchen, dann scannen. Damit findet die App
 * auch auf mitgebrachten Fotos ein Dokument, wo die alte Pipeline
 * "Kein Dokument gefunden" gemeldet hat. */
function scanMitVorerkennung(bilddaten) {
  standbildMarke++;
  var marke = standbildMarke;
  var fertig = false;
  var los = function (quad) {
    if (fertig) { return; }
    fertig = true;
    scanStarten(bilddaten, quad || null);
  };
  setTimeout(function () { los(null); }, 9000);        // Notbremse

  /* Schritt 2: Geometrie - mit dem KI-Viereck als Kandidat. */
  var geometrie = function (kiQuad, kiKonf) {
    if (fertig) { return; }
    var kopie = new Uint8ClampedArray(bilddaten.data);  // Puffer wird uebertragen
    standbildWartet[marke] = function (quad) { los(quad); };
    setTimeout(function () {                            // zweite Notbremse
      if (standbildWartet[marke]) {
        delete standbildWartet[marke];
        los(kiQuad || null);
      }
    }, 5000);
    erkWorker.postMessage({
      typ: "standbild", marke: marke, rgba: kopie.buffer,
      breite: bilddaten.width, hoehe: bilddaten.height,
      kiQuad: kiQuad || null, kiKonf: kiKonf || 0
    }, [kopie.buffer]);
  };

  /* Schritt 1: KI befragen (wenn vorhanden). Sie darf hier gruendlich
   * arbeiten - ein mitgebrachtes Foto ist kein Sucherbild, 300 ms mehr
   * fallen nicht auf. */
  if (kiWorker) {
    var kiFertig = false;
    kiStandbild[marke] = function (quad, konf) {
      if (kiFertig) { return; }
      kiFertig = true;
      geometrie(quad, konf);
    };
    setTimeout(function () {
      if (!kiFertig) {
        kiFertig = true;
        delete kiStandbild[marke];
        geometrie(null, 0);
      }
    }, 3500);
    var kiKopie = new Uint8ClampedArray(bilddaten.data);
    kiWorker.postMessage({
      typ: "standbild", marke: marke, rgba: kiKopie.buffer,
      breite: bilddaten.width, hoehe: bilddaten.height
    }, [kiKopie.buffer]);
  } else {
    geometrie(null, 0);
  }
}

function scanFertig() {
  scanLaeuft = false;
  geradeAusgeloest = false;
  arbeitOverlay.classList.add("verborgen");
}

function ergebnisUebernehmen(n) {
  var c = document.createElement("canvas");
  c.width = n.breite; c.height = n.hoehe;
  c.getContext("2d").putImageData(
    new ImageData(new Uint8ClampedArray(n.rgba), n.breite, n.hoehe), 0, 0);
  c.toBlob(function (blob) {
    scanFertig();
    if (!blob) { zeigeMeldung("Das hat nicht geklappt", "Das Ergebnis konnte nicht erzeugt werden.", "!"); return; }
    scans.push({ blob: blob, url: URL.createObjectURL(blob), drehung: 0, anzeigeDrehung: 0 });
    zeigeGalerie();
    toast(scans.length === 1 ? "Scan fertig" : scans.length + " Scans");
  }, "image/jpeg", 0.93);
}

/* ======================= Bildquellen ============================ */
el("btn-quelle").addEventListener("click", function () { quelleSheet.classList.remove("verborgen"); });
el("btn-sheet-schliessen").addEventListener("click", function () { quelleSheet.classList.add("verborgen"); });
quelleSheet.addEventListener("click", function (e) { if (e.target === quelleSheet) { quelleSheet.classList.add("verborgen"); } });

el("btn-foto").addEventListener("click", function () {
  quelleSheet.classList.add("verborgen");
  el("datei-input-foto").click();
});
el("btn-datei").addEventListener("click", function () {
  quelleSheet.classList.add("verborgen");
  el("datei-input-datei").click();
});
["datei-input-foto", "datei-input-datei"].forEach(function (id) {
  el(id).addEventListener("change", function () {
    var d = this.files && this.files[0];
    this.value = "";
    if (d) { bildVerarbeiten(d); }
  });
});

el("btn-zwischenablage").addEventListener("click", function () {
  quelleSheet.classList.add("verborgen");
  if (!navigator.clipboard || !navigator.clipboard.read) {
    zeigeMeldung("Zwischenablage nicht m\u00f6glich",
      "Dieser Browser gibt die Zwischenablage nicht frei. Nutze \u201eFoto ausw\u00e4hlen\u201c \u2013 oder f\u00fcge das Bild direkt auf dieser Seite mit Einsetzen ein.", "\u2398");
    return;
  }
  navigator.clipboard.read().then(function (eintraege) {
    for (var i = 0; i < eintraege.length; i++) {
      var typen = eintraege[i].types;
      for (var j = 0; j < typen.length; j++) {
        if (typen[j].indexOf("image/") === 0) {
          return eintraege[i].getType(typen[j]).then(bildVerarbeiten);
        }
      }
    }
    throw new Error("kein Bild");
  }).catch(function () {
    zeigeMeldung("Nichts zum Einf\u00fcgen",
      "In der Zwischenablage liegt kein Bild \u2013 oder das Ger\u00e4t erlaubt den Zugriff nicht. Nutze \u201eFoto ausw\u00e4hlen\u201c.", "\u2398");
  });
});

/* Einsetzen per Tastatur / iPadOS-Menue */
window.addEventListener("paste", function (e) {
  var d = e.clipboardData;
  if (!d) { return; }
  for (var i = 0; i < d.items.length; i++) {
    if (d.items[i].type.indexOf("image/") === 0) {
      var f = d.items[i].getAsFile();
      if (f) { e.preventDefault(); bildVerarbeiten(f); return; }
    }
  }
});

function bildVerarbeiten(blob) {
  if (scanLaeuft) { return; }
  arbeitOverlay.classList.remove("verborgen");
  ladeBild(blob).then(function (bd) {
    scanMitVorerkennung(bd);
  }).catch(function () {
    arbeitOverlay.classList.add("verborgen");
    zeigeMeldung("Bild nicht lesbar", "Dieses Format kann nicht ge\u00f6ffnet werden. Versuche ein JPEG oder PNG.", "!");
  });
}

function ladeBild(blob) {
  return new Promise(function (ok, nein) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      try {
        var b = img.naturalWidth, h = img.naturalHeight;
        if (!b || !h) { throw new Error("leer"); }
        var f = Math.min(1, MAX_KANTE / Math.max(b, h));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(b * f));
        c.height = Math.max(1, Math.round(h * f));
        var cc = c.getContext("2d");
        cc.drawImage(img, 0, 0, c.width, c.height);
        var bd = cc.getImageData(0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(bd);
      } catch (f2) { URL.revokeObjectURL(url); nein(f2); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); nein(new Error("Format")); };
    img.src = url;
  });
}

/* ========================== Galerie ============================= */
function scanZaehlerText() {
  return scans.length + (scans.length === 1 ? " Scan" : " Scans");
}

function aktualisiereTopbarStatus() {
  if (!scans.length) {
    topbarStatus.textContent = "";
    topbarStatus.classList.add("verborgen");
    return;
  }
  var text = scanZaehlerText();
  topbarStatus.textContent = text;
  topbarStatus.setAttribute("aria-label", "Zu den fertigen Scans (" + text + ")");
  topbarStatus.classList.remove("verborgen");
}

topbarStatus.addEventListener("click", function () {
  if (!scans.length) { return; }
  if (galerieScreen.classList.contains("verborgen")) { zeigeGalerie(); }
});

function zeigeGalerie() {
  liveAktiv = false;
  kameraScreen.classList.add("verborgen");
  galerieScreen.classList.remove("verborgen");
  baueGalerie();
  aktualisiereTopbarStatus();
}

function zeigeKamera() {
  galerieScreen.classList.add("verborgen");
  kameraScreen.classList.remove("verborgen");
  zuruecksetzenErkennung();
  passeOverlayAn();
  aktualisiereTopbarStatus();
  if (stream) {
    liveAktiv = true;
    schleife();
  } else {
    starteKamera();
  }
}

function baueGalerie() {
  galerieListe.innerHTML = "";
  scans.forEach(function (s, i) {
    if (typeof s.anzeigeDrehung !== "number") { s.anzeigeDrehung = normalisiereDrehung(s.drehung || 0); }
    s.drehung = normalisiereDrehung(s.drehung || 0);

    var karte = document.createElement("div");
    karte.className = "scan-karte";

    var kopf = document.createElement("div");
    kopf.className = "scan-kopf";
    kopf.innerHTML = "<span>Scan " + (i + 1) + "</span>";

    var wz = document.createElement("div");
    wz.className = "scan-werkzeuge";

    var drehen = document.createElement("button");
    drehen.className = "werkzeug";
    drehen.setAttribute("aria-label", "Um 90 Grad drehen");
    drehen.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>';
    drehen.addEventListener("click", function () {
      if (typeof s.anzeigeDrehung !== "number") { s.anzeigeDrehung = normalisiereDrehung(s.drehung || 0); }
      s.anzeigeDrehung += 90;
      s.drehung = normalisiereDrehung(s.anzeigeDrehung);
      setzeBildDrehung(bild, s.anzeigeDrehung);
      passeRahmenAn(rahmen, bild, s.drehung);
    });
    wz.appendChild(drehen);

    if (scans.length >= 2) {
      var weg = document.createElement("button");
      weg.className = "werkzeug loeschen";
      weg.setAttribute("aria-label", "Scan l\u00f6schen");
      weg.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9Z"/></svg>';
      weg.addEventListener("click", function () {
        karte.classList.add("geht");
        setTimeout(function () {
          URL.revokeObjectURL(s.url);
          scans.splice(scans.indexOf(s), 1);
          baueGalerie();
          aktualisiereTopbarStatus();
        }, 300);
      });
      wz.appendChild(weg);
    }

    kopf.appendChild(wz);

    var rahmen = document.createElement("div");
    rahmen.className = "scan-bild-rahmen";
    var bild = document.createElement("img");
    bild.src = s.url;
    bild.alt = "Scan " + (i + 1);
    setzeBildDrehung(bild, s.anzeigeDrehung);
    bild.addEventListener("load", function () { passeRahmenAn(rahmen, bild, s.drehung); });
    rahmen.appendChild(bild);

    karte.appendChild(kopf);
    karte.appendChild(rahmen);
    galerieListe.appendChild(karte);
  });
}

function normalisiereDrehung(winkel) {
  return ((winkel % 360) + 360) % 360;
}

function setzeBildDrehung(bild, winkel) {
  bild.style.transform = "translate(-50%, -50%) rotate(" + winkel + "deg)";
}

function galerieMaxBildHoehe() {
  var h = window.innerHeight || 800;
  if (window.matchMedia && window.matchMedia("(max-height: 520px)").matches) { return h * 0.62; }
  if (window.matchMedia && window.matchMedia("(min-width: 1000px)").matches) { return h * 0.52; }
  if (window.matchMedia && window.matchMedia("(min-width: 700px)").matches) { return h * 0.46; }
  return h * 0.58;
}

/* Bei 90/270 Grad muessen Breite und Hoehe getauscht werden. Das Bild wird
 * absolut im Mittelpunkt des Rahmens gehalten, damit die Drehung nicht nach
 * unten aus dem sichtbaren Bereich wandert. */
function passeRahmenAn(rahmen, bild, drehung) {
  if (!bild.naturalWidth || !bild.naturalHeight) { return; }
  var winkel = normalisiereDrehung(drehung || 0);
  var quer = (winkel % 180) !== 0;
  var nw = bild.naturalWidth;
  var nh = bild.naturalHeight;
  var sichtBreiteNat = quer ? nh : nw;
  var sichtHoeheNat = quer ? nw : nh;
  var breiteRahmen = rahmen.clientWidth || (rahmen.parentElement && rahmen.parentElement.clientWidth) || 300;
  var maxHoehe = galerieMaxBildHoehe();
  var faktor = Math.min(1, breiteRahmen / sichtBreiteNat, maxHoehe / sichtHoeheNat);
  var layoutBreite = Math.max(1, nw * faktor);
  var layoutHoehe = Math.max(1, nh * faktor);
  var sichtHoehe = Math.max(160, sichtHoeheNat * faktor);

  bild.style.width = Math.round(layoutBreite) + "px";
  bild.style.height = Math.round(layoutHoehe) + "px";
  bild.style.maxWidth = "none";
  bild.style.maxHeight = "none";
  rahmen.style.height = Math.round(sichtHoehe) + "px";
}

el("btn-weiter-scannen").addEventListener("click", zeigeKamera);

var galerieLayoutTimer = null;
function planeGalerieLayoutUpdate() {
  if (galerieScreen.classList.contains("verborgen")) { return; }
  clearTimeout(galerieLayoutTimer);
  galerieLayoutTimer = setTimeout(baueGalerie, 90);
}
window.addEventListener("resize", planeGalerieLayoutUpdate);
window.addEventListener("orientationchange", function () { setTimeout(planeGalerieLayoutUpdate, 260); });

/* ========================== Teilen =============================== */
el("btn-teilen").addEventListener("click", function () { teilenSheet.classList.remove("verborgen"); });
el("btn-teilen-schliessen").addEventListener("click", function () { teilenSheet.classList.add("verborgen"); });
teilenSheet.addEventListener("click", function (e) { if (e.target === teilenSheet) { teilenSheet.classList.add("verborgen"); } });

function heute() { return new Date().toISOString().slice(0, 10); }

/* gedrehten Scan als JPEG-Blob rendern */
function gerendert(s) {
  return new Promise(function (ok, nein) {
    var img = new Image();
    img.onload = function () {
      var quer = (s.drehung % 180) !== 0;
      var c = document.createElement("canvas");
      c.width  = quer ? img.naturalHeight : img.naturalWidth;
      c.height = quer ? img.naturalWidth  : img.naturalHeight;
      var cc = c.getContext("2d");
      cc.fillStyle = "#fff";
      cc.fillRect(0, 0, c.width, c.height);
      cc.translate(c.width / 2, c.height / 2);
      cc.rotate(s.drehung * Math.PI / 180);
      cc.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      c.toBlob(function (b) {
        if (!b) { nein(new Error("render")); return; }
        ok({ blob: b, breite: c.width, hoehe: c.height });
      }, "image/jpeg", 0.92);
    };
    img.onerror = function () { nein(new Error("laden")); };
    img.src = s.url;
  });
}

el("btn-teilen-bild").addEventListener("click", function () {
  teilenSheet.classList.add("verborgen");
  Promise.all(scans.map(gerendert)).then(function (liste) {
    var dateien = liste.map(function (r, i) {
      return new File([r.blob], "Ultra-Scan-" + heute() + (liste.length > 1 ? "-" + (i + 1) : "") + ".jpg",
        { type: "image/jpeg" });
    });
    teileDateien(dateien, "Ultra Scan");
  }).catch(function () { toast("Teilen nicht m\u00f6glich"); });
});

el("btn-teilen-pdf").addEventListener("click", function () {
  teilenSheet.classList.add("verborgen");
  toast("PDF wird erstellt \u2026");
  Promise.all(scans.map(gerendert)).then(function (liste) {
    return Promise.all(liste.map(function (r) {
      return r.blob.arrayBuffer().then(function (ab) {
        return { jpeg: new Uint8Array(ab), breite: r.breite, hoehe: r.hoehe };
      });
    }));
  }).then(function (seiten) {
    var blob = UltraPDF.erzeuge(seiten);
    var datei = new File([blob], "Ultra-Scan-" + heute() + ".pdf", { type: "application/pdf" });
    teileDateien([datei], "Ultra Scan PDF");
  }).catch(function () { toast("PDF nicht m\u00f6glich"); });
});

function teileDateien(dateien, titel) {
  if (navigator.canShare && navigator.canShare({ files: dateien }) && navigator.share) {
    navigator.share({ files: dateien, title: titel }).catch(function (f) {
      if (f && f.name !== "AbortError") { dateien.forEach(herunterladen); }
    });
  } else {
    dateien.forEach(herunterladen);
    toast("Gespeichert");
  }
}

function herunterladen(datei) {
  var url = URL.createObjectURL(datei);
  var a = document.createElement("a");
  a.href = url;
  a.download = datei.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

/* ========================= Meldungen ============================= */
var meldungButton   = el("btn-meldung-ok");
var meldungNeuLaden = false;
function zeigeMeldung(titel, text, symbol, neuLaden) {
  meldungTitel.textContent = titel;
  meldungText.textContent = text;
  el("meldung-symbol").textContent = symbol || "!";
  meldungNeuLaden = !!neuLaden;
  meldungButton.textContent = meldungNeuLaden ? "Seite neu laden" : "Verstanden";
  meldungOv.classList.remove("verborgen");
}
meldungButton.addEventListener("click", function () {
  if (meldungNeuLaden) { window.location.reload(); return; }
  meldungOv.classList.add("verborgen");
});

var toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("verborgen");
  void toastEl.offsetWidth;
  toastEl.classList.add("sichtbar");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toastEl.classList.remove("sichtbar");
    setTimeout(function () { toastEl.classList.add("verborgen"); }, 350);
  }, 1900);
}

/* Kamera pausieren, wenn die App in den Hintergrund geht */
document.addEventListener("visibilitychange", function () {
  if (document.hidden) {
    liveAktiv = false;
  } else if (galerieScreen.classList.contains("verborgen") && stream) {
    liveAktiv = true;
    schleife();
  }
});
