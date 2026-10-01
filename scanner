"""
Ultra-Scan System
=================
Aufruf:  python3 scanner.py <eingabebild> <vergleichsbild-ausgabe> <testname>

Pipeline:
 1. Grobes Dokument-Viereck finden (Mehrfach-Strategie-Konturanalyse)
 2. Kanten-Refinement: jede Kante wird abgetastet, der echte Rand per
    Gradient gesucht, robuste Linie gefittet, Linien geschnitten -> Ecken
 3. Perspektiv-Entzerrung + 0.6% Rand-Inset
 4. Schwarze-Balken-Erkennung (z.B. Fullscreen-Bild auf Smartboard) -> Crop
 5. Auto-Clean: 2x Beleuchtungs-Normalisierung, Weisspunkt, Saettigung, Schaerfe
 6. S&W-Modus mit Text-vs-Artefakt-Klassifikation (Entfleckung)
"""
import sys
import cv2
import numpy as np

# ------------------------------------------------------------ 1. grobes Viereck
def quad_edge_support(gx, gy, quad, w, h):
    """Bewertet ein Viereck: mittlere Gradientenstaerke (senkrecht zur Kante)
    entlang des gesamten Umfangs. Vierecke am Bildrand oder mitten in
    homogenen Flaechen bekommen automatisch schlechte Werte."""
    q = order_pts(quad)

    def support(a, b, t_lo, t_hi, n):
        L = np.linalg.norm(b - a)
        if L < 4:
            return 0.0
        d = (b - a) / L
        nv = np.array([-d[1], d[0]])
        t = np.linspace(t_lo, t_hi, n)
        pts = a[None, :] + t[:, None] * (b - a)[None, :]
        total, cnt = 0.0, 0
        for p in pts:
            xi, yi = int(round(p[0])), int(round(p[1]))
            cnt += 1
            if 2 <= xi < w - 2 and 2 <= yi < h - 2:
                total += abs(gx[yi, xi] * nv[0] + gy[yi, xi] * nv[1])
        return total / max(cnt, 1)

    per_edge = []
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        s_edge = support(a, b, 0.04, 0.96, max(20, int(np.linalg.norm(b - a) / 8)))
        # Fortsetzungs-Test: laeuft die Linie ueber die Ecken hinaus weiter?
        # Echte Dokumentkanten ENDEN an den Ecken. Eine Linie, die weiterlaeuft,
        # ist eine kreuzende Kante (z.B. Schattengrenze) -> Kante ungueltig.
        s_ext = max(support(a, b, -0.20, -0.05, 12),
                    support(a, b, 1.05, 1.20, 12))
        if s_ext > max(5.0, 0.55 * s_edge):
            per_edge.append(0.0)
        else:
            per_edge.append(s_edge)
    return per_edge

def find_rough_quad(img):
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 0)
    gxs = cv2.Sobel(gray.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
    gys = cv2.Sobel(gray.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)

    candidates = []
    for lo, hi in [(30, 90), (50, 150), (10, 60)]:
        e = cv2.Canny(gray, lo, hi)
        candidates.append(cv2.dilate(e, np.ones((5, 5), np.uint8), 2))
    thr = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY, 51, -5)
    candidates.append(cv2.dilate(thr, np.ones((5, 5), np.uint8), 2))
    # Helligkeits-Segmentierungen (Otsu + Quantile) fuer Papier auf hellem Tisch
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates.append(cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)))
    for q_pct in (75, 85):
        tq = np.percentile(gray, q_pct)
        _, m = cv2.threshold(gray, tq, 255, cv2.THRESH_BINARY)
        candidates.append(cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)))

    quads = []
    for edges in candidates:
        cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:5]:
            area = cv2.contourArea(c)
            if area < 0.15 * w * h:
                continue
            peri = cv2.arcLength(c, True)
            for eps in (0.02, 0.03, 0.05):
                ap = cv2.approxPolyDP(c, eps * peri, True)
                if len(ap) == 4 and cv2.isContourConvex(ap):
                    quads.append(ap.reshape(4, 2).astype(np.float64))
                    break
            # zusaetzlich immer: rotiertes Minimal-Rechteck (wellige Raender)
            quads.append(cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float64))

    best, best_score = None, 0.0
    for q in quads:
        area = cv2.contourArea(order_pts(q).astype(np.float32))
        if area < 0.15 * w * h:
            continue
        per_edge = quad_edge_support(gxs, gys, q, w, h)
        if min(per_edge) < 3.0:
            continue              # JEDE Kante muss einzeln vom Bild gestuetzt sein
        # geometrisches Mittel: bestraft unausgewogene Kanten (eine super-
        # scharfe Kante kann drei schwache nicht mehr "retten")
        score = float(np.exp(np.mean(np.log(np.array(per_edge) + 1e-6)))) \
            * float(np.sqrt(area))
        if score > best_score:
            best, best_score = q, score
    return best                   # None wenn kein Viereck alle 4 Kanten belegt

def order_pts(p):
    s, d = p.sum(1), np.diff(p, axis=1).ravel()
    return np.array([p[np.argmin(s)], p[np.argmin(d)],
                     p[np.argmax(s)], p[np.argmax(d)]], dtype=np.float64)

# --------------------------------------------------------- 2. Kanten-Refinement
def refine_edges(img, quad):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    h, w = gray.shape
    q = order_pts(quad)
    edge_pairs = [(q[0], q[1]), (q[1], q[2]), (q[2], q[3]), (q[3], q[0])]
    lines = []
    for a, b in edge_pairs:
        L = np.linalg.norm(b - a)
        n_samples = max(24, int(L / 12))
        t = np.linspace(0.06, 0.94, n_samples)
        pts_on = a[None, :] + t[:, None] * (b - a)[None, :]
        d = (b - a) / L
        nvec = np.array([-d[1], d[0]])
        search = max(8, int(0.035 * max(h, w)))
        found = []
        for p in pts_on:
            best_s, best_mag = None, -1
            for s in np.arange(-search, search + 1, 1.0):
                x, y = p + s * nvec
                xi, yi = int(round(x)), int(round(y))
                if 1 <= xi < w - 1 and 1 <= yi < h - 1:
                    mag = abs(gx[yi, xi] * nvec[0] + gy[yi, xi] * nvec[1])
                    if mag > best_mag:
                        best_mag, best_s = mag, s
            if best_s is not None and best_mag > 8:
                found.append(p + best_s * nvec)
        found = np.array(found)
        if len(found) < 8:
            lines.append((a, b))
            continue
        pts = found.copy()
        for _ in range(3):
            vx, vy, x0, y0 = cv2.fitLine(pts.astype(np.float32),
                                         cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            dist = np.abs((pts[:, 0] - x0) * vy - (pts[:, 1] - y0) * vx)
            mad = np.median(dist) + 1e-6
            keep = dist < max(2.5 * mad, 1.5)
            if keep.sum() < 8:
                break
            pts = pts[keep]
        vx, vy, x0, y0 = cv2.fitLine(pts.astype(np.float32),
                                     cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        p0 = np.array([x0, y0])
        lines.append((p0, p0 + np.array([vx, vy])))

    def intersect(l1, l2):
        (p1, p2), (p3, p4) = l1, l2
        a1, a2 = p2 - p1, p4 - p3
        den = a1[0] * a2[1] - a1[1] * a2[0]
        if abs(den) < 1e-9:
            return None
        tt = ((p3[0] - p1[0]) * a2[1] - (p3[1] - p1[1]) * a2[0]) / den
        return p1 + tt * a1
    top, right, bottom, left = lines
    corners = [intersect(left, top), intersect(top, right),
               intersect(right, bottom), intersect(bottom, left)]
    if any(c is None for c in corners):
        return q
    return np.array(corners, dtype=np.float64)

# ------------------------------------------------------------------ 3. entzerren
def warp(img, quad):
    tl, tr, br, bl = order_pts(quad)
    W = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    H = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    M = cv2.getPerspectiveTransform(
        np.array([tl, tr, br, bl], np.float32),
        np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32))
    out = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC)
    ix, iy = int(0.006 * W), int(0.006 * H)
    return out[iy:H - iy, ix:W - ix]

# --------------------------------------------- 4. schwarze Balken (Smartboard)
def crop_black_bars(img):
    """Erkennt dunkle Balken an den Raendern (z.B. Fullscreen-Foto auf einem
    Smartboard) und schneidet sie weg. Max 45% pro Seite."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    H, W = g.shape
    col = np.median(g, axis=0)
    row = np.median(g, axis=1)
    def run(vals, limit, skip):
        """dunklen Randbalken finden; ein schmaler heller Rest (z.B. Rahmen-
        Sliver nach der Entzerrung) am aeussersten Rand darf uebersprungen
        werden, zaehlt dann aber mit zum Crop."""
        i = 0
        while i < min(skip, limit) and vals[i] >= 60:
            i += 1                                    # hellen Sliver skippen
        start = i
        while i < limit and vals[i] < 60:
            i += 1
        if i - start < max(4, int(0.015 * limit / 0.45)):
            return 0                                  # kein echter Balken
        return i
    skip = int(0.03 * max(W, H))
    l = run(col, int(0.45 * W), skip)
    r = run(col[::-1], int(0.45 * W), skip)
    t = run(row, int(0.45 * H), skip)
    b = run(row[::-1], int(0.45 * H), skip)
    if l + r + t + b > 0:
        pad = 3   # kleine Sicherheitszugabe
        img = img[t + (pad if t else 0):H - b - (pad if b else 0),
                  l + (pad if l else 0):W - r - (pad if r else 0)]
    return img, (l, t, r, b)

# ------------------------------------------- 4a2. Buchfalz-Erkennung (Buecher)
def crop_book_gutter(img):
    """Erkennt den dunklen Falz (Rinne) zwischen zwei Buchseiten und schneidet
    die angeschnittene rechte Seite ab. Der Falz muss ein schmales, ueber die
    GANZE Hoehe durchgehendes dunkles Tal im rechten Bildbereich sein."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    H, W = g.shape
    col = np.median(g, axis=0).astype(np.float32)
    k = int(0.02 * W) | 1
    col_sm = cv2.blur(col.reshape(1, -1), (k, 1)).ravel()
    ref = float(np.median(col_sm[int(0.15 * W):int(0.55 * W)]))
    zone = np.arange(int(0.55 * W), int(0.99 * W))
    if len(zone) < 5 or ref < 40:
        return img, -1
    xm = int(zone[np.argmin(col_sm[zone])])
    if col_sm[xm] > 0.72 * ref:
        return img, -1                      # kein deutliches Tal
    # Tal muss schmal sein
    below = col_sm < 0.85 * ref
    xl = xm
    while xl > 0 and below[xl - 1]:
        xl -= 1
    xr = xm
    while xr < W - 1 and below[xr + 1]:
        xr += 1
    if (xr - xl) > 0.18 * W:
        return img, -1                      # zu breit -> eher Schatten
    # Tal muss oben UND unten vorhanden sein (durchgehende Falz-Linie)
    band = g[:, max(xm - 3, 0):min(xm + 4, W)]
    top = float(np.median(band[:H // 3]))
    bot = float(np.median(band[-H // 3:]))
    if top > 0.85 * ref or bot > 0.85 * ref:
        return img, -1
    return img[:, :max(xm - 1, 1)], xm

# --------------------------------- 4a3. Wellen-Glaettung (Buch-Kruemmung)
def flatten_curvature(img):
    """V9: 2D-Kruemmungsmodell. Misst pro Textzeile die Abweichung von ihrer
    Mittellage und fittet ein glattes Verzerrungs-FELD d(x,y) ueber die ganze
    Seite (Kruemmung + deren Aenderung mit der Hoehe). Angewendet wird nur,
    wenn das Feld die Zeilen-Abweichungen nachweislich gut erklaert -
    strukturierte Buchwoelbung: ja / zufaellig kippende Handschrift: nein."""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    txt = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 41, 12)
    lines = cv2.dilate(txt, np.ones((3, int(0.04 * W) | 1), np.uint8))
    cnts, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    X, D = [], []
    n_lines = 0
    for c in cnts:
        x, y, bw_, bh = cv2.boundingRect(c)
        if bw_ < 0.35 * W or bh > 0.09 * H:
            continue
        mask = np.zeros((bh, bw_), np.uint8)
        cv2.drawContours(mask, [c - [x, y]], -1, 255, -1)
        band = (txt[y:y + bh, x:x + bw_] > 0) & (mask > 0)
        xs, ys = [], []
        for xi in range(0, bw_, 4):
            rows = np.where(band[:, xi])[0]
            if rows.size:
                xs.append(x + xi)
                ys.append(y + rows.mean())
        if len(xs) < 12:
            continue
        n_lines += 1
        xs = np.array(xs, float)
        ys = np.array(ys, float)
        ybar = ys.mean()
        xn = xs / W - 0.5
        yn = ybar / H - 0.5
        for xi, di in zip(xn, ys - ybar):
            X.append([1.0, xi, xi * xi, xi ** 3,
                      yn, xi * yn, xi * xi * yn,
                      yn * yn, xi * yn * yn, xi * xi * yn * yn])
            D.append(di)
    if n_lines < 5 or len(D) < 200:
        return img, 0.0
    X = np.array(X)
    D = np.array(D)
    coef, *_ = np.linalg.lstsq(X, D, rcond=None)
    rms_before = float(D.std())
    rms_after = float((D - X @ coef).std())
    if rms_after > 0.6 * rms_before:
        return img, 0.0        # Feld erklaert die Abweichungen nicht -> Finger weg
    # Verzerrungsfeld auf ganzes Bild anwenden
    xg = (np.arange(W, dtype=np.float32) / W - 0.5)
    yg = (np.arange(H, dtype=np.float32) / H - 0.5)
    XX, YY = np.meshgrid(xg, yg)
    dfield = (coef[0] + coef[1] * XX + coef[2] * XX ** 2 + coef[3] * XX ** 3
              + coef[4] * YY + coef[5] * XX * YY + coef[6] * XX ** 2 * YY
              + coef[7] * YY ** 2 + coef[8] * XX * YY ** 2
              + coef[9] * XX ** 2 * YY ** 2)
    dfield -= dfield.mean()
    # an den Raendern (ausserhalb der Messdaten) kann das Polynom
    # extrapolieren -> deckeln statt verwerfen
    dfield = np.clip(dfield, -0.08 * H, 0.08 * H)
    amp = float(np.percentile(np.abs(dfield), 98))
    if amp < 2.0:
        return img, 0.0
    map_x = np.tile(np.arange(W, dtype=np.float32), (H, 1))
    map_y = np.arange(H, dtype=np.float32)[:, None] + dfield.astype(np.float32)
    out = cv2.remap(img, map_x, map_y, cv2.INTER_CUBIC,
                    borderMode=cv2.BORDER_REPLICATE)
    return out, amp
# ------------------------------------------------- 4b. Text-Deskew (Feindrehung)
def dewarp_book_margins(img):
    """Buchseite: linker Textrand wandert nach rechts (oben staerker),
    rechte Haelfte ist zum Falz hin gestaucht. Misst pro Textzeile den
    linken/rechten Rand, fittet zwei robuste Randgeraden und entzerrt
    jede Zeile linear darauf. Nur fuer Buchseiten aufrufen!"""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bwt = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 41, 12)
    ker = cv2.getStructuringElement(cv2.MORPH_RECT, (max(int(0.04 * W), 3), 1))
    dil = cv2.dilate(bwt, ker)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(dil, 8)
    lines = []
    for i in range(1, n):
        x, y, w, h = (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                      stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])
        if w >= 0.30 * W and 3 <= h <= 0.09 * H:
            lines.append((y + h / 2.0, float(x), float(x + w)))
    if len(lines) < 6:
        return img, 0.0
    ys = np.array([l[0] for l in lines])
    x0 = np.array([l[1] for l in lines])
    x1 = np.array([l[2] for l in lines])

    def robust_edge(ys_, xs_, q):
        # Steigung = Median aller Paar-Steigungen (immun gegen Einzuege /
        # kurze Absatz-Endzeilen), Achsenabschnitt = Quantil der Residuen
        slopes = []
        for i in range(len(ys_)):
            for j in range(i + 1, len(ys_)):
                dy = ys_[j] - ys_[i]
                if abs(dy) > 0.04 * H:
                    slopes.append((xs_[j] - xs_[i]) / dy)
        if len(slopes) < 3:
            return None
        b = float(np.median(slopes))
        a = float(np.percentile(xs_ - b * ys_, q))
        return np.poly1d([b, a])

    def edge_poly(ys_, xs_, is_left, q):
        """Quadratischer Randfit ueber Huellpunkte (min/max je y-Bin) -
        die Seitenwoelbung ist oben staerker, eine Gerade unterschaetzt
        sie dort. Fallback: robuste Gerade."""
        lin = robust_edge(ys_, xs_, q)
        y0, y1 = float(ys_.min()), float(ys_.max())
        if y1 - y0 < 0.2 * H:
            return lin
        pts = []
        nb = 6
        for k in range(nb):
            a_ = y0 + (y1 - y0) * k / nb
            b_ = y0 + (y1 - y0) * (k + 1) / nb + 1e-6
            sel = (ys_ >= a_) & (ys_ < b_)
            if not sel.any():
                continue
            idx = np.argmin(xs_[sel]) if is_left else np.argmax(xs_[sel])
            pts.append((ys_[sel][idx], xs_[sel][idx]))
        if len(pts) < 5:
            return lin
        P = np.array(pts, dtype=np.float64)
        coef = np.polyfit(P[:, 0], P[:, 1], 2)
        if abs(coef[0]) * H * H > 0.25 * W:      # unplausible Kruemmung
            return lin
        return np.poly1d(coef)

    lpoly = edge_poly(ys, x0, True, 20)          # linker Rand: untere Huelle
    sel = x1 >= np.percentile(x1, 55)            # rechts: nur volle Zeilen
    rpoly = edge_poly(ys[sel], x1[sel], False, 80)
    if lpoly is None or rpoly is None:
        return img, 0.0
    ymin, ymax = float(ys.min()), float(ys.max())
    ymid = H / 2.0
    L0, R0 = float(lpoly(ymid)), float(rpoly(ymid))
    if R0 - L0 < 0.35 * W:
        return img, 0.0
    ss = np.linspace(ymin, ymax, 24)
    dev = max(float(np.max(np.abs(lpoly(ss) - L0))),
              float(np.max(np.abs(rpoly(ss) - R0))))
    if dev < 3.0:
        return img, 0.0
    yy = np.arange(H, dtype=np.float64)
    # unterhalb des Textblocks einfrieren (kein Extrapolieren ins Holz);
    # OBERHALB linear weiterfuehren (Tangente am ersten Textblock-Punkt),
    # damit Ueberschriften ueber der ersten Absatzzeile mitkorrigiert werden
    yc = np.clip(yy, ymin, ymax)
    l_row = lpoly(yc)
    r_row = rpoly(yc)
    above = yy < ymin
    l_row[above] += float(lpoly.deriv()(ymin)) * (yy[above] - ymin)
    r_row[above] += float(rpoly.deriv()(ymin)) * (yy[above] - ymin)
    span = np.clip(r_row - l_row, 0.3 * W, 1.5 * W)
    xx = np.arange(W, dtype=np.float64)
    map_x = l_row[:, None] + (xx[None, :] - L0) * (span[:, None] / (R0 - L0))
    map_y = np.repeat(yy[:, None], W, axis=1)
    out = cv2.remap(img, map_x.astype(np.float32), map_y.astype(np.float32),
                    cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return out, float(dev)

def decompress_book_x(img):
    """Zum Falz hin ist der Text horizontal GESTAUCHT (die Seite kruemmt
    sich vom Betrachter weg). Messbar: die Buchstaben werden dort schmaler.
    Misst die Median-Buchstabenbreite je x-Zone, baut daraus ein glattes
    Streckprofil und entzerrt horizontal. Nur fuer Buchseiten!"""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bwt = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 41, 12)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bwt, 8)
    hs = [stats[i, cv2.CC_STAT_HEIGHT] for i in range(1, n)
          if 15 <= stats[i, cv2.CC_STAT_AREA] <= 1500]
    if not hs:
        return img, 1.0
    ch = float(np.median(hs))
    cxs, ws = [], []
    for i in range(1, n):
        a = stats[i, cv2.CC_STAT_AREA]
        w = stats[i, cv2.CC_STAT_WIDTH]
        h = stats[i, cv2.CC_STAT_HEIGHT]
        if 15 <= a <= 1500 and 0.4 * ch <= h <= 2.5 * ch and w <= 3 * ch:
            cxs.append(stats[i, cv2.CC_STAT_LEFT] + w / 2.0)
            ws.append(float(w))
    if len(cxs) < 80:
        return img, 1.0
    cxs = np.array(cxs)
    ws = np.array(ws)
    Lt, Rt = np.percentile(cxs, 2), np.percentile(cxs, 98)
    nb = 10
    edges = np.linspace(Lt, Rt, nb + 1)
    centers = 0.5 * (edges[:-1] + edges[1:])
    meds = np.full(nb, np.nan)
    for k in range(nb):
        sel = (cxs >= edges[k]) & (cxs < edges[k + 1])
        if sel.sum() >= 8:
            meds[k] = np.median(ws[sel])
    if np.isnan(meds[:5]).all():
        return img, 1.0
    ref = np.nanmedian(meds[:5])                # linke Haelfte = ungestaucht
    s = np.where(np.isnan(meds), 1.0, np.clip(ref / meds, 1.0, 1.7))
    s[:5] = 1.0                                 # links nie anfassen
    s = np.convolve(np.r_[s[0], s, s[-1]], [0.25, 0.5, 0.25], 'valid')
    sp = np.interp(np.arange(W, dtype=np.float64), centers, s,
                   left=1.0, right=float(s[-1]))
    if float(sp.max()) < 1.08:
        return img, 1.0                         # keine relevante Stauchung
    cum = np.concatenate([[0.0], np.cumsum(sp)])
    W2 = int(round(cum[-1]))
    if W2 > 1.4 * W:
        return img, 1.0                         # unplausibel viel
    u = np.arange(W2, dtype=np.float64)
    src_x = np.interp(u, cum[:-1], np.arange(W, dtype=np.float64))
    map_x = np.tile(src_x.astype(np.float32), (H, 1))
    map_y = np.repeat(np.arange(H, dtype=np.float32)[:, None], W2, axis=1)
    out = cv2.remap(img, map_x, map_y, cv2.INTER_CUBIC,
                    borderMode=cv2.BORDER_REPLICATE)
    return out, float(sp.max())

def balance_left_margin(img):
    """Buchseite: links bleibt oft ein breiter Leerstreifen (Falz-Crop war
    rechts). Schneidet den linken Rand so, dass er zum rechten passt."""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bwt = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 41, 12)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bwt, 8)
    xs0, xs1 = [], []
    for i in range(1, n):
        if 15 <= stats[i, cv2.CC_STAT_AREA] <= 5000:
            xs0.append(stats[i, cv2.CC_STAT_LEFT])
            xs1.append(stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH])
    if len(xs0) < 30:
        return img, 0
    lm = float(np.percentile(xs0, 1))
    rm = W - float(np.percentile(xs1, 99))
    target = max(rm, 0.045 * W)
    cut = int(lm - target)
    if cut < 0.02 * W:
        return img, 0
    return img[:, cut:], cut

def deskew_by_text(img):
    """Auch nach perfekter Entzerrung kann der TEXT leicht schief sein (schief
    bedrucktes/fotografiertes Papier). Findet den Winkel, bei dem die
    Textzeilen exakt horizontal liegen (Projektionsprofil-Varianz) und dreht
    das Bild entsprechend. Begrenzt auf +-5 Grad."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    scale = 800.0 / max(g.shape)
    small = cv2.resize(g, None, fx=scale, fy=scale)
    txt = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 41, 14)
    h, w = txt.shape

    def profile_var(angle):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        rot = cv2.warpAffine(txt, M, (w, h), flags=cv2.INTER_NEAREST)
        return float(np.var(rot.sum(axis=1)))

    best_a, best_v = 0.0, profile_var(0.0)
    for a in np.arange(-5.0, 5.01, 0.5):
        v = profile_var(a)
        if v > best_v:
            best_a, best_v = a, v
    for a in np.arange(best_a - 0.5, best_a + 0.51, 0.1):
        v = profile_var(a)
        if v > best_v:
            best_a, best_v = a, v
    if abs(best_a) < 0.15:
        return 0.0
    return best_a

# ------------------------- 4c. Zeilen-Begradigung (Scherung, nicht Drehung!)
def shear_level_lines(img):
    """Nach Entzerrung+Drehung koennen Textzeilen noch leicht 'bergab' laufen
    (Rest-Scherung aus der Perspektive). Misst die Neigung jeder erkannten
    Textzeile einzeln und schert das Bild, bis alle Grundlinien exakt
    horizontal nach rechts laufen. Buchstaben bleiben dabei aufrecht."""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    txt = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV, 41, 12)
    # Buchstaben horizontal zu Zeilenbloecken verschmelzen
    lines = cv2.dilate(txt, np.ones((3, int(0.04 * W) | 1), np.uint8))
    cnts, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    slopes = []
    for c in cnts:
        x, y, bw_, bh = cv2.boundingRect(c)
        if bw_ < 0.30 * W or bh > 0.08 * H:
            continue                                   # keine echte Textzeile
        vx, vy, _, _ = cv2.fitLine(c.reshape(-1, 2).astype(np.float32),
                                   cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        if abs(vx) < 1e-6:
            continue
        slope = vy / vx
        if abs(slope) < 0.12:                          # nur plausible Neigungen
            slopes.append(slope)
    if len(slopes) < 4:
        return 0.0
    s = float(np.median(slopes))
    mad = float(np.median(np.abs(np.array(slopes) - s)))
    if mad > 0.008:
        return 0.0    # Zeilen kippen UNTERSCHIEDLICH (Handschrift o.ae.):
                      # das ist keine echte Verzerrung -> nicht anfassen!
    if abs(s) < 0.002:
        return 0.0
    return s

# ------------------- 4d. (entfernt in V7: Zeilen-Feinausrichtung war zu
# riskant - einzelne Zeilen konnten kollidieren und die Neigungsmessung pro
# Zeile ist durch Unterlaengen/Unterstreichungen verrauscht)

# ---------------------------------------------------------------- 5. Auto-Clean
def remove_shadows(img):
    out = []
    for ch in cv2.split(img):
        bg = cv2.morphologyEx(ch, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
        bg = cv2.medianBlur(bg, 81)
        out.append(cv2.divide(ch, bg, scale=255))
    return cv2.merge(out)

def auto_clean(img):
    img = remove_shadows(img)
    img = remove_shadows(img)              # 2. Pass: glaettet Rest-Geister
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    white = np.percentile(g, 88)
    img = np.clip(img.astype(np.float32) * (255.0 / max(white, 1)), 0, 255).astype(np.uint8)
    # Farben (Marker/Zeichnungen) leicht kraeftigen
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.3, 0, 255)
    img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    blur = cv2.GaussianBlur(img, (0, 0), 2.0)
    return cv2.addWeighted(img, 1.5, blur, -0.5, 0)

# ------------------------------------------- 6. S&W + Entfleckung
def mode_bw_smart(warped, book=False):
    norm = remove_shadows(warped)
    g = cv2.cvtColor(norm, cv2.COLOR_BGR2GRAY)
    g = cv2.bilateralFilter(g, 5, 40, 20)  # glaettet Flaechen, schont Striche
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY, 41, 12)
    # Saettigungskarte des Originals: Schatten sind GRAU. Was bunt ist,
    # ist Inhalt (Zeichnungen, Marker) und darf nie geloescht werden.
    sat = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)[..., 1]
    inv = 255 - bw
    n, lab, stats, cent = cv2.connectedComponentsWithStats(inv, 8)
    H, W = bw.shape
    hs = [stats[i, cv2.CC_STAT_HEIGHT] for i in range(1, n)
          if 15 <= stats[i, cv2.CC_STAT_AREA] <= 1500]
    char_h = np.median(hs) if hs else 14
    margin = int(0.012 * max(H, W))
    keep = np.zeros(n, bool)
    # Pass 1: Eigenschaften aller Komponenten einsammeln
    props = {}
    for i in range(1, n):
        x, y, bw_, bh, area = (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                               stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT],
                               stats[i, cv2.CC_STAT_AREA])
        comp_mask = (lab[y:y + bh, x:x + bw_] == i)
        props[i] = (x, y, bw_, bh, area,
                    float(sat[y:y + bh, x:x + bw_][comp_mask].mean()),
                    float(g[y:y + bh, x:x + bw_][comp_mask].mean()))
    # adaptiver Tinten-Schwellwert: lernt aus DIESEM Dokument, wie dunkel
    # seine Tinte ist (Median) + Toleranz. Faltenschatten liegen weit darueber.
    darks = [p[6] for i, p in props.items() if p[4] >= 15 and p[5] <= 45]
    ink_thr = min(185.0, (np.median(darks) if darks else 110.0) + 50.0)
    # KANTENSCHAERFE je Komponente: Bleistift/Tinte springt in 1-2px vom
    # Papier zum Strich (hoher Gradient), Faltenschatten verlaufen weich.
    # Rettet Bleistift-Zeichnungen vor den Anti-Schatten-Filtern.
    sx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    sy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    gradm = cv2.magnitude(sx, sy)
    gsum = np.bincount(lab.ravel(), weights=gradm.ravel(), minlength=n)
    garea = np.bincount(lab.ravel(), minlength=n)
    sharp = gsum / np.maximum(garea, 1)
    # Pass 2: entscheiden
    for i in range(1, n):
        x, y, bw_, bh, area, comp_sat, comp_dark = props[i]
        fill = area / max(bw_ * bh, 1)
        if x <= margin or y <= margin or x + bw_ >= W - margin or y + bh >= H - margin:
            # randnahe Komponente: nur behalten, wenn sie wie ein BUCHSTABE
            # aussieht (dunkel + buchstabengross); Papierkanten/Schmutz sind
            # blass oder lang gestreckt
            letter_like = (props[i][6] < 140 and area < 6 * char_h * char_h
                           and bh < 3.6 * char_h and bw_ < 4 * char_h
                           and props[i][5] <= 90)   # Tinte darf leicht
                           # gesaettigt sein (blaue Handschrift ~50);
                           # Holz/Deckel liegen bei sat 100+
            if not letter_like:
                continue
        if area < 2:
            continue                    # nur echtes 1px-Rauschen (i-Punkte leben!)
        if comp_sat > 45:
            # bunt = Inhalt ... ausser winzige bunte Reste direkt am Rand
            # (z.B. angeschnittener Buchdeckel)
            # Randstreifen bewusst SCHMAL (2%): Schatten kann Text warm
            # einfaerben -> sonst wuerden echte Textzeilen am Blattrand
            # als "bunter Rest" geloescht (passierte beim Schraeg-Zettel).
            # Bei BUCHSEITEN breiter (6%): Buchdeckel/Tischholz ragt dort
            # rein, und Buchtext ist ohnehin schwarzweiss.
            bf = 0.06 if book else 0.008
            near_border = (x < bf * W or y < bf * H or
                           x + bw_ > (1 - bf) * W or y + bh > (1 - bf) * H)
            if near_border and area < 8 * char_h * char_h:
                continue
            keep[i] = True
            continue
        # Tinten-Test: echte Tinte ist dunkel (relativ zum Dokument),
        # Faltenschatten und Knickkanten sind nur blassgrau -> raus damit.
        # Buchstabenfoermige Komponenten (kompakt, zeilenhoch) bekommen
        # etwas Toleranz -- in aufgehellten Woelbungszonen (Buchseite!)
        # ist echte Tinte sonst 1-2 Graustufen zu hell.
        glyphish = (bh <= 2.5 * char_h and bw_ <= 4 * char_h and fill >= 0.3)
        # scharfkantig + substanziell dunkel = gezeichneter Strich
        # (Bleistift!), egal wie gross -- Faltenschatten sind weich
        # verlaufend und Knickschatten kaum dunkler als Papier
        penciled = (sharp[i] >= 55.0 and comp_dark < 190.0)
        if comp_dark > ink_thr + (18 if glyphish else 0) and not penciled:
            # letzte Chance: LOKALER Kontrast. In extrem aufgehellten Zonen
            # (Seitenwoelbung oben) ist Tinte global zu blass, hebt sich aber
            # weiterhin stark vom lokalen Papier ab. Faltenschatten haben
            # nur ~30 Graustufen Kontrast zum Umfeld, Tinte ~70+.
            if not glyphish:
                continue
            y0_, y1_ = max(y - 6, 0), min(y + bh + 6, H)
            x0_, x1_ = max(x - 6, 0), min(x + bw_ + 6, W)
            local_bg = float(np.percentile(g[y0_:y1_, x0_:x1_], 90))
            # solide Striche (hoher Fuellgrad) duerfen etwas blasser sein;
            # Schattenschlieren sind diffus (Fuellgrad niedrig)
            need = 50 if fill >= 0.6 else 70
            if local_bg - comp_dark < need:
                continue
        if bh > 3.2 * char_h and bw_ < 2.5 * char_h and fill < 0.5 \
                and not penciled:
            continue                    # hohe schmale Schliere
        if area > 40 * char_h * char_h and fill < 0.35 and not penciled:
            continue                    # grosser DUENNER GRAUER Klecks -> Schatten
        if bh > 2.2 * char_h and fill < 0.18 and not penciled:
            continue
        keep[i] = True
    all_mask = np.isin(lab, np.where(keep)[0]).astype(np.uint8)
    kept_ids = [j for j in range(1, n) if keep[j]]
    r = int(2.5 * char_h)
    small_limit = 0.45 * char_h * char_h
    for i in range(1, n):
        if not keep[i] or stats[i, cv2.CC_STAT_AREA] >= small_limit:
            continue
        # flache SOLIDE Balken (=, Minus, Bruchstriche) stehen in Hand-
        # schrift oft frei zwischen Woertern -> nie als isoliert loeschen
        bw_i = stats[i, cv2.CC_STAT_WIDTH]
        bh_i = stats[i, cv2.CC_STAT_HEIGHT]
        fill_i = stats[i, cv2.CC_STAT_AREA] / max(bw_i * bh_i, 1)
        if (fill_i >= 0.6 and bh_i <= max(3, 0.4 * char_h)
                and bw_i >= 0.5 * char_h):
            continue
        cx, cy = int(cent[i][0]), int(cent[i][1])
        y0, y1 = max(cy - r, 0), min(cy + r, H)
        x0, x1 = max(cx - r, 0), min(cx + r, W)
        win = all_mask[y0:y1, x0:x1].sum() - stats[i, cv2.CC_STAT_AREA]
        if win < 0.3 * char_h * char_h:
            # Rettung: ZEILEN-Ausrichtung. Seitenzahlen/Kopfzeilen ("- 12 -")
            # sind klein UND isoliert, aber ihre Zeichen stehen exakt auf
            # einer Zeile mit aehnlich grossen Nachbarn. Zufaellige Flecken
            # nicht.
            hi = stats[i, cv2.CC_STAT_HEIGHT]
            aligned = False
            for j in kept_ids:
                if j == i:
                    continue
                gap = abs(cent[j][0] - cent[i][0]) \
                    - 0.5 * (stats[j, cv2.CC_STAT_WIDTH]
                             + stats[i, cv2.CC_STAT_WIDTH])
                if (abs(cent[j][1] - cent[i][1]) <= 0.6 * char_h
                        and gap <= 2.5 * char_h
                        and stats[j, cv2.CC_STAT_AREA] >= 25
                        and 0.2 <= stats[j, cv2.CC_STAT_HEIGHT]
                                   / max(hi, 1) <= 5.0):
                    aligned = True
                    break
            if not aligned:
                keep[i] = False
    mask = keep[lab]
    out = np.full_like(bw, 255)
    out[mask] = 0
    return out

# ------------------------------- 6b. Hintergrund-Weissung (Falten-Killer)
def whiten_background(clean, bw):
    """Alles was weder S&W-Inhalt noch farbig noch dunkel ist, wird reines
    Weiss: Falten, Knicke, Papiertextur und Rest-Schatten verschwinden."""
    sat = cv2.cvtColor(clean, cv2.COLOR_BGR2HSV)[..., 1]
    g = cv2.cvtColor(clean, cv2.COLOR_BGR2GRAY)
    content = ((bw == 0) | (sat > 45) | (g < 150)).astype(np.uint8) * 255
    content = cv2.dilate(content, np.ones((3, 3), np.uint8), iterations=2)
    feather = cv2.GaussianBlur(content, (0, 0), 2.0).astype(np.float32) / 255.0
    feather = feather[..., None]
    out = clean.astype(np.float32) * feather + 255.0 * (1 - feather)
    return out.astype(np.uint8)

# --------------------------- 6c. Hybrid: S&W-Schaerfe + Farben vom Farbscan
def mode_hybrid(clean, bw, scale=2, orig=None):
    """S&W entscheidet WAS Inhalt ist, der Farbscan liefert die FARBE.
    V7: rendert mit 2x Supersampling - die weiche Tintenmaske wird VOR dem
    Compositing hochskaliert, dadurch praezisere, glattere Buchstabenkanten
    beim Zoomen (Stufe 1 des Qualitaets-Boosters)."""
    if scale > 1:
        clean = cv2.resize(clean, None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_CUBIC)
    hsv = cv2.cvtColor(clean, cv2.COLOR_BGR2HSV).astype(np.float32)
    sat = hsv[..., 1]
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.6, 0, 255)
    hsv[..., 2] = np.clip(hsv[..., 2] * 0.85, 0, 255)
    recolored = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    layer = np.zeros_like(clean)
    colored = sat >= 40
    layer[colored] = recolored[colored]
    # weiche Tintenmaske in hoher Aufloesung (Anti-Aliasing)
    m = ((bw == 0) * 255).astype(np.uint8)
    if scale > 1:
        m = cv2.resize(m, (clean.shape[1], clean.shape[0]),
                       interpolation=cv2.INTER_CUBIC)
    m = cv2.GaussianBlur(m, (0, 0), 0.8 * scale)
    m = m.astype(np.float32) / 255.0
    # FARBFLAECHEN-Maske: grosse flache Farbfuellungen (Diagramm-Balken,
    # farbige Boxen) erwischt der adaptive Schwellwert nur an den KANTEN
    # -> Innenraum waere weiss. Darum: alles satt Gefaerbte im gereinigten
    # Bild ist Inhalt. Mini-Flecken und randberuehrende Reste (z.B.
    # angeschnittener Buchdeckel) fliegen raus.
    # WICHTIG: Quelle ist das UNbereinigte Bild (orig) - auto_clean bleicht
    # grosse Farbflaechen aus (haelt ihr Inneres fuer Hintergrund)!
    src = clean if orig is None else cv2.resize(
        orig, (clean.shape[1], clean.shape[0]), interpolation=cv2.INTER_CUBIC)
    hsv_s = cv2.cvtColor(src, cv2.COLOR_BGR2HSV).astype(np.float32)
    sat_s = hsv_s[..., 1]
    hsv_s[..., 1] = np.clip(hsv_s[..., 1] * 1.5, 0, 255)
    hsv_s[..., 2] = np.clip(hsv_s[..., 2] * 0.9, 0, 255)
    recolored_s = cv2.cvtColor(hsv_s.astype(np.uint8), cv2.COLOR_HSV2BGR)
    Hs, Ws = sat_s.shape
    # Chroma statt Saettigung: warm getoente SCHATTEN erreichen sat 90+,
    # aber nur Chroma <40; echte Druckfarben liegen bei 100-200
    chroma = (src.max(axis=2).astype(np.int16)
              - src.min(axis=2).astype(np.int16))
    fills = (chroma >= 70).astype(np.uint8)
    # Oeffnung: duenne Chroma-Raender / JPEG-Farbrauschen wegputzen
    fills = cv2.morphologyEx(fills, cv2.MORPH_OPEN,
                             np.ones((3, 3), np.uint8), iterations=scale)
    ncc, labf, statsf, _ = cv2.connectedComponentsWithStats(fills, 8)
    # Tinten-Umgebung: Farb-Inseln IN Buchstaben (Loch im D, O, 0, Icons
    # auf farbigem Grund) sind klein, aber von Tinte umschlossen -> Inhalt.
    ink_dil = cv2.dilate((m > 0.35).astype(np.uint8),
                         np.ones((3, 3), np.uint8), iterations=2 * scale)
    keepf = np.zeros(ncc, bool)
    for i in range(1, ncc):
        fx, fy = statsf[i, cv2.CC_STAT_LEFT], statsf[i, cv2.CC_STAT_TOP]
        fw, fh = statsf[i, cv2.CC_STAT_WIDTH], statsf[i, cv2.CC_STAT_HEIGHT]
        fa = statsf[i, cv2.CC_STAT_AREA]
        if (fx <= 2 * scale or fy <= 2 * scale or
                fx + fw >= Ws - 2 * scale or fy + fh >= Hs - 2 * scale):
            continue    # beruehrt Bildrand -> Schattenzunge / Buchdeckel
        if fa < 200 * scale * scale:
            # klein: nur behalten, wenn von Tinte umschlossen
            if fa < 3 * scale * scale:
                continue
            comp = (labf[fy:fy + fh, fx:fx + fw] == i)
            if float(ink_dil[fy:fy + fh, fx:fx + fw][comp].mean()) < 0.55:
                continue                      # freiliegend -> Farbrauschen
        keepf[i] = True
    fmask = (keepf[labf] * 255).astype(np.uint8)
    fmask = cv2.GaussianBlur(fmask, (0, 0), 0.8 * scale).astype(np.float32) / 255.0
    fmask = fmask[..., None]
    # Compositing: weiss -> Farbflaechen -> Tinte obendrauf
    out = 255.0 * (1 - fmask) + recolored_s.astype(np.float32) * fmask
    m = m[..., None]
    out = out * (1 - m) + layer.astype(np.float32) * m
    return np.clip(out, 0, 255).astype(np.uint8)

# ==================================================================== Hauptlauf
def scan(in_path, out_path, testname):
    src = cv2.imread(in_path)
    if src is None:
        raise SystemExit(f"kann {in_path} nicht lesen")
    rough = find_rough_quad(src)
    refined = refine_edges(src, rough) if rough is not None else None

    overlay = src.copy()
    if rough is not None:
        cv2.polylines(overlay, [order_pts(rough).astype(int)], True, (0, 0, 255), 4)
    if refined is not None:
        cv2.polylines(overlay, [refined.astype(int)], True, (0, 255, 0), 2)
        for c in refined.astype(int):
            cv2.circle(overlay, tuple(c), 10, (0, 255, 0), 3)
    print(f"[{testname}] grob:      ",
          None if rough is None else order_pts(rough).astype(int).tolist())
    print(f"[{testname}] verfeinert:",
          None if refined is None else refined.astype(int).tolist())

    warped = warp(src, refined if refined is not None else rough) \
        if rough is not None else src.copy()
    warped, bars = crop_black_bars(warped)
    if sum(bars):
        print(f"[{testname}] schwarze Balken erkannt & entfernt (l,t,r,b) = {bars}")
    warped, gx_ = crop_book_gutter(warped)
    if gx_ >= 0:
        print(f"[{testname}] Buchfalz erkannt bei x={gx_} -> rechte Seite abgeschnitten")
    warped, curve_amp = flatten_curvature(warped)
    if curve_amp:
        print(f"[{testname}] Wellen-Glaettung: Kruemmung bis {curve_amp:.1f}px begradigt")
    if gx_ >= 0:   # nur Buchseiten: Raender begradigen + Stauchung ausgleichen
        warped, mdev = dewarp_book_margins(warped)
        if mdev:
            print(f"[{testname}] Rand-Entzerrung: Textraender um bis zu "
                  f"{mdev:.1f}px begradigt")
        warped, sfac = decompress_book_x(warped)
        if sfac > 1.0:
            print(f"[{testname}] Falz-Entstauchung: Buchstaben bis Faktor "
                  f"{sfac:.2f} verbreitert")
        warped, lcut = balance_left_margin(warped)
        if lcut:
            print(f"[{testname}] linker Leerrand um {lcut}px gekuerzt")
    # Drehung + Scherung MESSEN, dann in EINER Matrix anwenden
    # (nur einmal resamplen -> feine Zeichen wie '+' bleiben scharf)
    Hh, Ww = warped.shape[:2]
    angle = deskew_by_text(warped)
    Mrot = cv2.getRotationMatrix2D((Ww / 2, Hh / 2), angle, 1.0) if angle \
        else np.array([[1, 0, 0], [0, 1, 0]], np.float64)
    probe = cv2.warpAffine(warped, Mrot, (Ww, Hh),
                           flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE) if angle else warped
    shear = shear_level_lines(probe)
    if angle or shear:
        Msh = np.array([[1, 0, 0], [-shear, 1, shear * Ww / 2]], np.float64)
        A = (np.vstack([Msh, [0, 0, 1]]) @ np.vstack([Mrot, [0, 0, 1]]))[:2]
        warped = cv2.warpAffine(warped, A, (Ww, Hh), flags=cv2.INTER_CUBIC,
                                borderMode=cv2.BORDER_REPLICATE)
        print(f"[{testname}] Begradigung: Drehung {angle:+.1f} Grad, "
              f"Scherung {shear:+.4f} (1 Resample)")

    bw = mode_bw_smart(warped, book=(gx_ >= 0))
    clean0 = auto_clean(warped)
    hybrid = mode_hybrid(clean0, bw, scale=2, orig=warped)  # 2x Supersampling

    # Vergleichsbild: nur noch ORIGINAL -> SCAN (Hybrid)
    H = 1000
    def fit(i):
        if i.ndim == 2:
            i = cv2.cvtColor(i, cv2.COLOR_GRAY2BGR)
        return cv2.resize(i, (max(1, int(i.shape[1] * H / i.shape[0])), H))
    o, hy = fit(src), fit(hybrid)
    pad = np.full((H, 20, 3), 255, np.uint8)
    combo = np.hstack([o, pad, hy])
    head = np.full((70, combo.shape[1], 3), 30, np.uint8)
    cv2.putText(head, f"{testname}  |  ORIGINAL  ->  SCAN",
                (16, 46), 0, 1.1, (255, 255, 255), 2)
    combo = np.vstack([head, combo])
    cv2.imwrite(out_path, combo)
    print(f"[{testname}] -> {out_path}")

if __name__ == "__main__":
    scan(sys.argv[1], sys.argv[2], sys.argv[3])
