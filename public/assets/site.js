// Small comforts. The page reads and works the same without this file.
(function () {
  "use strict";
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Copy buttons: the address, and each line under "Add it in one line".
  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-copy]") : null;
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.getAttribute("data-copy") || "").then(function () {
      var label = button.getAttribute("data-label") || button.textContent;
      button.setAttribute("data-label", label);
      button.textContent = "Copied";
      setTimeout(function () {
        button.textContent = label;
      }, 1600);
    });
  });

  // A well in the first screen points at its tool: open that tool's bar when it is the target.
  function openTarget() {
    var id = location.hash.slice(1);
    var target = id ? document.getElementById(id) : null;
    if (target && target.tagName === "DETAILS") target.open = true;
  }
  window.addEventListener("hashchange", openTarget);
  openTarget();

  // The photograph in the first screen turns from day to dusk and back, slowly.
  var source = document.querySelector(".source");
  if (source && !still) {
    setInterval(function () {
      if (!document.hidden) source.classList.toggle("turned");
    }, 6500);
  }

  // Parts below the first screen rise into place as they are reached.
  if (!still && "IntersectionObserver" in window) {
    var parts = document.querySelectorAll(
      ".plate, .ask > *, .col h2, .bars details, .round, .field h2, .clause, .add-say > h2, .add-say > p, .clients li, .tile, .log-say, .log table, .share h2, .picks, .figs, .foot .line i, .foot .mark",
    );
    var seen = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          seen.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    Array.prototype.forEach.call(parts, function (part) {
      // What is already on screen stays put; only what is still below rises.
      if (part.getBoundingClientRect().top < window.innerHeight) return;
      part.classList.add("rise");
      seen.observe(part);
    });
  }
})();
