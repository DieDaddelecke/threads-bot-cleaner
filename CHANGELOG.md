# Changelog

## 0.12.2
- Fix (#1): Scan bricht bei einem kurzzeitigen Fehler nicht mehr ab, sondern versucht es bis zu 3× (5 / 15 / 45 s).
- Bricht ein Scan doch ab, zeigt das Panel den echten Stand und den Grund an – statt der Anzeige des vorherigen Laufs – und „Weiter laden“ setzt genau dort fort.
- Kein endloses Warten mehr, wenn Sitzungs-Tokens fehlen.
- Diagnose-Info enthält jetzt Scan-Stand und eingestellte Blockgröße.

## 0.12.1
- Fix (#1): Zahlenfelder akzeptieren Tausenderpunkte („5.000“). Ungültige Eingaben fielen bisher still auf den Standardwert 1.000 zurück – jetzt bleibt der alte Wert und es gibt einen Hinweis im Protokoll.
- Neben „Follower scannen“ steht, wie viele Follower pro Lauf geladen werden.

## 0.12.0
- Einstellungen in einem eigenen Dialog (⚙ oben im Panel), Hauptansicht wieder aufgeräumt.

## 0.11.0
- Neuer Bereich „Einstellungen“ mit Reitern Tempo / Bewertung / Automatik / Erweitert.
- Tempo: Voreinstellungen Vorsichtig / Normal / Zügig, Regler für Blocks pro Tag (75–250) mit Risiko-Ampel und Dauer-Anzeige, Pausen-Regler, aktive Uhrzeiten, Kaffeepausen.
- Bewertung: Strenge, Punkte pro Merkmal, eigene Spam- und Schutz-Wörter, Schutzregeln (Instagram, privat, ab X Followern).
- Automatik: Autopilot ab Score X, täglicher Check der neuesten Follower.

## 0.10.0
- Profil-Prüfung erkennt, ob ein Instagram-Konto verknüpft ist (ohne zusätzliche Abfrage). Öffentliche Profile ohne Instagram: +10.
- IG-Link neben dem Namen, um Grenzfälle schnell auf Instagram anzusehen.

## 0.9.0
- Tageslimit Standard 150 (höhere Werte werden einmalig auf 150 gesenkt).
- Profil-Prüfung standardmäßig 2 parallel, max. 300 Profile pro Durchlauf.
- Scan in Blöcken: zuerst die neuesten 1000 Follower, weitere per „Nächste 1000 laden“.

## 0.8.0
- Keine externen Schriften mehr (Google Fonts entfernt, Datenschutz).
- Vorsichtigere Standardwerte für neue Installationen: 20–40 s Pause, max. 100 Blocks/Tag. Bestehende Einstellungen bleiben unverändert.
- README zweisprachig (DE/EN), Issue-Vorlage, Changelog.

## 0.7.x
- Design im Stil von getartcraft.com: Papier-Töne, Archivo/Inter/Geist Mono, nummerierte Abschnitte, Haarlinien.
- Tabelle passt sich an die Panelbreite an (Gründe kürzen, Zahlen inline, Aktionen immer sichtbar).
- Kompaktere Zeilen, Warteschlange unter der Kontenliste, farbige Score-Kodierung.

## 0.6.x
- Helles, kantiges Design. Tageslimit einstellbar bis 250.

## 0.5.x
- Profil-Prüfung parallel und schneller, eindeutige Bots werden übersprungen.
- Shift-Klick-Bereichsauswahl, Auswahl per Zeilenklick.
- Panelbreite per Ziehen am linken Rand einstellbar.

## 0.4.0
- Breiteres Panel, Gründe als Chips.

## 0.3.x
- Private Konten ohne sichtbare Beiträge werden höher bewertet; Ziffern am Namensanfang zählen.
- Kürzere Block-Pause einstellbar.

## 0.2.0
- Profil-Prüfung über die öffentliche Profilseite (Follower, Beiträge, Bio, Links).
- Erkennung von Bots mit Klarnamen („Vorname.Nachname“, 0 Follower, keine Beiträge).

## 0.1.0
- Erste Version: Lernmodus, Follower-Scan, Bot-Score, Einzel- und Bulk-Blocken, gedrosselte Warteschlange.
