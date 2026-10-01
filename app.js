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
var MIN_FLAECHE     = 0.17;   // Viereck muss >= 17 % des Bildes fuellen
var STABIL_PIXEL    = 0.035;  // max. Eckenwanderung (Anteil der Bilddiagonale)
var STABIL_FRAMES   = 3;      // so viele gute Frames in Folge
var RUHE_SCHWELLE   = 7.0;    // mittlere Helligkeitsaenderung je Pixel
var COUNTDOWN_MS    = 900;

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
var arbeitOverlay= el("arbeit-overlay");
var meldungOv    = el("meldung-overlay");
var meldungTitel = el("meldung-titel");
var meldungText  = el("meldung-text");
var quelleSheet  = el("quelle-sheet");
var teilenSheet  = el("teilen-sheet");
var hinweis      = el("kamera-hinweis");
var autoPille    = el("auto-pille");
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
var liveOffen     = false;        // Live-Anfrage unterwegs
var liveAktiv     = false;        // Erkennungsschleife laeuft
var stream        = null;
var kameraRichtung= "environment";
var zoom          = 1;
var zoomMax       = 5;
var trackZoom     = null;         // native Zoom-Faehigkeit (falls vorhanden)
var scans         = [];           // { blob, url, drehung }
var letzterQuad   = null;         // gezeichnetes (geglaettetes) Viereck
var zielQuad      = null;
var gutFrames     = 0;
var countdownBis  = 0;
var countdownAn   = false;
var letztesGrau   = null;
var ruheWert      = 999;
var geradeAusgeloest = false;

/* ======================= Service Worker ========================= */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(function () {});
}

/* ========================== Worker ============================== */
var worker = new Worker("worker.js");

worker.onerror = function (f) {
  zeigeMeldung("Start fehlgeschlagen", "Bitte die Seite neu laden.", "!");
};

worker.onmessage = function (e) {
  var n = e.data;
  if (n.typ === "fortschritt") {
    ladeBalken.style.width = Math.max(2, n.prozent) + "%";
  } else if (n.typ === "bereit") {
    workerBereit = true;
    ladeBalken.style.width = "100%";
    setTimeout(function () {
      ladeOverlay.classList.add("verborgen");
      starteKamera();
    }, 450);
  } else if (n.typ === "quad") {
    liveOffen = false;
    quadErhalten(n.quad);
  } else if (n.typ === "ergebnis") {
    ergebnisUebernehmen(n);
  } else if (n.typ === "keindokument") {
    scanFertig();
    zeigeMeldung("Kein Dokument gefunden",
      "Auf diesem Bild ist kein Dokument zu erkennen. Versuche es mit einer Aufnahme, auf der das Blatt vollst\u00e4ndig und mit Abstand zum Untergrund zu sehen ist.", "!");
  } else if (n.typ === "fehler") {
    liveOffen = false;
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

/* Ruhe-Messung: mittlere Helligkeitsaenderung zwischen zwei Frames */
function messeRuhe(bilddaten) {
  var d = bilddaten.data, n = d.length / 4;
  var schritt = Math.max(1, Math.floor(n / 2400));
  var grau = [];
  for (var i = 0; i < n; i += schritt) {
    var p = i * 4;
    grau.push((d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000);
  }
  if (letztesGrau && letztesGrau.length === grau.length) {
    var s = 0;
    for (var j = 0; j < grau.length; j++) { s += Math.abs(grau[j] - letztesGrau[j]); }
    ruheWert = s / grau.length;
  }
  letztesGrau = grau;
}

var letzteLive = 0;
function schleife() {
  if (!liveAktiv) { return; }
  requestAnimationFrame(schleife);
  var jetzt = performance.now();

  if (!scanLaeuft && !liveOffen && workerBereit && jetzt - letzteLive > 90 &&
      video.readyState >= 2 && !geradeAusgeloest) {
    var f = liveFrame();
    if (f) {
      letzteLive = jetzt;
      messeRuhe(f.daten);
      liveOffen = true;
      var puffer = f.daten.data.buffer.slice(0);
      worker.postMessage({ typ: "live", rgba: puffer, breite: f.breite, hoehe: f.hoehe }, [puffer]);
      liveSkala = { ew: f.aus.ew, eh: f.aus.eh, w: f.breite, h: f.hoehe };
    }
  }

  zeichne();
  pruefeAusloeser(jetzt);
}

var liveSkala = null;

function quadErhalten(q) {
  if (!q || !liveSkala) { zielQuad = null; return; }
  var sx = liveSkala.ew / liveSkala.w, sy = liveSkala.eh / liveSkala.h;
  zielQuad = q.map(function (p) { return [p[0] * sx, p[1] * sy]; });
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

function quadAbstand(a, b) {
  if (!a || !b) { return 1e9; }
  var m = 0;
  for (var i = 0; i < 4; i++) {
    m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  }
  return m;
}

var puls = 0;
function zeichne() {
  var w = overlay.clientWidth, h = overlay.clientHeight;
  ctx.clearRect(0, 0, w, h);
  puls += 0.04;

  /* weiches Nachfuehren der Ecken */
  if (zielQuad) {
    if (!letzterQuad) {
      letzterQuad = zielQuad.map(function (p) { return [p[0], p[1]]; });
    } else {
      for (var i = 0; i < 4; i++) {
        letzterQuad[i][0] += (zielQuad[i][0] - letzterQuad[i][0]) * 0.28;
        letzterQuad[i][1] += (zielQuad[i][1] - letzterQuad[i][1]) * 0.28;
      }
    }
  } else {
    letzterQuad = null;
  }
  var q = letzterQuad;
  if (!q) { return; }

  var stark = gutFrames >= STABIL_FRAMES;
  var glanz = 0.5 + 0.5 * Math.sin(puls);

  ctx.save();
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
}

/* ==================== Automatischer Ausloeser ==================== */
var letzteBewertung = null;
function pruefeAusloeser(jetzt) {
  if (scanLaeuft || geradeAusgeloest || !zielQuad) {
    gutFrames = 0;
    countdownAbbrechen();
    setHinweis(scanLaeuft ? "" : "Dokument anvisieren", false);
    letzteBewertung = null;
    return;
  }

  var flaeche = flaecheAnteil(zielQuad);
  var stabil = quadAbstand(zielQuad, letzteBewertung) <
               STABIL_PIXEL * Math.hypot(overlay.clientWidth, overlay.clientHeight);
  letzteBewertung = zielQuad.map(function (p) { return [p[0], p[1]]; });
  var ruhig = ruheWert < RUHE_SCHWELLE;

  if (flaeche < MIN_FLAECHE) {
    gutFrames = 0;
    countdownAbbrechen();
    setHinweis("N\u00e4her herangehen", false);
    return;
  }
  if (!stabil || !ruhig) {
    gutFrames = 0;
    countdownAbbrechen();
    setHinweis("Ruhig halten", false);
    return;
  }

  gutFrames++;
  setHinweis("Dokument erkannt", true);
  if (gutFrames >= STABIL_FRAMES) {
    if (!countdownAn) {
      countdownAn = true;
      countdownBis = jetzt + COUNTDOWN_MS;
      ringBox.classList.add("aktiv");
    }
    var rest = Math.max(0, countdownBis - jetzt);
    ringFg.style.strokeDashoffset = String(327 * (rest / COUNTDOWN_MS));
    if (rest <= 0) { ausloesen(); }
  }
}

function countdownAbbrechen() {
  if (countdownAn) {
    countdownAn = false;
    ringBox.classList.remove("aktiv");
    ringFg.style.strokeDashoffset = "327";
  }
}

function setHinweis(text, gut) {
  if (!text) { hinweis.classList.add("verborgen"); return; }
  hinweis.classList.remove("verborgen");
  if (hinweis.textContent !== text) { hinweis.textContent = text; }
  hinweis.classList.toggle("gut", !!gut);
  autoPille.classList.toggle("scharf", !!gut);
}

function zuruecksetzenErkennung() {
  zielQuad = null; letzterQuad = null; gutFrames = 0;
  letzteBewertung = null; letztesGrau = null; ruheWert = 999;
  countdownAbbrechen();
}

function ausloesen() {
  geradeAusgeloest = true;
  countdownAbbrechen();
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
  scanStarten(bd);
}

function blitzen() {
  var b = document.createElement("div");
  b.className = "blitz";
  document.body.appendChild(b);
  setTimeout(function () { b.remove(); }, 440);
}

/* ========================== Scannen ============================= */
function scanStarten(bilddaten) {
  scanLaeuft = true;
  zuruecksetzenErkennung();
  arbeitOverlay.classList.remove("verborgen");
  topbarStatus.textContent = "";
  var puffer = bilddaten.data.buffer;
  worker.postMessage({
    typ: "scan", rgba: puffer,
    breite: bilddaten.width, hoehe: bilddaten.height
  }, [puffer]);
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
    scans.push({ blob: blob, url: URL.createObjectURL(blob), drehung: 0 });
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
    scanStarten(bd);
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
function zeigeGalerie() {
  liveAktiv = false;
  kameraScreen.classList.add("verborgen");
  galerieScreen.classList.remove("verborgen");
  baueGalerie();
  topbarStatus.textContent = scans.length + (scans.length === 1 ? " Scan" : " Scans");
}

function zeigeKamera() {
  galerieScreen.classList.add("verborgen");
  kameraScreen.classList.remove("verborgen");
  zuruecksetzenErkennung();
  passeOverlayAn();
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
      s.drehung = (s.drehung + 90) % 360;
      bild.style.transform = "rotate(" + s.drehung + "deg)";
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
          topbarStatus.textContent = scans.length + (scans.length === 1 ? " Scan" : " Scans");
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
    bild.style.transform = "rotate(" + s.drehung + "deg)";
    bild.addEventListener("load", function () { passeRahmenAn(rahmen, bild, s.drehung); });
    rahmen.appendChild(bild);

    karte.appendChild(kopf);
    karte.appendChild(rahmen);
    galerieListe.appendChild(karte);
  });
}

/* Bei 90/270 Grad muessen Breite und Hoehe getauscht werden */
function passeRahmenAn(rahmen, bild, drehung) {
  var quer = (drehung % 180) !== 0;
  if (!quer || !bild.naturalWidth) {
    bild.style.maxHeight = "";
    bild.style.maxWidth = "";
    rahmen.style.height = "";
    return;
  }
  var breiteRahmen = rahmen.clientWidth || 300;
  var maxHoehe = Math.min(breiteRahmen, window.innerHeight * 0.58);
  bild.style.maxWidth = "none";
  bild.style.maxHeight = maxHoehe + "px";
  var angezeigteBreite = maxHoehe * (bild.naturalWidth / bild.naturalHeight);
  var deckel = window.innerHeight * 0.58;
  if (angezeigteBreite > deckel) {
    maxHoehe = maxHoehe * (deckel / angezeigteBreite);
    angezeigteBreite = deckel;
    bild.style.maxHeight = maxHoehe + "px";
  }
  rahmen.style.height = Math.round(angezeigteBreite) + "px";
}

el("btn-weiter-scannen").addEventListener("click", zeigeKamera);

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
function zeigeMeldung(titel, text, symbol) {
  meldungTitel.textContent = titel;
  meldungText.textContent = text;
  el("meldung-symbol").textContent = symbol || "!";
  meldungOv.classList.remove("verborgen");
}
el("btn-meldung-ok").addEventListener("click", function () {
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
