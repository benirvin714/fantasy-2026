/* Backdrop prototype (branch only) — the harness for comparing two ambient treatments.
 *
 * Injects the backdrop layer and a switcher into every page, so the comparison runs against real
 * content rather than a mockup. Variant lives on <html data-backdrop>, persists in localStorage and
 * can be forced with ?bg=none|css|video for a clean-slate look.
 *
 * The video half follows the autoplay-loop guidance rather than fighting it: muted, playsinline,
 * preload="none", and paused whenever the tab is hidden or the layer scrolls off screen. A poster
 * paints first so the page never waits on the file, and a missing asset says so instead of
 * rendering an empty black rectangle that looks like a bug.
 *
 * Deleting this file, backdrop.css, and the two tags in each page removes the experiment entirely.
 */
(() => {
  const VARIANTS = ["none", "css", "video"];
  const KEY = "hq-backdrop";
  const SRC = "assets/backdrop.mp4";
  const POSTER = "assets/backdrop-poster.jpg";

  const root = document.documentElement;
  const qs = new URLSearchParams(location.search).get("bg");
  const stored = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  let variant = VARIANTS.includes(qs) ? qs : VARIANTS.includes(stored) ? stored : "none";

  /* ---------------------------------------------------------------- layer */
  const bd = document.createElement("div");
  bd.className = "bd";
  bd.setAttribute("aria-hidden", "true");   // pure decoration: never in the a11y tree
  bd.innerHTML = `
    <div class="bd-css">
      <div class="bd-turf"></div>
      <div class="bd-lights"></div>
      <div class="bd-vignette"></div>
    </div>
    <div class="bd-video">
      <video muted loop playsinline preload="none" tabindex="-1"></video>
      <div class="bd-vignette"></div>
    </div>`;
  document.body.insertBefore(bd, document.body.firstChild);

  const video = bd.querySelector("video");

  /* ---------------------------------------------------------------- video lifecycle
     A background loop that keeps decoding while the tab is in another window is pure waste, and on
     a laptop it is waste the user can hear. Pause on hidden tab and when scrolled out of view. */
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let sourceAttached = false;

  const canPlay = () => variant === "video" && !reduced.matches
    && document.visibilityState === "visible";

  function syncVideo() {
    if (variant !== "video") { video.pause(); return; }
    if (!sourceAttached) {
      /* Both the poster and the source are attached here rather than in the markup. A `poster`
         written into the HTML is fetched on parse even while the element is display:none, so the
         default page would pay a request (and log a 404 until the asset exists) for a variant
         nobody selected. preload="none" then holds the video itself back until play() is called. */
      video.poster = POSTER;
      video.src = SRC;
      sourceAttached = true;
      video.addEventListener("error", () => {
        if (bd.querySelector(".bd-missing")) return;
        const note = document.createElement("div");
        note.className = "bd-missing";
        note.textContent = `no backdrop asset yet — expected site/${SRC}`;
        bd.querySelector(".bd-video").appendChild(note);
      }, { once: true });
    }
    if (canPlay()) video.play().catch(() => { /* autoplay refused: poster stands in, no error state */ });
    else video.pause();
  }

  document.addEventListener("visibilitychange", syncVideo);
  reduced.addEventListener?.("change", syncVideo);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => { if (!e.isIntersecting) video.pause(); else syncVideo(); })
      .observe(bd);
  }

  /* ---------------------------------------------------------------- switcher */
  function apply(v, persist = true) {
    variant = v;
    root.setAttribute("data-backdrop", v);
    if (persist) { try { localStorage.setItem(KEY, v); } catch { /* private window: session only */ } }
    sw.querySelectorAll("button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.v === v)));
    syncVideo();
  }

  const sw = document.createElement("div");
  sw.className = "bd-switch";
  sw.innerHTML = `<b>backdrop</b>` + VARIANTS.map((v) =>
    `<button type="button" data-v="${v}" aria-pressed="false">${v}</button>`).join("");
  document.body.appendChild(sw);
  sw.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) apply(b.dataset.v);
  });

  apply(variant, false);
})();
