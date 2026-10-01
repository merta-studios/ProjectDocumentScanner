#!/usr/bin/env python3
"""Erzeugt synthetische Kamera-Szenen mit BEKANNTEN Dokument-Ecken.

Damit laesst sich die Erkennung objektiv messen (mittlerer Eckfehler in
Prozent der Bilddiagonale, Trefferquote). Ausgabe je Szene:
  <ziel>/<name>.png      - Vorschau
  <ziel>/<name>.rgba     - rohe RGBA-Bytes (fuer den Node-Test von detect.js)
  <ziel>/faelle.json     - Liste mit Groesse + Soll-Ecken

Aufruf:  python3 tools/testbilder.py <zielordner>
"""
import json
import os
import sys

import cv2
import numpy as np

rng = np.random.default_rng(20251001)


# --------------------------------------------------------------- Dokumentseite
def seite(w=900, h=1250, art="text"):
    img = np.full((h, w, 3), 252, np.uint8)
    img = cv2.GaussianBlur(img, (0, 0), 1.0)
    if art == "leer":
        return img
    y = int(0.12 * h)
    cv2.rectangle(img, (int(0.12 * w), y), (int(0.62 * w), y + 46), (40, 40, 40), -1)
    y += 110
    while y < 0.9 * h:
        zeilen = rng.integers(3, 9)
        for _ in range(zeilen):
            if y > 0.9 * h:
                break
            breite = rng.uniform(0.45, 0.78) * w
            cv2.rectangle(img, (int(0.12 * w), y),
                          (int(0.12 * w + breite), y + 16), (55, 55, 60), -1)
            y += 34
        y += 40
    if art == "bunt":
        cv2.rectangle(img, (int(0.15 * w), int(0.55 * h)),
                      (int(0.8 * w), int(0.72 * h)), (40, 60, 200), -1)
    return img


def hintergrund(w, h, art):
    if art == "dunkel":
        bg = np.full((h, w, 3), 38, np.uint8)
    elif art == "holz":
        bg = np.full((h, w, 3), 90, np.uint8)
        bg[:, :, 0] = 55
        bg[:, :, 2] = 130
    elif art == "hell":          # weisser Tisch - der schwierige Fall
        bg = np.full((h, w, 3), 232, np.uint8)
    elif art == "unruhig":
        bg = np.full((h, w, 3), 120, np.uint8)
        for _ in range(26):
            x0, y0 = rng.integers(0, w), rng.integers(0, h)
            cv2.rectangle(bg, (x0, y0),
                          (x0 + int(rng.integers(30, 260)), y0 + int(rng.integers(30, 260))),
                          tuple(int(v) for v in rng.integers(40, 210, 3)), -1)
        bg = cv2.GaussianBlur(bg, (0, 0), 3)
    else:
        bg = np.full((h, w, 3), 150, np.uint8)
    rausch = rng.normal(0, 4, (h, w, 3))
    return np.clip(bg.astype(np.float32) + rausch, 0, 255).astype(np.uint8)


def szene(name, bgart="dunkel", seitenart="text", ecken=None, w=1280, h=960,
          unschaerfe=0.8, schatten=True, vignette=True):
    doc = seite(art=seitenart)
    dh, dw = doc.shape[:2]
    bg = hintergrund(w, h, bgart)
    quelle = np.float32([[0, 0], [dw - 1, 0], [dw - 1, dh - 1], [0, dh - 1]])
    ziel = np.float32(ecken)
    M = cv2.getPerspectiveTransform(quelle, ziel)
    warped = cv2.warpPerspective(doc, M, (w, h), flags=cv2.INTER_CUBIC)
    maske = cv2.warpPerspective(np.full((dh, dw), 255, np.uint8), M, (w, h),
                                flags=cv2.INTER_NEAREST)
    maske3 = cv2.GaussianBlur(maske, (0, 0), 0.8)[:, :, None].astype(np.float32) / 255.0
    bild = (warped.astype(np.float32) * maske3 +
            bg.astype(np.float32) * (1 - maske3))
    if schatten:                      # weicher Schlagschatten unten rechts
        sm = cv2.GaussianBlur(maske, (0, 0), 18).astype(np.float32) / 255.0
        sm = np.roll(np.roll(sm, 14, axis=0), 14, axis=1) * (1 - maske3[:, :, 0])
        bild *= (1 - 0.45 * sm)[:, :, None]
    if vignette:                      # ungleichmaessige Beleuchtung
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        lampe = 1.0 - 0.38 * (((xx - w * 0.3) ** 2 + (yy - h * 0.25) ** 2) /
                              (w * w + h * h))
        bild *= lampe[:, :, None]
    bild = np.clip(bild, 0, 255).astype(np.uint8)
    if unschaerfe > 0:
        bild = cv2.GaussianBlur(bild, (0, 0), unschaerfe)
    bild = np.clip(bild.astype(np.float32) + rng.normal(0, 3.2, bild.shape),
                   0, 255).astype(np.uint8)
    return {"name": name, "bild": bild, "ecken": [[float(a), float(b)] for a, b in ecken]}


def faelle():
    out = []
    w, h = 1280, 960

    def rechteck(cx, cy, bw, bh, neig=0.0, persp=0.0):
        p = np.float32([[-bw / 2, -bh / 2], [bw / 2, -bh / 2],
                        [bw / 2, bh / 2], [-bw / 2, bh / 2]])
        c, s = np.cos(neig), np.sin(neig)
        R = np.float32([[c, -s], [s, c]])
        p = p @ R.T
        p[:, 0] *= 1 + persp * (p[:, 1] / bh)
        p[:, 0] += cx
        p[:, 1] += cy
        return p

    out.append(szene("mitte_dunkel", "dunkel", "text",
                     rechteck(640, 480, 620, 820)))
    out.append(szene("schraeg_dunkel", "dunkel", "text",
                     rechteck(640, 480, 640, 820, neig=0.16, persp=0.22)))
    out.append(szene("hell_auf_hell", "hell", "text",
                     rechteck(640, 480, 640, 840)))
    out.append(szene("hell_schraeg", "hell", "text",
                     rechteck(620, 470, 660, 830, neig=-0.12, persp=-0.25)))
    out.append(szene("holz_quer", "holz", "text",
                     rechteck(640, 480, 900, 620, neig=0.03)))
    out.append(szene("unruhig", "unruhig", "text",
                     rechteck(660, 470, 620, 800, neig=0.07, persp=0.15)))
    out.append(szene("klein", "dunkel", "text",
                     rechteck(600, 450, 420, 560, neig=0.2)))
    out.append(szene("riesig", "dunkel", "text",
                     rechteck(640, 480, 1120, 880, neig=0.02)))
    out.append(szene("leer_dunkel", "dunkel", "leer",
                     rechteck(640, 480, 620, 820, neig=0.05)))
    out.append(szene("bunt", "grau", "bunt",
                     rechteck(640, 480, 640, 820, neig=-0.06, persp=0.1)))
    out.append(szene("stark_perspektiv", "dunkel", "text",
                     np.float32([[300, 180], [1010, 120], [1180, 880], [180, 800]])))
    out.append(szene("ecke_ausserhalb", "dunkel", "text",
                     np.float32([[60, 60], [1240, 40], [1260, 930], [40, 900]])))
    out.append(szene("unscharf", "dunkel", "text",
                     rechteck(640, 480, 640, 820, neig=0.09), unschaerfe=2.6))
    out.append(szene("wenig_kontrast", "hell", "leer",
                     rechteck(640, 480, 600, 800, neig=0.04)))
    out.append(szene("hochkant_gedreht", "holz", "text",
                     rechteck(640, 480, 560, 780, neig=0.33)))
    out.append(szene("ipad_nah", "dunkel", "text",
                     rechteck(640, 480, 1180, 900, neig=0.05, persp=0.12)))

    # ---------------------------------------------------------- schwere Faelle
    def nachtraeglich(s, fn):
        s["bild"] = fn(s["bild"])
        return s

    def finger(img):
        """Daumen am linken Rand - verdeckt ein Stueck Kante."""
        cv2.ellipse(img, (330, 600), (70, 150), 12, 0, 360, (90, 120, 165), -1)
        return cv2.GaussianBlur(img, (0, 0), 1.2)

    out.append(nachtraeglich(
        szene("finger_am_rand", "dunkel", "text",
              rechteck(640, 480, 640, 820, neig=0.04)), finger))

    def harter_schatten(img):
        h, w = img.shape[:2]
        maske = np.zeros((h, w), np.float32)
        pts = np.int32([[0, 0], [w, 0], [w, int(0.45 * h)], [0, int(0.72 * h)]])
        cv2.fillPoly(maske, [pts], 1.0)
        maske = cv2.GaussianBlur(maske, (0, 0), 9)
        return np.clip(img.astype(np.float32) * (1 - 0.5 * maske[:, :, None]),
                       0, 255).astype(np.uint8)

    out.append(nachtraeglich(
        szene("harter_schatten", "grau", "text",
              rechteck(640, 480, 640, 840, neig=-0.05)), harter_schatten))

    def nachbarblatt(img):
        """zweites Blatt direkt daneben - klassische Fehlerquelle."""
        cv2.fillPoly(img, [np.int32([[975, 120], [1279, 100],
                                     [1279, 880], [985, 860]])], (242, 243, 244))
        return img

    out.append(nachtraeglich(
        szene("zweites_blatt", "dunkel", "text",
              rechteck(590, 480, 620, 820, neig=0.02)), nachbarblatt))

    def tischkante(img):
        """lange gerade Stoerlinie quer durchs Bild (Tischkante/Lineal)."""
        cv2.line(img, (0, 70), (1279, 40), (30, 30, 30), 7)
        cv2.line(img, (0, 915), (1279, 945), (20, 20, 20), 6)
        return img

    out.append(nachtraeglich(
        szene("stoerlinien", "grau", "text",
              rechteck(640, 500, 620, 700, neig=0.01)), tischkante))

    def rahmen_im_blatt(img):
        """gedruckter Kasten IM Dokument - lockt die Erkennung nach innen."""
        cv2.rectangle(img, (420, 230), (870, 740), (70, 70, 70), 4)
        return img

    out.append(nachtraeglich(
        szene("kasten_im_blatt", "dunkel", "text",
              rechteck(640, 480, 660, 840, neig=0.0)), rahmen_im_blatt))

    out.append(szene("dunkles_blatt", "hell", "leer",
                     rechteck(640, 480, 620, 800, neig=0.06)))
    out[-1]["bild"] = cv2.addWeighted(out[-1]["bild"], 1.0, out[-1]["bild"], 0, 0)

    out.append(szene("kassenbon", "dunkel", "text",
                     rechteck(640, 480, 300, 860, neig=0.08)))
    out.append(szene("stark_gedreht", "holz", "text",
                     rechteck(640, 480, 560, 760, neig=0.62)))
    out.append(szene("bewegung", "dunkel", "text",
                     rechteck(640, 480, 640, 820, neig=0.05), unschaerfe=0.6))
    out[-1]["bild"] = cv2.filter2D(
        out[-1]["bild"], -1, np.ones((1, 11), np.float32) / 11)
    out.append(szene("dunkel_rauschig", "dunkel", "text",
                     rechteck(640, 480, 620, 800, neig=0.03)))
    out[-1]["bild"] = np.clip(
        out[-1]["bild"].astype(np.float32) * 0.45 +
        rng.normal(0, 11, out[-1]["bild"].shape), 0, 255).astype(np.uint8)
    out.append(szene("unruhig_hell", "unruhig", "text",
                     rechteck(620, 500, 680, 780, neig=-0.1, persp=0.2)))
    return out


LIVE_KANTE = 320      # genau die Groesse, die die App live auswertet
LIVE_FRAMES = 6


def live_frames(bild, ecken, name, ziel):
    """Simuliert echte Sucherbilder: klein, verrauscht, JPEG-komprimiert,
    mit minimalem Handzittern (sub-Pixel). Genau hier ist die Erkennung
    frueher zusammengebrochen."""
    h, w = bild.shape[:2]
    f = LIVE_KANTE / max(w, h)
    lw, lh = int(round(w * f)), int(round(h * f))
    frames = []
    for k in range(LIVE_FRAMES):
        dx, dy = rng.normal(0, 0.9, 2)         # Handzittern
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        bewegt = cv2.warpAffine(bild, M, (w, h), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_REPLICATE)
        klein = cv2.resize(bewegt, (lw, lh), interpolation=cv2.INTER_AREA)
        klein = np.clip(klein.astype(np.float32) +
                        rng.normal(0, 2.6, klein.shape), 0, 255).astype(np.uint8)
        ok, buf = cv2.imencode(".jpg", klein, [cv2.IMWRITE_JPEG_QUALITY, 72])
        klein = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        datei = f"{name}_live{k}"
        cv2.cvtColor(klein, cv2.COLOR_BGR2RGBA).tofile(
            os.path.join(ziel, datei + ".rgba"))
        cv2.imwrite(os.path.join(ziel, datei + ".png"), klein)
        frames.append(datei)
    return {"name": name, "breite": lw, "hoehe": lh,
            "ecken": [[p[0] * lw / w, p[1] * lh / h] for p in ecken],
            "frames": frames}


# ===========================================================================
# Geometrie-Fallen: Szenen, bei denen die Nachbearbeitung den Inhalt
# VERSCHIEBEN oder ABSCHNEIDEN will. In jede Ecke des Blattes kommt eine
# schwarze Marke - am Ergebnis laesst sich dann zaehlen, ob wirklich das
# ganze Dokument im Scan gelandet ist.
# ===========================================================================
def seite_mit_marken(w=900, h=1250, dreh=0.0, wellig=0.0, zufall=0.0):
    img = np.full((h, w, 3), 252, np.uint8)
    mw = int(0.035 * w)
    for mx, my in ((0.05, 0.035), (0.95, 0.035), (0.95, 0.965), (0.05, 0.965)):
        cv2.rectangle(img,
                      (int(mx * w) - mw // 2, int(my * h) - mw // 2),
                      (int(mx * w) + mw // 2, int(my * h) + mw // 2),
                      (20, 20, 20), -1)
    y = int(0.10 * h)
    while y < 0.92 * h:
        breite = rng.uniform(0.5, 0.74) * w
        x0 = int(0.14 * w)
        welle = int(wellig * h * 0.02 *
                    np.sin(2 * np.pi * (y / h)))
        kipp = int(rng.normal(0, zufall * 12))
        cv2.rectangle(img, (x0, y + welle + kipp),
                      (int(x0 + breite), y + welle + kipp + 15), (55, 55, 60), -1)
        y += 34
    if dreh:
        # Das ganze Blatt steht schraeg - Zeilen UND Raender zusammen,
        # so wie bei einem echten schief aufgelegten Dokument.
        M = cv2.getRotationMatrix2D((w / 2, h / 2), dreh, 1.0)
        img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_REPLICATE)
    return img


def fallen():
    """Szenen, die die geometrische Nachbearbeitung in Versuchung fuehren."""
    out = []
    w, h = 1280, 960

    def platziere(doc, ecken, bgart="dunkel", nach=None):
        dh, dw = doc.shape[:2]
        bg = hintergrund(w, h, bgart)
        M = cv2.getPerspectiveTransform(
            np.float32([[0, 0], [dw - 1, 0], [dw - 1, dh - 1], [0, dh - 1]]),
            np.float32(ecken))
        warped = cv2.warpPerspective(doc, M, (w, h), flags=cv2.INTER_CUBIC)
        maske = cv2.warpPerspective(np.full((dh, dw), 255, np.uint8), M, (w, h),
                                    flags=cv2.INTER_NEAREST)
        m3 = cv2.GaussianBlur(maske, (0, 0), 0.8)[:, :, None].astype(np.float32) / 255
        bild = warped.astype(np.float32) * m3 + bg.astype(np.float32) * (1 - m3)
        if nach is not None:
            bild = nach(bild, maske)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        bild *= (1.0 - 0.3 * (((xx - w * 0.35) ** 2 + (yy - h * 0.3) ** 2) /
                              (w * w + h * h)))[:, :, None]
        return np.clip(bild + rng.normal(0, 3, bild.shape), 0, 255).astype(np.uint8)

    ecken = np.float32([[330, 70], [950, 70], [950, 890], [330, 890]])

    # 1. Falz-Falle: dunkler Schattenstreifen rechts im Blatt
    def schattenstreifen(bild, maske):
        band = np.zeros(bild.shape[:2], np.float32)
        band[:, 820:860] = 1.0
        band = cv2.GaussianBlur(band, (0, 0), 7) * (maske / 255.0)
        return bild * (1 - 0.55 * band[:, :, None])

    out.append({"name": "falle_falz",
                "bild": platziere(seite_mit_marken(), ecken, "dunkel",
                                  schattenstreifen),
                "ecken": [[float(a), float(b)] for a, b in ecken]})

    # 2. Kipp-Falle: Blatt schraeg UND mit Schattenstreifen - beide
    #    Schutzmechanismen muessen gleichzeitig greifen.
    ecken2 = np.float32([[340, 95], [955, 55], [975, 875], [360, 915]])
    out.append({"name": "falle_kipp",
                "bild": platziere(seite_mit_marken(dreh=2.5), ecken2,
                                  "dunkel", schattenstreifen),
                "ecken": [[float(a), float(b)] for a, b in ecken2]})

    # 3. Wellen-Falle: Zeilen wellig (Buchwoelbung)
    out.append({"name": "falle_welle",
                "bild": platziere(seite_mit_marken(wellig=1.0), ecken),
                "ecken": [[float(a), float(b)] for a, b in ecken]})

    # 4. Handschrift-Falle: Zeilen kippen zufaellig
    out.append({"name": "falle_handschrift",
                "bild": platziere(seite_mit_marken(zufall=1.0), ecken),
                "ecken": [[float(a), float(b)] for a, b in ecken]})

    # 5. ECHTER Buchfalz: rechts hinter einem dunklen Tal beginnt die
    #    Nachbarseite mit eigenem Rand - dieser Schnitt MUSS erhalten bleiben.
    def buchseite():
        img = seite_mit_marken(900, 1250)
        breit = int(900 * 1.42)
        doppel = np.full((1250, breit, 3), 252, np.uint8)
        doppel[:, :900] = img
        # Falz-Tal
        tal = np.zeros((1250, breit), np.float32)
        tal[:, 900:940] = 1.0
        tal = cv2.GaussianBlur(tal, (0, 0), 9)
        doppel = (doppel.astype(np.float32) *
                  (1 - 0.75 * tal[:, :, None])).astype(np.uint8)
        # Nachbarseite: eigener linker Rand, dann Text
        y = int(0.12 * 1250)
        while y < 0.9 * 1250:
            cv2.rectangle(doppel, (985, y), (breit - 30, y + 15), (55, 55, 60), -1)
            y += 34
        return doppel

    ecken_b = np.float32([[250, 70], [1010, 70], [1010, 890], [250, 890]])
    out.append({"name": "falle_buch_echt",
                "bild": platziere(buchseite(), ecken_b),
                "ecken": [[float(a), float(b)] for a, b in ecken_b]})

    # 6. Dreh-Falle: der Text steht schraeg AUF dem Blatt (4 Grad).
    #    Die Pipeline dreht ihn gerade - dabei wandern die Ecken aus dem
    #    Bild, wenn die Leinwand nicht mitwaechst.
    out.append({"name": "falle_gedreht",
                "bild": platziere(seite_mit_marken(dreh=4.0), ecken),
                "ecken": [[float(a), float(b)] for a, b in ecken]})

    # 7. Rand-Falle: Blatt fast formatfuellend, Drehung schneidet Ecken ab
    ecken5 = np.float32([[70, 60], [1215, 95], [1200, 905], [55, 870]])
    out.append({"name": "falle_randnah",
                "bild": platziere(seite_mit_marken(), ecken5),
                "ecken": [[float(a), float(b)] for a, b in ecken5]})
    return out


def main():
    ziel = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ultrascan-tests"
    os.makedirs(ziel, exist_ok=True)
    liste = []
    live = []
    for f in faelle() + fallen():
        bild = f["bild"]
        h, w = bild.shape[:2]
        cv2.imwrite(os.path.join(ziel, f["name"] + ".png"), bild)
        rgba = cv2.cvtColor(bild, cv2.COLOR_BGR2RGBA)
        rgba.tofile(os.path.join(ziel, f["name"] + ".rgba"))
        liste.append({"name": f["name"], "breite": w, "hoehe": h,
                      "ecken": f["ecken"]})
        live.append(live_frames(bild, f["ecken"], f["name"], ziel))
    with open(os.path.join(ziel, "faelle.json"), "w") as fh:
        json.dump(liste, fh, indent=1)
    with open(os.path.join(ziel, "live.json"), "w") as fh:
        json.dump(live, fh, indent=1)
    print(f"{len(liste)} Testszenen + {len(live) * LIVE_FRAMES} "
          f"Live-Frames -> {ziel}")


if __name__ == "__main__":
    main()
