/* Tabriz site — v3 application layer.
 *
 * Keeps the v0.4 behaviour that worked (safety net, reveals, language, mode, tabs,
 * pager, counters) and adds the map system. Maps are created lazily, when their
 * panel is first shown: eight panels' worth of canvas at device pixel ratio is a lot
 * of memory to allocate for one visible tab.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var RM = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
  var CAN = ("IntersectionObserver" in window) && !RM;
  if (CAN) root.classList.add("js-anim");
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  /* Safety net first: if anything below throws, the page still shows its content
     and its final numbers. Carried over from v0.4 unchanged — it has earned its place. */
  function revealAll() {
    $$(".rv:not(.in),.fr:not(.in)").forEach(function (el) { el.classList.add("in"); });
    $$("[data-to]").forEach(function (el) {
      if (el.textContent === "0" || el.textContent === "")
        el.textContent = parseFloat(el.dataset.to).toFixed(parseInt(el.dataset.dec, 10));
    });
  }
  setTimeout(revealAll, 2600);
  window.addEventListener("load", function () { setTimeout(revealAll, 1200); });

  var B = JSON.parse($("#tz-bundle").textContent);
  var N = B.numbers;
  var BASE = { light: window.__TZ_BASE_LIGHT__, dark: window.__TZ_BASE_DARK__ };
  var MAPS = {};
  var W = {};                               // widget repaint hooks, by name
  window.Tabriz = { maps: MAPS, bundle: B, numbers: N };
  function ur() { return root.getAttribute("data-lang") === "ur"; }
  function t(en, u) { return ur() ? u : en; }
  function fx(v, d) { return Number(v).toFixed(d === undefined ? 1 : d); }

  /* Map labels are resolved at paint time, not when they are set, so a language
     change re-reads them without every map having to rebuild its label set. */
  function L_INTAKE() { return t("Intake", "انٹیک"); }
  function L_FOREBAY() { return t("Forebay", "ذخیرہ"); }
  function L_POWER() { return t("Powerhouse", "پاور ہاؤس"); }

  /* ---- reveal ---------------------------------------------------------- */
  var io = CAN ? new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: .1, rootMargin: "0px 0px -5% 0px" }) : null;
  function observeIn(scope) {
    if (!io) return;
    $$(".rv:not(.in),.fr:not(.in)", scope || document).forEach(function (el) { io.observe(el); });
  }
  observeIn(document);

  /* ---- language -------------------------------------------------------- */
  var le = $("#l-en"), lu = $("#l-ur");
  function setLang(L, save) {
    root.setAttribute("data-lang", L); root.setAttribute("lang", L);
    document.body.setAttribute("dir", L === "ur" ? "rtl" : "ltr");
    le.setAttribute("aria-pressed", String(L === "en"));
    lu.setAttribute("aria-pressed", String(L === "ur"));
    if (save) { try { localStorage.setItem("tz-lang", L); } catch (e) {} }
    pager(CUR); repaintWidgets();
  }
  le.onclick = function () { setLang("en", true); };
  lu.onclick = function () { setLang("ur", true); };

  /* ---- mode ------------------------------------------------------------ */
  var mg = $("#m-gen"), mt = $("#m-tech");
  function setMode(m, save) {
    root.setAttribute("data-mode", m);
    mg.setAttribute("aria-pressed", String(m === "general"));
    mt.setAttribute("aria-pressed", String(m === "technical"));
    if (save) { try { localStorage.setItem("tz-mode", m); } catch (e) {} }
    // technical blocks can contain a map that was hidden when it was measured
    setTimeout(resizeVisibleMaps, 60);
  }
  mg.onclick = function () { setMode("general", true); };
  mt.onclick = function () { setMode("technical", true); };

  /* ---- tabs and pager -------------------------------------------------- */
  var allTabs = $$(".tab"), topTabs = $$(".tabwrap .tab"), panels = $$(".panel"),
    NAMES = topTabs.map(function (x) {
      return { en: ($(".en", x) || {}).textContent || "", ur: ($(".ur", x) || {}).textContent || "" };
    });
  var pgPrev = $("#pgPrev"), pgNext = $("#pgNext"),
    pgPrevT = $("#pgPrevT"), pgNextT = $("#pgNextT"), CUR = 0;
  function idxOf(el) { return parseInt(el.getAttribute("data-i"), 10) || 0; }
  function pager(i) {
    if (!pgPrev) return;
    pgPrev.disabled = (i === 0); pgNext.disabled = (i === panels.length - 1);
    pgPrevT.textContent = i > 0 ? (ur() ? NAMES[i - 1].ur : NAMES[i - 1].en) : "—";
    pgNextT.textContent = i < panels.length - 1 ? (ur() ? NAMES[i + 1].ur : NAMES[i + 1].en) : "—";
  }
  function select(i, focus) {
    CUR = i;
    allTabs.forEach(function (tb) {
      var on = idxOf(tb) === i;
      tb.setAttribute("aria-current", String(on));
      if (tb.hasAttribute("aria-selected")) tb.setAttribute("aria-selected", String(on));
    });
    panels.forEach(function (p, k) {
      p.classList.toggle("on", k === i);
      if (k === i) p.removeAttribute("hidden"); else p.setAttribute("hidden", "");
    });
    if (focus && topTabs[i]) topTabs[i].focus();
    try { topTabs[i].scrollIntoView({ block: "nearest", inline: "nearest", behavior: RM ? "auto" : "smooth" }); } catch (e) {}
    observeIn(panels[i]); pager(i);
    mountMaps(panels[i]);
    try { history.replaceState(null, "", "#" + topTabs[i].getAttribute("aria-controls")); } catch (e) {}
  }
  function stickyOffset() {
    var tw = $(".tabwrap"), m = $(".mast");
    var o = tw ? tw.getBoundingClientRect().height : 0;
    if (m && getComputedStyle(m).position === "sticky") o += m.getBoundingClientRect().height;
    return o + 14;
  }
  function goTo(i, scrollTop) {
    select(i, false);
    if (!scrollTop) return;
    try {
      var tw = $(".tabwrap");
      var y = tw.getBoundingClientRect().top + window.scrollY -
        (stickyOffset() - tw.getBoundingClientRect().height) - 6;
      window.scrollTo({ top: Math.max(0, y), behavior: RM ? "auto" : "smooth" });
    } catch (e) {}
  }
  allTabs.forEach(function (tb) { tb.addEventListener("click", function () { goTo(idxOf(tb), true); }); });
  topTabs.forEach(function (tb, i) {
    tb.addEventListener("keydown", function (e) {
      var n = null;
      if (e.key === "ArrowRight") n = (i + 1) % topTabs.length;
      else if (e.key === "ArrowLeft") n = (i - 1 + topTabs.length) % topTabs.length;
      else if (e.key === "Home") n = 0; else if (e.key === "End") n = topTabs.length - 1;
      if (n !== null) { e.preventDefault(); select(n, true); }
    });
  });
  if (pgPrev) pgPrev.addEventListener("click", function () { if (CUR > 0) goTo(CUR - 1, true); });
  if (pgNext) pgNext.addEventListener("click", function () { if (CUR < panels.length - 1) goTo(CUR + 1, true); });

  var cta = $(".cta");
  if (cta) cta.addEventListener("click", function (e) {
    e.preventDefault();
    try { $(".tabwrap").scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "start" }); } catch (x) {}
  });

  /* ---- counters -------------------------------------------------------- */
  var cio = CAN ? new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      cio.unobserve(e.target);
      var el = e.target, to = parseFloat(el.dataset.to), dec = parseInt(el.dataset.dec, 10), t0 = null;
      function step(ts) {
        if (!t0) t0 = ts;
        var p = Math.min((ts - t0) / 1300, 1), k = 1 - Math.pow(1 - p, 3);
        el.textContent = (to * k).toFixed(dec);
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }, { threshold: .4 }) : null;
  $$("[data-to]").forEach(function (el) {
    if (cio) cio.observe(el);
    else el.textContent = parseFloat(el.dataset.to).toFixed(parseInt(el.dataset.dec, 10));
  });

  /* ═══════════════════════════════════════════════════ maps, mounted lazily */
  var SPEC = {};                              // id -> setup function
  function mountMaps(scope) {
    $$("[data-map]", scope || document).forEach(function (el) {
      var id = el.getAttribute("data-map");
      if (MAPS[id] || !SPEC[id]) return;
      var m = new window.TabrizMap(el, B, { view: el.getAttribute("data-view") || "tabriz" });
      m.setBase(BASE.light, BASE.dark);
      MAPS[id] = m;
      SPEC[id](m);
    });
  }
  function resizeVisibleMaps() {
    Object.keys(MAPS).forEach(function (k) {
      var m = MAPS[k];
      if (m.el.offsetParent !== null) { m._resize(); m._clampView(); m.draw(); }
    });
  }
  window.addEventListener("resize", function () { setTimeout(resizeVisibleMaps, 120); });

  var steps = B.layers.command.steps;
  var arrivalIdx = steps.reduce(function (best, s, i) {
    return Math.abs(s.level - B.layers.command.arrival) <
      Math.abs(steps[best].level - B.layers.command.arrival) ? i : best;
  }, 0);
  var SC = B.layers.scheme;
  var LEAD = SC.options.filter(function (o) { return o.lead; })[0];

  /* ---- the transformation sequence -------------------------------------- */
  SPEC.story = function (m) {
    m.layer("boundary", { width: 2.4 })
      .layer("constraintL", {
        data: "constraint", opacity: 0, perClass: [0, 0, 0, 1],
        palette: ["#000", "#000", "#000", m.themeName() === "dark" ? "#5A6470" : "#38424C"]
      })
      .layer("cmdL", { data: "command", index: arrivalIdx, opacity: 0 })
      .layer("routeL", {
        data: "canal", color: m.pal().canal, width: 3, halo: true, reveal: 0,
        select: function (l) { return l.id === "G3"; }
      })
      .layer("fieldsL", { data: "allocation", opacity: 0, only: [1] })
      .layer("orchL", { data: "allocation", opacity: 0, only: [2] })
      .layer("houseL", { data: "allocation", opacity: 0, only: [3, 7] })
      .layer("powerL", { data: "scheme", option: LEAD.option, reveal: 0, flow: true, phase: 0 });

    var acts = [
      function () {
        ["constraintL", "cmdL", "fieldsL", "orchL", "houseL"].forEach(function (k) { m.tween(k, { opacity: 0 }, 350); });
        m.tween("routeL", { reveal: 0 }, 0); m.tween("powerL", { reveal: 0 }, 0);
        m.setLabels([]);
      },
      function () { m.tween("constraintL", { opacity: .40 }, 600); },
      function () {
        m.tween("routeL", { reveal: 1 }, RM ? 0 : 1500);
        m.setLabels([{ at: SC.forebay, text: L_FOREBAY, marker: true, anchor: ["14px", "0px"] }]);
      },
      function () { m.tween("cmdL", { opacity: .44 }, 800); },
      function () { m.tween("cmdL", { opacity: .14 }, 500); m.tween("fieldsL", { opacity: .60 }, 900); },
      function () { m.tween("orchL", { opacity: .74 }, 800); },
      function () {
        m.tween("houseL", { opacity: .74 }, 800);
        m.setLabels([{ at: SC.forebay, text: L_FOREBAY, marker: true, anchor: ["14px", "0px"] }]);
      },
      function () { m.tween("powerL", { reveal: 1 }, RM ? 0 : 1200); },
      function () {
        m.setLabels([
          { at: SC.forebay, text: L_FOREBAY, marker: true, anchor: ["14px", "0px"] },
          { at: LEAD.at, text: L_POWER, marker: true, anchor: ["14px", "0px"], color: m.pal().penstock }
        ]);
        var c = $("#story-close"); if (c) c.hidden = false;
      }
    ];
    sequencer("#story-steps", "#story-play", acts, function (i) {
      var c = $("#story-close"); if (c && i < acts.length - 1) c.hidden = true;
    });
    spin(m, "powerL");
  };

  /* ---- the canal --------------------------------------------------------- */
  SPEC.canal = function (m) {
    m.layer("contours", { data: "contours", opacity: .5, width: .7 })
      .layer("boundary", { width: 2.2 })
      .layer("drawn", {
        data: "canal", color: m.pal().ink, width: 1.6, dash: [6, 5], opacity: 0,
        select: function (l) { return l.id === "AS_DRAWN"; }
      })
      .layer("route", {
        data: "canal", color: m.pal().canal, width: 3, halo: true, reveal: 0,
        select: function (l) { return l.id === "G3"; }
      })
      .layer("cmdOn", { data: "command", index: arrivalIdx, opacity: 0 });
    var IN = { at: SC.intake, text: L_INTAKE, marker: true, anchor: ["14px", "0px"] };
    var acts = [
      function () {
        m.layer("drawn", { opacity: 0 }); m.tween("route", { reveal: 0 }, 0);
        m.tween("cmdOn", { opacity: 0 }, 300); m.setLabels([IN]);
      },
      function () { m.tween("drawn", { opacity: 1 }, 500); m.setLabels([IN]); },
      function () { m.tween("route", { reveal: 1 }, RM ? 0 : 1900); },
      function () {
        m.setLabels([IN, {
          at: SC.forebay, marker: true, anchor: ["14px", "0px"],
          text: function () { return L_FOREBAY() + " · " + SC.forebay_display_m + " m"; }
        }]);
      },
      function () { m.tween("cmdOn", { opacity: .46 }, 700); }
    ];
    sequencer("#canal-steps", "#canal-play", acts);
  };

  /* ---- delivery level ---------------------------------------------------- */
  SPEC.cmd = function (m) {
    m.layer("command", { index: arrivalIdx, opacity: .46 })
      .layer("boundary", { width: 2.2 })
      .layer("canal", {
        data: "canal", color: m.pal().canal, width: 2.6, halo: true,
        select: function (l) { return l.id === "G3"; }
      });
    m.setLabels([
      { at: SC.forebay, text: L_FOREBAY, marker: true, anchor: ["14px", "0px"] },
      { at: SC.intake, text: L_INTAKE, marker: true, anchor: ["14px", "0px"] }
    ]);
    var lvl = $("#lvl");
    lvl.max = steps.length - 1; lvl.value = arrivalIdx;
    var mk = $("#lvl-mark"); if (mk) mk.style.left = (arrivalIdx / (steps.length - 1) * 100) + "%";
    W.level = function () {
      var i = +lvl.value, s = steps[i];
      MAPS.cmd && MAPS.cmd.layer("command", { index: i });
      $("#lvl-ha").textContent = fx(s.ha, 1);
      $("#lvl-lbl").textContent = t("water arriving at " + s.level + " m",
        "پانی " + s.level + " میٹر پر پہنچے");
      $("#lvl-15").textContent = fx(s.lt15, 1) + " ha";
      $("#lvl-10").textContent = fx(s.lt10, 1) + " ha";
      $("#lvl-x").textContent = s.x;
      $("#lvl-pct").textContent = fx(s.pct, 1) + " %";
      $("#lvl-bar").style.width = Math.min(100, s.ha / N.site.area_ha_rasterised * 100) + "%";
      var v = $("#lvl-msg");
      if (i === arrivalIdx) {
        v.className = "verdictline ok";
        v.innerHTML = t(
          "This is where the routed canal actually arrives. <b>" + fx(s.ha, 1) + " ha</b> — " +
          fx(s.pct, 0) + " % of Tabriz — comes within gravity command.",
          "تجویز کردہ نہر یہیں پہنچتی ہے۔ <b>" + fx(s.ha, 1) + " ہیکٹر</b> — تبریز کا " +
          fx(s.pct, 0) + " فیصد — کششِ ثقل کی پہنچ میں آ جاتی ہے۔");
      } else if (s.level < 3030) {
        v.className = "verdictline";
        v.innerHTML = t(
          "Delivering this low means taking irrigation water <b>below the powerhouse</b>. " +
          "Simpler to build, but it leaves " + fx(steps[arrivalIdx].ha - s.ha, 1) +
          " ha of the terrace above the water.",
          "اتنا نیچے پانی دینے کا مطلب ہے آبپاشی کا پانی <b>پاور ہاؤس کے نیچے</b> سے لینا۔ " +
          "بنانا آسان، مگر چبوترے کی " + fx(steps[arrivalIdx].ha - s.ha, 1) +
          " ہیکٹر زمین پانی سے اوپر رہ جاتی ہے۔");
      } else {
        v.className = "verdictline";
        v.innerHTML = t(
          "Arriving at <b>" + s.level + " m</b> reaches " + fx(s.ha, 1) +
          " ha. Above about 3060 m the curve flattens — the terrace runs out before the head does.",
          "<b>" + s.level + " میٹر</b> پر پہنچ کر " + fx(s.ha, 1) +
          " ہیکٹر تک رسائی ہوتی ہے۔ تقریباً ۳۰۶۰ میٹر کے بعد اضافہ رک جاتا ہے — ہیڈ سے پہلے چبوترہ ختم ہو جاتا ہے۔");
      }
    };
    lvl.addEventListener("input", W.level);
    W.level();
  };

  /* ---- flood stage ------------------------------------------------------- */
  SPEC.flood = function (m) {
    var stg = B.layers.flood.steps;
    m.layer("flood", { data: "flood", index: 2, opacity: .50 })
      .layer("boundary", { width: 2.4 });
    var el = $("#stg");
    el.max = stg.length - 1;
    W.stage = function () {
      var i = +el.value, s = stg[i];
      if (MAPS.flood) MAPS.flood.layer("flood", {
        index: i, color: MAPS.flood.pal().flood[Math.min(5, i)]
      });
      $("#stg-ha").textContent = fx(s.ha_in_tabriz, 2);
      $("#stg-lbl").textContent = t("+" + s.stage + " m above the river bed",
        "دریا کی تہہ سے ‎+" + s.stage + " میٹر");
      $("#stg-bar").style.width = Math.max(.6, s.ha_in_tabriz / N.site.area_ha_rasterised * 100) + "%";
      var v = $("#stg-msg");
      if (s.ha_in_tabriz === 0) {
        v.className = "verdictline ok";
        v.innerHTML = t(
          "At this stage <b>none of Tabriz</b> is below the water. The terrace stands " +
          N.river.hand_min_m + " m above the river at its lowest point." +
          (s.stage === 30 ? " This is the stage the earlier study used to cut its land funnel by half." : ""),
          "اس سطح پر <b>تبریز کا کوئی حصہ</b> پانی کے نیچے نہیں آتا۔ چبوترے کا نچلا ترین مقام بھی دریا سے " +
          N.river.hand_min_m + " میٹر بلند ہے۔" +
          (s.stage === 30 ? " پچھلے مطالعے نے اسی سطح پر اپنی زمین آدھی کر دی تھی۔" : ""));
      } else {
        v.className = "verdictline";
        v.innerHTML = t(
          "<b>" + fx(s.ha_in_tabriz, 2) + " ha</b> of Tabriz would be potentially exposed under " +
          "an assumed stage of +" + s.stage + " m — the very lowest edge of the terrace, on the river side.",
          "فرض کی گئی ‎+" + s.stage + " میٹر سطح پر تبریز کی <b>" + fx(s.ha_in_tabriz, 2) +
          " ہیکٹر</b> زمین متاثر ہو سکتی ہے — چبوترے کا سب سے نچلا کنارہ، دریا کی طرف۔");
      }
    };
    el.addEventListener("input", W.stage);
    W.stage();
  };

  /* ---- constraint (static classes) --------------------------------------- */
  SPEC.constraint = function (m) {
    m.layer("constraint", { data: "constraint", opacity: .52 })
      .layer("boundary", { width: 2.4 });
  };

  /* ---- hydropower -------------------------------------------------------- */
  SPEC.power = function (m) {
    var cur = LEAD.option;
    m.layer("boundary", { width: 2.2 })
      .layer("canal", {
        data: "canal", color: m.pal().canal, width: 2.4, halo: true,
        select: function (l) { return l.id === "G3"; }
      })
      .layer("scheme", { data: "scheme", option: cur, flow: true, phase: 0 });
    function labels() {
      var o = SC.options.filter(function (x) { return x.option === cur; })[0];
      m.setLabels([
        { at: SC.forebay, marker: true, anchor: ["14px", "0px"],
          text: function () { return L_FOREBAY() + " · " + SC.forebay_display_m + " m"; } },
        { at: o.at, marker: true, anchor: ["14px", "0px"], color: m.pal().penstock,
          text: function () { return L_POWER() + " · " + o.head + t(" m head", " میٹر ہیڈ"); } }
      ]);
    }
    var chips = $("#phopt");
    chips.innerHTML = SC.options.map(function (o) {
      return '<button class="chip" type="button" data-o="' + o.option + '" aria-pressed="' +
        (o.option === cur) + '">' + o.option + " — " + o.head + " m</button>";
    }).join("");
    chips.addEventListener("click", function (e) {
      var b = e.target.closest("[data-o]"); if (!b) return;
      cur = b.dataset.o;
      [].forEach.call(chips.children, function (c) { c.setAttribute("aria-pressed", String(c.dataset.o === cur)); });
      m.layer("scheme", { option: cur, reveal: 0 });
      m.tween("scheme", { reveal: 1 }, RM ? 0 : 700);
      labels(); W.power();
    });
    var q = $("#q");
    W.power = function () {
      var o = SC.options.filter(function (x) { return x.option === cur; })[0];
      var Q = +q.value, kW = 9.81 * Q / 1000 * o.head * SC.eta;
      $("#qv").textContent = Q + " l/s";
      $("#kw").textContent = kW < 100 ? fx(kW, 1) : Math.round(kW);
      $("#kw-lbl").textContent = t("option " + o.option + " · " + o.head + " m head · " + Q + " l/s",
        "آپشن " + o.option + " · " + o.head + " میٹر ہیڈ · " + Q + " l/s");
      $("#kw-bar").style.width = Math.min(100, kW / 250 * 100) + "%";
      $("#p-head").textContent = o.head + " m";
      $("#p-pen").textContent = o.penstock_m + " m";
      $("#p-hand").textContent = "+" + Math.round(o.hand) + " m";
      var h1 = Math.floor(kW / SC.demand.lighting_appliances_kW),
        h2 = Math.floor(kW / SC.demand.with_electric_heating_kW);
      $("#p-hh1").textContent = h1; $("#p-hh2").textContent = h2;
      var v = $("#kw-msg"), target = N.population.proposed_scenario.households;
      if (Q <= 45) {
        v.className = "verdictline " + (h1 >= target ? "ok" : "");
        v.innerHTML = t(
          "At the assumed <b>winter minimum</b> this carries " + h1 +
          " households for lighting and appliances" +
          (h2 >= target ? ", and " + h2 + " with electric heating." :
            " — but only " + h2 + " with electric heating. Winter is the binding season."),
          "سردیوں کے فرض کردہ <b>کم سے کم بہاؤ</b> پر یہ " + h1 +
          " گھرانوں کی روشنی اور آلات چلا سکتا ہے" +
          (h2 >= target ? "، اور " + h2 + " گھرانوں کی بجلی سے گرمائش بھی۔" :
            " — مگر بجلی سے گرمائش صرف " + h2 + " گھرانوں کی۔ سردیاں ہی اصل رکاوٹ ہیں۔"));
      } else {
        v.className = "verdictline";
        v.innerHTML = t(
          "Summer flow. The turbine is sized for winter, not for this — and the same water is " +
          "wanted on the fields. <b>Discharge has never been measured</b>; every figure here is " +
          "a sensitivity range against an assumed flow.",
          "گرمیوں کا بہاؤ۔ ٹربائن سردیوں کے حساب سے بنے گی، اس کے حساب سے نہیں — اور یہی پانی " +
          "کھیتوں کو بھی چاہیے۔ <b>بہاؤ کبھی ناپا نہیں گیا</b>؛ یہاں ہر عدد ایک فرض کیے گئے بہاؤ " +
          "پر مبنی حساب ہے۔");
      }
    };
    q.addEventListener("input", W.power);
    labels(); W.power(); spin(m, "scheme");
  };

  /* ---- shared helpers ---------------------------------------------------- */
  function repaintWidgets() {
    ["level", "stage", "power", "season"].forEach(function (k) { if (W[k]) W[k](); });
    Object.keys(MAPS).forEach(function (k) {
      var m = MAPS[k];
      // labels carry translated text, so they have to be rebuilt on a language change
      if (m.labels && m.labels.length) m.draw();
    });
    $$("[data-seq]").forEach(function (h) { renderSteps(h); });
  }
  function spin(m, layer) {
    if (RM) return;
    (function loop() {
      var L = m.layers[layer];
      if (L && L.reveal > 0) { L.phase = (L.phase + 0.9) % 34; m.draw(); }
      requestAnimationFrame(loop);
    })();
  }
  function renderSteps(host) {
    var list = JSON.parse(host.getAttribute("data-seq"));
    var cur = host.getAttribute("data-at") || "0";
    host.innerHTML = list.map(function (s, i) {
      return '<button class="step" type="button" data-i="' + i + '" aria-current="' +
        (String(i) === cur) + '"><b>' + ("0" + (i + 1)).slice(-2) + "</b><span>" +
        (ur() ? s[1] : s[0]) + "</span></button>";
    }).join("");
  }
  function sequencer(listSel, playSel, acts, onStep) {
    var host = $(listSel), btn = $(playSel), timer = null, at = 0;
    renderSteps(host);
    function go(i) {
      at = i; host.setAttribute("data-at", String(i));
      [].forEach.call(host.children, function (c, j) { c.setAttribute("aria-current", String(j === i)); });
      if (onStep) onStep(i);
      acts[i]();
    }
    function label(k) {
      btn.querySelector(".ic").textContent = k === "play" ? "▶" : "❚❚";
      var s = btn.querySelector(".txt");
      s.innerHTML = k === "play"
        ? (at >= acts.length - 1
          ? '<span class="en">Play again</span><span class="ur">دوبارہ چلائیے</span>'
          : '<span class="en">Play</span><span class="ur">چلائیے</span>')
        : '<span class="en">Pause</span><span class="ur">روکیے</span>';
    }
    function stop() { clearTimeout(timer); timer = null; label("play"); }
    function tick() {
      if (at >= acts.length - 1) { stop(); return; }
      go(at + 1); timer = setTimeout(tick, 2000);
    }
    btn.addEventListener("click", function () {
      if (timer) { stop(); return; }
      if (at >= acts.length - 1) at = 0;
      go(at); label("pause"); timer = setTimeout(tick, 2000);
    });
    host.addEventListener("click", function (e) {
      var b = e.target.closest("[data-i]"); if (!b) return;
      stop(); go(+b.dataset.i);
    });
    go(0);
  }

  /* ---- seasonal flow (kept from v0.4, numbers unchanged) ------------------ */
  (function season() {
    var sea = $("#sea"); if (!sea) return;
    var EN = ["December", "January", "February", "March", "April", "May", "June", "July",
      "August", "September", "October", "November"];
    var UR = ["دسمبر", "جنوری", "فروری", "مارچ", "اپریل", "مئی", "جون", "جولائی",
      "اگست", "ستمبر", "اکتوبر", "نومبر"];
    var LS = [40, 34, 32, 45, 110, 290, 640, 880, 720, 300, 120, 62];
    W.season = function () {
      var i = +sea.value, v = LS[i];
      $("#flowv").textContent = v;
      $("#flowbar").style.width = Math.max(3, (v / 900) * 100) + "%";
      $("#seaname").textContent = ur() ? UR[i] : EN[i];
      var m, c = "";
      if (v < 60) m = t("<b>Scarce.</b> Irrigation demand is nil, so all of it can go through the turbine.",
        "<b>کمی۔</b> آبپاشی کی طلب صفر ہے، اس لیے سارا پانی ٹربائن سے گزارا جا سکتا ہے۔");
      else if (v < 200) { c = "ok"; m = t("<b>Rising.</b> Enough to irrigate and generate at the same time.",
        "<b>بڑھتا ہوا۔</b> بیک وقت آبپاشی اور بجلی، دونوں ممکن ہیں۔"); }
      else { c = "ok"; m = t("<b>Abundant.</b> Far more than the scheme can use — the surplus passes down the river.",
        "<b>وافر۔</b> منصوبے کی ضرورت سے کہیں زیادہ — اضافی پانی دریا میں چلا جاتا ہے۔"); }
      $("#flowmsg").className = "verdictline " + c;
      $("#flowmsg").innerHTML = m;
    };
    sea.addEventListener("input", W.season);
  })();

  /* ---- canal long profile ------------------------------------------------ */
  (function profile() {
    var P = B.layers.profile, host = $("#profile"); if (!host) return;
    var Wd = 900, H = 250, pad = { l: 52, r: 14, t: 14, b: 34 };
    var lo = Math.min.apply(null, P.g.concat(P.inv)) - 8,
      hi = Math.max.apply(null, P.g.concat(P.inv)) + 8,
      md = P.d[P.d.length - 1];
    var X = function (d) { return pad.l + d / md * (Wd - pad.l - pad.r); },
      Y = function (z) { return H - pad.b - (z - lo) / (hi - lo) * (H - pad.t - pad.b); };
    var band = P.d.map(function (d, i) { return X(d) + "," + Y(P.g[i] + P.uncert_m); })
      .concat(P.d.map(function (d, i) { return X(d) + "," + Y(P.g[i] - P.uncert_m); }).reverse()).join(" ");
    var gl = P.d.map(function (d, i) { return X(d) + "," + Y(P.g[i]); }).join(" ");
    var il = P.d.map(function (d, i) { return X(d) + "," + Y(P.inv[i]); }).join(" ");
    var CC = ["#9BB7A8", "#D9C27E", "#C97E56"], fills = "", ticks = "";
    for (var i = 0; i < P.d.length - 1; i++)
      fills += '<polygon points="' + X(P.d[i]) + "," + Y(P.inv[i]) + " " + X(P.d[i + 1]) + "," +
        Y(P.inv[i + 1]) + " " + X(P.d[i + 1]) + "," + Y(P.g[i + 1]) + " " + X(P.d[i]) + "," +
        Y(P.g[i]) + '" fill="' + CC[P.cls[i]] + '" opacity=".72"/>';
    for (var z = Math.ceil(lo / 5) * 5; z <= hi; z += 5)
      ticks += '<line x1="' + pad.l + '" x2="' + (Wd - pad.r) + '" y1="' + Y(z) + '" y2="' + Y(z) +
        '" stroke="currentColor" opacity=".12"/><text x="' + (pad.l - 8) + '" y="' + (Y(z) + 4) +
        '" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">' + z + "</text>";
    for (var d2 = 0; d2 <= md; d2 += 100)
      ticks += '<text x="' + X(d2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" ' +
        'fill="currentColor" opacity=".6">' + d2 + " m</text>";
    host.innerHTML = '<svg viewBox="0 0 ' + Wd + " " + H + '" style="width:100%;height:auto;' +
      'color:var(--ink);font-family:IBM Plex Mono,monospace;direction:ltr" role="img" ' +
      'aria-label="Canal long profile from the intake to the forebay">' + ticks +
      '<polygon points="' + band + '" fill="currentColor" opacity=".10"/>' + fills +
      '<polyline points="' + gl + '" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<polyline points="' + il + '" fill="none" stroke="var(--blue)" stroke-width="2.6"/></svg>';
  })();

  /* ---- deep-zoom viewer -------------------------------------------------- */
  (function zoomer() {
    var Z = $("#zoomer"); if (!Z) return;
    var stage = $(".stage", Z), img = $("img", stage), lastF = null;
    var st = { s: 1, x: 0, y: 0, fit: 1 }, drag = null, pinch = null;
    function apply() { img.style.transform = "translate(" + st.x + "px," + st.y + "px) scale(" + st.s + ")"; }
    function fit() {
      var r = stage.getBoundingClientRect();
      if (!img.naturalWidth) return;
      st.fit = Math.min(r.width / img.naturalWidth, (r.height - 60) / img.naturalHeight);
      st.s = st.fit;
      st.x = (r.width - img.naturalWidth * st.s) / 2;
      st.y = 60 + (r.height - 60 - img.naturalHeight * st.s) / 2;
      apply();
    }
    function zoom(f, px, py) {
      var r = stage.getBoundingClientRect();
      px = px === undefined ? r.width / 2 : px; py = py === undefined ? r.height / 2 : py;
      var ns = Math.max(st.fit * .9, Math.min(st.fit * 14, st.s * f));
      st.x = px - (px - st.x) * (ns / st.s); st.y = py - (py - st.y) * (ns / st.s);
      st.s = ns; apply();
    }
    function open(src, cap, alt) {
      // The stage image ships as alt="", which tells a screen reader the image is
      // decorative and to skip it — on the one element the viewer exists to show. The
      // caption is a sibling, so it does not name the image either.
      // alt describes the picture; the caption carries provenance. They are not the same
      // string: using the caption alone announced "EPSG:32643 · EGM2008" as the content.
      img.src = src; img.alt = alt || cap || "";
      $("#z-cap").textContent = cap || "";
      Z.classList.add("on"); document.body.style.overflow = "hidden";
      lastF = document.activeElement;
      if (img.complete) fit(); else img.onload = fit;
      Z.querySelector('[data-z="close"]').focus();
    }
    function close() {
      Z.classList.remove("on"); document.body.style.overflow = ""; img.src = ""; img.alt = "";
      if (lastF) try { lastF.focus(); } catch (e) {}
    }
    Z.addEventListener("click", function (e) {
      var b = e.target.closest("[data-z]"); if (!b) return;
      if (b.dataset.z === "close") close();
      else if (b.dataset.z === "fit") fit();
      else zoom(b.dataset.z === "in" ? 1.6 : 1 / 1.6);
    });
    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = stage.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * .0018), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener("pointerdown", function (e) {
      try { stage.setPointerCapture(e.pointerId); } catch (x) {}
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      stage.classList.add("is-grabbing");
    });
    stage.addEventListener("pointermove", function (e) {
      if (!drag || drag.id !== e.pointerId) return;
      st.x += e.clientX - drag.x; st.y += e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; apply();
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      stage.addEventListener(ev, function () { drag = null; stage.classList.remove("is-grabbing"); });
    });
    function td(tt) { return Math.hypot(tt[0].clientX - tt[1].clientX, tt[0].clientY - tt[1].clientY); }
    stage.addEventListener("touchstart", function (e) {
      if (e.touches.length === 2) { drag = null; pinch = { d: td(e.touches), s: st.s }; }
    }, { passive: true });
    stage.addEventListener("touchmove", function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      var r = stage.getBoundingClientRect();
      zoom((pinch.s * td(e.touches) / pinch.d) / st.s,
        (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
        (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top);
    }, { passive: false });
    stage.addEventListener("touchend", function (e) { if (e.touches.length < 2) pinch = null; }, { passive: true });
    stage.addEventListener("dblclick", function (e) {
      var r = stage.getBoundingClientRect();
      zoom(2, e.clientX - r.left, e.clientY - r.top);
    });
    document.addEventListener("keydown", function (e) {
      if (!Z.classList.contains("on")) return;
      if (e.key === "Escape") close();
      else if (e.key === "+" || e.key === "=") zoom(1.5);
      else if (e.key === "-") zoom(1 / 1.5);
      else if (e.key === "0") fit();
    });
    window.addEventListener("resize", function () { if (Z.classList.contains("on")) fit(); });
    $$(".fw").forEach(function (fw) {
      function go() {
        var im = fw.querySelector("img");
        open(im.getAttribute("data-full") || im.src, fw.getAttribute("data-cap") || im.alt,
             im.alt);
      }
      fw.addEventListener("click", go);
      fw.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });
    });
  })();

  /* ---- boot -------------------------------------------------------------- */
  (function boot() {
    try {
      var hh = (location.hash || "").replace("#", ""), hi = -1;
      topTabs.forEach(function (x, k) { if (x.getAttribute("aria-controls") === hh) hi = k; });
      var sl = null, sm = null;
      try { sl = localStorage.getItem("tz-lang"); sm = localStorage.getItem("tz-mode"); } catch (e) {}
      setLang(sl === "ur" ? "ur" : "en", false);
      setMode(sm === "technical" ? "technical" : "general", false);
      mountMaps(document.querySelector(".storysec"));
      select(hi >= 0 ? hi : 0, false);
      if (W.season) W.season();
    } catch (e) {
      if (window.console) console.error("init:", e);
      revealAll();
    }
  })();

  /* ---- animated topographic ground ---------------------------------------
     The v3 build shipped the <canvas id="contours">, the #contours rule in
     base.css, the .page>* stacking, the translucent cards written so "the
     contour field runs through the whole page", and tuned --contour/--grid
     tokens — everything except the code that draws it. The canvas sat at its
     default 300x150 at 0x0 CSS pixels with nothing painted, so the whole
     translucent treatment floated on a flat background.

     Ported from the v0.4 build (log A026/A027), keeping the mobile hardening
     that entry records: clientWidth/clientHeight lead because iOS reports
     innerWidth unreliably while the address bar animates, DPR is capped, the
     field is coarser and the loop slower on small screens, and the animation
     stops entirely when the tab is hidden or the reader prefers less motion. */
  (function contourField() {
    var cv = document.getElementById("contours");
    if (!cv || !cv.getContext) return;
    var cx = cv.getContext("2d"), ph = 0, raf = null, SMALL = false, lastT = 0, VW = 0, VH = 0;

    function vp() {
      VW = root.clientWidth || window.innerWidth || 0;
      VH = root.clientHeight || window.innerHeight || 0;
      SMALL = VW < 820;
      return VW > 0 && VH > 0;
    }
    function size() {
      if (!vp()) return false;
      var dpr = Math.min(window.devicePixelRatio || 1, SMALL ? 1.5 : 2);
      cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr);
      cv.style.width = VW + "px"; cv.style.height = VH + "px";
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }
    // Four octaves. A single sine pair can only make parallel bands, which is
    // what made an earlier attempt read as scan lines rather than terrain.
    function fld(x, y, p) {
      return Math.sin(x * .0031 + p * .9) * Math.cos(y * .0027 - p * .55)
           + 0.66 * Math.sin((x * .85 + y * .62) * .0034 - p * 1.15)
           + 0.44 * Math.cos((x * .55 - y * .9) * .0046 + p * .75)
           + 0.28 * Math.sin((x * 1.3 + y * .4) * .0067 - p * 1.6)
           + 0.17 * Math.cos((x * .3 - y * 1.2) * .0089 + p * 2.1);
    }
    function draw() {
      if (!VW || !VH) return;
      var w = VW, h = VH, S = SMALL ? 22 : 17, STEP = SMALL ? 0.20 : 0.155,
          cols = Math.ceil(w / S) + 1, rows = Math.ceil(h / S) + 1, i, j;
      cx.clearRect(0, 0, w, h);
      var st = getComputedStyle(root);
      var gr = st.getPropertyValue("--grid").trim();
      if (gr) {
        var gs = SMALL ? 86 : 110;
        cx.strokeStyle = gr; cx.lineWidth = 1; cx.beginPath();
        for (var gx = 0; gx < w; gx += gs) { cx.moveTo(gx + .5, 0); cx.lineTo(gx + .5, h); }
        for (var gy = 0; gy < h; gy += gs) { cx.moveTo(0, gy + .5); cx.lineTo(w, gy + .5); }
        cx.stroke();
      }
      cx.strokeStyle = st.getPropertyValue("--contour").trim() || "rgba(255,255,255,.4)";
      cx.lineWidth = SMALL ? 1.25 : 1.1; cx.lineCap = "round"; cx.lineJoin = "round";
      var G = new Float32Array(cols * rows);
      for (j = 0; j < rows; j++) for (i = 0; i < cols; i++) G[j * cols + i] = fld(i * S, j * S, ph);
      function ip(a, b, lv) { var t = (lv - a) / (b - a); return t < 0 ? 0 : t > 1 ? 1 : t; }
      cx.beginPath();
      for (var lv = -2.3; lv <= 2.3; lv += STEP) {
        for (j = 0; j < rows - 1; j++) for (i = 0; i < cols - 1; i++) {
          var x0 = i * S, y0 = j * S,
              a = G[j * cols + i], b = G[j * cols + i + 1],
              c = G[(j + 1) * cols + i + 1], d = G[(j + 1) * cols + i],
              k = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
          if (k === 0 || k === 15) continue;
          var T = [x0 + ip(a, b, lv) * S, y0], R = [x0 + S, y0 + ip(b, c, lv) * S],
              B = [x0 + ip(d, c, lv) * S, y0 + S], L = [x0, y0 + ip(a, d, lv) * S],
              p1 = null, p2 = null;
          switch (k) {
            case 1: case 14: p1 = L; p2 = B; break;
            case 2: case 13: p1 = B; p2 = R; break;
            case 3: case 12: p1 = L; p2 = R; break;
            case 4: case 11: p1 = T; p2 = R; break;
            case 6: case 9:  p1 = T; p2 = B; break;
            case 7: case 8:  p1 = L; p2 = T; break;
            case 5:  p1 = L; p2 = T; cx.moveTo(B[0], B[1]); cx.lineTo(R[0], R[1]); break;
            case 10: p1 = L; p2 = B; cx.moveTo(T[0], T[1]); cx.lineTo(R[0], R[1]); break;
          }
          if (p1) { cx.moveTo(p1[0], p1[1]); cx.lineTo(p2[0], p2[1]); }
        }
      }
      cx.stroke();
    }
    function loop(ts) {
      raf = requestAnimationFrame(loop);
      var minDt = SMALL ? 45 : 16;              /* ~22 fps on phones, ~60 on desktop */
      if (ts && ts - lastT < minDt) return;
      lastT = ts || 0; ph += SMALL ? 0.0022 : 0.00075; draw();
    }
    function start() {
      try {
        if (!size()) { cv.style.display = "none"; return; }
        cv.style.display = "";
        draw();
        if (!RM && !raf) raf = requestAnimationFrame(loop);
      } catch (e) { cv.style.display = "none"; }
    }
    start();
    var rz = null;
    function onResize() {
      clearTimeout(rz);
      rz = setTimeout(function () { if (size()) draw(); }, 120);
    }
    addEventListener("resize", onResize);
    addEventListener("orientationchange", function () { setTimeout(start, 220); });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", onResize);
    addEventListener("load", start);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
      else if (!RM && !raf) { lastT = 0; raf = requestAnimationFrame(loop); }
    });
    // The tokens are theme-dependent; repaint when the theme attribute changes.
    new MutationObserver(function () { draw(); })
      .observe(root, { attributes: true, attributeFilter: ["data-theme", "data-scheme", "class"] });
    window.__tzContourField = { draw: draw, size: size, running: function () { return !!raf; } };
  })();

})();
