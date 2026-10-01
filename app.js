/*
 * Dokument-Scanner - Oberflaeche.
 * Die eigentliche Verarbeitung (Original-Pipeline in Python) laeuft im
 * Web Worker (worker.js) unter Pyodide.
 */
"use strict";

var MAX_KANTE = 1600;   // laengste Bildkante vor der Verarbeitung (Geschwindigkeit)

/* ---------- Elemente ---------- */
var el = function (id) { return document.getElementById(id); };
var ladeKarte = el("lade-karte");
var ladeBalken = el("lade-balken");
var ladeStatus = el("lade-status");
var ladeTitel = el("lade-titel");
var fehlerKarte = el("fehler-karte");
var fehlerText = el("fehler-text");
var startKarte = el("start-karte");
var arbeitKarte = el("arbeit-karte");
var ergebnisKarte = el("ergebnis-karte");
var meldungenBox = el("meldungen");
var ergebnisBild = el("ergebnis-bild");
var btnFoto = el("btn-foto");
var dateiInput = el("datei-input");
var btnScanAnsicht = el("btn-scan-ansicht");
var btnOriginalAnsicht = el("btn-original-ansicht");
var btnSpeichern = el("btn-speichern");
var btnNeu = el("btn-neu");
var btnNeuladen = el("btn-neuladen");

var scanBlobUrl = null, originalBlobUrl = null, scanBlob = null;
var workerBereit = false;

/* ---------- Service Worker (Caching fuer schnelle Folge-Starts) ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(function () { /* nicht kritisch */ });
}

/* ---------- Ansichten umschalten ---------- */
function zeige(karte) {
  [ladeKarte, startKarte, arbeitKarte, ergebnisKarte].forEach(function (k) {
    k.classList.add("verborgen");
  });
  karte.classList.remove("verborgen");
}

function zeigeFehler(text, detail) {
  fehlerText.textContent = text + (detail ? " (Technische Info: " + detail + ")" : "");
  fehlerKarte.classList.remove("verborgen");
  ladeKarte.classList.add("verborgen");
  arbeitKarte.classList.add("verborgen");
}

/* ---------- Worker starten ---------- */
var worker = new Worker("worker.js");

worker.onerror = function (f) {
  zeigeFehler("Der Scanner-Hintergrunddienst konnte nicht gestartet werden. " +
    "Bitte die Seite neu laden.", f.message || "");
};

worker.onmessage = function (ereignis) {
  var n = ereignis.data;
  if (n.typ === "fortschritt") {
    ladeBalken.style.width = n.prozent + "%";
    ladeStatus.textContent = n.text + "  (" + n.prozent + " %)";
  } else if (n.typ === "bereit") {
    workerBereit = true;
    ladeBalken.style.width = "100%";
    zeige(startKarte);
  } else if (n.typ === "ergebnis") {
    ergebnisAnzeigen(n);
  } else if (n.typ === "fehler") {
    if (n.scanFehler) {
      zeigeFehler(n.text, n.detail);
      startKarte.classList.remove("verborgen");
    } else {
      zeigeFehler(n.text, n.detail);
    }
  }
};

/* ---------- Foto waehlen ---------- */
btnFoto.addEventListener("click", function () { dateiInput.click(); });

dateiInput.addEventListener("change", function () {
  var datei = dateiInput.files && dateiInput.files[0];
  if (!datei) { return; }
  fehlerKarte.classList.add("verborgen");
  zeige(arbeitKarte);
  bildVerkleinern(datei)
    .then(function (r) {
      if (originalBlobUrl) { URL.revokeObjectURL(originalBlobUrl); }
      originalBlobUrl = URL.createObjectURL(r.blob);
      worker.postMessage({
        typ: "scan",
        rgba: r.bilddaten.data.buffer,
        breite: r.bilddaten.width,
        hoehe: r.bilddaten.height
      }, [r.bilddaten.data.buffer]);
    })
    .catch(function (f) {
      zeigeFehler("Das Foto konnte nicht gelesen werden. Bitte ein anderes Bild versuchen.", String(f));
      startKarte.classList.remove("verborgen");
    });
  dateiInput.value = "";
});

/* Bild laden + auf MAX_KANTE verkleinern; liefert ImageData (RGBA) und
 * eine JPEG-Kopie fuer die "Original"-Ansicht. Safari dreht Fotos mit
 * EXIF-Ausrichtung beim Zeichnen automatisch richtig. */
function bildVerkleinern(datei) {
  return new Promise(function (erfuellen, ablehnen) {
    var url = URL.createObjectURL(datei);
    var img = new Image();
    img.onload = function () {
      try {
        var b = img.naturalWidth, h = img.naturalHeight;
        if (!b || !h) { throw new Error("Bild hat keine Groesse"); }
        var faktor = Math.min(1, MAX_KANTE / Math.max(b, h));
        var zb = Math.max(1, Math.round(b * faktor));
        var zh = Math.max(1, Math.round(h * faktor));
        var leinwand = document.createElement("canvas");
        leinwand.width = zb;
        leinwand.height = zh;
        var ctx = leinwand.getContext("2d");
        ctx.drawImage(img, 0, 0, zb, zh);
        var bilddaten = ctx.getImageData(0, 0, zb, zh);
        leinwand.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob) { ablehnen(new Error("Vorschaubild fehlgeschlagen")); return; }
          erfuellen({ bilddaten: bilddaten, blob: blob });
        }, "image/jpeg", 0.9);
      } catch (f) {
        URL.revokeObjectURL(url);
        ablehnen(f);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      ablehnen(new Error("Bildformat wird nicht unterst\u00fctzt"));
    };
    img.src = url;
  });
}

/* ---------- Ergebnis anzeigen ---------- */
function ergebnisAnzeigen(n) {
  var leinwand = document.createElement("canvas");
  leinwand.width = n.breite;
  leinwand.height = n.hoehe;
  var ctx = leinwand.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(n.rgba), n.breite, n.hoehe), 0, 0);
  leinwand.toBlob(function (blob) {
    if (!blob) { zeigeFehler("Das Ergebnisbild konnte nicht erzeugt werden."); return; }
    if (scanBlobUrl) { URL.revokeObjectURL(scanBlobUrl); }
    scanBlob = blob;
    scanBlobUrl = URL.createObjectURL(blob);

    // Meldungen der Pipeline (z.B. "Kein Dokument erkannt")
    var meldungen = (n.info && n.info.meldungen) || [];
    if (!n.info.dokument_erkannt) {
      meldungen = ["\u26a0\ufe0f Kein Dokument-Viereck erkannt \u2013 das ganze Foto wurde " +
        "verarbeitet. Tipp: Dokument vollst\u00e4ndig und mit Kontrast zum Untergrund fotografieren."]
        .concat(meldungen.filter(function (m) { return m.indexOf("Kein Dokument") === -1; }));
    }
    if (meldungen.length) {
      meldungenBox.innerHTML = meldungen.map(function (m) {
        return "<div>" + m.replace(/</g, "&lt;") + "</div>";
      }).join("");
      meldungenBox.classList.remove("verborgen");
    } else {
      meldungenBox.classList.add("verborgen");
    }

    ansichtScan();
    zeige(ergebnisKarte);
  }, "image/jpeg", 0.93);
}

function ansichtScan() {
  ergebnisBild.src = scanBlobUrl;
  btnScanAnsicht.classList.add("aktiv");
  btnOriginalAnsicht.classList.remove("aktiv");
}
function ansichtOriginal() {
  ergebnisBild.src = originalBlobUrl;
  btnOriginalAnsicht.classList.add("aktiv");
  btnScanAnsicht.classList.remove("aktiv");
}
btnScanAnsicht.addEventListener("click", ansichtScan);
btnOriginalAnsicht.addEventListener("click", ansichtOriginal);

/* ---------- Sichern / Teilen ---------- */
btnSpeichern.addEventListener("click", function () {
  if (!scanBlob) { return; }
  var datum = new Date().toISOString().slice(0, 10);
  var datei = new File([scanBlob], "Scan-" + datum + ".jpg", { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [datei] })) {
    navigator.share({ files: [datei], title: "Scan" }).catch(function (f) {
      if (f && f.name !== "AbortError") { herunterladen(); }
    });
  } else {
    herunterladen();
  }
});

function herunterladen() {
  var a = document.createElement("a");
  a.href = scanBlobUrl;
  a.download = "Scan-" + new Date().toISOString().slice(0, 10) + ".jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------- Neues Foto ---------- */
btnNeu.addEventListener("click", function () {
  fehlerKarte.classList.add("verborgen");
  zeige(startKarte);
});

btnNeuladen.addEventListener("click", function () { location.reload(); });

/* Falls der Worker sehr schnell fertig war, bevor Listener standen */
if (workerBereit) { zeige(startKarte); }
