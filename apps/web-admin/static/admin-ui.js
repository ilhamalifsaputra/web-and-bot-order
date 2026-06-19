/* admin-ui.js — progressive-enhancement layer for the web-admin component macros
   (packages/web-ui/views/_macros.njk). Loaded once via base.njk as <script defer>.
   Everything here is opt-in by markup: pages without these data-attributes are
   untouched, and with JS disabled the underlying forms/links still work.

   Provides:
     • Tabs       — [data-tabs] tablists (ARIA, arrows, hash + sessionStorage)
     • AlertDialog — [data-confirm] forms/buttons → one shared <dialog class=alert>
     • Dropdown   — details.dropdown close-on-outside / Escape
     • Dropzone   — .dropzone-form drag & drop + preview
*/
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  // Generalises the bespoke settings.njk controller. Each [data-tabs] group:
  // shows one [data-panel] at a time, mirrors the active key to the URL hash,
  // and (across the save → 303 redirect) restores the last tab from
  // sessionStorage so you land back where you saved.
  function initTabs(root) {
    root.querySelectorAll(".tabs[data-tabs]").forEach(function (group) {
      var id = group.getAttribute("data-tabs");
      var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"][data-tab]'));
      var panels = Array.prototype.slice.call(group.querySelectorAll('[data-panel]'));
      if (!tabs.length) return;
      var storeKey = "admin-tab:" + id;

      function show(key, focus) {
        tabs.forEach(function (t) {
          var on = t.getAttribute("data-tab") === key;
          t.setAttribute("aria-selected", on ? "true" : "false");
          t.setAttribute("tabindex", on ? "0" : "-1");
          if (on && focus) t.focus();
        });
        panels.forEach(function (p) {
          p.hidden = p.getAttribute("data-panel") !== key;
        });
        try { sessionStorage.setItem(storeKey, key); } catch (e) { /* ignore */ }
      }

      tabs.forEach(function (tab, i) {
        tab.addEventListener("click", function () {
          var key = tab.getAttribute("data-tab");
          show(key, false);
          if (history.replaceState) history.replaceState(null, "", "#" + key);
        });
        tab.addEventListener("keydown", function (e) {
          var idx = i;
          if (e.key === "ArrowRight" || e.key === "ArrowDown") idx = (i + 1) % tabs.length;
          else if (e.key === "ArrowLeft" || e.key === "ArrowUp") idx = (i - 1 + tabs.length) % tabs.length;
          else if (e.key === "Home") idx = 0;
          else if (e.key === "End") idx = tabs.length - 1;
          else return;
          e.preventDefault();
          show(tabs[idx].getAttribute("data-tab"), true);
        });
      });

      // Initial selection: URL hash wins, else a stashed tab from the last save,
      // else the first tab (already shown server-side).
      var hash = (location.hash || "").replace(/^#/, "");
      var stored = null;
      try { stored = sessionStorage.getItem(storeKey); } catch (e) { /* ignore */ }
      var keys = tabs.map(function (t) { return t.getAttribute("data-tab"); });
      var initial = keys.indexOf(hash) >= 0 ? hash : (keys.indexOf(stored) >= 0 ? stored : keys[0]);
      show(initial, false);

      // Stash the current tab right before any form on this page submits, so the
      // post-redirect GET restores it.
      group.querySelectorAll("form").forEach(function (form) {
        form.addEventListener("submit", function () {
          var active = group.querySelector('[role="tab"][aria-selected="true"]');
          if (active) {
            try { sessionStorage.setItem(storeKey, active.getAttribute("data-tab")); } catch (e) { /* ignore */ }
          }
        });
      });
    });
  }

  // ── AlertDialog ─────────────────────────────────────────────────────────────
  // One shared <dialog class="alert"> (markup in base.njk). Any element carrying
  // data-confirm="message" defers its action until confirmed. Forms intercept
  // submit (preserving the actual submitter button so two-action forms — e.g.
  // bulk mark-bad vs. formaction=bulk-delete — keep the right action).
  function initConfirm(root) {
    var dialog = document.getElementById("alert-dialog");
    if (!dialog || typeof dialog.showModal !== "function") return; // fallback: native submit
    var msgEl = dialog.querySelector("[data-alert-message]");
    var okBtn = dialog.querySelector("[data-alert-confirm]");
    var pending = null;

    function open(message, onConfirm) {
      if (msgEl) msgEl.textContent = message || "Are you sure?";
      pending = onConfirm;
      dialog.showModal();
      if (okBtn) okBtn.focus();
    }
    okBtn && okBtn.addEventListener("click", function () {
      var fn = pending; pending = null; dialog.close();
      if (fn) fn();
    });
    dialog.addEventListener("close", function () { pending = null; });

    root.querySelectorAll("form[data-confirm]").forEach(function (form) {
      if (form.__confirmBound) return; form.__confirmBound = true;
      form.addEventListener("submit", function (e) {
        if (form.__confirmed) { form.__confirmed = false; return; }
        e.preventDefault();
        var submitter = e.submitter || form.querySelector('[type="submit"]');
        open(form.getAttribute("data-confirm"), function () {
          form.__confirmed = true;
          if (submitter && typeof form.requestSubmit === "function") form.requestSubmit(submitter);
          else form.submit();
        });
      });
    });

    root.querySelectorAll("button[data-confirm], a[data-confirm]").forEach(function (el) {
      if (el.__confirmBound || el.closest("form[data-confirm]")) return;
      el.__confirmBound = true;
      el.addEventListener("click", function (e) {
        e.preventDefault();
        open(el.getAttribute("data-confirm"), function () {
          if (el.tagName === "A") window.location.href = el.getAttribute("href");
          else if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit(el);
          else if (el.form) el.form.submit();
        });
      });
    });
  }

  // ── Dropdown ────────────────────────────────────────────────────────────────
  function initDropdowns() {
    if (document.__ddBound) return; document.__ddBound = true;
    document.addEventListener("click", function (e) {
      document.querySelectorAll("details.dropdown[open]").forEach(function (d) {
        if (!d.contains(e.target)) d.removeAttribute("open");
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      document.querySelectorAll("details.dropdown[open]").forEach(function (d) {
        d.removeAttribute("open");
      });
    });
  }

  // ── Dropzone ────────────────────────────────────────────────────────────────
  var MAX_BYTES = 5 * 1024 * 1024;
  var OK_TYPES = ["image/jpeg", "image/png", "image/webp"];
  function initDropzones(root) {
    root.querySelectorAll(".dropzone-form").forEach(function (form) {
      if (form.__dzBound) return; form.__dzBound = true;
      var zone = form.querySelector(".dropzone");
      var input = form.querySelector(".dz-input");
      var preview = form.querySelector(".dz-preview");
      var prompt = form.querySelector(".dz-prompt");
      var nameEl = form.querySelector(".dz-name");
      if (!zone || !input) return;

      function showFile(file) {
        if (!file) return;
        if (OK_TYPES.indexOf(file.type) < 0) { alert("Only JPG, PNG, or WebP images are allowed."); input.value = ""; return; }
        if (file.size > MAX_BYTES) { alert("Image is larger than 5 MB."); input.value = ""; return; }
        if (nameEl) nameEl.textContent = file.name;
        if (preview) {
          var url = URL.createObjectURL(file);
          preview.src = url;
          preview.classList.remove("hidden");
          if (prompt) prompt.classList.add("hidden");
        }
      }

      input.addEventListener("change", function () { showFile(input.files && input.files[0]); });
      ["dragenter", "dragover"].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("is-dragover"); });
      });
      ["dragleave", "dragend", "drop"].forEach(function (ev) {
        zone.addEventListener(ev, function () { zone.classList.remove("is-dragover"); });
      });
      zone.addEventListener("drop", function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          input.files = e.dataTransfer.files;
          showFile(input.files[0]);
        }
      });
    });
  }

  function initAll(root) {
    root = root || document;
    initTabs(root);
    initConfirm(root);
    initDropzones(root);
    refreshIcons();
  }

  ready(function () {
    initDropdowns();
    initAll(document);
  });
  // Re-init swapped-in HTMX content (matches base.njk's icon hook).
  document.addEventListener("htmx:afterSettle", function (e) { initAll(e.target || document); });
})();
