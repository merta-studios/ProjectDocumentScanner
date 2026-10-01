/*
 * Ultra Scan - Dokument-Erkennung (reines JavaScript, laeuft ohne Python).
 * ============================================================================
 *
 * Diese Datei findet die 4 Eckpunkte eines Dokuments in einem Bild. Sie ist
 * der Ersatz fuer die frueher live benutzte Python-Funktion
 * scanner.find_rough_quad(), die ueber Pyodide nur ca. 5-8 mal pro Sekunde
 * laufen konnte, dabei stark gezittert hat und bei Dokumenten ohne starken
 * Kontrast haeufig gar nichts gefunden hat.
 *
 * Verfahren (mehrere Quellen, EINE gemeinsame Bewertung):
 *
 *   1. Bild auf Arbeitsgroesse verkleinern (Flaechenmittel), weichzeichnen.
 *   2. Sobel-Gradienten, Kantenpunkte mit Non-Maximum-Suppression.
 *   3. Gradienten-orientierte Hough-Transformation: jeder Kantenpunkt stimmt
 *      nur fuer Linien ab, die ungefaehr senkrecht zu seinem Gradienten
 *      stehen -> schnell und rauscharm.
 *   4. Aus den staerksten Linien werden Paare (fast parallel, weit
 *      auseinander) und daraus Vierecke gebildet. Zusaetzlich duerfen die
 *      Bildraender als Kante dienen (Dokument groesser als der Sucher).
 *   5. Helligkeits-Fallback: Otsu-Maske -> groesste Flaeche -> konvexe
 *      Huelle -> flaechengroesstes Viereck. Faengt Papier mit weichen
 *      Kanten, wo Linien versagen.
 *   6. Alle Kandidaten werden mit derselben Funktion bewertet:
 *      Kantenstuetze (Gradient senkrecht zur Kante), Abdeckung der Kante,
 *      Polaritaet (innen heller/dunkler als aussen - konsistent auf allen
 *      vier Seiten), Form- und Flaechenplausibilitaet.
 *   7. Der Sieger wird subpixelgenau nachgezogen: jede Kante wird quer
 *      abgetastet, die echte Kante gesucht, eine robuste Gerade gefittet
 *      (IRLS + MAD-Ausreisserfilter) und die Geraden geschnitten.
 *
 * Rueckgabe sind IMMER Koordinaten im Eingabebild (nicht in Arbeitsgroesse).
 *
 * Die Datei haengt von nichts ab und laeuft im Hauptthread wie im Worker.
 */
"use strict";

(function (global) {

  /* ======================= kleine Helfer ========================= */
  function klemme(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function winkelAbstand(a, b) {           // kleinster Winkel zweier Geraden
    var d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  }

  /* ============== 1. Graustufen + Verkleinerung =================== */
  /* Flaechenmittel statt Nearest-Neighbour: sonst flimmern duenne Kanten
   * von Frame zu Frame und die Erkennung zittert. */
  function graubild(rgba, w, h, maxKante) {
    var f = Math.max(w, h) / maxKante;
    if (f < 1) { f = 1; }
    var dw = Math.max(32, Math.round(w / f));
    var dh = Math.max(32, Math.round(h / f));
    var summe = new Float32Array(dw * dh);
    var anzahl = new Float32Array(dw * dh);
    var xi = new Int32Array(w), yi = new Int32Array(h);
    var x, y;
    for (x = 0; x < w; x++) { xi[x] = Math.min(dw - 1, (x * dw / w) | 0); }
    for (y = 0; y < h; y++) { yi[y] = Math.min(dh - 1, (y * dh / h) | 0); }
    for (y = 0; y < h; y++) {
      var zeile = y * w * 4, ziel = yi[y] * dw;
      for (x = 0; x < w; x++) {
        var p = zeile + x * 4;
        var l = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) * 0.001;
        var k = ziel + xi[x];
        summe[k] += l; anzahl[k]++;
      }
    }
    var g = new Float32Array(dw * dh);
    for (var i = 0; i < dw * dh; i++) { g[i] = anzahl[i] ? summe[i] / anzahl[i] : 0; }
    return { g: g, w: dw, h: dh, sx: w / dw, sy: h / dh };
  }

  /* ===================== 2. Weichzeichnen ========================= */
  function weich(src, w, h, durchgaenge) {
    var a = src, b = new Float32Array(w * h), x, y, i;
    for (var d = 0; d < durchgaenge; d++) {
      for (y = 0; y < h; y++) {                       // waagerecht 1-2-1
        var z = y * w;
        for (x = 0; x < w; x++) {
          var l = a[z + (x > 0 ? x - 1 : 0)];
          var r = a[z + (x < w - 1 ? x + 1 : w - 1)];
          b[z + x] = (l + 2 * a[z + x] + r) * 0.25;
        }
      }
      for (x = 0; x < w; x++) {                       // senkrecht 1-2-1
        for (y = 0; y < h; y++) {
          var o = b[(y > 0 ? y - 1 : 0) * w + x];
          var u = b[(y < h - 1 ? y + 1 : h - 1) * w + x];
          a[y * w + x] = (o + 2 * b[y * w + x] + u) * 0.25;
        }
      }
    }
    return a;
  }

  /* ======================== 3. Gradienten ========================= */
  function gradienten(g, w, h) {
    var gx = new Float32Array(w * h);
    var gy = new Float32Array(w * h);
    var mag = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      var z = y * w, zo = z - w, zu = z + w;
      for (var x = 1; x < w - 1; x++) {
        var a = g[zo + x - 1], b = g[zo + x], c = g[zo + x + 1];
        var d = g[z + x - 1],                 e = g[z + x + 1];
        var f = g[zu + x - 1], i = g[zu + x], j = g[zu + x + 1];
        /* durch 4 teilen -> Werte in "Graustufen pro Pixel" */
        var sx = ((c + 2 * e + j) - (a + 2 * d + f)) * 0.25;
        var sy = ((f + 2 * i + j) - (a + 2 * b + c)) * 0.25;
        gx[z + x] = sx; gy[z + x] = sy;
        mag[z + x] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    return { gx: gx, gy: gy, mag: mag };
  }

  /* Schaerfe (Varianz des Laplace-Operators) auf dem UNgeglaetteten Grau.
   * Damit erkennt die App bewegungsunscharfe Frames und loest dort nicht
   * aus - das ist einer der Gruende, warum fertige Scans frueher weich
   * und "verschmiert" aussahen. */
  function schaerfeWert(g, w, h) {
    var summe = 0, quad = 0, n = 0;
    for (var y = 2; y < h - 2; y += 2) {
      var z = y * w;
      for (var x = 2; x < w - 2; x += 2) {
        var l = 4 * g[z + x] - g[z + x - 1] - g[z + x + 1] -
                g[z + x - w] - g[z + x + w];
        summe += l; quad += l * l; n++;
      }
    }
    if (!n) { return 0; }
    var m = summe / n;
    return quad / n - m * m;
  }

  /* Bewegung zwischen zwei Frames: mittlerer Helligkeitsunterschied, aber
   * BELICHTUNGSBEREINIGT (der Mittelwert wird abgezogen) und auf den
   * Bildkontrast normiert. Ohne das meldete schon eine Helligkeits-
   * anpassung der Kamera "Bewegung" - und die App sagte wieder
   * "Ruhig halten", obwohl das Geraet still lag. */
  var letztesGrau = null, letzteGroesse = 0;
  function bewegungWert(g, w, h) {
    var n = w * h, i, summe = 0, quad = 0;
    for (i = 0; i < n; i++) { summe += g[i]; quad += g[i] * g[i]; }
    var m = summe / n;
    var streuung = Math.sqrt(Math.max(1, quad / n - m * m));
    var bew = -1;
    if (letztesGrau && letzteGroesse === n) {
      var dSumme = 0;
      for (i = 0; i < n; i++) { dSumme += g[i] - letztesGrau[i]; }
      var versatz = dSumme / n;                    // Belichtungsaenderung
      var abw = 0;
      for (i = 0; i < n; i++) {
        var d = g[i] - letztesGrau[i] - versatz;
        abw += d < 0 ? -d : d;
      }
      bew = (abw / n) / streuung;                  // 0 = still
    }
    if (!letztesGrau || letzteGroesse !== n) { letztesGrau = new Float32Array(n); }
    letztesGrau.set(g);
    letzteGroesse = n;
    return bew;
  }

  /* Arbeitsbild bauen (Grau + Gradienten + Kennzahlen) */
  function arbeitsbild(rgba, w, h, maxKante, glaetten, masse) {
    var b = graubild(rgba, w, h, maxKante);
    if (masse) {
      b.schaerfe = schaerfeWert(b.g, b.w, b.h);
      b.bewegung = bewegungWert(b.g, b.w, b.h);
    }
    b.g = weich(b.g, b.w, b.h, glaetten === undefined ? 2 : glaetten);
    var gr = gradienten(b.g, b.w, b.h);
    b.gx = gr.gx; b.gy = gr.gy; b.mag = gr.mag;
    b.diag = Math.sqrt(b.w * b.w + b.h * b.h);
    return b;
  }

  /* bilineares Abtasten (Grauwert) */
  function grauAn(b, x, y) {
    if (x < 0) { x = 0; } if (y < 0) { y = 0; }
    if (x > b.w - 1.001) { x = b.w - 1.001; }
    if (y > b.h - 1.001) { y = b.h - 1.001; }
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * b.w + x0;
    var o = b.g[i] + (b.g[i + 1] - b.g[i]) * fx;
    var u = b.g[i + b.w] + (b.g[i + b.w + 1] - b.g[i + b.w]) * fx;
    return o + (u - o) * fy;
  }

  /* gerichteter Gradient (Projektion auf die Normale nx,ny), bilinear */
  function gradAn(b, x, y, nx, ny) {
    if (x < 1 || y < 1 || x > b.w - 2.001 || y > b.h - 2.001) { return 0; }
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * b.w + x0;
    var gxv = (b.gx[i] * (1 - fx) + b.gx[i + 1] * fx) * (1 - fy) +
              (b.gx[i + b.w] * (1 - fx) + b.gx[i + b.w + 1] * fx) * fy;
    var gyv = (b.gy[i] * (1 - fx) + b.gy[i + 1] * fx) * (1 - fy) +
              (b.gy[i + b.w] * (1 - fx) + b.gy[i + b.w + 1] * fx) * fy;
    return gxv * nx + gyv * ny;
  }

  /* ============= 4. Kantenpunkte (mit Non-Max-Suppression) ======== */
  var GEWICHT_DECKEL = 28;   // siehe unten

  function kantenPunkte(b, maxPunkte) {
    var w = b.w, h = b.h, mag = b.mag, gx = b.gx, gy = b.gy;
    /* Schwelle aus dem Histogramm, aber NIEDRIG gedeckelt.
     *
     * Wichtig: Text auf Papier liefert Gradienten von 100+, die Papierkante
     * auf einem hellen Tisch nur 15-25. Eine Schwelle "staerkste 8 %" liegt
     * dann weit ueber der Dokumentkante - genau deshalb wurde Papier auf
     * hellem Untergrund frueher gar nicht gefunden. */
    var hist = new Int32Array(257), i, m;
    for (i = 0; i < mag.length; i++) {
      m = mag[i] | 0; if (m > 256) { m = 256; }
      hist[m]++;
    }
    var ziel = Math.round(mag.length * 0.10), sum = 0, schwelle = 256;
    for (i = 256; i >= 0; i--) { sum += hist[i]; if (sum >= ziel) { schwelle = i; break; } }
    if (schwelle < 2.5) { schwelle = 2.5; }
    if (schwelle > 14) { schwelle = 14; }

    /* 1. Durchgang: zaehlen, 2. Durchgang: gleichmaessig ausduennen.
     * (Frueher wurde bei Erreichen der Obergrenze abgebrochen - dann kamen
     * alle Punkte aus der oberen Bildhaelfte.) */
    var treffer = new Int32Array(w * h);
    var n = 0, x, y, k, ax, ay, dx, dy;
    for (y = 2; y < h - 2; y++) {
      var z = y * w;
      for (x = 2; x < w - 2; x++) {
        k = z + x;
        m = mag[k];
        if (m < schwelle) { continue; }
        ax = gx[k]; ay = gy[k];
        dx = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 1 : -1) : 0;
        dy = Math.abs(ay) >= Math.abs(ax) ? (ay > 0 ? 1 : -1) : 0;
        if (Math.abs(Math.abs(ax) - Math.abs(ay)) < 0.3 * m) {
          dx = ax > 0 ? 1 : -1; dy = ay > 0 ? 1 : -1;
        }
        if (m < mag[k + dy * w + dx] || m < mag[k - dy * w - dx]) { continue; }
        treffer[n++] = k;
      }
    }
    var schritt = Math.max(1, Math.ceil(n / maxPunkte));
    var anzahl = Math.floor((n + schritt - 1) / schritt);
    var xs = new Float32Array(anzahl), ys = new Float32Array(anzahl);
    var gxs = new Float32Array(anzahl), gys = new Float32Array(anzahl);
    var ws = new Float32Array(anzahl);
    var j = 0;
    for (i = 0; i < n; i += schritt) {
      k = treffer[i];
      xs[j] = k % w; ys[j] = (k / w) | 0;
      gxs[j] = gx[k]; gys[j] = gy[k];
      /* Gewicht deckeln: sonst erschlagen schwarze Buchstaben (Gradient
       * 100-200) jede Papierkante (Gradient 15-40) in der Hough-Abstimmung.
       * Mit Deckel zaehlt vor allem die LAENGE einer Linie - und das ist
       * genau das Merkmal einer Dokumentkante. */
      ws[j] = mag[k] > GEWICHT_DECKEL ? GEWICHT_DECKEL : mag[k];
      j++;
    }
    return { xs: xs, ys: ys, gxs: gxs, gys: gys, ws: ws, n: j,
             schwelle: schwelle, roh: n };
  }

  /* ============ 5. Hough-Transformation (orientierungsgefuehrt) === */
  var WINKEL_BINS = 180;
  var COS = new Float32Array(WINKEL_BINS), SIN = new Float32Array(WINKEL_BINS);
  (function () {
    for (var i = 0; i < WINKEL_BINS; i++) {
      var t = i * Math.PI / WINKEL_BINS;
      COS[i] = Math.cos(t); SIN[i] = Math.sin(t);
    }
  })();
  var STREU = [0.32, 0.72, 1.0, 0.72, 0.32];   // Streuung ueber +-2 Grad

  function houghLinien(b, pkte, maxLinien) {
    var cx = b.w / 2, cy = b.h / 2;
    var rhoMax = Math.ceil(b.diag / 2) + 2;
    var rhoBins = 2 * rhoMax + 1;
    var acc = new Float32Array(WINKEL_BINS * rhoBins);
    var i, d, bin;
    for (i = 0; i < pkte.n; i++) {
      var ax = pkte.gxs[i], ay = pkte.gys[i];
      var grad = Math.atan2(ay, ax) * 180 / Math.PI;
      if (grad < 0) { grad += 180; }
      if (grad >= 180) { grad -= 180; }
      var b0 = Math.round(grad) % 180;
      var px = pkte.xs[i] - cx, py = pkte.ys[i] - cy, gew = pkte.ws[i];
      for (d = -2; d <= 2; d++) {
        bin = (b0 + d + 180) % 180;
        var r = px * COS[bin] + py * SIN[bin] + rhoMax;
        var ri = Math.floor(r), fr = r - ri;
        if (ri < 0 || ri + 1 >= rhoBins) { continue; }
        var gg = gew * STREU[d + 2], basis = bin * rhoBins + ri;
        acc[basis] += gg * (1 - fr);
        acc[basis + 1] += gg * fr;
      }
    }
    /* leichtes Glaetten in Rho-Richtung: Peaks werden stabiler */
    var tmp = new Float32Array(rhoBins);
    for (bin = 0; bin < WINKEL_BINS; bin++) {
      var o = bin * rhoBins;
      for (i = 0; i < rhoBins; i++) {
        tmp[i] = acc[o + (i > 0 ? i - 1 : 0)] + 2 * acc[o + i] +
                 acc[o + (i < rhoBins - 1 ? i + 1 : rhoBins - 1)];
      }
      for (i = 0; i < rhoBins; i++) { acc[o + i] = tmp[i] * 0.25; }
    }
    /* lokale Maxima einsammeln */
    var max = 0;
    for (i = 0; i < acc.length; i++) { if (acc[i] > max) { max = acc[i]; } }
    if (max <= 0) { return []; }
    var grenze = 0.14 * max;
    var roh = [];
    for (bin = 0; bin < WINKEL_BINS; bin++) {
      var ob = bin * rhoBins;
      var vor = bin > 0 ? (bin - 1) * rhoBins : -1;
      var nach = bin < WINKEL_BINS - 1 ? (bin + 1) * rhoBins : -1;
      for (i = 1; i < rhoBins - 1; i++) {
        var v = acc[ob + i];
        if (v < grenze) { continue; }
        if (v < acc[ob + i - 1] || v < acc[ob + i + 1]) { continue; }
        if (vor >= 0 && (v < acc[vor + i])) { continue; }
        if (nach >= 0 && (v < acc[nach + i])) { continue; }
        roh.push({ bin: bin, rho: i - rhoMax, wert: v });
      }
    }
    roh.sort(function (a, c) { return c.wert - a.wert; });

    var linien = [];
    for (i = 0; i < roh.length && linien.length < maxLinien; i++) {
      var k = roh[i];
      var t = k.bin * Math.PI / WINKEL_BINS;
      var lpx = cx + k.rho * COS[k.bin], lpy = cy + k.rho * SIN[k.bin];
      /* r ist IMMER der Abstand zum Bildursprung (0,0) - nur so passen
       * Schnittpunkte ohne Umrechnung zu allen anderen Koordinaten. */
      var lin = {
        t: t, c: COS[k.bin], s: SIN[k.bin],
        r: lpx * COS[k.bin] + lpy * SIN[k.bin], wert: k.wert,
        px: lpx, py: lpy, rand: false
      };
      var doppelt = false;
      for (d = 0; d < linien.length; d++) {
        if (aehnlich(lin, linien[d], b.diag)) { doppelt = true; break; }
      }
      if (!doppelt) { linien.push(lin); }
    }
    return linien;
  }

  function aehnlich(a, b, diag) {
    if (winkelAbstand(a.t, b.t) > 7 * Math.PI / 180) { return false; }
    var dx = a.px - b.px, dy = a.py - b.py;
    return Math.abs(dx * b.c + dy * b.s) < 0.035 * diag;
  }

  /* Bildrand als moegliche Dokumentkante (Dokument groesser als Sucher) */
  function randLinien(b) {
    var cx = b.w / 2, cy = b.h / 2, e = 1.0;
    function mach(px, py, t) {
      var c = Math.cos(t), s = Math.sin(t);
      return { t: t, c: c, s: s, r: px * c + py * s,
               px: px, py: py, wert: 0, rand: true };
    }
    return [mach(e, cy, 0), mach(b.w - 1 - e, cy, 0),
            mach(cx, e, Math.PI / 2), mach(cx, b.h - 1 - e, Math.PI / 2)];
  }

  /* Linie auf das Bildrechteck beschneiden -> Strecke */
  function strecke(b, lin) {
    var dx = -lin.s, dy = lin.c;
    var t0 = -1e9, t1 = 1e9;
    function slab(p, d, lo, hi) {
      if (Math.abs(d) < 1e-9) { return p >= lo && p <= hi; }
      var a = (lo - p) / d, c = (hi - p) / d;
      if (a > c) { var h = a; a = c; c = h; }
      if (a > t0) { t0 = a; }
      if (c < t1) { t1 = c; }
      return true;
    }
    if (!slab(lin.px, dx, 0, b.w - 1)) { return null; }
    if (!slab(lin.py, dy, 0, b.h - 1)) { return null; }
    if (t1 <= t0) { return null; }
    return [[lin.px + t0 * dx, lin.py + t0 * dy],
            [lin.px + t1 * dx, lin.py + t1 * dy]];
  }

  /* Wie gut wird eine Linie vom Bild gestuetzt? (einmal pro Linie) */
  function linienStuetze(b, lin) {
    if (lin.rand) { lin.stuetze = 3; lin.abdeckung = 1; return; }
    var st = strecke(b, lin);
    if (!st) { lin.stuetze = 0; lin.abdeckung = 0; return; }
    var a = st[0], c = st[1];
    var len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    var n = Math.max(12, Math.min(80, Math.round(len / 3)));
    var summe = 0, treffer = 0;
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      var v = Math.abs(gradAn(b, a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, lin.c, lin.s));
      summe += v;
      if (v > 4) { treffer++; }
    }
    lin.stuetze = summe / n;
    lin.abdeckung = treffer / n;
    lin.laenge = len;
  }

  /* =================== 6. Vierecke bauen ========================== */
  function schnitt(l1, l2) {
    var den = l1.c * l2.s - l1.s * l2.c;
    if (Math.abs(den) < 1e-9) { return null; }
    return [(l1.r * l2.s - l2.r * l1.s) / den,
            (l2.r * l1.c - l1.r * l2.c) / den];
  }

  function sortiereEcken(p, cx, cy) {
    var mx = 0, my = 0, i;
    for (i = 0; i < 4; i++) { mx += p[i][0] / 4; my += p[i][1] / 4; }
    var mit = p.slice().sort(function (a, b) {
      return Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx);
    });
    /* Start bei der Ecke oben links (kleinste Summe) */
    var beste = 0, best = 1e18;
    for (i = 0; i < 4; i++) {
      var v = mit[i][0] + mit[i][1];
      if (v < best) { best = v; beste = i; }
    }
    return [mit[beste % 4], mit[(beste + 1) % 4], mit[(beste + 2) % 4], mit[(beste + 3) % 4]];
  }

  function flaeche(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) {
      var p = q[i], n = q[(i + 1) % 4];
      a += p[0] * n[1] - n[0] * p[1];
    }
    return Math.abs(a / 2);
  }

  function konvex(q) {
    var vz = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      var k = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(k) < 1e-9) { continue; }
      var s = k > 0 ? 1 : -1;
      if (vz === 0) { vz = s; } else if (s !== vz) { return false; }
    }
    return true;
  }

  function formOk(b, q, minFlaeche) {
    var i;
    var rand = 0.06 * b.diag;
    for (i = 0; i < 4; i++) {
      if (q[i][0] < -rand || q[i][0] > b.w - 1 + rand ||
          q[i][1] < -rand || q[i][1] > b.h - 1 + rand) { return false; }
    }
    if (!konvex(q)) { return false; }
    var fl = flaeche(q) / (b.w * b.h);
    if (fl < minFlaeche || fl > 1.25) { return false; }
    /* Innenwinkel plausibel? */
    for (i = 0; i < 4; i++) {
      var a = q[(i + 3) % 4], m = q[i], c = q[(i + 1) % 4];
      var v1x = a[0] - m[0], v1y = a[1] - m[1];
      var v2x = c[0] - m[0], v2y = c[1] - m[1];
      var n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
      if (n1 < 0.06 * b.diag || n2 < 0.06 * b.diag) { return false; }
      var cosw = (v1x * v2x + v1y * v2y) / (n1 * n2);
      if (cosw > 0.57 || cosw < -0.57) { return false; }   // ca. 55..125 Grad
    }
    /* gegenueberliegende Seiten duerfen sich nicht extrem unterscheiden */
    var l = [];
    for (i = 0; i < 4; i++) {
      l.push(Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
    }
    if (Math.max(l[0], l[2]) > 3.2 * Math.min(l[0], l[2])) { return false; }
    if (Math.max(l[1], l[3]) > 3.2 * Math.min(l[1], l[3])) { return false; }
    return true;
  }

  /* ================== 7. Bewertung eines Vierecks ================= */
  /* mitte = Schwerpunkt des Vierecks; damit zeigt die Normale IMMER nach
   * aussen und "pol > 0" heisst eindeutig: innen heller als aussen. */
  function seiteMessen(b, a, c, mitte) {
    var L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 6) { return { stuetze: 0, abdeckung: 0, pol: 0, kontrast: 0, fort: 0 }; }
    var dx = (c[0] - a[0]) / L, dy = (c[1] - a[1]) / L;
    var nx = -dy, ny = dx;
    if (mitte) {
      var vx = mitte[0] - (a[0] + c[0]) / 2, vy = mitte[1] - (a[1] + c[1]) / 2;
      if (nx * vx + ny * vy > 0) { nx = -nx; ny = -ny; }
    }
    var n = Math.max(14, Math.min(64, Math.round(L / 4)));
    var abstand = Math.max(2.5, 0.012 * b.diag);
    var summe = 0, treffer = 0, polSum = 0, kontrast = 0, gueltig = 0, stufe = 0;
    for (var i = 0; i < n; i++) {
      var t = 0.05 + 0.9 * (i / (n - 1));
      var px = a[0] + (c[0] - a[0]) * t, py = a[1] + (c[1] - a[1]) * t;
      /* beste Kantenantwort in einem schmalen Band (+-1.5 px) - die
       * Kandidatenkante liegt selten exakt auf dem Pixelraster */
      var best = 0;
      for (var s = -1.5; s <= 1.51; s += 0.75) {
        var v = Math.abs(gradAn(b, px + s * nx, py + s * ny, nx, ny));
        if (v > best) { best = v; }
      }
      summe += best;
      if (best > 4) { treffer++; }
      var innen = grauAn(b, px - abstand * nx, py - abstand * ny);
      var aussen = grauAn(b, px + abstand * nx, py + abstand * ny);
      polSum += (innen - aussen) > 0 ? 1 : -1;
      kontrast += Math.abs(innen - aussen);
      /* STUFE statt STRICH: an einer echten Dokumentkante bleibt es
       * draussen anders hell - auch ein Stueck weiter weg. Ein dunkler
       * Strich (Tischkante, Lineal, Unterstreichung) sieht nur direkt
       * daneben anders aus und geht danach wieder in den Hintergrund
       * ueber. Dieser Test wirft solche Stoerlinien zuverlaessig raus. */
      var fern = grauAn(b, px + 2.8 * abstand * nx, py + 2.8 * abstand * ny);
      var nah = Math.abs(innen - aussen);
      var weit = Math.abs(innen - fern);
      var gleich = ((innen - aussen) > 0) === ((innen - fern) > 0);
      stufe += gleich ? Math.min(1.15, weit / (nah + 1.5)) : 0;
      gueltig++;
    }
    /* Fortsetzungstest: laeuft die Kante ueber die Ecken hinaus weiter?
     * Dann ist es eher eine durchgehende Linie (Tischkante, Schatten). */
    var fort = 0, fn = 0;
    for (var e = 0; e < 2; e++) {
      for (var j = 1; j <= 6; j++) {
        var tt = e === 0 ? -0.04 * j : 1 + 0.04 * j;
        var qx = a[0] + (c[0] - a[0]) * tt, qy = a[1] + (c[1] - a[1]) * tt;
        if (qx < 1 || qy < 1 || qx > b.w - 2 || qy > b.h - 2) { continue; }
        fort += Math.abs(gradAn(b, qx, qy, nx, ny)); fn++;
      }
    }
    return {
      stuetze: summe / n,
      abdeckung: treffer / n,
      pol: polSum / Math.max(1, gueltig),
      kontrast: kontrast / Math.max(1, gueltig),
      stufe: stufe / Math.max(1, gueltig),
      fort: fn ? fort / fn : 0
    };
  }

  function schwerpunkt(q) {
    return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
            (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
  }

  function bewerte(b, q, randSeiten) {
    var mitte = schwerpunkt(q), i;
    var seiten = [];
    var geo = 0, abd = 0, polGew = 0, polSumme = 0, kon = 0, strafe = 1;
    for (i = 0; i < 4; i++) {
      var a = q[i], c = q[(i + 1) % 4];
      var m = seiteMessen(b, a, c, mitte);
      seiten.push(m);
      var s = m.stuetze * (0.35 + 0.65 * m.abdeckung) *
              (m.kontrast < 3 ? 0.9 : (0.4 + 0.6 * Math.min(1, m.stufe)));
      /* Eine Seite, die auf dem Bildrand liegt, ist nur ein NOTBEHELF
       * (Dokument groesser als der Sucher). Sie bekommt eine feste,
       * niedrige Stuetze und einen Abschlag, damit eine echte, erkannte
       * Blattkante immer gewinnt. */
      if (randSeiten && randSeiten[i]) { s = 3.0; strafe *= 0.6; }
      else if (m.fort > Math.max(5, 0.75 * m.stuetze)) { strafe *= 0.55; }
      geo += Math.log(Math.max(s, 0.25));
      abd += m.abdeckung / 4;
      /* Polaritaet KONTRASTGEWICHTET: eine Seite mit kaum Helligkeits-
       * unterschied (z.B. Blattkante im Schatten) darf das Urteil ueber
       * die anderen drei nicht kippen. */
      polSumme += m.pol * m.kontrast;
      polGew += m.kontrast;
      kon += m.kontrast / 4;
    }
    geo = Math.exp(geo / 4);
    var pol = polGew > 1e-6 ? polSumme / polGew : 0;
    var fl = flaeche(q) / (b.w * b.h);
    /* Polaritaet: alle vier Seiten sollen gleich herum sein.
     * Eine echte Blattkante ist auf ALLEN Seiten gleich gepolt (innen
     * heller als aussen bzw. umgekehrt). Die Kante eines Textblocks ist
     * das nicht - das ist das zuverlaessigste Unterscheidungsmerkmal. */
    var einigkeit = Math.abs(pol);
    var polBonus = kon < 2.0 ? 0.6 : (0.3 + 0.7 * einigkeit);
    /* Mitte: Dokumente liegen normalerweise mittig im Sucher */
    var ab = Math.hypot(mitte[0] - b.w / 2, mitte[1] - b.h / 2) / (b.diag / 2);
    var mitteBonus = 1 - 0.3 * Math.min(1, ab);
    /* Flaeche geht LINEAR ein: lieber das ganze Blatt als der Textblock
     * darin. Mit Wurzel gewann regelmaessig der (kontrastreichere) innere
     * Textblock - eine der Hauptursachen fuer "verrutschte" Scans. */
    var wert = geo * fl * polBonus * mitteBonus * strafe;
    return {
      wert: wert, geo: geo, abdeckung: abd, polaritaet: einigkeit,
      kontrast: kon, flaeche: fl, seiten: seiten,
      konfidenz: klemme((geo / 13) * (0.3 + 0.7 * abd) *
                        (0.45 + 0.55 * einigkeit), 0, 1)
    };
  }

  /* ========== 8. Kanten subpixelgenau nachziehen ================== */
  function gerade(punkte) {        // Total-Least-Squares durch Punktwolke
    var n = punkte.length, mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += punkte[i][0]; my += punkte[i][1]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      var dx = punkte[i][0] - mx, dy = punkte[i][1] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);   // Hauptachse
    var dxr = Math.cos(theta), dyr = Math.sin(theta);
    return { px: mx, py: my, dx: dxr, dy: dyr, c: -dyr, s: dxr,
             r: mx * (-dyr) + my * dxr };
  }

  function verfeinereSeite(b, a, c, suchweite, polaritaet, mitte) {
    var L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 10) { return null; }
    var dx = (c[0] - a[0]) / L, dy = (c[1] - a[1]) / L;
    var nx = -dy, ny = dx;
    if (mitte) {
      var vx = mitte[0] - (a[0] + c[0]) / 2, vy = mitte[1] - (a[1] + c[1]) / 2;
      if (nx * vx + ny * vy > 0) { nx = -nx; ny = -ny; }
    }
    var n = Math.max(20, Math.min(90, Math.round(L / 4)));
    var punkte = [];
    for (var i = 0; i < n; i++) {
      var t = 0.04 + 0.92 * (i / (n - 1));
      var px = a[0] + (c[0] - a[0]) * t, py = a[1] + (c[1] - a[1]) * t;
      var bestS = null, bestV = 0;
      /* Erwartung: ist innen heller (pol > 0), faellt die Helligkeit nach
       * aussen - der Gradient entlang der Aussennormalen ist negativ.
       * Kanten mit falscher Polaritaet (z.B. eine Textzeile knapp daneben)
       * werden stark abgewertet statt gleichberechtigt mitzuspielen. */
      for (var s = -suchweite; s <= suchweite + 0.001; s += 0.5) {
        var g = gradAn(b, px + s * nx, py + s * ny, nx, ny);
        var passt = polaritaet === 0 || (polaritaet > 0 ? g < 0 : g > 0);
        var v = Math.abs(g) * (passt ? 1 : 0.3);
        /* leichte Bevorzugung der Naehe zur Ausgangskante */
        v *= 1 - 0.25 * Math.abs(s) / (suchweite + 1e-6);
        if (v > bestV) { bestV = v; bestS = s; }
      }
      if (bestS !== null && bestV > 3) {
        punkte.push([px + bestS * nx, py + bestS * ny]);
      }
    }
    if (punkte.length < 8) { return null; }
    var lin = gerade(punkte);
    for (var k = 0; k < 3; k++) {                 // Ausreisser rauswerfen
      var dist = [], j;
      for (j = 0; j < punkte.length; j++) {
        dist.push(Math.abs((punkte[j][0] - lin.px) * lin.c +
                           (punkte[j][1] - lin.py) * lin.s));
      }
      var sortiert = dist.slice().sort(function (p, q2) { return p - q2; });
      var mad = sortiert[sortiert.length >> 1] + 1e-6;
      var behalten = [];
      for (j = 0; j < punkte.length; j++) {
        if (dist[j] < Math.max(2.2 * mad, 1.2)) { behalten.push(punkte[j]); }
      }
      if (behalten.length < 8) { break; }
      punkte = behalten;
      lin = gerade(punkte);
    }
    lin.anzahl = punkte.length;
    return lin;
  }

  function verfeinere(b, q, suchweite) {
    var mitte = schwerpunkt(q), i;
    var linien = [];
    for (i = 0; i < 4; i++) {
      var a = q[i], c = q[(i + 1) % 4];
      var m = seiteMessen(b, a, c, mitte);
      var pol = m.kontrast > 4 ? (m.pol > 0 ? 1 : -1) : 0;
      linien.push(verfeinereSeite(b, a, c, suchweite, pol, mitte));
    }
    var neu = [];
    for (i = 0; i < 4; i++) {
      var l1 = linien[(i + 3) % 4], l2 = linien[i];
      if (!l1 || !l2) { neu.push(q[i]); continue; }
      if (winkelAbstand(Math.atan2(l1.dy, l1.dx), Math.atan2(l2.dy, l2.dx)) < 0.25) {
        neu.push(q[i]); continue;           // zu parallel -> Schnitt unsicher
      }
      var p = schnitt(l1, l2);
      if (!p) { neu.push(q[i]); continue; }
      /* Sicherheitsnetz: die neue Ecke darf nicht weit weglaufen */
      if (Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > 1.6 * suchweite + 3) {
        neu.push(q[i]); continue;
      }
      neu.push(p);
    }
    return neu;
  }

  /* ========== 9. Helligkeits-Fallback (Otsu + Huelle) ============= */
  function otsu(b) {
    var hist = new Int32Array(256), i;
    for (i = 0; i < b.g.length; i++) {
      var v = b.g[i] | 0; if (v < 0) { v = 0; } if (v > 255) { v = 255; }
      hist[v]++;
    }
    var gesamt = b.g.length, summe = 0;
    for (i = 0; i < 256; i++) { summe += i * hist[i]; }
    var sumB = 0, wB = 0, best = 0, schwelle = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) { continue; }
      var wF = gesamt - wB;
      if (!wF) { break; }
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (summe - sumB) / wF;
      var zw = wB * wF * (mB - mF) * (mB - mF);
      if (zw > best) { best = zw; schwelle = i; }
    }
    return schwelle;
  }

  function maskeKomponente(maske, w, h) {
    /* groesste 8-verbundene Komponente (Zwei-Pass mit Union-Find) */
    var lab = new Int32Array(w * h);
    var eltern = [0];
    function finde(a) { while (eltern[a] !== a) { a = eltern[a] = eltern[eltern[a]]; } return a; }
    function vereine(a, c) { a = finde(a); c = finde(c); if (a !== c) { eltern[c] = a; } }
    var naechste = 1, x, y;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var i = y * w + x;
        if (!maske[i]) { continue; }
        var beste = 0;
        var nach = [
          (x > 0 ? i - 1 : -1),
          (y > 0 ? i - w : -1),
          (y > 0 && x > 0 ? i - w - 1 : -1),
          (y > 0 && x < w - 1 ? i - w + 1 : -1)
        ];
        for (var k = 0; k < 4; k++) {
          var j = nach[k];
          if (j >= 0 && lab[j]) {
            if (!beste) { beste = finde(lab[j]); }
            else { vereine(beste, lab[j]); }
          }
        }
        if (!beste) { beste = naechste; eltern[naechste] = naechste; naechste++; }
        lab[i] = beste;
      }
    }
    var groesse = new Int32Array(naechste);
    for (var p = 0; p < lab.length; p++) {
      if (lab[p]) { groesse[finde(lab[p])]++; }
    }
    var top = 0, tops = 0;
    for (var l = 1; l < naechste; l++) {
      if (groesse[l] > tops) { tops = groesse[l]; top = l; }
    }
    if (!top) { return null; }
    var pkte = [];
    for (y = 0; y < h; y++) {
      var min = -1, max = -1;
      for (x = 0; x < w; x++) {
        if (lab[y * w + x] && finde(lab[y * w + x]) === top) {
          if (min < 0) { min = x; }
          max = x;
        }
      }
      if (min >= 0) { pkte.push([min, y]); if (max !== min) { pkte.push([max, y]); } }
    }
    return { punkte: pkte, groesse: tops };
  }

  function huelle(punkte) {
    if (punkte.length < 4) { return punkte; }
    var p = punkte.slice().sort(function (a, b) {
      return a[0] - b[0] || a[1] - b[1];
    });
    function kreuz(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    var unten = [], oben = [], i;
    for (i = 0; i < p.length; i++) {
      while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], p[i]) <= 0) { unten.pop(); }
      unten.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], p[i]) <= 0) { oben.pop(); }
      oben.push(p[i]);
    }
    unten.pop(); oben.pop();
    return unten.concat(oben);
  }

  function groesstesViereck(h) {
    var n = h.length;
    if (n < 4) { return null; }
    if (n > 48) {                                  // ausduennen
      var step = n / 48, neu = [];
      for (var i = 0; i < 48; i++) { neu.push(h[Math.floor(i * step)]); }
      h = neu; n = 48;
    }
    function dreieck(a, b, c) {
      return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    var bestF = 0, best = null;
    for (var a = 0; a < n; a++) {
      for (var c = a + 2; c < n; c++) {
        var b1 = -1, f1 = -1, b2 = -1, f2 = -1, k;
        for (k = a + 1; k < c; k++) {
          var f = dreieck(h[a], h[k], h[c]);
          if (f > f1) { f1 = f; b1 = k; }
        }
        for (k = c + 1; k < n + a; k++) {
          var kk = k % n;
          var g = dreieck(h[a], h[kk], h[c]);
          if (g > f2) { f2 = g; b2 = kk; }
        }
        if (b1 < 0 || b2 < 0) { continue; }
        if (f1 + f2 > bestF) {
          bestF = f1 + f2;
          best = [h[a], h[b1], h[c], h[b2]];
        }
      }
    }
    return best;
  }

  function dilatieren(m, w, h, mal) {
    var a = m, b = new Uint8Array(w * h);
    for (var d = 0; d < mal; d++) {
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var i = y * w + x, v = 0;
          for (var dy = -1; dy <= 1 && !v; dy++) {
            var yy = y + dy; if (yy < 0 || yy >= h) { continue; }
            for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx; if (xx < 0 || xx >= w) { continue; }
              if (a[yy * w + xx]) { v = 1; break; }
            }
          }
          b[i] = v;
        }
      }
      var t = a; a = b; b = t;
    }
    return a;
  }

  function erodieren(m, w, h, mal) {
    var a = m, b = new Uint8Array(w * h);
    for (var d = 0; d < mal; d++) {
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var v = 1;
          for (var dy = -1; dy <= 1 && v; dy++) {
            var yy = y + dy;
            for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h || !a[yy * w + xx]) { v = 0; break; }
            }
          }
          b[y * w + x] = v;
        }
      }
      var t = a; a = b; b = t;
    }
    return a;
  }

  /* Halbe Aufloesung reicht: das Ergebnis ist ein GROBER Kandidat, der
   * anschliessend sowieso subpixelgenau nachgezogen wird. Spart 75 % der
   * Rechenzeit des Fallbacks. */
  function halbieren(b) {
    var w = b.w >> 1, h = b.h >> 1;
    var g = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var z = 2 * y * b.w, z2 = z + b.w, o = y * w;
      for (var x = 0; x < w; x++) {
        var i = 2 * x;
        g[o + x] = (b.g[z + i] + b.g[z + i + 1] + b.g[z2 + i] + b.g[z2 + i + 1]) * 0.25;
      }
    }
    return { g: g, w: w, h: h };
  }

  function flaechenKandidaten(bGross) {
    var b = halbieren(bGross);
    var out = [];
    var schwelle = otsu(b);
    var w = b.w, h = b.h, i;
    for (var modus = 0; modus < 2; modus++) {
      var maske = new Uint8Array(w * h), an = 0;
      for (i = 0; i < w * h; i++) {
        var hell = b.g[i] > schwelle;
        maske[i] = (modus === 0 ? hell : !hell) ? 1 : 0;
        an += maske[i];
      }
      var anteil = an / (w * h);
      if (anteil < 0.04 || anteil > 0.97) { continue; }
      /* Schliessen: Textloecher zu, danach oeffnen: duenne Bruecken weg */
      maske = erodieren(dilatieren(maske, w, h, 1), w, h, 1);
      var komp = maskeKomponente(maske, w, h);
      if (!komp || komp.groesse < 0.05 * w * h) { continue; }
      var hu = huelle(komp.punkte);
      var vier = groesstesViereck(hu);
      if (vier) {
        out.push(vier.map(function (p) { return [p[0] * 2 + 0.5, p[1] * 2 + 0.5]; }));
      }
    }
    return out;
  }

  function punktInnen(q, p) {
    var vz = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      var k = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (Math.abs(k) < 1e-9) { continue; }
      var s = k > 0 ? 1 : -1;
      if (vz === 0) { vz = s; } else if (s !== vz) { return false; }
    }
    return true;
  }

  function aussenGewinnt(liste, best) {
    var sieger = best;
    for (var i = 0; i < liste.length; i++) {
      var k = liste[i];
      if (k === best || k.flaeche <= sieger.flaeche * 1.04) { continue; }
      if (k.wert < 0.55 * best.wert) { continue; }
      if (k.geo < 0.7 * best.geo) { continue; }
      if (k.abdeckung < 0.9 * best.abdeckung && k.abdeckung < 0.9) { continue; }
      if (k.polaritaet < 0.75 * best.polaritaet && k.polaritaet < 0.8) { continue; }
      /* jede Seite des aeusseren Kandidaten muss eine echte STUFE sein */
      var schwach = false;
      for (var t = 0; t < 4; t++) {
        if (k.seiten[t].stufe < 0.3 && k.seiten[t].kontrast > 3) { schwach = true; }
      }
      if (schwach) { continue; }
      if (k.randSeiten && k.randSeiten.filter(Boolean).length >
          best.randSeiten.filter(Boolean).length) { continue; }
      /* der bisherige Sieger muss komplett im Kandidaten liegen
       * (kleine Toleranz: Ecken duerfen minimal herausragen) */
      var drin = 0;
      for (var e = 0; e < 4; e++) { if (punktInnen(k.q, best.q[e])) { drin++; } }
      if (drin < 4) { continue; }
      if (k.flaeche > sieger.flaeche) { sieger = k; }
    }
    return sieger;
  }

  /* ===================== 10. Hauptfunktion ======================== */
  /*
   * erkenne(rgba, breite, hoehe, optionen)
   *   optionen.arbeitsKante : Arbeitsaufloesung (Standard 256)
   *   optionen.minFlaeche   : Mindestflaeche des Vierecks (0..1, Std 0.06)
   *   optionen.feinKante    : Aufloesung fuer das Nachziehen (Std 2x Arbeit)
   *   optionen.randErlaubt  : duerfen Bildraender Kanten sein (Std true)
   *   optionen.kandidaten   : zusaetzliche Vierecke von aussen, z.B. aus der
   *                           KI-Erkennung (detect-nn.js). Format je Eintrag:
   *                           { quad: [[x,y]x4], konfidenz: 0..1 }. Sie
   *                           laufen durch GENAU dieselbe Bewertung wie die
   *                           selbst gefundenen Vierecke - es gewinnt also
   *                           immer das Viereck, das das Bild am besten
   *                           stuetzt, nicht pauschal "die KI".
   * Rueckgabe: { quad, konfidenz, wert, flaeche, randSeiten, quelle } | null
   */
  function erkenne(rgba, breite, hoehe, optionen) {
    optionen = optionen || {};
    var arbeitsKante = optionen.arbeitsKante || 256;
    var minFlaeche = optionen.minFlaeche === undefined ? 0.06 : optionen.minFlaeche;
    var randErlaubt = optionen.randErlaubt !== false;

    var diagnose = { alle: [] };
    modul.diagnose = diagnose;
    var b = arbeitsbild(rgba, breite, hoehe, arbeitsKante, 2, optionen.masse);
    modul.masse = { schaerfe: b.schaerfe || 0,
                    bewegung: b.bewegung === undefined ? -1 : b.bewegung };
    var pkte = kantenPunkte(b, 9000);
    var linien = houghLinien(b, pkte, 22);
    var i, j;
    for (i = 0; i < linien.length; i++) { linienStuetze(b, linien[i]); }
    linien = linien.filter(function (l) { return l.abdeckung > 0.22 && l.stuetze > 2.2; });
    if (randErlaubt) {
      var rl = randLinien(b);
      for (i = 0; i < rl.length; i++) { linienStuetze(b, rl[i]); linien.push(rl[i]); }
    }

    /* Linien in Familien (fast parallel) gruppieren.
     *
     * Entscheidend: In jeder Familie werden die beiden AEUSSERSTEN Linien
     * immer behalten. Eine Dokumentkante ist naemlich immer die aeusserste
     * Linie ihrer Richtung - die vielen starken Linien dazwischen sind
     * Textzeilen. Ohne diese Regel verdraengen 10 Textzeilen die echte
     * Blattkante aus der Auswahl (genau das Problem der alten Erkennung). */
    var familien = [];
    linien.sort(function (p, q) { return q.stuetze - p.stuetze; });
    for (i = 0; i < linien.length; i++) {
      var fam = null;
      for (j = 0; j < familien.length; j++) {
        if (winkelAbstand(familien[j].t, linien[i].t) < 15 * Math.PI / 180) {
          fam = familien[j]; break;
        }
      }
      if (!fam) { fam = { t: linien[i].t, mitglieder: [] }; familien.push(fam); }
      fam.mitglieder.push(linien[i]);
    }

    var paare = [];
    for (var fi = 0; fi < familien.length; fi++) {
      var mit = familien[fi].mitglieder;
      if (mit.length < 2) { continue; }
      /* nach Lage sortieren, Extreme + Staerkste behalten.
       * Bildrand-Linien zaehlen NICHT als Extreme - sonst besetzen sie die
       * beiden Aussenplaetze und verdraengen genau die echten Blattkanten,
       * um die es geht. */
      var ref = mit[0];
      mit.forEach(function (l) {
        l.lage = (l.px - ref.px) * ref.c + (l.py - ref.py) * ref.s;
      });
      var echte = mit.filter(function (l) { return !l.rand; });
      var raender = mit.filter(function (l) { return l.rand; });
      var auswahl = [];
      if (echte.length) {
        var nachLage = echte.slice().sort(function (p, q) { return p.lage - q.lage; });
        /* die beiden aeussersten UND die zweitaeussersten Linien je Seite:
         * oft ist die allererste Linie eine Stoerung (Tischkante, Schatten)
         * und die echte Blattkante liegt direkt dahinter. */
        var kandidatenIdx = [0, 1, nachLage.length - 2, nachLage.length - 1];
        for (j = 0; j < kandidatenIdx.length; j++) {
          var ix = kandidatenIdx[j];
          if (ix >= 0 && ix < nachLage.length && auswahl.indexOf(nachLage[ix]) < 0) {
            auswahl.push(nachLage[ix]);
          }
        }
      }
      for (j = 0; j < echte.length && auswahl.length < 8; j++) {
        if (auswahl.indexOf(echte[j]) < 0) { auswahl.push(echte[j]); }
      }
      auswahl = auswahl.concat(raender);
      for (i = 0; i < auswahl.length; i++) {
        for (j = i + 1; j < auswahl.length; j++) {
          var a = auswahl[i], c = auswahl[j];
          if (a.rand && c.rand && winkelAbstand(a.t, c.t) > 0.2) { continue; }
          var abst = Math.abs((c.px - a.px) * a.c + (c.py - a.py) * a.s);
          if (abst < 0.16 * Math.min(b.w, b.h)) { continue; }
          paare.push({ a: a, b: c, t: a.t, fam: fi,
                       guete: Math.min(a.stuetze, c.stuetze) * (0.6 + 0.4 * abst / b.diag) });
        }
      }
    }
    paare.sort(function (p, q) { return q.guete - p.guete; });
    if (paare.length > 40) { paare = paare.slice(0, 40); }

    /* Paar x Paar -> Viereck */
    var roh = [];
    for (i = 0; i < paare.length; i++) {
      for (j = i + 1; j < paare.length; j++) {
        var P = paare[i], Q = paare[j];
        if (P.fam === Q.fam) { continue; }
        var wink = winkelAbstand(P.t, Q.t) * 180 / Math.PI;
        if (wink < 48) { continue; }
        var e = [schnitt(P.a, Q.a), schnitt(Q.a, P.b), schnitt(P.b, Q.b), schnitt(Q.b, P.a)];
        if (!e[0] || !e[1] || !e[2] || !e[3]) { continue; }
        var q = sortiereEcken(e, b.w / 2, b.h / 2);
        if (!formOk(b, q, minFlaeche)) { continue; }
        var randZahl = (P.a.rand ? 1 : 0) + (P.b.rand ? 1 : 0) +
                       (Q.a.rand ? 1 : 0) + (Q.b.rand ? 1 : 0);
        if (randZahl > 2) { continue; }
        var grob = Math.pow(Math.min(P.guete, Q.guete) + 0.1, 0.35) *
                   (flaeche(q) / (b.w * b.h));
        roh.push({ q: q, grob: grob, randZahl: randZahl,
                   randLinien: [P.a, Q.a, P.b, Q.b] });
      }
    }
    roh.sort(function (p, q) { return q.grob - p.grob; });
    if (roh.length > 26) { roh = roh.slice(0, 26); }

    /* genaue Bewertung */
    var best = null;
    var bewertet = [];
    function bewerteAlle(liste) {
      for (var n = 0; n < liste.length; n++) {
        /* welche Seite liegt auf einem Bildrand? */
        var rs = [false, false, false, false];
        for (var k = 0; k < 4; k++) {
          var p1 = liste[n].q[k], p2 = liste[n].q[(k + 1) % 4];
          var mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
          rs[k] = mx < 2.5 || my < 2.5 || mx > b.w - 3.5 || my > b.h - 3.5;
        }
        var bw = bewerte(b, liste[n].q, rs);
        bw.q = liste[n].q;
        bw.randSeiten = rs;
        bw.quelle = liste[n].kiQuelle ? "ki"
                  : (liste[n].flaechenQuelle ? "flaeche" : "linien");
        if (liste[n].kiQuelle) {
          /* Das Netz sieht ein Dokument auch dort, wo gar keine Kante im
           * Bild ist (weisses Blatt auf weissem Tisch, Schattenrand,
           * Finger ueber der Ecke). Reine Kantenbewertung kann das
           * naturgemaess nicht belohnen - deshalb bekommt ein
           * KI-Vorschlag einen Bonus, der mit seiner eigenen Sicherheit
           * waechst. Bei unsicherer KI (<0.4) ist der Bonus klein, das
           * Bild entscheidet dann weiter allein. */
          bw.kiKonf = liste[n].kiKonf;
          /* Quadratisch, nicht linear: ein unsicheres Netz (z.B. weil das
           * Dokument ueber alle vier Bildraender hinausragt und es die
           * Ecken nur raet) bekommt dadurch sogar einen Abschlag statt
           * eines Bonus und kann ein gut gestuetztes Viereck aus dem Bild
           * nicht verdraengen. */
          bw.wert *= 0.5 + 1.8 * liste[n].kiKonf * liste[n].kiKonf;
          bw.konfidenz = Math.max(bw.konfidenz, 0.55 * liste[n].kiKonf +
                                                0.45 * bw.konfidenz);
        }
        bewertet.push(bw);
        if (modul.sammle) { diagnose.alle.push(bw); }
        if (!best || bw.wert > best.wert) { best = bw; }
      }
    }
    bewerteAlle(roh);

    /* ---- Vorschlaege von aussen (KI) in dieselbe Bewertung werfen ---- */
    var kiListe = [];
    var extern = optionen.kandidaten || [];
    for (i = 0; i < extern.length; i++) {
      var ek = extern[i];
      var eq = ek && ek.quad ? ek.quad : ek;
      if (!eq || eq.length !== 4) { continue; }
      var ekonf = (ek && ek.konfidenz !== undefined) ? ek.konfidenz : 0.8;
      var ska = [b.w / breite, b.h / hoehe];
      var qk = [];
      for (j = 0; j < 4; j++) {
        qk.push([klemme(eq[j][0] * ska[0], -0.25 * b.w, 1.25 * b.w),
                 klemme(eq[j][1] * ska[1], -0.25 * b.h, 1.25 * b.h)]);
      }
      qk = sortiereEcken(qk, b.w / 2, b.h / 2);
      if (!konvex(qk)) { continue; }
      if (flaeche(qk) < minFlaeche * b.w * b.h * 0.6) { continue; }
      kiListe.push({ q: qk, kiQuelle: true, kiKonf: klemme(ekonf, 0, 1) });
    }
    if (kiListe.length) { bewerteAlle(kiListe); }

    /* Helligkeits-Fallback nur, wenn die Linien nichts Ueberzeugendes
     * geliefert haben: er kostet mit Abstand die meiste Rechenzeit und
     * wird im Normalfall gar nicht gebraucht. */
    var flAnzahl = 0;
    var kiSicher = best && best.quelle === "ki" && best.kiKonf > 0.85;
    if (!kiSicher &&
        (!best || best.konfidenz < 0.95 || best.flaeche < 0.2 ||
         best.randSeiten.filter(Boolean).length)) {
      var flk = flaechenKandidaten(b), fliste = [];
      for (i = 0; i < flk.length; i++) {
        var qf = sortiereEcken(flk[i], b.w / 2, b.h / 2);
        if (formOk(b, qf, minFlaeche)) {
          fliste.push({ q: qf, flaechenQuelle: true });
        }
      }
      flAnzahl = fliste.length;
      bewerteAlle(fliste);
    }
    diagnose.linien = linien.length;
    diagnose.paare = paare.length;
    diagnose.kandidaten = roh.length + flAnzahl;
    if (best) {
      diagnose.geo = best.geo; diagnose.abdeckung = best.abdeckung;
      diagnose.polaritaet = best.polaritaet; diagnose.wert = best.wert;
      diagnose.quelle = best.quelle; diagnose.kontrast = best.kontrast;
    }
    if (!best) { return null; }

    /* AUSSEN GEWINNT: Liegt der Sieger vollstaendig INNERHALB eines anderen,
     * ebenfalls gut gestuetzten Kandidaten, dann ist der aeussere das
     * Dokument und der innere nur ein Teil davon (Textblock, Tabelle,
     * Bild im Dokument). Genau dieser Fall liess Scans "angeschnitten"
     * wirken. */
    if (modul.diagnose.alle && modul.diagnose.alle.length) {
      best = aussenGewinnt(modul.diagnose.alle, best);
    } else {
      best = aussenGewinnt(bewertet, best);
    }

    /* Mindestanforderungen - sonst lieber "nichts gefunden" melden.
     *
     * Ausnahme fuer die KI: ihre Aussage haengt NICHT an sichtbaren
     * Kanten. Ein helles Blatt auf hellem Tisch hat kaum Kantenstuetze
     * (geo klein), ist aber trotzdem ein Dokument. Deshalb genuegt bei
     * einem sicheren KI-Viereck eine deutlich kleinere Huerde - sonst
     * meldet die App weiter "kein Dokument", obwohl sie es gesehen hat. */
    var kiTraegt = best.quelle === "ki" && best.kiKonf >= 0.52;
    if (kiTraegt) {
      /* KI-Viereck: eigene, niedrigere Huerde (siehe oben). */
      if (best.flaeche < 0.03) { diagnose.abgelehnt = true; return null; }
    } else if (best.geo < 3.0 || best.abdeckung < 0.38) {
      diagnose.abgelehnt = true; return null;
    }

    /* Nachziehen: moeglichst in hoeherer Aufloesung */
    var quad = best.q;
    var feinKante = optionen.feinKante || Math.min(Math.max(breite, hoehe), arbeitsKante * 2.5);
    var fein = b, faktorX = 1, faktorY = 1;
    if (feinKante > arbeitsKante * 1.2) {
      fein = arbeitsbild(rgba, breite, hoehe, feinKante, 1);
      faktorX = fein.w / b.w; faktorY = fein.h / b.h;
      quad = quad.map(function (p) { return [p[0] * faktorX, p[1] * faktorY]; });
    }
    /* Nachziehen: bei einem KI-Viereck kleiner suchen. Die Ecken sitzen
     * dann schon fast richtig; ein weiter Suchkorridor wuerde nur das
     * Risiko erhoehen, auf eine Textzeile oder einen Schattenrand
     * danebenzuspringen. */
    var such = Math.max(4, (kiTraegt ? 0.012 : 0.022) * fein.diag);
    quad = verfeinere(fein, quad, such);
    quad = verfeinere(fein, quad, Math.max(3, such * 0.45));

    /* zurueck in Eingabekoordinaten */
    var sx = breite / fein.w, sy = hoehe / fein.h;
    var ergebnis = quad.map(function (p) {
      return [klemme(p[0] * sx, -0.02 * breite, breite * 1.02),
              klemme(p[1] * sy, -0.02 * hoehe, hoehe * 1.02)];
    });
    ergebnis = sortiereEcken(ergebnis, breite / 2, hoehe / 2);

    return {
      quad: ergebnis,
      konfidenz: best.konfidenz,
      wert: best.wert,
      flaeche: flaeche(ergebnis) / (breite * hoehe),
      abdeckung: best.abdeckung,
      polaritaet: best.polaritaet,
      randSeiten: best.randSeiten,
      randZahl: best.randSeiten.filter(Boolean).length,
      quelle: best.quelle
    };
  }

  var modul = {
    erkenne: erkenne,
    /* fuer Tests / Wiederverwendung */
    _intern: {
      arbeitsbild: arbeitsbild, kantenPunkte: kantenPunkte,
      houghLinien: houghLinien, verfeinere: verfeinere,
      bewerte: bewerte, sortiereEcken: sortiereEcken, flaeche: flaeche
    },
    version: 3
  };
  global.UltraErkennung = modul;

})(typeof self !== "undefined" ? self : this);
