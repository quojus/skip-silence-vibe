// Ausgeschlossene Webseiten: Domains, gelten auch für alle Subdomains.
(() => {
  const SS = (globalThis.SS = globalThis.SS || {});

  SS.MAX_EXCLUDED = 200;
  const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

  /** Eingabe (Domain oder URL) → Domain in Kleinbuchstaben ohne „www.“, sonst null. */
  SS.normalizeHost = function normalizeHost(input) {
    if (typeof input !== "string") return null;
    let s = input.trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
    let host;
    try {
      const url = new URL(s);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      host = url.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return null;
    }
    // URL ergänzt Kurzformen von IPv4 („3“ → 0.0.0.3) – nur ausgeschriebene Adressen zählen
    if (/^[\d.]+$/.test(host) && !s.includes(host)) return null;
    host = host.replace(/^www\./, "");
    if (host.length > 253 || !HOST.test(host) || (!host.includes(".") && host !== "localhost")) return null;
    return host;
  };

  /** Hostname einer Seite gegen die Liste prüfen: gleiche Domain oder Subdomain. */
  SS.hostExcluded = function hostExcluded(hostname, list) {
    if (!hostname || !Array.isArray(list) || !list.length) return false;
    const h = String(hostname).toLowerCase().replace(/\.$/, "");
    return list.some((d) => h === d || h.endsWith(`.${d}`));
  };

  /** Hostname einer URL, nur für http(s); sonst null. */
  SS.hostOfUrl = function hostOfUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  };

  /** Gespeicherte Liste bereinigen: gültig, eindeutig, sortiert, begrenzt. */
  SS.cleanExcluded = function cleanExcluded(list) {
    if (!Array.isArray(list)) return [];
    const out = new Set();
    for (const x of list) {
      const h = SS.normalizeHost(x);
      if (h) out.add(h);
    }
    return [...out].sort().slice(0, SS.MAX_EXCLUDED);
  };

  if (typeof module !== "undefined") module.exports = SS;
})();
