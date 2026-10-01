/*
 * Minimaler PDF-Erzeuger (JPEG-Seiten) - komplett lokal, keine Bibliothek,
 * kein CDN, kein Server. Jede Seite ist genau ein JPEG in Originalgroesse,
 * auf A4-Proportionen eingepasst.
 */
"use strict";

var UltraPDF = (function () {

  function textBytes(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) { b[i] = s.charCodeAt(i) & 0xff; }
    return b;
  }

  /* seiten: [{ jpeg: Uint8Array, breite: px, hoehe: px }] */
  function erzeuge(seiten) {
    var teile = [];        // Uint8Array-Stuecke
    var laenge = 0;
    var offsets = [];      // Byte-Offset je Objektnummer (1-basiert)

    function schreibe(data) {
      var u = (typeof data === "string") ? textBytes(data) : data;
      teile.push(u);
      laenge += u.length;
    }
    function objektStart(nr) { offsets[nr] = laenge; }

    var A4_B = 595.28, A4_H = 841.89, RAND = 18;

    // Objektnummern: 1 = Catalog, 2 = Pages, dann je Seite 3 Objekte
    var seitenIds = [];
    var nr = 3;
    seiten.forEach(function () {
      seitenIds.push({ seite: nr, inhalt: nr + 1, bild: nr + 2 });
      nr += 3;
    });
    var anzahlObjekte = nr - 1;

    schreibe("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");

    objektStart(1);
    schreibe("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    objektStart(2);
    schreibe("2 0 obj\n<< /Type /Pages /Count " + seiten.length + " /Kids [" +
      seitenIds.map(function (s) { return s.seite + " 0 R"; }).join(" ") +
      "] >>\nendobj\n");

    seiten.forEach(function (s, i) {
      var ids = seitenIds[i];
      var hoch = s.hoehe >= s.breite;
      var pb = hoch ? A4_B : A4_H;
      var ph = hoch ? A4_H : A4_B;
      var skal = Math.min((pb - 2 * RAND) / s.breite, (ph - 2 * RAND) / s.hoehe);
      var bw = s.breite * skal, bh = s.hoehe * skal;
      var bx = (pb - bw) / 2, by = (ph - bh) / 2;

      objektStart(ids.seite);
      schreibe(ids.seite + " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " +
        pb.toFixed(2) + " " + ph.toFixed(2) + "] /Resources << /XObject << /Bild " +
        ids.bild + " 0 R >> >> /Contents " + ids.inhalt + " 0 R >>\nendobj\n");

      var strom = "q\n" + bw.toFixed(2) + " 0 0 " + bh.toFixed(2) + " " +
        bx.toFixed(2) + " " + by.toFixed(2) + " cm\n/Bild Do\nQ\n";
      objektStart(ids.inhalt);
      schreibe(ids.inhalt + " 0 obj\n<< /Length " + strom.length + " >>\nstream\n" +
        strom + "endstream\nendobj\n");

      objektStart(ids.bild);
      schreibe(ids.bild + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " +
        s.breite + " /Height " + s.hoehe +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
        s.jpeg.length + " >>\nstream\n");
      schreibe(s.jpeg);
      schreibe("\nendstream\nendobj\n");
    });

    var xref = laenge;
    var x = "xref\n0 " + (anzahlObjekte + 1) + "\n0000000000 65535 f \n";
    for (var o = 1; o <= anzahlObjekte; o++) {
      x += ("0000000000" + offsets[o]).slice(-10) + " 00000 n \n";
    }
    x += "trailer\n<< /Size " + (anzahlObjekte + 1) +
      " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
    schreibe(x);

    var alles = new Uint8Array(laenge), pos = 0;
    teile.forEach(function (t) { alles.set(t, pos); pos += t.length; });
    return new Blob([alles], { type: "application/pdf" });
  }

  return { erzeuge: erzeuge };
})();

if (typeof module !== "undefined") { module.exports = UltraPDF; }
