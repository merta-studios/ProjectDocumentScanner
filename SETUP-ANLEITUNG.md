# 📄 Dokument-Scanner – Setup-Anleitung für absolute Anfänger

Diese Anleitung führt dich **Schritt für Schritt** vom Pull Request bis zur
fertigen Scanner-App auf deinem iPad. Du musst nichts von Git, Netlify oder
Deployments verstehen – einfach genau den Schritten folgen.

> **Was ist das hier überhaupt?**
> In deinem GitHub-Repository liegt jetzt eine komplette Web-App. Netlify ist
> ein kostenloser Dienst, der diese Dateien ins Internet stellt. Danach kannst
> du die App auf dem iPad wie eine normale App benutzen. Deine Python-Datei
> `scanner` wurde dabei **nicht verändert** – sie läuft 1:1 im Browser.

---

## Schritt 1: Den Pull Request ansehen und mergen

Ein "Pull Request" (kurz: PR) ist ein Änderungsvorschlag. Du musst ihn einmal
bestätigen ("mergen"), damit die neuen Dateien in dein Projekt übernommen
werden.

1. Öffne im Browser **github.com** und melde dich an.
2. Öffne dein Repository **ProjectDocumentScanner**
   (z.&nbsp;B. über dein Profilbild oben rechts → **Your repositories** →
   auf den Namen klicken).
3. Klicke oben in der Leiste des Repositories auf den Reiter
   **Pull requests** (zwischen "Issues" und "Actions").
4. Klicke auf den Pull Request mit dem Titel
   **"Web-App: Dokumentenscanner im Browser (Pyodide)"**.
5. Scrolle nach unten, bis du einen großen **grünen Button** siehst:
   **Merge pull request**. Klicke darauf.
   - Falls der Button ein Dropdown-Pfeil ist und etwas anderes anzeigt
     (z.&nbsp;B. "Squash and merge"): das ist auch in Ordnung, einfach klicken.
6. Es erscheint ein zweiter grüner Button: **Confirm merge**. Klicke darauf.
7. Fertig, wenn dort steht: **"Pull request successfully merged and closed"**.
   Den Button **Delete branch** kannst du klicken, musst du aber nicht.

**Was tun bei Warnungen?**
- Gelber Hinweis *"This branch has not been deployed"* oder ähnliches:
  ignorieren, einfach mergen.
- Grauer Hinweis *"Merging is blocked"*: dann ist in den Repo-Einstellungen
  eine Schutzregel aktiv. Gehe zu **Settings → Branches**, lösche die Regel
  für `main` (oder frage die Person, die sie eingerichtet hat).
- Roter Hinweis *"This branch has conflicts"*: sollte nicht passieren, weil
  nur neue Dateien hinzugefügt wurden. Falls doch: nicht mergen, sondern
  melden (dann wurde `main` zwischenzeitlich verändert).

---

## Schritt 2: Kostenlosen Netlify-Account anlegen (mit GitHub-Login)

1. Öffne im Browser: **https://app.netlify.com/signup**
2. Klicke auf den Button **GitHub** (meist der oberste in der Liste
   "Sign up with…").
3. Ein GitHub-Fenster öffnet sich: **Authorize Netlify** – klicke auf den
   grünen Button **Authorize netlify**.
   (Falls GitHub nach deinem Passwort fragt: das ist das normale
   GitHub-Passwort, das ist echt und sicher.)
4. Netlify stellt dir eventuell 2–3 Fragen ("What's your name?", Teamname
   usw.) – trage irgendetwas ein, das spielt keine Rolle. Kostenlosen Plan
   ("Free") wählen, falls gefragt.

---

## Schritt 3: Dein privates Repo mit Netlify verbinden

1. Du landest auf der Netlify-Übersichtsseite (Dashboard).
   Klicke auf den Button **Add new project** (oder **Add new site** –
   je nach Netlify-Version) und wähle **Import an existing project**.
2. Bei "Let's deploy your project with…" klicke auf **GitHub**.
3. **Jetzt kommt die wichtige Berechtigungs-Abfrage:** Ein GitHub-Fenster
   "Install Netlify" öffnet sich, weil dein Repo **privat** ist und Netlify
   Lese-Zugriff braucht.
   - Wähle deinen GitHub-Benutzernamen aus (falls gefragt).
   - Wähle die Option **Only select repositories** und wähle im Dropdown
     **ProjectDocumentScanner** aus.
     (Alternativ "All repositories" – geht auch, gibt Netlify aber Zugriff
     auf alles.)
   - Klicke auf den grünen Button **Install** (oder **Save**).
4. Zurück bei Netlify: in der Repo-Liste erscheint **ProjectDocumentScanner**.
   Klicke darauf.
5. Jetzt kommt die Seite mit den Deploy-Einstellungen. **So füllst du sie aus:**

   | Feld | Was eintragen? |
   |---|---|
   | **Site name** (falls angezeigt) | leer lassen oder Wunschname |
   | **Branch to deploy** | `main` (ist meist schon vorausgewählt) |
   | **Base directory** | **leer lassen** |
   | **Build command** | **leer lassen** (nichts eintragen!) |
   | **Publish directory** | **leer lassen** (oder `.` eintragen, falls das Feld nicht leer sein darf) |
   | **Functions directory** | **leer lassen** |

   > Im Repo liegt eine Datei `netlify.toml`, die das alles schon richtig
   > einstellt. Deshalb: im Zweifel einfach **alles leer lassen**.

6. Klicke unten auf den Button **Deploy ProjectDocumentScanner**
   (oder **Deploy site**).
7. Warte 1–2 Minuten. Der Status wechselt von "Building"/"Uploading" auf
   **Published** (grün). Fertig!

---

## Schritt 4: Web-Adresse finden und Seitennamen verschönern

1. Klicke in Netlify links auf **Project overview** (oder **Site overview**).
2. Oben siehst du deine Adresse, etwa:
   `https://glittery-kataifi-123abc.netlify.app` – das ist deine Scanner-App!
   Einmal anklicken zum Testen.
3. **Namen ändern:**
   1. Klicke auf **Project configuration** (oder **Site configuration**
      bzw. **Domain settings**).
   2. Unter **Project details** / **Site details** klicke auf
      **Change project name** (bzw. **Change site name**).
   3. Trage z.&nbsp;B. `mein-dokument-scanner` ein und klicke **Save**.
   4. Deine neue Adresse lautet dann:
      `https://mein-dokument-scanner.netlify.app`

> **Ab jetzt gilt:** Jedes Mal, wenn du etwas auf dem `main`-Branch in GitHub
> änderst (z.&nbsp;B. einen neuen PR mergst), aktualisiert Netlify die Seite
> automatisch. Du musst nie wieder etwas deployen.

---

## Schritt 5: Auf dem iPad öffnen und als App-Icon hinzufügen

1. Öffne auf dem iPad **Safari** (wichtig: Safari, nicht Chrome).
2. Tippe oben in die Adressleiste und gib deine Adresse ein, z.&nbsp;B.
   `mein-dokument-scanner.netlify.app`, dann **Öffnen**.
3. Warte, bis die App geladen ist (beim ersten Mal dauert das – siehe
   Schritt 6).
4. Tippe oben rechts (neben der Adressleiste) auf das **Teilen-Symbol**
   – das Quadrat mit dem Pfeil nach oben: ⬆️
5. Scrolle in dem Menü nach unten und tippe auf **"Zum Home-Bildschirm"**
   (englisch: "Add to Home Screen").
6. Oben rechts auf **"Hinzufügen"** tippen.
7. Auf deinem Home-Bildschirm liegt jetzt das Scanner-Icon 📄 – antippen und
   losscannen, wie eine normale App.

---

## Schritt 6: Was beim ALLERERSTEN Start zu erwarten ist

**Das ist normal:**
- Beim ersten Start lädt die App einmalig **ca. 28 MB** herunter
  (Python und OpenCV laufen komplett auf deinem iPad – deshalb so groß).
- Du siehst einen **Ladebalken** mit Texten wie *"Python wird geladen…"*,
  *"OpenCV wird geladen…"*. Das kann je nach Internet **1–3 Minuten** dauern.
- Danach wird alles auf dem Gerät gespeichert: ab dem zweiten Start ist die
  App in wenigen Sekunden bereit.
- Der erste Scan dauert etwas länger als die folgenden (10–60 Sekunden pro
  Foto sind normal – es läuft eine echte Bildverarbeitungs-Pipeline auf dem
  iPad).
- **Kein Bild verlässt dein Gerät.** Es gibt keinen Server, keine Cloud.

### Fehlerbehebung

| Problem | Lösung |
|---|---|
| **Seite lädt nicht / bleibt weiß** | 1. Internetverbindung prüfen. 2. In Safari neu laden (Kreis-Pfeil in der Adressleiste). 3. Safari komplett schließen (App-Umschalter, nach oben wischen) und neu öffnen. 4. Prüfen, ob die Adresse stimmt (`….netlify.app`). |
| **Ladebalken bleibt lange stehen** | Bei langsamem WLAN normal (28 MB!). Bis 5 Minuten warten. Hängt er wirklich fest: Seite neu laden – der Download wird fortgesetzt bzw. kommt aus dem Speicher. |
| **"Es ist ein Problem aufgetreten" wird angezeigt** | Auf **"Seite neu laden"** tippen. Hilft das nicht: WLAN prüfen; einmal mit anderem Netz (z.&nbsp;B. Hotspot) versuchen. |
| **Scan dauert ewig (über 2 Minuten)** | iPad kurz entsperrt lassen und Safari im Vordergrund behalten (iOS pausiert Hintergrund-Tabs!). Sehr alte iPads sind langsamer. Hilft nichts: Seite neu laden und Foto erneut wählen. |
| **"Kein Dokument-Viereck erkannt"** | Das Foto neu aufnehmen: ganzes Blatt aufs Bild, mit sichtbarem Rand, guter Kontrast zum Untergrund (helles Blatt auf dunklem Tisch), gleichmäßiges Licht. Die App zeigt trotzdem ein Ergebnis (ganzes Foto verarbeitet). |
| **Speichern geht nicht** | Der Button **"Scan sichern / teilen"** öffnet das iOS-Teilen-Menü: dort auf **"Bild sichern"** tippen – der Scan landet in der Fotos-App. Erscheint "Bild sichern" nicht: In iOS **Einstellungen → Safari** prüfen, dass Downloads erlaubt sind, oder im Teilen-Menü nach unten scrollen. |
| **App vom Home-Bildschirm zeigt alten Stand** | App schließen (App-Umschalter) und neu öffnen – sie holt sich Updates automatisch beim Start. |

---

## Für später: Wie kommt ein Update auf die Seite?

1. Änderung als Pull Request auf GitHub (wie Schritt 1).
2. **Merge pull request** → **Confirm merge**.
3. 1–2 Minuten warten – Netlify veröffentlicht automatisch neu. Das war's.
