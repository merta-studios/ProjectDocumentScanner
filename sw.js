/*
 * Ultra Scan - Service Worker: sorgt dafuer, dass die grossen Dateien
 * (Pyodide/OpenCV ca. 28 MB, ONNX Runtime + KI-Modelle ca. 25 MB) nach
 * dem ersten Besuch dauerhaft gespeichert sind und die App danach
 * blitzschnell (und sogar offline) startet.
 */
"use strict";

/* Version bei jeder Änderung der Startlogik erhöhen: so wird kein alter,
 * möglicherweise unvollständiger Worker aus dem Browser-Cache verwendet. */
var CACHE_NAME = "ultra-scan-v6";

self.addEventListener("install", function (e) {
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (namen) {
      return Promise.all(namen.filter(function (n) {
        return n !== CACHE_NAME;
      }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var anfrage = e.request;
  if (anfrage.method !== "GET") { return; }
  var url = new URL(anfrage.url);
  if (url.origin !== self.location.origin) { return; }

  if (url.pathname.indexOf("/vendor/") !== -1 ||
      url.pathname.indexOf("/models/") !== -1 ||
      url.pathname.indexOf("/icons/") !== -1) {
    /* grosse, versionierte Dateien (Pyodide, ONNX Runtime, KI-Modell):
     * Cache zuerst - die aendern sich nur mit einer neuen Version. */
    e.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(anfrage).then(function (treffer) {
          if (treffer) { return treffer; }
          return fetch(anfrage).then(function (antwort) {
            if (antwort.ok) { cache.put(anfrage, antwort.clone()); }
            return antwort;
          });
        });
      })
    );
  } else {
    /* App-Dateien: Netz zuerst (Updates kommen an), Cache als Fallback */
    e.respondWith(
      fetch(anfrage).then(function (antwort) {
        if (antwort.ok) {
          var kopie = antwort.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(anfrage, kopie); });
        }
        return antwort;
      }).catch(function () {
        return caches.match(anfrage).then(function (treffer) {
          if (treffer) { return treffer; }
          throw new Error("offline und nicht im Cache");
        });
      })
    );
  }
});
