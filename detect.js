/*
 * Ultra Scan - Dokument-Erkennung (reines JavaScript, laeuft ohne Python).
 * ============================================================================
 *
 * Diese Datei findet die 4 Eckpunkte eines Dokuments in einem Bild.
 * Version 4 - Verbesserungen fuer weiss-auf-weiss und Stapel:
 *
 *   - Textur-Karte (lokale Varianz) unterscheidet glattes Papier von
 *     strukturiertem Untergrund (Decke, Teppich, Holz). Inspiriert von
 *     dhruv-1004/document-scanner (HSV/LAB Strategien) und BiRefNet
 *     (Hintergrund vs Vordergrund via Textur).
 *   - Saettigungs-Karte: Papier hat niedrige Saettigung, farbiger
 *     Hintergrund oft hoehere. Hilft bei weissem Blatt auf weisser Decke
 *     wenn Textur allein nicht reicht.
 *   - Kontrast-adaptive Schwellen: Bei niedrigem Gesamtkontrast (weiss
 *     auf weiss) werden Kanten-Schwellen abgesenkt, damit schwache
 *     Papierkanten nicht verworfen werden.
 *   - Textdichte-Bonus: Ein korrektes Dokument-Viereck enthaelt innen
 *     deutlich mehr Kantenpunkte (Text) als aussen. Ein zu grosses
 *     Viereck (Stapelkante, Tischkante) hat draussen viel Textur, drinnen
 *     weniger Textdichte. Das unterscheidet Top-Blatt vom Stapel.
 *   - Stapel-Logik: Wenn KI-Viereck innerhalb klassischem liegt und
 *     Flaechenverhaeltnis <0.85, gewinnt KI auch bei niedriger Konfidenz
 *     (0.35+). Das ist genau der Fall "weisses Blatt auf weissem Stapel".
 *   - Flaechen-Fallback jetzt mit 4 Quellen: Helligkeit, normalisierte
 *     Helligkeit, Textur, Saettigung.
 *
 * Verfahren bleibt: Sobel -> Hough -> Vierecke -> Bewertung -> Verfeinern.
 * Zusaetzliche Quellen laufen durch DIESELBE Bewertung.
 */
"use strict";

(function (global) {

  /* ======================= kleine Helfer ========================= */
  function klemme(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function winkelAbstand(a, b) {
    var d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  }

  /* ============== 1. Graustufen + Verkleinerung =================== */
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
    return { g: g, w: dw, h: dh, sx: w / dw, sy: h / dh, xi: xi, yi: yi, dw: dw, dh: dh };
  }

  /* Saettigung: max-min, flaechengemittelt wie graubild */
  function sattBild(rgba, w, h, maxKante, vorXiYi) {
    var f = Math.max(w, h) / maxKante;
    if (f < 1) { f = 1; }
    var dw = Math.max(32, Math.round(w / f));
    var dh = Math.max(32, Math.round(h / f));
    var summe = new Float32Array(dw * dh);
    var anzahl = new Float32Array(dw * dh);
    var xi, yi;
    if (vorXiYi) {
      xi = vorXiYi.xi; yi = vorXiYi.yi;
    } else {
      xi = new Int32Array(w); yi = new Int32Array(h);
      for (var x = 0; x < w; x++) { xi[x] = Math.min(dw - 1, (x * dw / w) | 0); }
      for (var y = 0; y < h; y++) { yi[y] = Math.min(dh - 1, (y * dh / h) | 0); }
    }
    for (var y = 0; y < h; y++) {
      var zeile = y * w * 4, ziel = yi[y] * dw;
      for (var x = 0; x < w; x++) {
        var p = zeile + x * 4;
        var r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var s = mx - mn;
        var k = ziel + xi[x];
        summe[k] += s; anzahl[k]++;
      }
    }
    var out = new Float32Array(dw * dh);
    for (var i = 0; i < dw * dh; i++) { out[i] = anzahl[i] ? summe[i] / anzahl[i] : 0; }
    return out;
  }

  /* ===================== 2. Weichzeichnen ========================= */
  function weich(src, w, h, durchgaenge) {
    var a = src, b = new Float32Array(w * h), x, y, i;
    for (var d = 0; d < durchgaenge; d++) {
      for (y = 0; y < h; y++) {
        var z = y * w;
        for (x = 0; x < w; x++) {
          var l = a[z + (x > 0 ? x - 1 : 0)];
          var r = a[z + (x < w - 1 ? x + 1 : w - 1)];
          b[z + x] = (l + 2 * a[z + x] + r) * 0.25;
        }
      }
      for (x = 0; x < w; x++) {
        for (y = 0; y < h; y++) {
          var o = b[(y > 0 ? y - 1 : 0) * w + x];
          var u = b[(y < h - 1 ? y + 1 : h - 1) * w + x];
          a[y * w + x] = (o + 2 * b[y * w + x] + u) * 0.25;
        }
      }
    }
    return a;
  }

  /* Kasten-Mittel via Integralbild - fuer Textur */
  function kastenMittel(src, w, h, r) {
    var out = new Float32Array(w * h);
    var intg = new Float32Array((w + 1) * (h + 1));
    var x, y;
    for (y = 0; y < h; y++) {
      var sum = 0;
      var zw = y * w, zi = (y + 1) * (w + 1) + 1;
      for (x = 0; x < w; x++) {
        sum += src[zw + x];
        intg[zi + x] = intg[zi + x - (w + 1)] + sum;
      }
    }
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      var iy0 = y0 * (w + 1), iy1 = (y1 + 1) * (w + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        var a = intg[iy0 + x0], b = intg[iy0 + x1 + 1], c = intg[iy1 + x0], d = intg[iy1 + x1 + 1];
        var fl = (y1 - y0 + 1) * (x1 - x0 + 1);
        out[y * w + x] = (d - b - c + a) / fl;
      }
    }
    return out;
  }

  function texturKarte(g, w, h) {
    // lokale Varianz in 5x5 Fenster
    var r = 2;
    var mean = kastenMittel(g, w, h, r);
    var g2 = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) { g2[i] = g[i] * g[i]; }
    var mean2 = kastenMittel(g2, w, h, r);
    var vari = new Float32Array(w * h);
    for (var j = 0; j < w * h; j++) {
      var v = mean2[j] - mean[j] * mean[j];
      vari[j] = v < 0 ? 0 : Math.sqrt(v);
    }
    return { mean: mean, vari: vari };
  }

  function kontrastMasse(g, w, h) {
    var n = w * h, sum = 0, quad = 0;
    for (var i = 0; i < n; i++) { sum += g[i]; quad += g[i] * g[i]; }
    var m = sum / n;
    var vari = quad / n - m * m;
    return { mittel: m, std: Math.sqrt(Math.max(0, vari)) };
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
        var sx = ((c + 2 * e + j) - (a + 2 * d + f)) * 0.25;
        var sy = ((f + 2 * i + j) - (a + 2 * b + c)) * 0.25;
        gx[z + x] = sx; gy[z + x] = sy;
        mag[z + x] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    return { gx: gx, gy: gy, mag: mag };
  }

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
      var versatz = dSumme / n;
      var abw = 0;
      for (i = 0; i < n; i++) {
        var d = g[i] - letztesGrau[i] - versatz;
        abw += d < 0 ? -d : d;
      }
      bew = (abw / n) / streuung;
    }
    if (!letztesGrau || letzteGroesse !== n) { letztesGrau = new Float32Array(n); }
    letztesGrau.set(g);
    letzteGroesse = n;
    return bew;
  }

  /* Arbeitsbild bauen (Grau + Gradienten + Kennzahlen + Textur + Satt) */
  function arbeitsbild(rgba, w, h, maxKante, glaetten, masse) {
    var b = graubild(rgba, w, h, maxKante);
    if (masse) {
      b.schaerfe = schaerfeWert(b.g, b.w, b.h);
      b.bewegung = bewegungWert(b.g, b.w, b.h);
    }
    // Kontrast vor dem Weichzeichnen messen (auf Roh-Grau)
    var km = kontrastMasse(b.g, b.w, b.h);
    b.kontrastStd = km.std;
    b.kontrastMittel = km.mittel;

    // Textur auf Roh-Grau (vor Glaetten) fuer bessere Trennung
    var tex = texturKarte(b.g, b.w, b.h);
    b.texturVari = tex.vari;
    b.texturMean = tex.mean;

    // Saettigung
    try {
      b.satt = sattBild(rgba, w, h, maxKante, { xi: b.xi, yi: b.yi });
    } catch (e) { b.satt = new Float32Array(b.w * b.h); }

    b.g = weich(b.g, b.w, b.h, glaetten === undefined ? 2 : glaetten);
    var gr = gradienten(b.g, b.w, b.h);
    b.gx = gr.gx; b.gy = gr.gy; b.mag = gr.mag;
    b.diag = Math.sqrt(b.w * b.w + b.h * b.h);
    return b;
  }

  function grauAn(b, x, y) {
    if (x < 0) { x = 0; } if (y < 0) { y = 0; }
    if (x > b.w - 1.001) { x = b.w - 1.001; }
    if (y > b.h - 1.001) { y = b.h - 1.001; }
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * b.w + x0;
    var o = b.g[i] + (b.g[i + 1] - b.g[i]) * fx;
    var u = b.g[i + b.w] + (b.g[i + b.w + 1] - b.g[i + b.w]) * fx;
    return o + (u - o) * fy;
  }

  function gradAn(b, x, y, nx, ny) {
    if (x < 1 || y < 1 || x > b.w - 2.001 || y > b.h - 2.001) { return 0; }
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * b.w + x0;
    var gxv = (b.gx[i] * (1 - fx) + b.gx[i + 1] * fx) * (1 - fy) +
              (b.gx[i + b.w] * (1 - fx) + b.gx[i + b.w + 1] * fx) * fy;
    var gyv = (b.gy[i] * (1 - fx) + b.gy[i + 1] * fx) * (1 - fy) +
              (b.gy[i + b.w] * (1 - fx) + b.gy[i + b.w + 1] * fx) * fy;
    return gxv * nx + gyv * ny;
  }

  function texturAn(b, x, y) {
    if (!b.texturVari) { return 0; }
    if (x < 0) { x = 0; } if (y < 0) { y = 0; }
    if (x > b.w - 1.001) { x = b.w - 1.001; }
    if (y > b.h - 1.001) { y = b.h - 1.001; }
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * b.w + x0;
    var o = b.texturVari[i] + (b.texturVari[i + 1] - b.texturVari[i]) * fx;
    var u = b.texturVari[i + b.w] + (b.texturVari[i + b.w + 1] - b.texturVari[i + b.w]) * fx;
    return o + (u - o) * fy;
  }

  /* ============= 4. Kantenpunkte (mit Non-Max-Suppression) ======== */
  var GEWICHT_DECKEL = 28;

  function kantenPunkte(b, maxPunkte) {
    var w = b.w, h = b.h, mag = b.mag, gx = b.gx, gy = b.gy;
    var hist = new Int32Array(257), i, m;
    for (i = 0; i < mag.length; i++) {
      m = mag[i] | 0; if (m > 256) { m = 256; }
      hist[m]++;
    }
    var ziel = Math.round(mag.length * 0.10), sum = 0, schwelle = 256;
    for (i = 256; i >= 0; i--) { sum += hist[i]; if (sum >= ziel) { schwelle = i; break; } }

    // Kontrast-adaptiv: bei niedrigem Kontrast (weiss auf weiss) Schwelle senken
    var kontrastStd = b.kontrastStd || 20;
    var minSchwelle = 2.5, maxSchwelle = 14;
    if (kontrastStd < 12) {
      minSchwelle = 0.9;
      maxSchwelle = 8;
    } else if (kontrastStd < 18) {
      minSchwelle = 1.4;
      maxSchwelle = 10;
    }
    if (schwelle < minSchwelle) { schwelle = minSchwelle; }
    if (schwelle > maxSchwelle) { schwelle = maxSchwelle; }

    var treffer = new Int32Array(w * h);
    var n = 0, x, y, k, ax, ay, dx, dy;
    for (y = 2; y < h - 2; y++) {
      var z = y * w;
      for (x = 2; x < w - 2; x++) {
        k = z + x;
        m = mag[k];
        if (m < schwelle) { continue; }
        // Textur-Boost: wenn an dieser Stelle Textur stark wechselt, ist es eher Papierkante
        if (b.texturVari) {
          var tv = b.texturVari[k];
          // Fabric hat hohe Varianz (5-15), Papier glatt (0.5-3) aber Text hat mittlere.
          // Wir wollen Kanten wo Textur innen niedrig und aussen hoch oder umgekehrt.
          // Einfach: wenn Varianz sehr hoch (>8) und Gradient klein, ist es eher Fabric-Rauschen -> abwerten
          if (tv > 12 && m < 6) { continue; }
        }
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
      ws[j] = mag[k] > GEWICHT_DECKEL ? GEWICHT_DECKEL : mag[k];
      j++;
    }
    return { xs: xs, ys: ys, gxs: gxs, gys: gys, ws: ws, n: j,
             schwelle: schwelle, roh: n, kontrastStd: kontrastStd };
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
  var STREU = [0.32, 0.72, 1.0, 0.72, 0.32];

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
    var tmp = new Float32Array(rhoBins);
    for (bin = 0; bin < WINKEL_BINS; bin++) {
      var o = bin * rhoBins;
      for (i = 0; i < rhoBins; i++) {
        tmp[i] = acc[o + (i > 0 ? i - 1 : 0)] + 2 * acc[o + i] +
                 acc[o + (i < rhoBins - 1 ? i + 1 : rhoBins - 1)];
      }
      for (i = 0; i < rhoBins; i++) { acc[o + i] = tmp[i] * 0.25; }
    }
    var max = 0;
    for (i = 0; i < acc.length; i++) { if (acc[i] > max) { max = acc[i]; } }
    if (max <= 0) { return []; }
    var grenze = 0.14 * max;
    // Bei niedrigem Kontrast: niedrigere Grenze, damit schwache Linien durchkommen
    if (b.kontrastStd && b.kontrastStd < 14) { grenze = 0.08 * max; }
    else if (b.kontrastStd && b.kontrastStd < 20) { grenze = 0.11 * max; }
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

  function linienStuetze(b, lin) {
    if (lin.rand) { lin.stuetze = 3; lin.abdeckung = 1; return; }
    var st = strecke(b, lin);
    if (!st) { lin.stuetze = 0; lin.abdeckung = 0; return; }
    var a = st[0], c = st[1];
    var len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    var n = Math.max(12, Math.min(80, Math.round(len / 3)));
    var summe = 0, treffer = 0;
    var schwelle = 4;
    if (b.kontrastStd && b.kontrastStd < 14) { schwelle = 1.2; }
    else if (b.kontrastStd && b.kontrastStd < 20) { schwelle = 2.2; }
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      var v = Math.abs(gradAn(b, a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, lin.c, lin.s));
      summe += v;
      if (v > schwelle) { treffer++; }
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
    for (i = 0; i < 4; i++) {
      var a = q[(i + 3) % 4], m = q[i], c = q[(i + 1) % 4];
      var v1x = a[0] - m[0], v1y = a[1] - m[1];
      var v2x = c[0] - m[0], v2y = c[1] - m[1];
      var n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
      if (n1 < 0.06 * b.diag || n2 < 0.06 * b.diag) { return false; }
      var cosw = (v1x * v2x + v1y * v2y) / (n1 * n2);
      if (cosw > 0.40 || cosw < -0.40) { return false; }
    }
    var l = [];
    for (i = 0; i < 4; i++) {
      l.push(Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
    }
    if (Math.max(l[0], l[2]) > 3.2 * Math.min(l[0], l[2])) { return false; }
    if (Math.max(l[1], l[3]) > 3.2 * Math.min(l[1], l[3])) { return false; }
    return true;
  }

  /* ================== 7. Bewertung eines Vierecks ================= */
  function seiteMessen(b, a, c, mitte) {
    var L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 6) { return { stuetze: 0, abdeckung: 0, pol: 0, kontrast: 0, fort: 0, textur: 0 }; }
    var dx = (c[0] - a[0]) / L, dy = (c[1] - a[1]) / L;
    var nx = -dy, ny = dx;
    if (mitte) {
      var vx = mitte[0] - (a[0] + c[0]) / 2, vy = mitte[1] - (a[1] + c[1]) / 2;
      if (nx * vx + ny * vy > 0) { nx = -nx; ny = -ny; }
    }
    var n = Math.max(14, Math.min(64, Math.round(L / 4)));
    var abstand = Math.max(2.5, 0.012 * b.diag);
    var summe = 0, treffer = 0, polSum = 0, kontrast = 0, gueltig = 0, stufe = 0;
    var texturDiff = 0, texturN = 0;
    var gradSchw = 4;
    if (b.kontrastStd && b.kontrastStd < 14) { gradSchw = 1.2; }
    else if (b.kontrastStd && b.kontrastStd < 20) { gradSchw = 2.2; }
    for (var i = 0; i < n; i++) {
      var t = 0.05 + 0.9 * (i / (n - 1));
      var px = a[0] + (c[0] - a[0]) * t, py = a[1] + (c[1] - a[1]) * t;
      var best = 0;
      for (var s = -1.5; s <= 1.51; s += 0.75) {
        var v = Math.abs(gradAn(b, px + s * nx, py + s * ny, nx, ny));
        if (v > best) { best = v; }
      }
      summe += best;
      if (best > gradSchw) { treffer++; }
      var innen = grauAn(b, px - abstand * nx, py - abstand * ny);
      var aussen = grauAn(b, px + abstand * nx, py + abstand * ny);
      polSum += (innen - aussen) > 0 ? 1 : -1;
      kontrast += Math.abs(innen - aussen);
      var fern = grauAn(b, px + 2.8 * abstand * nx, py + 2.8 * abstand * ny);
      var nah = Math.abs(innen - aussen);
      var weit = Math.abs(innen - fern);
      var gleich = ((innen - aussen) > 0) === ((innen - fern) > 0);
      stufe += gleich ? Math.min(1.15, weit / (nah + 1.5)) : 0;
      gueltig++;
      if (b.texturVari) {
        var ti = texturAn(b, px - abstand * nx, py - abstand * ny);
        var ta = texturAn(b, px + abstand * nx, py + abstand * ny);
        texturDiff += Math.abs(ti - ta);
        texturN++;
      }
    }
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
      fort: fn ? fort / fn : 0,
      textur: texturN ? texturDiff / texturN : 0
    };
  }

  function schwerpunkt(q) {
    return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
            (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
  }

  // Textdichte: Anteil Kantenpunkte innerhalb Viereck
  function textDichte(b, q) {
    if (!b.pkte || !b.pkte.n) { return 0.5; }
    var pkte = b.pkte;
    var count = 0, inside = 0;
    // Bounding box fuer schnellen Test
    var minX = Math.min(q[0][0], q[1][0], q[2][0], q[3][0]);
    var maxX = Math.max(q[0][0], q[1][0], q[2][0], q[3][0]);
    var minY = Math.min(q[0][1], q[1][1], q[2][1], q[3][1]);
    var maxY = Math.max(q[0][1], q[1][1], q[2][1], q[3][1]);
    for (var i = 0; i < pkte.n; i++) {
      var x = pkte.xs[i], y = pkte.ys[i];
      if (x < minX || x > maxX || y < minY || y > maxY) { continue; }
      if (punktInnen(q, [x, y])) {
        inside++;
      }
    }
    var area = flaeche(q);
    if (area < 1) { return 0; }
    // Dichte pro Flaeche, normiert
    return inside / Math.sqrt(area);
  }

  function bewerte(b, q, randSeiten) {
    var mitte = schwerpunkt(q), i;
    var seiten = [];
    var geo = 0, abd = 0, polGew = 0, polSumme = 0, kon = 0, strafe = 1;
    var texturSum = 0;
    var kontrastStd = b.kontrastStd || 20;
    for (i = 0; i < 4; i++) {
      var a = q[i], c = q[(i + 1) % 4];
      var m = seiteMessen(b, a, c, mitte);
      seiten.push(m);
      var s = m.stuetze * (0.35 + 0.65 * m.abdeckung) *
              (m.kontrast < 3 ? 0.9 : (0.4 + 0.6 * Math.min(1, m.stufe)));
      // Textur-Bonus: Kante wo Textur wechselt ist wahrscheinlicher Papierkante
      // Bei niedrigem Kontrast (weiss auf weiss) Textur viel staerker gewichten
      if (m.textur > 0.5) {
        if (kontrastStd < 14) {
          s *= (1 + 0.55 * Math.min(1, m.textur / 2.5));
        } else if (kontrastStd < 20) {
          s *= (1 + 0.32 * Math.min(1, m.textur / 3));
        } else {
          s *= (1 + 0.15 * Math.min(1, m.textur / 3));
        }
      } else if (kontrastStd < 12 && m.textur > 0.25) {
        // Auch kleine Textur-Unterschiede belohnen bei sehr niedrigem Kontrast
        s *= (1 + 0.18 * m.textur);
      }
      if (randSeiten && randSeiten[i]) {
        // Randkanten koennen Papierraender sein, bleiben aber gegenueber
        // innenliegenden, bildgestuetzten Kanten benachteiligt.
        if (kontrastStd < 14) {
          // Randkanten erhalten keine kuenstlich hohe Stuetzung.
          s = 4.0; strafe *= 0.65;
        } else {
          s = 2.6; strafe *= 0.50;
        }
      } else if (m.fort > Math.max(5, 0.75 * m.stuetze)) {
        // Fortsetzung hinter Kante: bei niedrigem Kontrast weniger streng
        if (kontrastStd < 14) { strafe *= 0.75; }
        else { strafe *= 0.55; }
      }
      geo += Math.log(Math.max(s, 0.25));
      abd += m.abdeckung / 4;
      polSumme += m.pol * m.kontrast;
      polGew += m.kontrast;
      kon += m.kontrast / 4;
      texturSum += m.textur / 4;
    }
    geo = Math.exp(geo / 4);
    var pol = polGew > 1e-6 ? polSumme / polGew : 0;
    var fl = flaeche(q) / (b.w * b.h);
    var einigkeit = Math.abs(pol);
    var polBonus;
    if (kontrastStd < 14) {
      // Bei sehr niedrigem Kontrast Polaritaet weniger wichtig
      polBonus = kon < 1.0 ? 0.75 : (0.55 + 0.45 * einigkeit);
    } else {
      polBonus = kon < 2.0 ? 0.6 : (0.3 + 0.7 * einigkeit);
    }
    var ab = Math.hypot(mitte[0] - b.w / 2, mitte[1] - b.h / 2) / (b.diag / 2);
    var mitteBonus = 1 - 0.3 * Math.min(1, ab);
    // Bei niedrigem Kontrast Mitte-Bonus reduzieren (Papier liegt oft nicht mittig bei weiss-auf-weiss)
    if (kontrastStd < 14) { mitteBonus = 1 - 0.18 * Math.min(1, ab); }

    // Textdichte-Bonus: innen sollte mehr Text sein als aussen
    var dichte = textDichte(b, q);
    var dichteBonus = 0.8 + 0.4 * Math.min(1, dichte / 2.5);
    if (kontrastStd < 14) {
      // Bei niedrigem Kontrast Dichte noch wichtiger (Top-Blatt hat Text)
      dichteBonus = 0.7 + 0.65 * Math.min(1, dichte / 2.0);
    }
    // Bei sehr niedriger Dichte (nur Hintergrund) abwerten
    if (dichte < 0.15) { dichteBonus *= 0.6; }

    var wert = geo * fl * polBonus * mitteBonus * strafe * dichteBonus;
    // Textur-Bonus global: wenn Texturunterschied an Kanten hoch, belohnen
    if (texturSum > 0.8) {
      wert *= kontrastStd < 14 ? 1.22 : (kontrastStd < 20 ? 1.14 : 1.08);
    } else if (kontrastStd < 14 && texturSum > 0.4) {
      wert *= 1.10;
    }

    var konfBasis = (geo / 13) * (0.3 + 0.7 * abd) *
                    (0.45 + 0.55 * einigkeit) * dichteBonus;
    // Bei niedrigem Kontrast Konfidenz etwas anheben wenn Textur hoch
    if (kontrastStd < 14 && texturSum > 0.6) {
      konfBasis *= 1.25;
    }
    return {
      wert: wert, geo: geo, abdeckung: abd, polaritaet: einigkeit,
      kontrast: kon, flaeche: fl, seiten: seiten,
      textur: texturSum, dichte: dichte,
      konfidenz: klemme(konfBasis, 0, 1)
    };
  }

  /* ========== 8. Kanten subpixelgenau nachziehen ================== */
  function gerade(punkte) {
    var n = punkte.length, mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += punkte[i][0]; my += punkte[i][1]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      var dx = punkte[i][0] - mx, dy = punkte[i][1] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var dxr = Math.cos(theta), dyr = Math.sin(theta);
    return { px: mx, py: my, dx: dxr, dy: dyr, c: -dyr, s: dxr,
             r: mx * (-dyr) + my * dxr };
  }

  function verfeinereSeite(b, a, c, suchweite, polaritaet, mitte) {
    var L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 10) { return null; }
    var minSignal = b.kontrastStd < 14 ? 1.0 : 2.0;
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
      for (var s = -suchweite; s <= suchweite + 0.001; s += 0.5) {
        var g = gradAn(b, px + s * nx, py + s * ny, nx, ny);
        var passt = polaritaet === 0 || (polaritaet > 0 ? g < 0 : g > 0);
        var v = Math.abs(g) * (passt ? 1 : 0.3);
        v *= 1 - 0.25 * Math.abs(s) / (suchweite + 1e-6);
        if (v > bestV) { bestV = v; bestS = s; }
      }
      if (bestS !== null && bestV > minSignal) {
        punkte.push([px + bestS * nx, py + bestS * ny]);
      }
    }
    if (punkte.length < 8) { return null; }
    var lin = gerade(punkte);
    for (var k = 0; k < 3; k++) {
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
        neu.push(q[i]); continue;
      }
      var p = schnitt(l1, l2);
      if (!p) { neu.push(q[i]); continue; }
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

  function otsuFloat(arr) {
    // Otsu fuer Float-Array (0..max), fuer Textur/Satt
    var n = arr.length;
    if (!n) { return 0; }
    var min = arr[0], max = arr[0];
    for (var i = 1; i < n; i++) { if (arr[i] < min) { min = arr[i]; } if (arr[i] > max) { max = arr[i]; } }
    if (max - min < 1e-6) { return min; }
    var hist = new Int32Array(256);
    var scale = 255 / (max - min);
    for (var j = 0; j < n; j++) {
      var v = ((arr[j] - min) * scale) | 0;
      if (v < 0) { v = 0; } if (v > 255) { v = 255; }
      hist[v]++;
    }
    var gesamt = n, summe = 0;
    for (var k = 0; k < 256; k++) { summe += k * hist[k]; }
    var sumB = 0, wB = 0, best = 0, schwelle = 128;
    for (var k = 0; k < 256; k++) {
      wB += hist[k];
      if (!wB) { continue; }
      var wF = gesamt - wB;
      if (!wF) { break; }
      sumB += k * hist[k];
      var mB = sumB / wB, mF = (summe - sumB) / wF;
      var zw = wB * wF * (mB - mF) * (mB - mF);
      if (zw > best) { best = zw; schwelle = k; }
    }
    return min + schwelle / scale;
  }

  function maskeKomponente(maske, w, h) {
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
    if (n > 48) {
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

  function beleuchtungsfeldNetz(g, w, h) {
    var r = Math.max(3, Math.round(0.06 * Math.max(w, h)));
    var a = g, b = new Float32Array(w * h), x, y, summe = 0;
    for (var d = 0; d < 2; d++) {
      for (y = 0; y < h; y++) {
        var z = y * w, s = 0, n = 0;
        for (x = -r; x <= r; x++) {
          if (x >= 0 && x < w) { s += a[z + x]; }
          n++;
        }
        for (x = 0; x < w; x++) {
          b[z + x] = s / n;
          var raus = x - r, rein = x + r + 1;
          if (raus >= 0) { s -= a[z + raus]; }
          if (rein < w) { s += a[z + rein]; }
        }
      }
      for (x = 0; x < w; x++) {
        var t = 0, m = 0;
        for (y = -r; y <= r; y++) {
          if (y >= 0 && y < h) { t += b[y * w + x]; }
          m++;
        }
        for (y = 0; y < h; y++) {
          a[y * w + x] = t / m;
          var ro = y - r, ri = y + r + 1;
          if (ro >= 0) { t -= b[ro * w + x]; }
          if (ri < h) { t += b[ri * w + x]; }
        }
      }
    }
    for (var i = 0; i < w * h; i++) { summe += a[i]; }
    var mittel = summe / (w * h);
    var out = new Float32Array(w * h);
    for (var k = 0; k < w * h; k++) {
      var f = mittel / Math.max(a[k], 1.0);
      if (f > 2.4) { f = 2.4; } else if (f < 0.45) { f = 0.45; }
      out[k] = Math.min(255, g[k] * f);
    }
    return out;
  }

  function viereckeAusGrau(g, w, h, maxVierecke) {
    var out = [];
    var schwelle = otsu({ g: g, w: w, h: h });
    for (var modus = 0; modus < 2; modus++) {
      var maske = new Uint8Array(w * h), an = 0, i;
      for (i = 0; i < w * h; i++) {
        var hell = g[i] > schwelle;
        maske[i] = (modus === 0 ? hell : !hell) ? 1 : 0;
        an += maske[i];
      }
      var anteil = an / (w * h);
      if (anteil < 0.04 || anteil > 0.97) { continue; }
      maske = erodieren(dilatieren(maske, w, h, 1), w, h, 1);
      var komp = maskeKomponente(maske, w, h);
      if (!komp || komp.groesse < 0.05 * w * h) { continue; }
      var hu = huelle(komp.punkte);
      var vier = groesstesViereck(hu);
      if (vier) {
        out.push(vier.map(function (p) { return [p[0] * 2 + 0.5, p[1] * 2 + 0.5]; }));
        if (maxVierecke && out.length >= maxVierecke) { return out; }
      }
    }
    return out;
  }

  // Textur-basierte Kandidaten: glatte Flaeche (Papier) vs raue (Decke)
  function viereckeAusTextur(vari, w, h, maxVierecke) {
    var out = [];
    var schwelle = otsuFloat(vari);
    // Papier hat niedrige Varianz (glatt) im Vergleich zu Decke (hoch)
    // Aber Text erhoeht Varianz lokal - deshalb Schwelle etwas hoeher und
    // staerkere Morphologie um Textloecher zu schliessen.
    for (var modus = 0; modus < 2; modus++) {
      var maske = new Uint8Array(w * h), an = 0;
      for (var i = 0; i < w * h; i++) {
        var glatt = vari[i] < schwelle;
        maske[i] = (modus === 0 ? glatt : !glatt) ? 1 : 0;
        an += maske[i];
      }
      var anteil = an / (w * h);
      if (anteil < 0.05 || anteil > 0.95) { continue; }
      // Staerkere Schliessung: 3x dilate, 2x erode fuer Textloecher
      maske = erodieren(dilatieren(maske, w, h, 3), w, h, 2);
      var komp = maskeKomponente(maske, w, h);
      if (!komp || komp.groesse < 0.05 * w * h) { continue; }
      var hu = huelle(komp.punkte);
      var vier = groesstesViereck(hu);
      if (vier) {
        out.push(vier.map(function (p) { return [p[0] * 2 + 0.5, p[1] * 2 + 0.5]; }));
        if (maxVierecke && out.length >= maxVierecke) { return out; }
      }
    }
    // Zweiter Versuch mit adaptiver Schwelle (Mittelwert * 0.7) falls Otsu versagt
    if (out.length === 0) {
      var sum = 0; for (var i = 0; i < vari.length; i++) { sum += vari[i]; }
      var avg = sum / vari.length;
      var schw2 = avg * 0.75;
      for (var modus2 = 0; modus2 < 2; modus2++) {
        var maske2 = new Uint8Array(w * h), an2 = 0;
        for (var j = 0; j < w * h; j++) {
          var glatt2 = vari[j] < schw2;
          maske2[j] = (modus2 === 0 ? glatt2 : !glatt2) ? 1 : 0;
          an2 += maske2[j];
        }
        var anteil2 = an2 / (w * h);
        if (anteil2 < 0.05 || anteil2 > 0.95) { continue; }
        maske2 = erodieren(dilatieren(maske2, w, h, 3), w, h, 2);
        var komp2 = maskeKomponente(maske2, w, h);
        if (!komp2 || komp2.groesse < 0.05 * w * h) { continue; }
        var hu2 = huelle(komp2.punkte);
        var vier2 = groesstesViereck(hu2);
        if (vier2) {
          out.push(vier2.map(function (p) { return [p[0] * 2 + 0.5, p[1] * 2 + 0.5]; }));
          if (maxVierecke && out.length >= maxVierecke) { return out; }
        }
      }
    }
    return out;
  }

  function viereckeAusSatt(satt, w, h, maxVierecke) {
    var out = [];
    var schwelle = otsuFloat(satt);
    for (var modus = 0; modus < 2; modus++) {
      var maske = new Uint8Array(w * h), an = 0;
      for (var i = 0; i < w * h; i++) {
        var wenig = satt[i] < schwelle;
        maske[i] = (modus === 0 ? wenig : !wenig) ? 1 : 0;
        an += maske[i];
      }
      var anteil = an / (w * h);
      if (anteil < 0.05 || anteil > 0.96) { continue; }
      maske = erodieren(dilatieren(maske, w, h, 1), w, h, 1);
      var komp = maskeKomponente(maske, w, h);
      if (!komp || komp.groesse < 0.05 * w * h) { continue; }
      var hu = huelle(komp.punkte);
      var vier = groesstesViereck(hu);
      if (vier) {
        out.push(vier.map(function (p) { return [p[0] * 2 + 0.5, p[1] * 2 + 0.5]; }));
        if (maxVierecke && out.length >= maxVierecke) { return out; }
      }
    }
    return out;
  }

  function flaechenKandidaten(bGross, auchNormalisiert) {
    var b = halbieren(bGross);
    var out = viereckeAusGrau(b.g, b.w, b.h, 2);

    // Textur-Kandidaten (NEU: fuer weisse Decke)
    if (bGross.texturVari) {
      var bTex = halbieren({ g: bGross.texturVari, w: bGross.w, h: bGross.h });
      var texK = viereckeAusTextur(bTex.g, bTex.w, bTex.h, 2);
      for (var i = 0; i < texK.length; i++) {
        var v = texK[i], doppelt = false;
        for (var j = 0; j < out.length; j++) {
          if (abstandVierecke(v, out[j]) < 6) { doppelt = true; break; }
        }
        if (!doppelt) { out.push(v); }
      }
    }

    // Saettigungs-Kandidaten
    if (bGross.satt) {
      var bSatt = halbieren({ g: bGross.satt, w: bGross.w, h: bGross.h });
      var sattK = viereckeAusSatt(bSatt.g, bSatt.w, bSatt.h, 2);
      for (var ii = 0; ii < sattK.length; ii++) {
        var vv = sattK[ii], dd = false;
        for (var jj = 0; jj < out.length; jj++) {
          if (abstandVierecke(vv, out[jj]) < 6) { dd = true; break; }
        }
        if (!dd) { out.push(vv); }
      }
    }

    if (auchNormalisiert) {
      var gn = beleuchtungsfeldNetz(b.g, b.w, b.h);
      var weitere = viereckeAusGrau(gn, b.w, b.h, 2);
      for (var k = 0; k < weitere.length; k++) {
        var wk = weitere[k], dopp = false;
        for (var l = 0; l < out.length; l++) {
          if (abstandVierecke(wk, out[l]) < 4) { dopp = true; break; }
        }
        if (!dopp) { out.push(wk); }
      }
    }
    return out;
  }

  function abstandVierecke(a, c) {
    var m = 0;
    for (var i = 0; i < 4; i++) {
      var d = Math.hypot(a[i][0] - c[i][0], a[i][1] - c[i][1]);
      if (d > m) { m = d; }
    }
    return m;
  }

  function mittlererAbstand(a, c) {
    var s = 0;
    for (var i = 0; i < 4; i++) {
      s += Math.hypot(a[i][0] - c[i][0], a[i][1] - c[i][1]) / 4;
    }
    return s;
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

  function quadEnthaelt(aussen, innen) {
    for (var i = 0; i < 4; i++) {
      if (!punktInnen(aussen, innen[i])) { return false; }
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
      var schwach = false;
      for (var t = 0; t < 4; t++) {
        if (k.seiten[t].stufe < 0.3 && k.seiten[t].kontrast > 3) { schwach = true; }
      }
      if (schwach) { continue; }
      if (k.randSeiten && k.randSeiten.filter(Boolean).length >
          best.randSeiten.filter(Boolean).length) { continue; }
      var drin = 0;
      for (var e = 0; e < 4; e++) { if (punktInnen(k.q, best.q[e])) { drin++; } }
      if (drin < 4) { continue; }
      // NEU: Wenn inneres Viereck hoehere Textdichte hat, ist es wahrscheinlich Top-Blatt
      // Dann soll aeusseres NICHT gewinnen (Stapel-Fall)
      if (best.dichte && k.dichte && best.dichte > k.dichte * 1.25) { continue; }
      if (k.flaeche > sieger.flaeche) { sieger = k; }
    }
    return sieger;
  }

  /* Stapel-Korrektur: Wenn KI innerhalb klassischem liegt, Top-Blatt bevorzugen */
  function stapelKorrektur(bewertet, best, kiBester) {
    if (!kiBester) { return best; }
    if (!best) { return kiBester; }
    // KI innerhalb best?
    if (quadEnthaelt(best.q, kiBester.q)) {
      var areaRatio = kiBester.flaeche / best.flaeche;
      if (areaRatio < 0.88 && areaRatio > 0.25) {
        // Bei Stapel: KI ist Top-Blatt, best ist Stapelkante
        if (kiBester.kiKonf >= 0.32) {
          // Zusaetzlich pruefen: hat inneres hoehere Textdichte?
          if (!best.dichte || !kiBester.dichte || kiBester.dichte >= best.dichte * 0.85) {
            return kiBester;
          }
        }
      }
    }
    // Auch zwischen zwei klassischen: inneres mit hoeherer Dichte gewinnt bei Stapel
    for (var i = 0; i < bewertet.length; i++) {
      var k = bewertet[i];
      if (k === best) { continue; }
      if (quadEnthaelt(best.q, k.q)) {
        var ar = k.flaeche / best.flaeche;
        if (ar < 0.88 && ar > 0.25 && k.dichte > best.dichte * 1.3) {
          if (k.wert > best.wert * 0.5) { return k; }
        }
      }
    }
    return best;
  }

  /* ===================== 10. Hauptfunktion ======================== */
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
    b.pkte = pkte; // fuer Textdichte
    var linien = houghLinien(b, pkte, 28); // mehr Linien fuer weiss-auf-weiss
    var i, j;
    for (i = 0; i < linien.length; i++) { linienStuetze(b, linien[i]); }
    // Adaptive Filter fuer niedrigen Kontrast
    var minAbdeckung = 0.22, minStuetze = 2.2;
    if (b.kontrastStd < 14) { minAbdeckung = 0.12; minStuetze = 0.9; }
    else if (b.kontrastStd < 20) { minAbdeckung = 0.16; minStuetze = 1.4; }
    linien = linien.filter(function (l) { return l.abdeckung > minAbdeckung && l.stuetze > minStuetze; });
    if (randErlaubt) {
      var rl = randLinien(b);
      for (i = 0; i < rl.length; i++) { linienStuetze(b, rl[i]); linien.push(rl[i]); }
    }

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
      var ref = mit[0];
      mit.forEach(function (l) {
        l.lage = (l.px - ref.px) * ref.c + (l.py - ref.py) * ref.s;
      });
      var echte = mit.filter(function (l) { return !l.rand; });
      var raender = mit.filter(function (l) { return l.rand; });
      var auswahl = [];
      if (echte.length) {
        var nachLage = echte.slice().sort(function (p, q) { return p.lage - q.lage; });
        var kandidatenIdx = [0, 1, nachLage.length - 2, nachLage.length - 1];
        for (j = 0; j < kandidatenIdx.length; j++) {
          var ix = kandidatenIdx[j];
          if (ix >= 0 && ix < nachLage.length && auswahl.indexOf(nachLage[ix]) < 0) {
            auswahl.push(nachLage[ix]);
          }
        }
      }
      for (j = 0; j < echte.length && auswahl.length < 10; j++) {
        if (auswahl.indexOf(echte[j]) < 0) { auswahl.push(echte[j]); }
      }
      auswahl = auswahl.concat(raender);
      for (i = 0; i < auswahl.length; i++) {
        for (j = i + 1; j < auswahl.length; j++) {
          var a = auswahl[i], c = auswahl[j];
          if (a.rand && c.rand && winkelAbstand(a.t, c.t) > 0.2) { continue; }
          var abst = Math.abs((c.px - a.px) * a.c + (c.py - a.py) * a.s);
          if (abst < 0.14 * Math.min(b.w, b.h)) { continue; }
          paare.push({ a: a, b: c, t: a.t, fam: fi,
                       guete: Math.min(a.stuetze, c.stuetze) * (0.6 + 0.4 * abst / b.diag) });
        }
      }
    }
    paare.sort(function (p, q) { return q.guete - p.guete; });
    if (paare.length > 50) { paare = paare.slice(0, 50); }

    var roh = [];
    for (i = 0; i < paare.length; i++) {
      for (j = i + 1; j < paare.length; j++) {
        var P = paare[i], Q = paare[j];
        if (P.fam === Q.fam) { continue; }
        var wink = winkelAbstand(P.t, Q.t) * 180 / Math.PI;
        if (wink < 42) { continue; }
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
    if (roh.length > 32) { roh = roh.slice(0, 32); }

    var best = null;
    var bewertet = [];
    function bewerteAlle(liste) {
      for (var n = 0; n < liste.length; n++) {
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
          bw.kiKonf = liste[n].kiKonf;
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

    var kiListe = [], kiBester = null;
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
      if (flaeche(qk) < minFlaeche * b.w * b.h * 0.5) { continue; }
      kiListe.push({ q: qk, kiQuelle: true, kiKonf: klemme(ekonf, 0, 1) });
    }
    if (kiListe.length) { bewerteAlle(kiListe); }
    for (i = 0; i < kiListe.length; i++) {
      var kb = bewertet[bewertet.length - kiListe.length + i];
      if (!kiBester || kb.wert > kiBester.wert) { kiBester = kb; }
    }

    var flAnzahl = 0;
    var kiSicherGenug = kiBester && kiBester.kiKonf > 0.85;
    if (!kiSicherGenug && (optionen.flaechenImmer ||
        !best || best.konfidenz < 0.92 || best.flaeche < 0.22 ||
         best.randSeiten.filter(Boolean).length || b.kontrastStd < 18)) {
      var flk = flaechenKandidaten(b, optionen.flaechenImmer !== false), fliste = [];
      for (i = 0; i < flk.length; i++) {
        var qf = sortiereEcken(flk[i], b.w / 2, b.h / 2);
        if (formOk(b, qf, minFlaeche * 0.85)) {
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
      diagnose.dichte = best.dichte;
    }
    if (!best) { return null; }

    if (modul.diagnose.alle && modul.diagnose.alle.length) {
      best = aussenGewinnt(modul.diagnose.alle, best);
    } else {
      best = aussenGewinnt(bewertet, best);
    }

    // Stapel-Korrektur: Top-Blatt statt Stapel
    best = stapelKorrektur(bewertet, best, kiBester);

    var KI_SICHER = 0.58; // leicht gesenkt von 0.62 fuer weiss-auf-weiss
    if (kiBester && kiBester.kiKonf >= KI_SICHER && kiBester.flaeche >= 0.02) {
      if (best.quelle === "ki") {
      } else {
        var abw = mittlererAbstand(best.q, kiBester.q) / b.diag;
        var zustimmung = abw < 0.035;
        if (!zustimmung) {
          diagnose.kiUeberstimmt = true;
          // Bei weiss-auf-weiss: KI gewinnt auch wenn klassisch gut aussieht
          if (b.kontrastStd < 18 || kiBester.kiKonf >= 0.68) {
            best = kiBester;
          } else if (kiBester.kiKonf >= 0.72) {
            best = kiBester;
          }
        }
      }
    }
    // Extra: Bei sehr niedrigem Kontrast und vorhandener KI mit >=0.35, KI nehmen
    if (kiBester && b.kontrastStd < 12 && kiBester.kiKonf >= 0.35) {
      if (!best || best.quelle !== "ki") {
        diagnose.kiWeissAufWeiss = true;
        best = kiBester;
      }
    }
    diagnose.kiKonf = kiBester ? kiBester.kiKonf : 0;

    var kiTraegt = best.quelle === "ki" && best.kiKonf >= 0.45;
    if (kiTraegt) {
      if (best.flaeche < 0.025) { diagnose.abgelehnt = true; return null; }
    } else if (best.geo < 2.2 || best.abdeckung < 0.30) {
      // Bei niedrigem Kontrast niedrigere Huerden
      if (b.kontrastStd < 14) {
        if (best.geo < 0.8 || best.abdeckung < 0.10) { diagnose.abgelehnt = true; return null; }
      } else if (b.kontrastStd < 20) {
        if (best.geo < 1.4 || best.abdeckung < 0.18) { diagnose.abgelehnt = true; return null; }
      } else {
        diagnose.abgelehnt = true; return null;
      }
    }

    var quad = best.q;
    var feinKante = optionen.feinKante || Math.min(Math.max(breite, hoehe), arbeitsKante * 2.5);
    var fein = b, faktorX = 1, faktorY = 1;
    if (feinKante > arbeitsKante * 1.2) {
      fein = arbeitsbild(rgba, breite, hoehe, feinKante, 1);
      // Textur fuer fein auch? Nicht noetig fuer Verfeinerung
      fein.pkte = pkte;
      faktorX = fein.w / b.w; faktorY = fein.h / b.h;
      quad = quad.map(function (p) { return [p[0] * faktorX, p[1] * faktorY]; });
    }
    // Breite erste Nachsuche erreicht auch ungenaue KI-Quads; danach wird enger verfeinert.
    var such = Math.max(4, 0.035 * fein.diag);
    quad = verfeinere(fein, quad, such);
    quad = verfeinere(fein, quad, Math.max(3, such * 0.45));

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
      quelle: best.quelle,
      dichte: best.dichte,
      kontrastStd: b.kontrastStd
    };
  }

  var modul = {
    erkenne: erkenne,
    _intern: {
      arbeitsbild: arbeitsbild, kantenPunkte: kantenPunkte,
      houghLinien: houghLinien, verfeinere: verfeinere,
      bewerte: bewerte, sortiereEcken: sortiereEcken, flaeche: flaeche
    },
    version: 4
  };
  global.UltraErkennung = modul;

})(typeof self !== "undefined" ? self : this);
