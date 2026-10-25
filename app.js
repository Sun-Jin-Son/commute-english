(() => {
  "use strict";

  const GOAL_LINES = 20;
  const GOAL_REVIEWS = 10;
  const INTERVALS = [0, 1, 3, 7, 14, 30];
  // topic ids match tools/topics.json on the PC
  const TOPICS = { tech: "기술·반도체", meeting: "회의·협업", present: "발표·커뮤니케이션", career: "커리어·리더십", habit: "습관·자기계발", daily: "일상·여행", science: "과학·미래", biz: "비즈니스", comedy: "코미디·예능" };
  const DEFAULT_TOPICS = ["tech", "meeting", "present", "career"];
  const LV = { A1: 0.5, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };
  const lvNum = (s) => { const m = String(s || "").toUpperCase().match(/[ABC][12]/g); return m ? m.reduce((a, x) => a + LV[x], 0) / m.length : null; };
  const lvName = (n) => (n < 1.5 ? "A2" : n < 2.5 ? "B1" : n < 3.5 ? "B2" : "C1");

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
  const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = (name) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "i"); s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#i-" + name); s.append(u); return s;
  };
  const load = (k, d) => { try { const v = localStorage.getItem("cep:" + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem("cep:" + k, JSON.stringify(v)); } catch (e) { toast("저장 공간이 부족해요."); } };
  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const TODAY = () => dayKey();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- packs store (IndexedDB for imported packs, which can hold audio) ----------
  const idb = (() => {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("ce-pwa", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("packs", { keyPath: "id" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction("packs", mode); const req = fn(t.objectStore("packs"));
        t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
      });
    };
    return { all: () => tx("readonly", (s) => s.getAll()), put: (p) => tx("readwrite", (s) => s.put(p)), del: (id) => tx("readwrite", (s) => s.delete(id)) };
  })();

  // ---------- state ----------
  const S = {
    p: load("progress", { xp: 0, streak: 0, best: 0, last: null, days: {}, seen: {}, cont: null }),
    cards: load("cards", {}),
    cand: load("candidates", {}),
    wrong: load("wrong", {}),   // wrong-answer notebook: "<packId>~q<k>" -> { packId, k, miss, hit, out }
    speak: load("speak", {}),   // per prompt: { n, good, slow, miss, last, ms (best voice onset) }
    talks: load("talks", []),   // 30-second answers: { id, packId, title, q, qko, text, secs, at, sent }
    set: Object.assign({ rate: 1, pauseEach: true, showKo: false, topics: null, target: 2.5, rated: {} }, load("settings", {})),
    packs: {}
  };
  const saveP = () => save("progress", S.p);
  const saveCards = () => save("cards", S.cards);
  const day = () => (S.p.days[TODAY()] = Object.assign({ xp: 0, lines: 0, reviews: 0, spoken: 0 }, S.p.days[TODAY()] || {}));
  const GOAL_SPOKEN = 10;

  function displayStreak() {
    if (!S.p.last) return 0;
    return daysBetween(S.p.last, TODAY()) <= 1 ? S.p.streak : 0;
  }
  function touchDay() {
    const t = TODAY();
    if (S.p.last === t) return;
    const gap = S.p.last ? daysBetween(S.p.last, t) : 0;
    S.p.streak = gap === 1 ? S.p.streak + 1 : 1;
    S.p.last = t; S.p.best = Math.max(S.p.best || 0, S.p.streak);
  }
  function addXP(n) { touchDay(); S.p.xp += n; day().xp += n; saveP(); renderChrome(); }

  // ---------- pack loading & validation ----------
  function normStudy(s) {
    if (!s || typeof s !== "object") return null;
    const txt = (v) => (typeof v === "string" ? v.trim() : "");
    const parts = (Array.isArray(s.parts) ? s.parts : []).map((p) => ({ t: txt(p && p.t), m: txt(p && p.m), why: txt(p && p.why) })).filter((p) => p.t);
    const more = (Array.isArray(s.more) ? s.more : []).map(txt).filter(Boolean);
    const out = { parts, grammar: txt(s.grammar), more, use: txt(s.use) };
    return parts.length || out.grammar || more.length || out.use ? out : null;
  }
  // Builds the "문장 분석" view: chunk-by-chunk meaning and why, grammar point, related expressions, a work example
  function studyView(st) {
    const box = el("div", "study");
    if (st.parts.length) {
      box.append(el("h3", "", "표현 풀이"));
      const ul = el("ul", "parts");
      st.parts.forEach((p) => {
        const li = el("li");
        li.append(el("b", "chunk", p.t));
        if (p.m) li.append(el("span", "mean", p.m));
        if (p.why) li.append(el("p", "why", p.why));
        ul.append(li);
      });
      box.append(ul);
    }
    if (st.grammar) box.append(el("h3", "", "문법 포인트"), el("p", "", st.grammar));
    if (st.more.length) {
      box.append(el("h3", "", "같이 알면 좋은 표현"));
      const ul = el("ul", "more"); st.more.forEach((m) => ul.append(el("li", "", m))); box.append(ul);
    }
    if (st.use) {
      box.append(el("h3", "", "이렇게 써 보세요"));
      const row = el("div", "use");
      const sp = el("button", "speak-sm"); sp.type = "button"; sp.setAttribute("aria-label", "예문 듣기"); sp.append(icon("sound"));
      const en = st.use.replace(/\s*\(.*\)\s*$/, "");
      sp.onclick = () => tts(en);
      row.append(el("p", "", st.use), sp);
      box.append(row);
    }
    return box;
  }
  // grammar packs add a rule card and choice quizzes on top of their example sentences (the lines)
  function normGrammar(g, n) {
    if (!g || typeof g !== "object") return null;
    const txt = (v) => (typeof v === "string" ? v.trim() : "");
    const exOk = (i) => Number.isInteger(i) && i >= 0 && i < n;
    const points = (Array.isArray(g.points) ? g.points : []).map((p) => ({ h: txt(p && p.h), d: txt(p && p.d), ex: (Array.isArray(p && p.ex) ? p.ex : []).filter(exOk) })).filter((p) => p.h);
    const pairs = (Array.isArray(g.pairs) ? g.pairs : []).map((p) => ({ a: txt(p && p.a), b: txt(p && p.b), d: txt(p && p.d) })).filter((p) => p.a && p.b);
    const quiz = (Array.isArray(g.quiz) ? g.quiz : [])
      .map((q) => ({ q: txt(q && q.q), ko: txt(q && q.ko), opts: (Array.isArray(q && q.opts) ? q.opts : []).map(txt), a: q && q.a, why: txt(q && q.why), ex: exOk(q && q.ex) ? q.ex : -1 }))
      .filter((q) => q.q.includes("___") && q.opts.length >= 2 && Number.isInteger(q.a) && q.a >= 0 && q.a < q.opts.length);
    return points.length || quiz.length ? { ref: txt(g.ref), intro: txt(g.intro), points, pairs, quiz } : null;
  }
  function normPack(o) {
    if (!o || o.type !== "ce-pack") throw new Error("출퇴근 영어 팩 파일이 아니에요.");
    const m = o.media || {};
    if (m.kind === "youtube" && !/^[A-Za-z0-9_-]{6,20}$/.test(m.id || "")) throw new Error("YouTube 영상 정보가 잘못됐어요.");
    if ((m.kind === "audio" || m.kind === "slides") && !m.src && !m.data && !m.blob) throw new Error("팩에 음성 파일이 없어요.");
    if (m.kind === "slides" && !(Array.isArray(m.slides) && m.slides.length) && !(Array.isArray(m.slideBlobs) && m.slideBlobs.length)) throw new Error("발표 팩에 슬라이드가 없어요.");
    if (m.kind !== "youtube" && m.kind !== "audio" && m.kind !== "slides") throw new Error("지원하지 않는 형식의 팩이에요.");
    const lines = (Array.isArray(o.lines) ? o.lines : [])
      .filter((l) => l && typeof l.en === "string" && l.en.trim() && Number.isFinite(+l.t))
      .map((l) => ({ t: +l.t, e: Number.isFinite(+l.e) ? +l.e : +l.t + 4, en: l.en.trim(), ko: (l.ko || "").trim(), note: (l.note || "").trim(), who: l.who || "", study: normStudy(l.study), slide: Number.isInteger(l.slide) ? l.slide : null }))
      .sort((a, b) => a.t - b.t);
    if (!lines.length) throw new Error("팩에 문장이 없어요.");
    // a sentence must end by the time the next one starts, or "문장마다 멈춤" skips past it
    lines.forEach((l, i) => { const n = lines[i + 1]; if (n && l.e > n.t) l.e = n.t; });
    const id = String(o.id || "").replace(/[^A-Za-z0-9_.-]/g, "-") || "pack-" + Date.now();
    const speak = (Array.isArray(o.speak) ? o.speak : [])
      .filter((s) => s && typeof s.ko === "string" && typeof s.en === "string" && s.ko.trim() && s.en.trim())
      .map((s) => ({ ko: s.ko.trim(), en: s.en.trim(), frame: typeof s.frame === "string" ? s.frame.trim() : "", line: Number.isInteger(s.line) ? s.line : -1 }));
    const meta = o.meta && typeof o.meta === "object" ? o.meta : {};
    const topics = (Array.isArray(meta.topics) ? meta.topics : []).map(String).filter((t) => TOPICS[t]);
    const minutes = Number(meta.minutes) || Math.round((lines[lines.length - 1].e - lines[0].t) / 6) / 10;
    return {
      id, title: String(o.title || "제목 없음"), author: String(o.author || ""), level: String(o.level || ""),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
      meta: {
        topics, minutes, url: meta.url || "", shorts: !!meta.shorts,
        series: meta.series && typeof meta.series.title === "string" ? { title: meta.series.title.trim(), order: Number(meta.series.order) || 0 } : null
      },
      media: m, lines, speak, addedAt: o.addedAt || new Date().toISOString(), grammar: normGrammar(o.grammar, lines.length),
      talkQs: (Array.isArray(o.talk) ? o.talk : []).filter((q) => q && typeof q.en === "string" && q.en.trim()).map((q) => ({ en: q.en.trim(), ko: typeof q.ko === "string" ? q.ko.trim() : "" }))
    };
  }
  // The app ships with no content: every pack is imported on the phone and kept in IndexedDB
  async function loadPacks() {
    try {
      (await idb.all()).forEach((p) => {
        try { const n = normPack(Object.assign({ type: "ce-pack" }, p)); S.packs[n.id] = n; } catch (e) { console.warn("stored pack skipped", p.id, e); }
      });
    } catch (e) { console.warn("idb failed", e); }
  }
  async function storePack(o) {
    const p = normPack(o);
    if ((p.media.kind === "audio" || p.media.kind === "slides") && p.media.data) {
      try {
        const media = { kind: p.media.kind, blob: await fetch(p.media.data).then((r) => r.blob()) };
        if (p.media.kind === "slides") media.slideBlobs = await Promise.all(p.media.slides.map((u) => fetch(u).then((r) => r.blob())));
        p.media = media;
      } catch (e) { throw new Error("팩 안의 음성이나 슬라이드 파일이 손상됐어요."); }
    }
    if (S.packs[p.id]) p.addedAt = S.packs[p.id].addedAt;
    try { await idb.put(p); } catch (e) { throw new Error("저장 공간이 부족해서 팩을 저장하지 못했어요."); }
    S.packs[p.id] = p;
    return p;
  }
  async function importPackFile(file) {
    let o, raw = "";
    try { raw = await file.text(); o = JSON.parse(raw); }
    catch (e) {
      // cloud pickers blocked by company policy hand over an empty file or an HTML notice instead of the pack
      const blocked = !raw.trim() || raw.trim().startsWith("<");
      toast(blocked
        ? "파일 내용을 받지 못했어요. 회사 OneDrive 정책 때문일 수 있어요. 파일을 휴대폰 다운로드 폴더에 저장한 뒤 거기서 골라 주세요."
        : "파일을 읽지 못했어요. 팩 파일(.json)이 맞는지 확인해 주세요.");
      return;
    }
    try {
      if (o && o.type === "ce-bundle" && Array.isArray(o.packs)) {
        let ok = 0;
        for (const p of o.packs) { try { await storePack(p); ok++; } catch (e) { console.warn("bundle item", e); } }
        const cands = Array.isArray(o.candidates) ? o.candidates.filter((c) => c && /^[A-Za-z0-9_-]{6,20}$/.test(c.id || "")) : [];
        cands.forEach((c) => { if (!S.cand[c.id]) S.cand[c.id] = { id: c.id, title: String(c.title || ""), channel: String(c.channel || ""), duration: +c.duration || 0, topic: TOPICS[c.topic] ? c.topic : "", shorts: !!c.shorts, addedAt: Date.now() }; });
        save("candidates", S.cand);
        toast(ok || cands.length ? `"${o.title || "추천 묶음"}"에서 팩 ${ok}개${cands.length ? `, 영상 후보 ${cands.length}개` : ""}를 추가했어요` : "묶음 안에 읽을 수 있는 팩이 없어요.");
      } else {
        const existed = o && S.packs[o.id];
        const p = await storePack(o);
        toast(existed ? `"${p.title}" 팩을 새 내용으로 바꿨어요` : `"${p.title}" 팩을 추가했어요`);
      }
    } catch (e) { toast(e.message); }
    renderHome();
  }
  $("#importFile").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importPackFile(f); });
  const mediaUrl = (p) => p.media.src || (p.media.blob ? (p._url || (p._url = URL.createObjectURL(p.media.blob))) : "");
  const slideUrl = (p, k) => {
    const blobs = p.media.slideBlobs || [];
    if (!blobs.length) return "";
    p._slides = p._slides || [];
    const i = Math.max(0, Math.min(blobs.length - 1, k || 0));
    return p._slides[i] || (p._slides[i] = URL.createObjectURL(blobs[i]));
  };
  const isTimedAudio = (p) => p.media.kind === "audio" || p.media.kind === "slides";
  const KIND = { youtube: { label: "영상", icon: "video", cls: "" }, audio: { label: "음성", icon: "audio", cls: " audio" }, slides: { label: "발표", icon: "slides", cls: " slides" }, grammar: { label: "문법", icon: "book", cls: " grammar" } };
  const kindOf = (p) => (p.grammar ? KIND.grammar : KIND[p.media.kind] || KIND.audio);
  const kindIcon = (p) => { const k = kindOf(p), s = el("span", "ic" + k.cls); s.append(icon(k.icon)); return s; };
  const seenOf = (id) => (S.p.seen[id] = S.p.seen[id] || {});
  const pctOf = (p) => Math.round(Object.keys(seenOf(p.id)).length / p.lines.length * 100);
  const marksOf = (p) => p.lines.reduce((n, _, i) => n + (S.cards[`${p.id}~${i}`] ? 1 : 0), 0);
  // 진행 = sentences seen / all, 학습도 = seen sentences that are not bookmarked / all (equals (all - bookmarks) / all once fully watched)
  const statsText = (p) => {
    const pct = pctOf(p);
    if (!pct) return "진행 0% · 학습도 –";
    const seen = seenOf(p.id);
    const known = p.lines.reduce((n, _, i) => n + (seen[i] && !S.cards[`${p.id}~${i}`] ? 1 : 0), 0);
    return `진행 ${pct}% · 학습도 ${Math.round(known / p.lines.length * 100)}% (아는 문장 ${known}/${p.lines.length})`;
  };
  const statsLine = (p) => el("div", "stats", statsText(p));

  // ---------- YouTube API ----------
  let ytApi = null;
  function loadYt() {
    if (ytApi) return ytApi;
    ytApi = new Promise((res, rej) => {
      window.onYouTubeIframeAPIReady = () => res(window.YT);
      const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { ytApi = null; rej(new Error("yt")); }; document.head.append(s);
    });
    return ytApi;
  }
  async function makeYt(hostId, videoId, onState) {
    const YT = await loadYt();
    return new Promise((res) => {
      const pl = new YT.Player(hostId, {
        // fs: 0 hides YouTube's own fullscreen button so fullscreen goes through our stage, which keeps the subtitles visible
        videoId, playerVars: { playsinline: 1, rel: 0, cc_load_policy: 0, iv_load_policy: 3, modestbranding: 1, fs: 0 },
        events: { onReady: () => res(pl), onStateChange: (e) => onState && onState(e.data) }
      });
    });
  }

  // ---------- media abstraction ----------
  const audio = $("#audio");
  const M = {
    kind: null, yt: null, ytVideo: null, ytPlaying: false,
    play() { if (this.kind === "yt") this.yt && this.yt.playVideo(); else audio.play().catch(() => toast("재생하지 못했어요. 다시 눌러 주세요.")); },
    pause() { if (this.kind === "yt") this.yt && this.yt.pauseVideo(); else audio.pause(); },
    seek(t) { if (this.kind === "yt") this.yt && this.yt.seekTo(Math.max(0, t), true); else audio.currentTime = Math.max(0, t); },
    time() { return this.kind === "yt" ? (this.yt && this.yt.getCurrentTime ? this.yt.getCurrentTime() : 0) : audio.currentTime; },
    playing() { return this.kind === "yt" ? this.ytPlaying : !audio.paused; },
    rate(r) { if (this.kind === "yt") this.yt && this.yt.setPlaybackRate(r); else audio.playbackRate = r; }
  };
  audio.addEventListener("play", () => renderPlayBtn());
  audio.addEventListener("pause", () => renderPlayBtn());

  // ---------- player ----------
  const P = { pack: null, idx: -1, pausedFor: -1, timer: 0 };
  // listen: open the player even for a grammar pack (its examples as one audio list)
  async function openPack(id, listen) {
    const p = S.packs[id]; if (!p) return;
    if (p.grammar && !listen) { open("grammar", id); return; }
    P.pack = p; P.idx = -1; P.pausedFor = -1;
    S.p.cont = { id, t: S.p.cont && S.p.cont.id === id ? S.p.cont.t : 0 };
    S.p.opened = Object.assign(S.p.opened || {}, { [id]: Date.now() }); saveP();
    open("player", id);
    $("#topTitle").textContent = p.title;
    renderScript();
    $("#credit").textContent = p.author ? `출처: ${p.author}` : "";
    $("#deletePack").hidden = !!p.builtin;
    checkRating();
    const yt = p.media.kind === "youtube", deck = p.media.kind === "slides";
    $("#ytWrap").hidden = !yt; $("#audioStage").hidden = yt || deck; $("#slideWrap").hidden = !deck;
    $("#ytWrap").classList.toggle("vertical", !!p.meta.shorts);
    if (deck) $("#slideImg").src = slideUrl(p, 0);
    if (yt) {
      M.kind = "yt";
      try {
        if (!M.yt) { M.yt = await makeYt("ytHost", p.media.id, onYtState); M.ytVideo = p.media.id; }
        else if (M.ytVideo !== p.media.id) { M.yt.cueVideoById(p.media.id, S.p.cont.t || 0); M.ytVideo = p.media.id; }
        M.rate(S.set.rate);
        if (S.p.cont.t) M.yt.cueVideoById(p.media.id, S.p.cont.t);
      } catch (e) { toast("YouTube를 불러오지 못했어요. 인터넷 연결을 확인해 주세요."); }
    } else {
      M.kind = "audio";
      $("#audioTitle").textContent = p.title; $("#audioSub").textContent = `${p.lines.length}문장 · 화면을 꺼도 계속 들을 수 있어요`;
      const url = mediaUrl(p);
      if (audio.getAttribute("src") !== url) { audio.src = url; audio.load(); }
      audio.playbackRate = S.set.rate;
      if (S.p.cont.t) audio.currentTime = S.p.cont.t;
      setupMediaSession(p);
    }
    const start = lineAt((S.p.cont && S.p.cont.t) || 0);
    setLine(Math.max(0, start), false);
    renderOpts(); renderPlayBtn();
    clearInterval(P.timer); P.timer = setInterval(tick, 150);
  }
  function onYtState(s) { M.ytPlaying = s === 1; renderPlayBtn(); }
  function lineAt(t) {
    const L = P.pack.lines; let i = -1;
    for (let k = 0; k < L.length; k++) { if (L[k].t <= t + 0.05) i = k; else break; }
    return i;
  }
  function tick() {
    if (!P.pack) return;
    const t = M.time(), L = P.pack.lines, cur = L[P.idx];
    // check the end of the current sentence before switching, since one line's end is often the next line's start
    // caption times are estimates, so wait a moment before pausing or moving on rather than cutting the last word
    if (S.set.pauseEach && cur && M.playing() && t >= cur.e + 0.1 && P.pausedFor !== P.idx) {
      P.pausedFor = P.idx; M.pause(); return;
    }
    if (P.pausedFor === P.idx && !M.playing()) return;
    let i = lineAt(t - 0.15);
    // the delay only holds back moving on during playback; right after jumping to a line (알아요, 이전, tap), stay on it
    if (cur && i < P.idx && t >= cur.t - 0.3) i = P.idx;
    if (i !== P.idx && i >= 0) setLine(i, true);
    if (Math.abs((S.p.cont.t || 0) - t) > 3) { S.p.cont.t = t; saveP(); }
  }
  function markSeen(i) {
    const s = seenOf(P.pack.id);
    if (s[i]) return;
    s[i] = 1; const d = day(); d.lines += 1; addXP(1);
    if (d.lines === GOAL_LINES) toast("오늘 문장 듣기 목표 달성!");
    checkRating();
  }
  function setLine(i, fromPlayback) {
    const L = P.pack.lines; if (i < 0 || i >= L.length) return;
    if (fromPlayback && P.idx >= 0) markSeen(P.idx);
    P.idx = i; if (P.pausedFor !== i) P.pausedFor = -1;
    const l = L[i];
    $("#lineCount").textContent = `${i + 1} / ${L.length}`;
    $("#lineEn").textContent = l.en;
    const who = $("#lineWho"); who.hidden = !l.who; who.textContent = l.who === "me" ? "나" : l.who === "partner" ? "상대" : l.who;
    const ko = $("#lineKo"); ko.classList.toggle("shown", S.set.showKo); ko.firstChild.textContent = S.set.showKo ? (l.ko || "뜻이 없는 문장이에요") : "뜻 보기";
    const n = $("#lineNote"); n.hidden = !(S.set.showKo && l.note); n.textContent = l.note;
    renderStudy();
    if (P.pack.media.kind === "slides" && l.slide != null) {   // the slide follows the sentence being spoken
      const src = slideUrl(P.pack, l.slide);
      if ($("#slideImg").getAttribute("src") !== src) $("#slideImg").src = src;
    }
    const saved = !!S.cards[cardId(P.pack.id, i)];
    $("#cSave").setAttribute("aria-pressed", String(saved)); $("#saveLbl").textContent = saved ? "북마크됨" : "북마크";
    document.querySelectorAll("#script .sline").forEach((li, k) => { li.classList.toggle("cur", k === i); });
    // follow the current line inside the script box only; never move the page itself
    const cur = document.querySelector(`#script .sline[data-i="${i}"]`), box = $("#script");
    if (cur && fromPlayback && box.scrollHeight > box.clientHeight) {
      const top = cur.offsetTop - box.clientHeight / 3;   // .script is position: relative, so offsetTop is already box-relative
      box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    if ("mediaSession" in navigator && M.kind === "audio") navigator.mediaSession.metadata && (navigator.mediaSession.metadata.artist = l.en);
    updateFs();
  }

  // ---------- sentence study panel ----------
  let studyOpen = false;
  function renderStudy() {
    const l = P.pack && P.pack.lines[P.idx];
    const btn = $("#studyBtn"), box = $("#studyBox");
    btn.hidden = !(l && l.study);
    const show = !!(l && l.study && studyOpen);
    btn.setAttribute("aria-expanded", String(show));
    btn.querySelector("span").textContent = show ? "분석 닫기" : "문장 분석";
    box.hidden = !show; box.textContent = "";
    if (show) box.append(studyView(l.study));
  }
  $("#studyBtn").onclick = () => {
    studyOpen = !studyOpen;
    if (studyOpen && M.playing()) M.pause();   // reading needs a pause
    renderStudy();
  };

  // ---------- fullscreen with subtitles ----------
  const stageBox = $("#stageBox");
  let fsOn = false, fsReal = false, fsKoOpen = false;
  function updateFs() {
    if (!fsOn || !P.pack || P.idx < 0) return;
    const l = P.pack.lines[P.idx], saved = !!S.cards[cardId(P.pack.id, P.idx)];
    $("#fsEn").textContent = l.en;
    const ko = $("#fsKo"); ko.textContent = l.ko || "뜻이 없는 문장이에요"; ko.hidden = !(S.set.showKo || fsKoOpen);
    $("#fsLine").classList.toggle("saved", saved);
    $("#fsSave").setAttribute("aria-pressed", String(saved));
  }
  async function enterFs() {
    if (!P.pack) return;
    fsOn = true; fsKoOpen = false;
    stageBox.classList.add("fs"); stageBox.classList.toggle("audio", P.pack.media.kind === "audio");
    $("#fsSub").hidden = false; document.body.style.overflow = "hidden";
    updateFs(); renderPlayBtn();
    try {
      if (stageBox.requestFullscreen) { await stageBox.requestFullscreen({ navigationUI: "hide" }); fsReal = true; }
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock(P.pack.meta.shorts ? "portrait" : "landscape").catch(() => {});
    } catch (e) { fsReal = false; /* the fixed-position stage still works as fullscreen inside the browser */ }
  }
  function exitFs() {
    if (!fsOn) return;
    fsOn = false;
    stageBox.classList.remove("fs", "audio"); $("#fsSub").hidden = true; document.body.style.overflow = "";
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    fsReal = false;
  }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && fsOn && fsReal) exitFs(); });
  $("#fsOpen").onclick = enterFs;
  $("#fsExit").onclick = exitFs;
  $("#fsLine").onclick = () => { fsKoOpen = !fsKoOpen; updateFs(); };
  $("#fsPrev").onclick = () => { fsKoOpen = false; $("#cPrev").click(); };
  $("#fsReplay").onclick = () => $("#cReplay").click();
  $("#fsPlay").onclick = () => { fsKoOpen = false; $("#cPlay").click(); };
  $("#fsNext").onclick = () => { fsKoOpen = false; $("#cNext").click(); };
  $("#fsSave").onclick = () => { $("#cSave").click(); updateFs(); };
  function goLine(i) {
    const L = P.pack.lines; if (i < 0 || i >= L.length) return;
    P.pausedFor = -1; M.seek(L[i].t); setLine(i, false); M.play();
  }
  $("#lineKo").onclick = () => {
    if (!P.pack || P.idx < 0) return;
    const l = P.pack.lines[P.idx], ko = $("#lineKo"), n = $("#lineNote");
    const show = !ko.classList.contains("shown");   // each tap toggles the meaning
    ko.classList.toggle("shown", show);
    ko.firstChild.textContent = show ? (l.ko || "뜻이 없는 문장이에요") : "뜻 보기";
    n.hidden = !(show && l.note); n.textContent = l.note;
  };
  $("#cPlay").onclick = () => {
    if (!P.pack) return;
    if (M.playing()) { M.pause(); return; }
    const cur = P.pack.lines[P.idx];
    if (cur && P.pausedFor === P.idx) { markSeen(P.idx); goLine(P.idx + 1 < P.pack.lines.length ? P.idx + 1 : P.idx); return; }
    // skip intros (music, applause) before the first sentence
    if (M.time() < P.pack.lines[0].t - 1) { goLine(0); return; }
    M.play();
  };
  $("#cReplay").onclick = () => { if (P.pack) goLine(Math.max(0, P.idx)); };
  $("#cPrev").onclick = () => { if (P.pack) goLine(Math.max(0, P.idx - 1)); };
  $("#cNext").onclick = () => { if (!P.pack) return; markSeen(P.idx); goLine(Math.min(P.pack.lines.length - 1, P.idx + 1)); };
  $("#cSave").onclick = () => { if (P.pack && P.idx >= 0) toggleCard(P.pack, P.idx); };
  function renderPlayBtn() {
    const on = M.playing();
    const path = on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $("#cPlayIcon").innerHTML = path; $("#fsPlayIcon").innerHTML = path;
    $("#cPlay").setAttribute("aria-label", on ? "일시정지" : "재생"); $("#fsPlay").setAttribute("aria-label", on ? "일시정지" : "재생");
  }
  function renderOpts() {
    document.querySelectorAll(".seg [data-rate]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.rate === +S.set.rate)));
    $("#tPause").setAttribute("aria-pressed", String(S.set.pauseEach));
    $("#tKo").setAttribute("aria-pressed", String(S.set.showKo));
  }
  document.querySelectorAll(".seg [data-rate]").forEach((b) => { b.onclick = () => { S.set.rate = +b.dataset.rate; save("settings", S.set); M.rate(S.set.rate); renderOpts(); }; });
  $("#tPause").onclick = () => { S.set.pauseEach = !S.set.pauseEach; save("settings", S.set); renderOpts(); toast(S.set.pauseEach ? "문장이 끝날 때마다 멈춰요" : "멈추지 않고 이어서 재생해요"); };
  $("#tKo").onclick = () => { S.set.showKo = !S.set.showKo; save("settings", S.set); renderOpts(); renderScript(); if (P.idx >= 0) setLine(P.idx, false); };

  function renderScript() {
    const ol = $("#script"); ol.textContent = "";
    const seen = seenOf(P.pack.id);
    P.pack.lines.forEach((l, i) => {
      const li = el("li", "sline" + (seen[i] ? " seen" : "") + (i === P.idx ? " cur" : "")); li.dataset.i = i;
      const go = el("button", "go"); go.type = "button";
      go.append(el("div", "en", l.en)); if (S.set.showKo && l.ko) go.append(el("div", "ko", l.ko));
      if (l.study) go.append(el("span", "has-study", "분석 있음"));
      go.onclick = () => goLine(i);
      const st = el("button", "star"); st.type = "button"; st.setAttribute("aria-label", "카드에 추가: " + l.en);
      st.setAttribute("aria-pressed", String(!!S.cards[cardId(P.pack.id, i)])); st.append(icon("star"));
      st.onclick = () => toggleCard(P.pack, i);
      li.append(go, st); ol.append(li);
    });
    $("#savedCount").textContent = statsText(P.pack);
  }

  function setupMediaSession(p) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: p.title, artist: p.author || "출퇴근 영어", artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
      navigator.mediaSession.setActionHandler("play", () => M.play());
      navigator.mediaSession.setActionHandler("pause", () => M.pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => goLine(Math.max(0, P.idx - 1)));
      navigator.mediaSession.setActionHandler("nexttrack", () => goLine(Math.min(P.pack.lines.length - 1, P.idx + 1)));
    } catch (e) { /* optional */ }
  }

  // ---------- cards ----------
  const cardId = (packId, i) => `${packId}~${i}`;
  function toggleCard(p, i) {
    const id = cardId(p.id, i);
    if (S.cards[id]) { delete S.cards[id]; toast("북마크를 해제했어요"); }
    else {
      const l = p.lines[i];
      S.cards[id] = { id, packId: p.id, i, en: l.en, ko: l.ko, note: l.note, t: l.t, e: l.e, box: 0, due: TODAY(), added: TODAY() };
      addXP(2); toast("북마크했어요. 북마크 탭에서 복습할 수 있어요");
    }
    saveCards();
    if (P.pack === p) { renderScript(); if (P.idx === i) setLine(i, false); }
    renderChrome();
  }

  // ---------- grammar lesson: rule card -> choice quiz -> recall (type the English for a Korean meaning) ----------
  // a wrong quiz answer goes to the wrong-answer notebook (오답노트); with 자동 북마크 on, its example sentence is bookmarked too
  const GR = { p: null, step: "rule", ri: 0, typed: "", res: null, known: 0 };
  const grBody = $("#grBody");
  const autoMark = () => S.set.autoMark !== false;
  function openGrammar(id) {
    const p = S.packs[id]; if (!p || !p.grammar) return;
    if (GR.p !== p) { GR.p = p; GR.step = "rule"; QZ.mode = null; resetRecall(); }
    $("#topTitle").textContent = p.title;
    renderGrammar();
  }
  function seenLine(p, i) {
    const s = seenOf(p.id);
    if (i < 0 || s[i]) return;
    s[i] = 1; day().lines += 1; addXP(1);
  }
  const isMarked = (p, i) => !!S.cards[cardId(p.id, i)];
  function markLine(p, i) { if (i >= 0 && !isMarked(p, i)) toggleCard(p, i); }
  function playLine(p, i) { const l = p.lines[i]; if (l) playSegment(p, l.t, l.e, "grYtHost", "grYtWrap"); }
  function speaker(p, i) {
    const b = el("button", "speak-sm"); b.type = "button"; b.setAttribute("aria-label", "예문 듣기"); b.append(icon("sound"));
    b.onclick = () => playLine(p, i); return b;
  }
  function exampleRow(p, i) {
    const l = p.lines[i], row = el("div", "gr-ex"), txt = el("div");
    txt.append(el("div", "en", l.en), el("div", "ko", l.ko));
    row.append(speaker(p, i), txt);
    return row;
  }
  // bookmark or unbookmark an example by hand, whatever the automatic setting did
  function markBtn(p, i, rerender) {
    const on = isMarked(p, i);
    const b = el("button", "toggle mark"); b.type = "button"; b.setAttribute("aria-pressed", String(on));
    b.append(icon("star"), el("span", "", on ? "북마크됨" : "북마크"));
    b.onclick = () => { toggleCard(p, i); rerender(); };
    return b;
  }
  function autoMarkToggle(rerender) {
    const b = el("button", "toggle small auto-mark", autoMark() ? "틀리면 자동 북마크 켬" : "틀리면 자동 북마크 끔"); b.type = "button";
    b.setAttribute("aria-pressed", String(autoMark()));
    b.onclick = () => { S.set.autoMark = !autoMark(); save("settings", S.set); rerender(); };
    return b;
  }
  const grBest = () => ((S.p.gram || {})[GR.p.id] || {}).best;
  function renderGrammar() {
    const p = GR.p, g = p.grammar;
    $("#grRef").textContent = g.ref || "문법";
    $("#grTitle").textContent = p.title;
    renderGrammarStats();
    document.querySelectorAll("#grSteps button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.step === GR.step)));
    grBody.textContent = "";
    stopClip();
    if (GR.step === "rule") renderRule();
    else if (GR.step === "quiz") { if (QZ.mode !== "unit" && QZ.mode !== "unit-missed") startUnitQuiz(); renderQuizInto(grBody, renderGrammar); }
    else renderRecall();
  }
  function renderGrammarStats() {
    const best = grBest();
    $("#grStats").textContent = statsText(GR.p) + (best != null ? ` · 퀴즈 최고 ${best}/${GR.p.grammar.quiz.length}` : "");
  }
  document.querySelectorAll("#grSteps button").forEach((b) => { b.onclick = () => { GR.step = b.dataset.step; renderGrammar(); window.scrollTo(0, 0); }; });
  $("#grListen").onclick = () => { if (GR.p) openPack(GR.p.id, true); };

  function renderRule() {
    const p = GR.p, g = p.grammar;
    if (g.intro) grBody.append(el("p", "gr-intro", g.intro));
    g.points.forEach((pt, k) => {
      const box = el("div", "panel gr-point");
      box.append(el("h3", "", `${k + 1}. ${pt.h}`));
      if (pt.d) box.append(el("p", "", pt.d));
      pt.ex.forEach((i) => box.append(exampleRow(p, i)));
      grBody.append(box);
    });
    if (g.pairs.length) {
      const box = el("div", "panel gr-pairs");
      box.append(el("h3", "", "헷갈리는 짝"));
      g.pairs.forEach((pr) => {
        const li = el("div", "gr-pair");
        const head = el("div", "ab"); head.append(el("b", "", pr.a), el("span", "vs", "vs"), el("b", "", pr.b));
        li.append(head); if (pr.d) li.append(el("p", "", pr.d));
        box.append(li);
      });
      grBody.append(box);
    }
    if (g.quiz.length) {
      const start = el("button", "btn primary wide", "퀴즈 풀기"); start.type = "button";
      start.onclick = () => { GR.step = "quiz"; startUnitQuiz(); renderGrammar(); window.scrollTo(0, 0); };
      grBody.append(start);
    }
  }

  // ---------- wrong-answer notebook ----------
  // one entry per quiz: kept until the learner takes it out, even after answering it right again
  const wrongKey = (packId, k) => `${packId}~q${k}`;
  const saveWrong = () => save("wrong", S.wrong);
  const wrongItems = (out) => Object.values(S.wrong)
    .filter((w) => !!w.out === !!out && quizOf(w))
    .sort((a, b) => (a.packId === b.packId ? a.k - b.k : a.packId < b.packId ? -1 : 1));
  function noteWrong(p, k) {
    const id = wrongKey(p.id, k);
    const w = S.wrong[id] || (S.wrong[id] = { id, packId: p.id, k, added: TODAY(), miss: 0, hit: 0 });
    w.miss += 1; w.out = false; w.last = TODAY(); saveWrong();
  }
  function setWrongOut(packId, k, out) {
    const id = wrongKey(packId, k);
    if (!S.wrong[id]) S.wrong[id] = { id, packId, k, added: TODAY(), miss: 0, hit: 0 };
    S.wrong[id].out = out; saveWrong();
    toast(out ? "오답노트에서 뺐어요" : "오답노트에 담았어요");
  }
  const inWrong = (packId, k) => { const w = S.wrong[wrongKey(packId, k)]; return !!(w && !w.out); };
  function wrongBtn(packId, k, rerender) {
    const on = inWrong(packId, k);
    const b = el("button", "toggle", on ? "오답노트에서 빼기" : "오답노트에 담기"); b.type = "button";
    b.onclick = () => { setWrongOut(packId, k, on); rerender(); };
    return b;
  }

  // ---------- choice quiz (one grammar unit, or the wrong-answer notebook across units) ----------
  // items: [{ packId, k }]; ans[i] is the option picked for item i, so earlier questions can be revisited
  // perm[i] is the order item i's options are shown in (the right answer moves around; "—" stays last)
  const QZ = { mode: null, items: [], qi: 0, ans: [], perm: [] };
  const quizOf = (it) => { const p = S.packs[it.packId]; const q = p && p.grammar && p.grammar.quiz[it.k]; return q ? { p, q } : null; };
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function startQuiz(mode, items) {
    // mixed order, so the answer can't be guessed from the rule just above it
    QZ.mode = mode; QZ.items = shuffle(items.filter(quizOf)); QZ.qi = 0; QZ.ans = [];
    QZ.perm = QZ.items.map((it) => {
      const opts = quizOf(it).q.opts, idx = opts.map((_, k) => k);
      const none = idx.filter((k) => opts[k] === "—");
      return shuffle(idx.filter((k) => opts[k] !== "—")).concat(none);
    });
  }
  function startUnitQuiz() { startQuiz("unit", GR.p.grammar.quiz.map((_, k) => ({ packId: GR.p.id, k }))); }
  const isRight = (i) => { const x = quizOf(QZ.items[i]); return x && QZ.ans[i] === x.q.a; };
  function renderQuizInto(box, rerender) {
    const n = QZ.items.length;
    if (QZ.qi >= n) { renderQuizEnd(box, rerender); return; }
    const it = QZ.items[QZ.qi], { p, q } = quizOf(it), picked = QZ.ans[QZ.qi], done = picked != null;
    const card = el("div", "panel gr-quiz");
    const head = el("div", "gr-qhead");
    head.append(el("span", "gr-count", `${QZ.qi + 1} / ${n}`), autoMarkToggle(rerender));
    card.append(head);
    if (QZ.mode === "wrong") card.append(el("p", "gr-src", p.title));
    if (q.ko) card.append(el("p", "gr-hint", q.ko));
    // "___" alone means the options are whole sentences: pick the right one
    const whole = q.q === "___";
    const sent = el("p", "gr-q" + (whole ? " whole" : ""));
    const [before, after] = q.q.split("___");
    const blank = el("span", "blank" + (done ? " right" : ""), done ? q.opts[q.a] : "    ");
    sent.append(before, blank, after || "");
    if (!whole || done) card.append(sent);   // a whole-sentence question shows its sentence only once answered
    const opts = el("div", "gr-opts" + (whole || q.opts.some((o) => o.length > 14) ? " long" : ""));
    QZ.perm[QZ.qi].forEach((k) => {
      const o = q.opts[k], b = el("button", "btn", o === "—" ? "— (없음)" : o); b.type = "button";
      if (done) { b.disabled = true; if (k === q.a) b.classList.add("right"); else if (k === picked) b.classList.add("wrong"); }
      b.onclick = () => pickQuiz(k, rerender);
      opts.append(b);
    });
    card.append(opts);
    if (done) {
      const ok = picked === q.a, fb = el("div", "gr-fb" + (ok ? " ok" : " no"));
      fb.append(el("b", "", ok ? "맞았어요" : "틀렸어요"));
      if (q.why) fb.append(el("p", "", q.why));
      if (q.ex >= 0) fb.append(exampleRow(p, q.ex));
      const tools = el("div", "gr-tools");
      if (q.ex >= 0) tools.append(markBtn(p, q.ex, rerender));
      tools.append(wrongBtn(p.id, it.k, rerender));
      fb.append(tools);
      card.append(fb);
    }
    const nav = el("div", "row gr-nav");
    if (QZ.qi > 0) {
      const prev = el("button", "btn", "이전 문제"); prev.type = "button";
      prev.onclick = () => { QZ.qi -= 1; rerender(); };
      nav.append(prev);
    }
    if (done) {
      const next = el("button", "btn primary", QZ.qi + 1 < n ? "다음 문제" : "결과 보기"); next.type = "button";
      next.onclick = () => { QZ.qi += 1; rerender(); };
      nav.append(next);
    }
    if (nav.childNodes.length) card.append(nav);
    box.append(card);
  }
  function pickQuiz(k, rerender) {
    if (QZ.ans[QZ.qi] != null) return;
    const it = QZ.items[QZ.qi], { p, q } = quizOf(it);
    QZ.ans[QZ.qi] = k;
    if (k === q.a) {
      addXP(1);
      const w = S.wrong[wrongKey(p.id, it.k)]; if (w) { w.hit += 1; saveWrong(); }
    } else {
      noteWrong(p, it.k);
      if (autoMark()) markLine(p, q.ex);
    }
    seenLine(p, q.ex);
    rerender();
    if (q.ex >= 0) playLine(p, q.ex);
  }
  function renderQuizEnd(box, rerender) {
    const n = QZ.items.length, right = QZ.items.reduce((s, _, i) => s + (isRight(i) ? 1 : 0), 0);
    const missed = QZ.items.filter((_, i) => !isRight(i));
    if (QZ.mode === "unit") {
      S.p.gram = S.p.gram || {};
      const rec = S.p.gram[GR.p.id] || {};
      S.p.gram[GR.p.id] = { best: Math.max(rec.best || 0, right), last: right, at: TODAY() }; saveP();
      renderGrammarStats();
    }
    const end = el("div", "panel gr-end");
    end.append(el("b", "gr-score", `${right} / ${n}`), el("p", "muted small",
      right === n ? "모두 맞았어요!" : `틀린 ${n - right}문제는 오답노트에 담겼어요.`));
    if (missed.length) {
      const again = el("button", "btn primary wide", "틀린 문제만 다시"); again.type = "button";
      again.onclick = () => { startQuiz(QZ.mode === "wrong" ? "wrong" : "unit-missed", missed); rerender(); };
      end.append(again);
    }
    const back = el("button", "btn wide", "이전 문제로 돌아가 보기"); back.type = "button";
    back.onclick = () => { QZ.qi = n - 1; rerender(); };
    end.append(back);
    if (QZ.mode === "wrong") {
      const nb = el("button", "btn wide", "오답노트 보기"); nb.type = "button";
      nb.onclick = () => go("wrong");
      end.append(nb);
    } else {
      const rc = el("button", "btn wide" + (missed.length ? "" : " primary"), "떠올리기로 넘어가기"); rc.type = "button";
      rc.onclick = () => { GR.step = "recall"; resetRecall(); renderGrammar(); };
      const re = el("button", "link", "처음부터 다시 풀기"); re.type = "button";
      re.onclick = () => { startUnitQuiz(); rerender(); };
      end.append(rc, re);
    }
    box.append(end);
  }

  // ---------- recall: see the Korean, type the English ----------
  function resetRecall() { GR.ri = 0; GR.typed = ""; GR.res = null; GR.known = 0; }
  // spelling-insensitive comparison: case, punctuation and contractions don't count as mistakes
  const EXPAND = [[/\bcan't\b/g, "can not"], [/\bcannot\b/g, "can not"], [/\bwon't\b/g, "will not"], [/n't\b/g, " not"], [/'m\b/g, " am"], [/'re\b/g, " are"],
    [/'ll\b/g, " will"], [/'ve\b/g, " have"], [/'d\b/g, " would"], [/\b(it|that|there|what|he|she|who|where|here|how)'s\b/g, "$1 is"]];
  function words(s) {
    s = s.toLowerCase().replace(/[’‘`]/g, "'").replace(/\ba\.m\./g, "am").replace(/\bp\.m\./g, "pm");
    EXPAND.forEach(([r, v]) => { s = s.replace(r, v); });
    return s.replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
  }
  // words of b missing from a, and words of a that b doesn't have (longest common subsequence)
  function wordDiff(a, b) {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const extra = [], missing = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) extra.push(a[i++]); else missing.push(b[j++]);
    }
    return { extra: extra.concat(a.slice(i)), missing: missing.concat(b.slice(j)) };
  }
  function renderRecall() {
    const p = GR.p, L = p.lines, n = L.length;
    if (GR.ri >= n) {
      const box = el("div", "panel gr-end");
      box.append(el("b", "gr-score", `${GR.known} / ${n}`), el("p", "muted small", GR.known === n ? "전부 맞게 썼어요!" : "틀린 문장은 북마크에서 간격을 두고 다시 볼 수 있어요."));
      const again = el("button", "btn primary wide", "처음부터 다시"); again.type = "button";
      again.onclick = () => { resetRecall(); renderGrammar(); };
      const rv = el("button", "btn wide", "북마크 보기"); rv.type = "button";
      rv.onclick = () => go("saved");
      box.append(again, rv);
      grBody.append(box);
      return;
    }
    const i = GR.ri, l = L[i], card = el("div", "panel gr-recall");
    const head = el("div", "gr-qhead");
    head.append(el("span", "gr-count", `${i + 1} / ${n}`), autoMarkToggle(renderGrammar));
    card.append(head, el("p", "muted small", "뜻을 보고 영어로 써 보세요"), el("p", "gr-ko", l.ko));
    const next = (known) => {
      if (known) GR.known += 1; else if (autoMark()) markLine(p, i);
      seenLine(p, i); GR.ri += 1; GR.typed = ""; GR.res = null; renderGrammar();
      const inp = $("#grInput"); if (inp) inp.focus();
    };
    if (!GR.res) {
      const inp = el("textarea", "gr-input"); inp.id = "grInput"; inp.rows = 2; inp.value = GR.typed;
      inp.placeholder = "영어 문장 입력"; inp.setAttribute("aria-label", "영어 문장 입력");
      inp.setAttribute("autocapitalize", "sentences"); inp.setAttribute("autocomplete", "off"); inp.spellcheck = false;
      const check = () => {
        GR.typed = inp.value.trim();
        if (!GR.typed) { toast("영어 문장을 써 주세요. 모르면 '모르겠어요'를 눌러요"); return; }
        const d = wordDiff(words(GR.typed), words(l.en));
        GR.res = !d.extra.length && !d.missing.length ? "ok" : "diff";
        if (GR.res === "ok") GR.known += 1;
        renderGrammar(); playLine(p, i);
      };
      inp.oninput = () => { GR.typed = inp.value; };
      inp.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); check(); } };
      const row = el("div", "row gr-grade");
      const skip = el("button", "btn", "모르겠어요"); skip.type = "button";
      skip.onclick = () => { GR.res = "skip"; if (autoMark()) markLine(p, i); renderGrammar(); playLine(p, i); };
      const ok = el("button", "btn primary", "확인"); ok.type = "button"; ok.onclick = check;
      row.append(skip, ok);
      card.append(inp, row);
    } else {
      const fb = el("div", "gr-fb" + (GR.res === "ok" ? " ok" : " no"));
      fb.append(el("b", "", GR.res === "ok" ? "맞았어요" : GR.res === "skip" ? "정답" : "조금 달라요"));
      if (GR.res === "diff") {
        const mine = el("p", "gr-mine"); mine.append(el("span", "lbl", "내 답 "), GR.typed); fb.append(mine);
        const d = wordDiff(words(GR.typed), words(l.en));
        if (d.missing.length) fb.append(el("p", "gr-diff", "빠지거나 다른 단어: " + d.missing.join(", ")));
        if (d.extra.length) fb.append(el("p", "gr-diff extra", "정답에 없는 단어: " + d.extra.join(", ")));
      }
      const ans = el("div", "gr-ans"); ans.append(speaker(p, i), el("b", "", l.en));
      fb.append(ans);
      if (l.note) fb.append(el("p", "muted small", l.note));
      const tools = el("div", "gr-tools"); tools.append(markBtn(p, i, renderGrammar)); fb.append(tools);
      card.append(fb);
      const row = el("div", "row gr-grade");
      if (GR.res === "diff") {
        // a different wording can still be right, so the learner decides
        const no = el("button", "btn", "틀렸어요"); no.type = "button"; no.onclick = () => next(false);
        const yes = el("button", "btn good", "맞은 걸로 할게요"); yes.type = "button"; yes.onclick = () => next(true);
        row.append(no, yes);
      } else {
        const nx = el("button", "btn primary", "다음"); nx.type = "button";
        // "모르겠어요" was already counted (and bookmarked) when it was pressed
        nx.onclick = () => { seenLine(p, i); GR.ri += 1; GR.typed = ""; GR.res = null; renderGrammar(); };
        row.append(nx);
      }
      card.append(row);
    }
    grBody.append(card);
  }

  // ---------- wrong-answer notebook tab and its quiz ----------
  function renderWrong() {
    const items = wrongItems(false), outs = wrongItems(true);
    $("#wrCount").textContent = items.length ? `틀린 퀴즈 ${items.length}개` : "오답노트가 비어 있어요";
    $("#wrStart").disabled = !items.length;
    const list = $("#wrList"); list.textContent = "";
    if (!items.length) list.append(el("p", "muted small", "문법 팩 퀴즈에서 틀린 문제가 여기 모여요. 다시 맞혀도 직접 빼기 전까지는 남아 있어요."));
    const group = (arr, box) => {
      let cur = null;
      arr.forEach((w) => {
        const { p, q } = quizOf(w);
        if (cur !== p.id) { cur = p.id; box.append(el("h3", "wr-pack", p.title)); }
        box.append(wrongCard(w, p, q));
      });
    };
    group(items, list);
    $("#wrOutBox").hidden = !outs.length;
    $("#wrOutCount").textContent = `뺀 문제 ${outs.length}개`;
    const ol = $("#wrOutList"); ol.textContent = "";
    group(outs, ol);
  }
  function wrongCard(w, p, q) {
    const box = el("div", "panel wr-item" + (w.out ? " out" : ""));
    if (q.ko) box.append(el("p", "gr-hint", q.ko));
    const sent = el("p", "gr-q small");
    const [before, after] = q.q.split("___");
    sent.append(before, el("span", "blank right", q.opts[q.a]), after || "");
    box.append(sent);
    if (q.why) box.append(el("p", "muted small", q.why));
    box.append(el("p", "wr-stat", `틀린 횟수 ${w.miss} · 다시 맞힌 횟수 ${w.hit}`));
    const tools = el("div", "gr-tools");
    if (q.ex >= 0) tools.append(speaker(p, q.ex), markBtn(p, q.ex, renderWrong));
    tools.append(wrongBtn(p.id, w.k, renderWrong));
    if (w.out) {
      // gone for good, with its counts; it comes back only if the quiz is missed again
      const del = el("button", "toggle", "완전히 지우기"); del.type = "button";
      del.onclick = () => {
        if (!del.dataset.confirm) { del.dataset.confirm = "1"; del.textContent = "한 번 더 누르면 지워져요"; setTimeout(() => { delete del.dataset.confirm; del.textContent = "완전히 지우기"; }, 3000); return; }
        delete S.wrong[w.id]; saveWrong(); toast("뺀 문제를 지웠어요"); renderWrong();
      };
      tools.append(del);
    }
    box.append(tools);
    return box;
  }
  $("#wrOutClear").onclick = () => {
    const b = $("#wrOutClear"), outs = wrongItems(true);
    if (!outs.length) return;
    if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = `한 번 더 누르면 ${outs.length}개가 모두 지워져요`; setTimeout(() => { delete b.dataset.confirm; b.textContent = "뺀 문제 모두 지우기"; }, 3000); return; }
    delete b.dataset.confirm; b.textContent = "뺀 문제 모두 지우기";
    outs.forEach((w) => delete S.wrong[w.id]); saveWrong();
    toast(`뺀 문제 ${outs.length}개를 지웠어요`); renderWrong();
  };
  const wqBody = $("#wqBody");
  function renderWQ() { wqBody.textContent = ""; stopClip(); renderQuizInto(wqBody, renderWQ); }
  function startWrongQuiz() { startQuiz("wrong", wrongItems(false).map((w) => ({ packId: w.packId, k: w.k }))); renderWQ(); }
  $("#wrStart").onclick = () => open("wquiz");
  $("#wrongQuiz").onclick = () => open("wquiz");

  // ---------- review ----------
  const RV = { queue: [], i: 0 };

  // ---------- clip playback (one sentence of the original audio/video) ----------
  const clipAudio = $("#clipAudio");
  const clipYt = {};   // host element id -> { pl, video }
  let clipTimer = 0, clipRun = 0;
  function watchSegment(t, e, now, stop) {
    clearInterval(clipTimer);
    const started = Date.now();
    clipTimer = setInterval(() => {
      const x = now();
      // ignore the old position for a moment while the seek lands
      if (Date.now() - started > 400 && x >= e && x >= t - 0.5) { stop(); clearInterval(clipTimer); }
    }, 100);
  }
  async function playSegment(p, t, e, hostId, wrapId) {
    stopClip();
    const run = ++clipRun;
    if (!p) return false;
    if (p.media.kind === "youtube") {
      $("#" + wrapId).hidden = false;
      $("#" + wrapId).classList.toggle("vertical", !!p.meta.shorts);
      try {
        let c = clipYt[hostId];
        if (!c) {
          c = clipYt[hostId] = { video: p.media.id };
          c.pl = await makeYt(hostId, p.media.id, null);
          if (run !== clipRun) return true;
          c.pl.seekTo(t, true); c.pl.playVideo();
        } else if (c.video !== p.media.id) { c.pl.loadVideoById(p.media.id, t); c.video = p.media.id; }
        else { c.pl.seekTo(t, true); c.pl.playVideo(); }
        watchSegment(t, e, () => c.pl.getCurrentTime(), () => c.pl.pauseVideo());
      } catch (err) { toast("YouTube를 불러오지 못했어요. 인터넷 연결을 확인해 주세요."); }
      return true;
    }
    const url = mediaUrl(p);
    if (clipAudio.getAttribute("src") !== url) clipAudio.src = url;
    const go = () => {
      if (run !== clipRun) return;
      clipAudio.currentTime = t; clipAudio.playbackRate = S.set.rate;
      clipAudio.play().catch(() => toast("재생하지 못했어요. 다시 눌러 주세요."));
      watchSegment(t, e, () => clipAudio.currentTime, () => clipAudio.pause());
    };
    if (clipAudio.readyState >= 1) go(); else clipAudio.addEventListener("loadedmetadata", go, { once: true });
    return true;
  }
  function stopClip() {
    clearInterval(clipTimer);
    try { clipAudio.pause(); } catch (e) {}
    Object.values(clipYt).forEach((c) => { try { c.pl && c.pl.pauseVideo(); } catch (e) {} });
  }
  function startReview() {
    const t = TODAY();
    RV.queue = Object.values(S.cards).filter((c) => c.due <= t).sort((a, b) => (a.due === b.due ? a.box - b.box : a.due < b.due ? -1 : 1)).slice(0, GOAL_REVIEWS);
    RV.i = 0; renderReview();
  }
  function renderReview() {
    stopClip();
    const c = RV.queue[RV.i];
    $("#rvCard").hidden = !c; $("#rvDone").hidden = !!c;
    if (!c) {
      const total = Object.keys(S.cards).length, left = Object.values(S.cards).filter((x) => x.due <= TODAY()).length;
      const next = Object.values(S.cards).map((x) => x.due).filter((x) => x > TODAY()).sort()[0];
      $("#rvDoneTitle").textContent = total ? (left ? "잠깐 쉬어가요" : "오늘 복습 끝") : "아직 카드가 없어요";
      $("#rvDoneText").textContent = total
        ? (left ? `오늘 볼 카드가 ${left}장 더 있어요.` : `다음 복습은 ${next ? next.slice(5).replace("-", "월 ") + "일" : "카드를 더 모은 뒤"}이에요.`)
        : "영상이나 음성을 보다가 모르는 문장의 별을 누르면 여기로 모여요.";
      $("#rvMore").hidden = !left;
      return;
    }
    const p = S.packs[c.packId];
    $("#rvSource").textContent = p ? p.title : "삭제된 팩";
    $("#rvCount").textContent = `${RV.i + 1} / ${RV.queue.length}`;
    $("#rvEn").textContent = c.en; $("#rvKo").textContent = c.ko || "";
    const n = $("#rvNote"); n.hidden = !c.note; n.textContent = c.note || "";
    $("#rvBack").hidden = true; $("#rvGrades").hidden = true; $("#rvReveal").hidden = false;
    $("#rvHint").textContent = p ? "들어 보고 무슨 뜻인지 떠올려 보세요" : "원래 음성이 없어요. 기계 음성으로 들어 보세요";
    $("#rvListen").hidden = !p;
    $("#rvYtWrap").hidden = !(p && p.media.kind === "youtube");
  }
  function playClip() {
    const c = RV.queue[RV.i]; if (!c) return;
    const p = S.packs[c.packId];
    if (!p) { tts(c.en); return; }
    playSegment(p, c.t, c.e, "rvYtHost", "rvYtWrap");
  }
  function tts(text) {
    if (!("speechSynthesis" in window)) { toast("이 브라우저는 기계 음성을 지원하지 않아요."); return; }
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = S.set.rate; speechSynthesis.speak(u);
  }
  $("#rvListen").onclick = playClip;
  $("#rvTts").onclick = () => { const c = RV.queue[RV.i]; if (c) tts(c.en); };
  $("#rvReveal").onclick = () => { $("#rvBack").hidden = false; $("#rvGrades").hidden = false; $("#rvReveal").hidden = true; };
  $("#rvGrades").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const c = RV.queue[RV.i]; if (!c) return;
    const g = b.dataset.g, t = TODAY();
    if (g === "again") { c.box = 1; c.due = addDays(t, 1); }
    else if (g === "hard") { c.box = Math.max(1, c.box); c.due = addDays(t, INTERVALS[c.box]); }
    else { c.box = Math.min(5, c.box + 1); c.due = addDays(t, INTERVALS[c.box]); }
    c.last = g; saveCards();
    const d = day(); d.reviews += 1; addXP(3);
    if (d.reviews === GOAL_REVIEWS) toast("오늘 복습 목표 달성!");
    RV.i += 1; renderReview();
    if (RV.queue[RV.i]) setTimeout(playClip, 250);
  });
  $("#rvMore").onclick = () => { startReview(); setTimeout(playClip, 250); };

  // ---------- speaking: 5-second answers (A) and work-situation drills (B) ----------
  const SK_LEN = 10, SK_SECONDS = 5;
  let skPack = "all";
  const SK = { mode: "A", items: [], i: 0, shownAt: 0, onsetMs: null, timer: 0, revealed: false };

  // A: sentences from packs the learner has watched (bookmarked first); B: the pack's work-situation drills
  function speakItems(mode) {
    const packs = Object.values(S.packs).filter((p) => skPack === "all" || p.id === skPack);
    const out = [];
    packs.forEach((p) => {
      if (mode === "A") {
        const seen = seenOf(p.id);
        p.lines.forEach((l, i) => {
          const marked = !!S.cards[cardId(p.id, i)];
          if (!l.ko || (!seen[i] && !marked)) return;
          out.push({ key: `${p.id}~${i}`, pack: p, ko: l.ko, en: l.en, t: l.t, e: l.e, hint: l.note, marked });
        });
      } else {
        p.speak.forEach((s, k) => out.push({ key: `${p.id}#${k}`, pack: p, ko: s.ko, en: s.en, hint: s.frame, line: s.line, marked: false }));
      }
    });
    // never practised, then missed, then slow, then the rest; bookmarked sentences go first within each group
    const rank = (it) => { const r = S.speak[it.key]; if (!r) return 0; if (r.last === "miss") return 1; if (r.last === "slow") return 2; return 3; };
    return out.sort((a, b) => rank(a) - rank(b) || (b.marked - a.marked) || ((S.speak[a.key] || {}).at || 0) - ((S.speak[b.key] || {}).at || 0));
  }
  function renderSpeak() {
    const f = $("#skFilters"); f.textContent = "";
    const usable = Object.values(S.packs).filter((p) => p.speak.length || Object.keys(seenOf(p.id)).length);
    if (skPack !== "all" && !S.packs[skPack]) skPack = "all";
    [{ id: "all", title: "전체" }].concat(usable).forEach((p) => {
      const b = el("button", "", p.title); b.type = "button"; b.setAttribute("aria-pressed", String(skPack === p.id));
      b.onclick = () => { skPack = p.id; renderSpeak(); }; f.append(b);
    });
    const a = speakItems("A").length, b = speakItems("B").length;
    $("#modeACnt").textContent = a; $("#modeBCnt").textContent = b;
    $("#modeA").disabled = !a; $("#modeB").disabled = !b;
    if (!a) $("#modeAText").textContent = "영상을 보거나 문장을 북마크하면 그 문장으로 연습할 수 있어요.";
    else $("#modeAText").textContent = "본 영상의 문장을 한국어로 보고 영어로 바로 말하기. 정답은 원래 목소리로 들려줘요.";
    if (!b) $("#modeBText").textContent = "말하기 문제가 들어 있는 팩을 가져오면 열려요. 앞으로 만드는 팩에는 모두 들어가요.";
    else $("#modeBText").textContent = "영상의 핵심 표현을 내 업무 상황에 넣어 말하기. 같은 틀을 여러 번 써서 입에 붙여요.";
    $("#tSilent").setAttribute("aria-pressed", String(!!S.set.silent));
    const dvn = Math.min(DV_LEN, a + b);
    $("#modeCCnt").textContent = dvn; $("#modeC").disabled = !dvn;
    const dq = talkQuestions().length;
    $("#modeDCnt").textContent = S.talks.length; $("#modeD").disabled = !dq;
    if (!dq) $("#modeDText").textContent = "영상을 하나 보고 나면 그 내용에 대한 질문으로 30초 동안 말해 볼 수 있어요.";
    const logs = Object.values(S.speak), today = (S.p.days[TODAY()] || {}).spoken || 0;
    const tried = logs.reduce((n, r) => n + r.n, 0), good = logs.reduce((n, r) => n + r.good, 0);
    const fast = logs.map((r) => r.ms).filter((x) => x != null);
    const avg = fast.length ? (fast.reduce((s, x) => s + x, 0) / fast.length / 1000).toFixed(1) + "초" : "–";
    const facts = $("#skFacts"); facts.textContent = "";
    [["오늘 말한 문장", `${today}개`], ["지금까지", `${tried}번`], ["바로 나온 비율", tried ? `${Math.round(good / tried * 100)}%` : "–"], ["말 시작까지 평균", avg]].forEach(([k, v]) => {
      const r = el("div"); r.append(el("span", "muted", k), el("b", "", v)); facts.append(r);
    });
  }
  $("#modeA").onclick = () => open("speakrun", "A");
  $("#modeB").onclick = () => open("speakrun", "B");
  $("#tSilent").onclick = () => { S.set.silent = !S.set.silent; save("settings", S.set); renderSpeak(); toast(S.set.silent ? "속으로 말하기: 녹음 없이 정답을 확인해요" : "소리 내어 말하기: 녹음하고 비교해요"); };

  // microphone: record each answer and detect when the voice starts (reaction time)
  const Rec = { stream: null, mr: null, chunks: [], url: null, ctx: null, raf: 0, onsetAt: null };
  async function micReady() {
    if (Rec.stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return false;
    try { Rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); return true; }
    catch (e) { return false; }
  }
  function recStart() {
    Rec.chunks = []; Rec.onsetAt = null;
    Rec.mr = new MediaRecorder(Rec.stream);
    Rec.mr.ondataavailable = (e) => { if (e.data.size) Rec.chunks.push(e.data); };
    Rec.mr.start();
    try {
      Rec.ctx = Rec.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const an = Rec.ctx.createAnalyser(); an.fftSize = 1024;
      Rec.ctx.createMediaStreamSource(Rec.stream).connect(an);
      const buf = new Float32Array(an.fftSize), bar = $("#skLevel");
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let k = 0; k < buf.length; k++) s += buf[k] * buf[k];
        const rms = Math.sqrt(s / buf.length);
        bar.style.width = Math.min(100, rms * 900) + "%";
        if (rms > 0.035 && Rec.onsetAt == null) Rec.onsetAt = performance.now();
        Rec.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { /* level meter is optional */ }
  }
  function recStop() {
    cancelAnimationFrame(Rec.raf);
    return new Promise((res) => {
      if (!Rec.mr || Rec.mr.state === "inactive") return res(null);
      Rec.mr.onstop = () => {
        if (Rec.url) URL.revokeObjectURL(Rec.url);
        Rec.url = Rec.chunks.length ? URL.createObjectURL(new Blob(Rec.chunks, { type: Rec.mr.mimeType })) : null;
        res(Rec.url);
      };
      Rec.mr.stop();
    });
  }
  function micOff() {
    cancelAnimationFrame(Rec.raf);
    try { if (Rec.mr && Rec.mr.state !== "inactive") Rec.mr.stop(); } catch (e) {}
    if (Rec.stream) Rec.stream.getTracks().forEach((t) => t.stop());
    Rec.stream = null;
  }

  function startSpeak(mode) {
    SK.mode = mode; SK.items = speakItems(mode).slice(0, SK_LEN); SK.i = 0;
    $("#topTitle").textContent = mode === "A" ? "5초 즉답" : "내 상황으로 말하기";
    showPrompt();
  }
  async function showPrompt() {
    stopClip(); clearTimeout(SK.timer);
    const it = SK.items[SK.i];
    $("#skDone").hidden = !!it; document.querySelector(".sk-card").hidden = !it;
    if (!it) { finishSpeak(); return; }
    SK.revealed = false; SK.onsetMs = null;
    $("#skSource").textContent = it.pack.title;
    $("#skCount").textContent = `${SK.i + 1} / ${SK.items.length}`;
    $("#skKind").textContent = SK.mode === "A" ? (it.marked ? "북마크한 문장 · 영어로 말해 보세요" : "영어로 말해 보세요") : "이 상황을 영어로 말해 보세요";
    $("#skKo").textContent = it.ko;
    $("#skHint").hidden = true; $("#skHint").textContent = it.hint ? `힌트: ${it.hint}` : "";
    $("#skHintBtn").hidden = !it.hint;
    $("#skAnswer").hidden = true; $("#skYtWrap").hidden = true;
    const tw = $("#skTimerWrap"); tw.classList.remove("run", "over"); void tw.offsetWidth; tw.classList.add("run");
    SK.timer = setTimeout(() => { tw.classList.add("over"); }, SK_SECONDS * 1000);
    SK.shownAt = performance.now();
    const silent = !!S.set.silent || !(await micReady());
    if (!S.set.silent && silent && SK.i === 0) toast("마이크를 쓸 수 없어 속으로 말하기로 진행해요");
    SK.silent = silent;
    $("#skRec").hidden = silent; $("#skReveal").hidden = !silent;
    $("#skMine").hidden = silent;
    if (!silent) { $("#skMic").classList.remove("idle"); $("#skRecText").textContent = "듣고 있어요. 다 말하면 마이크를 누르세요."; recStart(); }
  }
  async function reveal() {
    if (SK.revealed) return; SK.revealed = true;
    clearTimeout(SK.timer); $("#skTimerWrap").classList.remove("run");
    const it = SK.items[SK.i];
    if (!SK.silent) {
      await recStop();
      SK.onsetMs = Rec.onsetAt != null ? Math.max(0, Rec.onsetAt - SK.shownAt) : null;
      $("#skMic").classList.add("idle"); $("#skRecText").textContent = "녹음했어요.";
    }
    $("#skRec").hidden = true; $("#skReveal").hidden = true;
    $("#skOnset").innerHTML = "";
    if (SK.onsetMs != null) { $("#skOnset").append("말 시작까지 "); $("#skOnset").append(el("b", "", `${(SK.onsetMs / 1000).toFixed(1)}초`)); }
    else if (!SK.silent) $("#skOnset").textContent = "목소리가 잘 안 들렸어요. 다음엔 조금 더 크게 말해 보세요.";
    $("#skEn").textContent = it.en;
    $("#skModelLbl").textContent = SK.mode === "A" ? "원어민 음성" : "모범 답 듣기";
    $("#skAnswer").hidden = false;
    playModel();
  }
  function playModel() {
    const it = SK.items[SK.i]; if (!it) return;
    if (SK.mode === "A" && it.t != null) playSegment(it.pack, it.t, it.e, "skYtHost", "skYtWrap");
    else tts(it.en);
  }
  $("#skMic").onclick = reveal;
  $("#skReveal").onclick = reveal;
  $("#skHintBtn").onclick = () => { $("#skHint").hidden = false; $("#skHintBtn").hidden = true; };
  $("#skModel").onclick = playModel;
  $("#skMine").onclick = () => { if (!Rec.url) return; stopClip(); const a = $("#skAudio"); a.src = Rec.url; a.play().catch(() => {}); };
  document.querySelectorAll("[data-sg]").forEach((b) => {
    b.onclick = () => {
      const it = SK.items[SK.i]; if (!it || !SK.revealed) return;
      const g = b.dataset.sg;
      const r = S.speak[it.key] = Object.assign({ n: 0, good: 0, slow: 0, miss: 0, ms: null }, S.speak[it.key] || {});
      r.n += 1; r[g] += 1; r.last = g; r.at = Date.now();
      if (g === "good" && SK.onsetMs != null) r.ms = r.ms == null ? Math.round(SK.onsetMs) : Math.min(r.ms, Math.round(SK.onsetMs));
      save("speak", S.speak);
      const d = day(); d.spoken += 1; addXP(g === "good" ? 3 : 2, "", true);
      if (d.spoken === GOAL_SPOKEN) toast("오늘 말하기 목표 달성!");
      SK.i += 1; showPrompt();
    };
  });
  function finishSpeak() {
    micOff();
    const keys = SK.items.map((it) => it.key);
    const good = keys.filter((k) => S.speak[k] && S.speak[k].last === "good").length;
    $("#skDoneTitle").textContent = SK.items.length ? `${SK.items.length}문장 끝` : "연습할 문장이 없어요";
    $("#skDoneText").textContent = SK.items.length
      ? `바로 나온 문장 ${good}개. 못 한 문장은 다음 연습에 먼저 나와요.`
      : "영상을 보거나 말하기 문제가 있는 팩을 가져온 뒤 다시 와 주세요.";
    $("#skAgain").hidden = !SK.items.length;
  }
  $("#skAgain").onclick = () => startSpeak(SK.mode);

  // ---------- C: driving mode (hands-free: Korean prompt -> beep -> think -> English answer) ----------
  const DV_LEN = 15;
  const DV = { items: [], i: 0, run: 0, playing: false };
  S.set.dv = Object.assign({ src: "mix", gap: "6", reps: "1" }, S.set.dv || {});
  let dvWake = null;
  function driveItems() {
    const a = S.set.dv.src !== "B" ? speakItems("A") : [];
    const b = S.set.dv.src !== "A" ? speakItems("B") : [];
    const out = [];
    while (out.length < DV_LEN && (a.length || b.length)) {   // alternate the two kinds when mixing
      if (a.length) out.push(a.shift());
      if (b.length && out.length < DV_LEN) out.push(b.shift());
    }
    return out;
  }
  function speakP(text, lang, rate) {
    return new Promise((res) => {
      if (!("speechSynthesis" in window)) return res(false);
      const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = rate || 1;
      const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
      if (v) u.voice = v;
      let done = false; const end = (ok) => { if (!done) { done = true; res(ok); } };
      u.onend = () => end(true); u.onerror = () => end(false);
      setTimeout(() => end(false), Math.max(4000, text.length * 160 / (rate || 1)));   // some webviews never fire onend
      speechSynthesis.speak(u);
    });
  }
  function beep() {
    try {
      Rec.ctx = Rec.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = Rec.ctx.createOscillator(), g = Rec.ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(Rec.ctx.destination);
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, Rec.ctx.currentTime + 0.25); o.stop(Rec.ctx.currentTime + 0.26);
    } catch (e) { /* the pause still works without the cue */ }
  }
  function renderDrive(phase) {
    const it = DV.items[DV.i];
    $("#dvCount").textContent = `${Math.min(DV.i + 1, DV.items.length)} / ${DV.items.length}`;
    const segs = $("#dvSegs"); segs.textContent = "";
    DV.items.forEach((_, k) => segs.append(el("i", k === DV.i ? "cur" : k < DV.i ? "done" : "")));
    $("#dvSrc").textContent = it ? it.pack.title : "";
    $("#dvKo").textContent = it ? it.ko : (DV.items.length ? "끝까지 들었어요. 수고했어요!" : "연습할 문장이 없어요. 영상을 보거나 말하기 문제가 있는 팩을 가져와 주세요.");
    $("#dvEn").textContent = it && (phase === "en") ? it.en : "";
    $("#dvPhase").textContent = { ko: "한국어 듣는 중", think: "영어로 말해 보세요", en: "정답", idle: DV.playing ? "" : "재생을 누르면 시작해요" }[phase || "idle"] || "";
    $("#dvPlayIcon").innerHTML = DV.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $("#dvPlay").setAttribute("aria-label", DV.playing ? "일시정지" : "재생");
    document.querySelectorAll("[data-dv]").forEach((g) => g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === S.set.dv[g.dataset.dv]))));
  }
  function openDrive() {
    driveStop(); DV.items = driveItems(); DV.i = 0;
    $("#dvYtWrap").hidden = true;
    renderDrive("idle");
  }
  async function playAnswer(it, id) {
    if (SK_MODE_LINE(it) && isTimedAudio(it.pack)) {
      playSegment(it.pack, it.t, it.e, "dvYtHost", "dvYtWrap");
      await wait(((it.e - it.t) * 1000) / (S.set.rate || 1) + 400);
    } else if (SK_MODE_LINE(it) && document.visibilityState === "visible") {
      playSegment(it.pack, it.t, it.e, "dvYtHost", "dvYtWrap");   // YouTube needs the player on screen
      await wait(((it.e - it.t) * 1000) / (S.set.rate || 1) + 900);
    } else {
      await speakP(it.en, "en-US", S.set.rate || 1);
    }
    return id === DV.run;
  }
  const SK_MODE_LINE = (it) => it.t != null;   // sentences from the video have timings; work-situation drills don't
  async function drivePlay() {
    if (!DV.items.length) return;
    if (DV.i >= DV.items.length) DV.i = 0;
    const id = ++DV.run; DV.playing = true; driveWake(true); setDriveSession();
    while (DV.i < DV.items.length) {
      const it = DV.items[DV.i];
      if (!SK_MODE_LINE(it) || it.pack.media.kind !== "youtube") $("#dvYtWrap").hidden = true;
      renderDrive("ko");
      await speakP(it.ko, "ko-KR", 1);
      if (id !== DV.run) return;
      beep(); renderDrive("think");
      await wait(Number(S.set.dv.gap) * 1000);
      if (id !== DV.run) return;
      renderDrive("en");
      for (let r = 0; r < Number(S.set.dv.reps); r++) {
        if (!(await playAnswer(it, id))) return;
        await wait(600);
        if (id !== DV.run) return;
      }
      const d = day(); d.spoken += 1; addXP(2, "", true);
      if (d.spoken === GOAL_SPOKEN) toast("오늘 말하기 목표 달성!");
      DV.i += 1;
      await wait(700);
      if (id !== DV.run) return;
    }
    DV.playing = false; driveWake(false); renderDrive("idle");
  }
  function driveStop() {
    DV.run++; DV.playing = false;
    try { speechSynthesis.cancel(); } catch (e) {}
    stopClip(); driveWake(false);
  }
  async function driveWake(on) {
    try {
      if (on && !dvWake && navigator.wakeLock) { dvWake = await navigator.wakeLock.request("screen"); dvWake.addEventListener("release", () => { dvWake = null; }); }
      if (!on && dvWake) { await dvWake.release(); dvWake = null; }
    } catch (e) { dvWake = null; }
  }
  // steering-wheel / Bluetooth buttons
  function setDriveSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "운전 모드", artist: "출퇴근 영어", artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
      navigator.mediaSession.setActionHandler("play", () => { if (!DV.playing) drivePlay(); });
      navigator.mediaSession.setActionHandler("pause", () => { driveStop(); renderDrive("idle"); });
      navigator.mediaSession.setActionHandler("nexttrack", () => driveJump(1));
      navigator.mediaSession.setActionHandler("previoustrack", () => driveJump(-1));
    } catch (e) { /* optional */ }
  }
  function driveJump(delta) {
    const was = DV.playing; driveStop();
    DV.i = Math.max(0, Math.min(DV.items.length - 1, DV.i + delta));
    renderDrive("idle");
    if (was) drivePlay();
  }
  $("#dvPlay").onclick = () => { if (DV.playing) { driveStop(); renderDrive("idle"); } else drivePlay(); };
  $("#dvPrev").onclick = () => driveJump(-1);
  $("#dvNext").onclick = () => driveJump(1);
  document.querySelectorAll("[data-dv]").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.set.dv[g.dataset.dv] = b.dataset.v; save("settings", S.set);
    if (g.dataset.dv === "src") openDrive(); else renderDrive(DV.playing ? undefined : "idle");
  }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && DV.playing) driveWake(true); });
  $("#modeC").onclick = () => open("drive");

  // ---------- D: 30-second talk ----------
  const TALK_GENERIC = [
    { en: "Summarize this video in your own words.", ko: "이 영상 내용을 내 말로 요약해 보세요." },
    { en: "What was the most useful expression for you, and when would you use it at work?", ko: "가장 쓸모 있던 표현은 무엇이고, 회사에서 언제 쓸 수 있을까요?" },
    { en: "Do you agree with the speaker? Why or why not?", ko: "말한 사람의 생각에 동의하나요? 이유는요?" },
    { en: "Tell me about a time at work that is related to this topic.", ko: "이 주제와 관련된 회사 경험을 이야기해 보세요." }
  ];
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TK = { qs: [], qi: 0, running: false, startAt: 0, tick: 0, stt: null, sttBroken: false, secs: 0, usedRec: false };
  function talkQuestions() {
    return Object.values(S.packs).filter((p) => pctOf(p) > 0)
      .flatMap((p) => (p.talkQs.length ? p.talkQs : TALK_GENERIC).map((q) => ({ en: q.en, ko: q.ko, pack: p })));
  }
  function renderTalk(newQ) {
    TK.qs = talkQuestions();
    if (!TK.qs.length) { $("#tkQ").textContent = "먼저 영상을 하나 보고 오세요."; $("#tkQko").textContent = ""; $("#tkStart").disabled = true; renderTalkList(); return; }
    $("#tkStart").disabled = false;
    if (newQ || TK.qi >= TK.qs.length) {
      const asked = new Set(S.talks.slice(-12).map((t) => t.q + t.packId));
      const fresh = TK.qs.map((q, k) => k).filter((k) => !asked.has(TK.qs[k].en + TK.qs[k].pack.id));
      const pool = fresh.length ? fresh : TK.qs.map((q, k) => k);
      TK.qi = pool[Math.floor(Math.random() * pool.length)];
    }
    const q = TK.qs[TK.qi];
    $("#tkSource").textContent = q.pack.title;
    $("#tkQ").textContent = q.en; $("#tkQko").textContent = q.ko;
    $("#tkText").value = ""; $("#tkMine").hidden = true; $("#tkSec").textContent = "0초"; $("#tkSec").classList.remove("over");
    $("#tkTimerWrap").classList.remove("run30", "over");
    $("#tkHow").textContent = SR && !TK.sttBroken
      ? "말하기 시작을 누르고 30초 정도 영어로 말해 보세요. 말한 내용을 자동으로 받아 적어요."
      : "말하기 시작을 누르면 녹음돼요. 내가 한 말은 아래 칸을 누르고 키보드의 마이크 버튼으로 받아 적어 주세요.";
    setTalkBtn(false);
    renderTalkList();
  }
  function setTalkBtn(on) {
    $("#tkStart").querySelector("span").textContent = on ? "그만 말하기" : "말하기 시작";
    $("#tkStart").classList.toggle("primary", !on);
  }
  async function talkStart() {
    if (TK.running) { talkStop(); return; }
    TK.running = true; TK.secs = 0; TK.usedRec = false; setTalkBtn(true);
    const tw = $("#tkTimerWrap"); tw.classList.remove("run30", "over"); void tw.offsetWidth; tw.classList.add("run30");
    TK.startAt = Date.now();
    TK.tick = setInterval(() => {
      TK.secs = Math.round((Date.now() - TK.startAt) / 1000);
      $("#tkSec").textContent = `${TK.secs}초`; $("#tkSec").classList.toggle("over", TK.secs >= 30);
      if (TK.secs >= 90) talkStop();
    }, 250);
    if (SR && !TK.sttBroken) {
      const r = new SR(); r.lang = "en-US"; r.continuous = true; r.interimResults = true;
      let finalTxt = $("#tkText").value.trim() ? $("#tkText").value.trim() + " " : "";
      r.onresult = (e) => {
        let interim = "";
        for (let k = e.resultIndex; k < e.results.length; k++) {
          const t = e.results[k][0].transcript;
          if (e.results[k].isFinal) finalTxt += t.trim() + " "; else interim += t;
        }
        $("#tkText").value = (finalTxt + interim).trim();
      };
      r.onerror = (e) => {
        if (["not-allowed", "service-not-allowed", "network", "audio-capture"].includes(e.error)) {
          TK.sttBroken = true; toast("자동 받아쓰기를 쓸 수 없어요. 키보드 마이크로 받아 적어 주세요");
          $("#tkHow").textContent = "아래 칸을 누르고 키보드의 마이크 버튼으로 말해 주세요.";
        }
      };
      r.onend = () => { if (TK.running && !TK.sttBroken) { try { r.start(); } catch (err) {} } };
      try { r.start(); TK.stt = r; } catch (e) { TK.sttBroken = true; }
    }
    if (!TK.stt && await micReady()) { recStart(); TK.usedRec = true; }
  }
  async function talkStop() {
    if (!TK.running) return;
    TK.running = false; clearInterval(TK.tick); setTalkBtn(false);
    $("#tkTimerWrap").classList.remove("run30");
    if (TK.stt) { try { TK.stt.stop(); } catch (e) {} TK.stt = null; }
    if (TK.usedRec) { await recStop(); micOff(); $("#tkMine").hidden = !Rec.url; }
    $("#tkText").focus();
  }
  $("#tkStart").onclick = talkStart;
  $("#tkOther").onclick = () => { if (TK.running) talkStop(); renderTalk(true); };
  $("#tkMine").onclick = () => { if (Rec.url) { const a = $("#tkAudio"); a.src = Rec.url; a.play().catch(() => {}); } };
  $("#tkSave").onclick = () => {
    if (TK.running) talkStop();
    const text = $("#tkText").value.trim();
    if (!text) { toast("내가 한 말을 적어 주세요. 키보드 마이크로 받아 적어도 돼요"); $("#tkText").focus(); return; }
    const q = TK.qs[TK.qi];
    S.talks.push({ id: "t" + Date.now(), packId: q.pack.id, title: q.pack.title, q: q.en, qko: q.ko, text, secs: TK.secs, at: Date.now() });
    if (S.talks.length > 200) S.talks = S.talks.slice(-200);
    save("talks", S.talks);
    const d = day(); d.spoken += 3; addXP(6, "", true);
    toast("저장했어요. 북마크 탭의 Claude에게 묻기에서 피드백을 받아요");
    renderTalk(true);
  };
  function renderTalkList() {
    const box = $("#tkList"); box.textContent = "";
    const recent = S.talks.slice(-5).reverse();
    box.hidden = !recent.length;
    if (!recent.length) return;
    box.append(el("b", "", "최근 30초 말하기"));
    recent.forEach((t) => {
      const it = el("div", "talk-item");
      it.append(el("b", "", t.q), el("span", "", t.text.length > 120 ? t.text.slice(0, 120) + "…" : t.text));
      box.append(it);
    });
  }

  // ---------- ask Claude: notes + 30-second talks as one prompt ----------
  const akSel = { notes: new Set(), talks: new Set() };
  const akNotesList = () => Object.values(S.cards).filter((c) => c.memo).sort((a, b) => (b.memoAt || 0) - (a.memoAt || 0));
  const akTalksList = () => S.talks.slice().reverse();
  let aboutTimer = 0;
  $("#akAbout").addEventListener("input", () => {
    clearTimeout(aboutTimer);
    aboutTimer = setTimeout(() => { S.set.about = $("#akAbout").value.trim(); save("settings", S.set); updatePreview(); }, 300);
  });
  function initAsk() {
    $("#akAbout").value = S.set.about || "";
    akSel.notes = new Set(akNotesList().map((c) => c.id));
    akSel.talks = new Set(akTalksList().map((t) => t.id));
    renderAsk();
  }
  function renderAsk() {
    const fill = (box, items, set, row) => {
      box.textContent = "";
      if (!items.length) { box.append(el("p", "muted small", box.id === "akNotes" ? "아직 노트를 단 북마크가 없어요. 북마크 문장을 열고 노트·질문을 눌러 보세요." : "아직 저장한 30초 말하기가 없어요. 말하기 탭에서 해 보세요.")); return; }
      items.forEach((it) => {
        const lab = el("label", "ak-item");
        const cb = el("input"); cb.type = "checkbox"; cb.checked = set.has(it.id);
        cb.onchange = () => { if (cb.checked) set.add(it.id); else set.delete(it.id); updatePreview(); };
        const txt = el("span"); row(txt, it);
        lab.append(cb, txt); box.append(lab);
      });
    };
    fill($("#akNotes"), akNotesList(), akSel.notes, (t, c) => {
      t.append(el("div", "en", c.en), el("div", "sub", c.ko || ""), el("div", "memo", "노트: " + c.memo));
    });
    fill($("#akTalks"), akTalksList(), akSel.talks, (t, x) => {
      t.append(el("div", "en", x.q), el("div", "sub", x.text.length > 100 ? x.text.slice(0, 100) + "…" : x.text));
    });
    updatePreview();
  }
  function askText() {
    const notes = akNotesList().filter((c) => akSel.notes.has(c.id));
    const talks = akTalksList().filter((t) => akSel.talks.has(t.id));
    if (!notes.length && !talks.length) return "";
    // the learner's own introduction lives only in this phone's settings, never in the code
    const about = (S.set.about || "").trim() || "나는 영어 말하기를 연습하는 한국인 학습자야.";
    const L = ["[출퇴근 영어 · 질문과 피드백 요청]", about + " 한국어로 답해 줘.", ""];
    if (notes.length) {
      L.push("■ 북마크한 문장에 대한 내 질문과 메모 (각각 답해 줘. 메모만 있으면 그 표현에서 알아두면 좋은 점을 설명해 줘)");
      notes.forEach((c, k) => {
        const p = S.packs[c.packId];
        L.push(`${k + 1}. "${c.en}"`);
        if (c.ko) L.push(`   뜻: ${c.ko}`);
        if (p) L.push(`   출처: ${p.title}`);
        L.push(`   내 질문/메모: ${c.memo}`);
      });
      L.push("");
    }
    if (talks.length) {
      L.push("■ 30초 말하기 피드백 (각각 이 순서로: ① 내가 한 말을 한국어로 정리 ② 자연스러운지 평가 ③ 어색한 문장은 더 나은 표현과 이유 ④ 전체를 다듬은 모범 답안)");
      talks.forEach((t, k) => {
        L.push(`${k + 1}. 질문: ${t.q}${t.qko ? ` (${t.qko})` : ""}`);
        L.push(`   관련 영상: ${t.title}`);
        L.push(`   내가 한 말 (음성 인식이라 오타가 있을 수 있어): "${t.text}"`);
      });
    }
    return L.join("\n");
  }
  function updatePreview() {
    const txt = askText();
    $("#akPreview").value = txt;
    const n = akSel.notes.size + akSel.talks.size;
    $("#akCopy").disabled = !txt;
    $("#akCopy").querySelector("span").textContent = n ? `${n}개 골라서 복사하기` : "보낼 것을 골라 주세요";
  }
  $("#akAllNotes").onclick = () => { akNotesList().forEach((c) => akSel.notes.add(c.id)); renderAsk(); };
  $("#akAllTalks").onclick = () => { akTalksList().forEach((t) => akSel.talks.add(t.id)); renderAsk(); };
  $("#akCopy").onclick = async () => {
    const txt = askText(); if (!txt) return;
    if (!(await copyOut(txt))) { toast("복사하지 못했어요. 아래 미리 보기 글을 길게 눌러 복사해 주세요"); $("#akPreview").closest("details").open = true; return; }
    toast("복사했어요. Claude 앱에 붙여넣으세요");
  };
  $("#askOpen").onclick = () => open("ask");
  $("#modeD").onclick = () => open("talk");

  // ---------- bookmarks tab ----------
  // a bookmark list is one pack, one folder ("f:<name>"), every bookmark (ALL), or those whose pack was deleted (GONE)
  const GONE = "__gone__", ALL = "__all__", FOLDER = "f:";
  const inList = (c, key) => {
    const p = S.packs[c.packId];
    if (key === ALL) return true;
    if (key === GONE) return !p;
    if (key.startsWith(FOLDER)) return !!p && folderOf(p) === key.slice(FOLDER.length);
    return c.packId === key;
  };
  const bookmarksOf = (key) => Object.values(S.cards)
    .filter((c) => inList(c, key))
    .sort((a, b) => (a.packId === b.packId ? a.t - b.t : a.packId < b.packId ? -1 : 1));
  function savedPackCard(p) {
    const b = el("button", "pack"); b.type = "button";
    const mid = el("span"); mid.style.minWidth = "0";
    mid.append(el("div", "t", p.title), statsLine(p));
    const cnt = el("span", "pct", String(bookmarksOf(p.id).length)); cnt.setAttribute("aria-hidden", "true");
    b.append(kindIcon(p), mid, cnt);
    b.onclick = () => open("savedpack", p.id);
    return b;
  }
  function savedGroupCard(title, sub, n, iconName, onClick) {
    const b = el("button", "pack folder"); b.type = "button";
    const ic = el("span", "ic"); ic.append(icon(iconName));
    const mid = el("span"); mid.style.minWidth = "0";
    mid.append(el("div", "t", title), el("div", "s", sub));
    b.append(ic, mid, el("span", "pct", String(n)));
    b.onclick = onClick;
    return b;
  }
  const watchedPacks = () => {
    const opened = S.p.opened || {};
    return Object.values(S.packs)
      .filter((p) => bookmarksOf(p.id).length || Object.keys(seenOf(p.id)).length)
      .sort((a, b) => (opened[b.id] || 0) - (opened[a.id] || 0));
  };
  function renderSavedFolder(name) {
    $("#topTitle").textContent = name;
    const box = $("#sfList"); box.textContent = "";
    const n = bookmarksOf(FOLDER + name).length;
    if (n) box.append(savedGroupCard(`${name} 북마크 모두 보기`, "이 폴더의 북마크를 한 번에", n, "star", () => open("savedpack", FOLDER + name)));
    watchedPacks().filter((p) => folderOf(p) === name).sort(folderOrder).forEach((p) => box.append(savedPackCard(p)));
  }
  function renderSaved() {
    const due = Object.values(S.cards).filter((c) => c.due <= TODAY()).length;
    const total = Object.keys(S.cards).length;
    $("#dueTitle").textContent = due ? `오늘 복습할 문장 ${due}개` : "오늘 복습할 문장이 없어요";
    $("#dueText").textContent = due ? "원래 음성을 듣고 뜻을 떠올리는 복습이에요." : total ? "알았던 문장은 3일, 7일, 14일 뒤에 다시 나와요." : "영상을 보다가 별을 누르면 여기로 모여요.";
    $("#startReview").hidden = !due;
    const nNotes = Object.values(S.cards).filter((c) => c.memo).length, nTalks = S.talks.length;
    $("#askText").textContent = nNotes || nTalks
      ? `노트 ${nNotes}개 · 30초 말하기 ${nTalks}개`
      : "북마크 노트와 30초 말하기를 복사해서 Claude 앱에 붙여넣어요";
    $("#savedTotal").textContent = total ? `북마크 ${total}개` : "";
    const list = $("#watchedList"); list.textContent = "";
    const packs = watchedPacks();
    if (!packs.length && !bookmarksOf(GONE).length) {
      list.append(el("p", "muted", "아직 본 콘텐츠가 없어요. 홈에서 콘텐츠를 골라 보세요."));
      return;
    }
    if (total) list.append(savedGroupCard("전체 북마크", "모든 콘텐츠의 북마크를 한 번에", total, "star", () => open("savedpack", ALL)));
    // packs of one series (a drama, the grammar course) sit in a folder, like on the home screen
    const seenFolders = new Set();
    packs.forEach((p) => {
      const f = folderOf(p);
      if (!f) { list.append(savedPackCard(p)); return; }
      if (seenFolders.has(f)) return;
      seenFolders.add(f);
      const inF = packs.filter((x) => folderOf(x) === f).length;
      list.append(savedGroupCard(f, `콘텐츠 ${inF}개`, bookmarksOf(FOLDER + f).length, "folder", () => open("savedfolder", f)));
    });
    const gone = bookmarksOf(GONE).length;
    if (gone) {
      const b = el("button", "pack"); b.type = "button";
      const ic = el("span", "ic"); ic.append(icon("trash"));
      const mid = el("span"); mid.append(el("div", "t", "삭제한 콘텐츠의 북마크"), el("div", "s", `북마크 ${gone}개 · 원래 음성 없음`));
      b.append(ic, mid, el("span", "pct", String(gone)));
      b.onclick = () => open("savedpack", GONE);
      list.append(b);
    }
  }
  let spPack = null, spShowAll = false;
  function renderSavedPack(id) {
    spPack = id;
    const p = S.packs[id], group = id === ALL || id.startsWith(FOLDER);
    $("#topTitle").textContent = p ? p.title : id === ALL ? "전체 북마크" : group ? id.slice(FOLDER.length) + " 북마크" : "삭제한 콘텐츠";
    $("#spYtWrap").hidden = true;
    $("#spOpen").hidden = !p;
    $("#spShowAll").setAttribute("aria-pressed", String(spShowAll));
    const items = bookmarksOf(id);
    $("#spCount").textContent = `북마크 ${items.length}개`;
    const ol = $("#spList"); ol.textContent = "";
    if (!items.length) { ol.append(el("li", "muted", "아직 북마크한 문장이 없어요. 이 콘텐츠를 보다가 모르는 문장의 별을 눌러 보세요.")); return; }
    items.forEach((c) => {
      const pc = S.packs[c.packId];   // in a combined list every bookmark plays from its own pack
      const li = el("li", "bm" + (spShowAll ? " open" : ""));
      const face = el("button", "bm-face"); face.type = "button";
      if (group) face.append(el("span", "src", pc ? pc.title : "삭제한 콘텐츠"));
      face.append(el("span", "ko", c.ko || c.en));
      const back = el("span", "en-wrap");
      back.append(el("span", "en", c.en));
      if (c.note) back.append(el("span", "note", c.note));
      face.append(back);
      if (c.memo) face.append(el("span", "memo-tag", "노트: " + c.memo));
      const st0 = pc && pc.lines[c.i] && pc.lines[c.i].en === c.en ? pc.lines[c.i].study : null;
      const studyRow = el("div", "bm-actions");
      let studyWrap = null;
      if (st0) {
        const sb = el("button", "study-btn small"); sb.type = "button"; sb.append(icon("book"), el("span", "", "문장 분석"));
        studyWrap = el("div", "bm-study"); studyWrap.hidden = true;
        sb.onclick = () => {
          studyWrap.hidden = !studyWrap.hidden;
          if (!studyWrap.hidden && !studyWrap.firstChild) studyWrap.append(studyView(st0));
          sb.querySelector("span").textContent = studyWrap.hidden ? "문장 분석" : "분석 닫기";
          if (!studyWrap.hidden) { li.classList.add("open"); face.setAttribute("aria-expanded", "true"); }
        };
        studyRow.append(sb);
      }
      // a personal note or question on the sentence, later copied to Claude from "Claude에게 묻기"
      const nb = el("button", "study-btn small"); nb.type = "button"; nb.append(icon("chat"), el("span", "", c.memo ? "노트 고치기" : "노트·질문"));
      const memoBox = el("div", "memo-edit"); memoBox.hidden = true;
      const ta = el("textarea"); ta.rows = 3; ta.value = c.memo || ""; ta.placeholder = "궁금한 점이나 메모. 예: get to랑 get used to는 뭐가 달라?";
      ta.setAttribute("aria-label", "노트");
      const saveB = el("button", "btn small primary", "노트 저장"); saveB.type = "button";
      saveB.onclick = () => {
        const v = ta.value.trim();
        if (v !== (c.memo || "")) { c.memo = v; c.memoAt = Date.now(); saveCards(); }
        toast(v ? "노트를 저장했어요. Claude에게 묻기에서 보낼 수 있어요" : "노트를 지웠어요");
        renderSavedPack(id);
      };
      memoBox.append(ta, saveB);
      nb.onclick = () => { memoBox.hidden = !memoBox.hidden; if (!memoBox.hidden) { li.classList.add("open"); ta.focus(); } };
      studyRow.prepend(nb);
      if (!c.ko) li.classList.add("open");
      face.setAttribute("aria-expanded", String(li.classList.contains("open")));
      face.onclick = () => { li.classList.toggle("open"); face.setAttribute("aria-expanded", String(li.classList.contains("open"))); };
      const side = el("div", "bm-side");
      const sp = el("button", "speak"); sp.type = "button"; sp.setAttribute("aria-label", "원래 음성 듣기: " + c.en); sp.append(icon("sound"));
      sp.onclick = () => { if (pc) playSegment(pc, c.t, c.e, "spYtHost", "spYtWrap"); else tts(c.en); };
      const st = el("button", "unstar"); st.type = "button"; st.setAttribute("aria-label", "북마크 해제: " + c.en); st.append(icon("star"));
      st.onclick = () => {
        if (!st.classList.contains("confirm")) { st.classList.add("confirm"); toast("한 번 더 누르면 북마크가 해제돼요"); setTimeout(() => st.classList.remove("confirm"), 2500); return; }
        delete S.cards[c.id]; saveCards(); renderSavedPack(id); renderChrome();
      };
      side.append(sp, st);
      li.append(face, side);
      li.append(studyRow, memoBox);
      if (studyWrap) li.append(studyWrap);
      ol.append(li);
    });
  }
  $("#spShowAll").onclick = () => { spShowAll = !spShowAll; renderSavedPack(spPack); };
  $("#spOpen").onclick = () => { if (S.packs[spPack]) openPack(spPack); };
  $("#startReview").onclick = () => open("review");
  $("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify({ type: "ce-backup", v: 1, at: new Date().toISOString(), progress: S.p, cards: S.cards, settings: S.set, speak: S.speak, talks: S.talks, wrong: S.wrong })], { type: "application/json" });
    const a = el("a"); a.href = URL.createObjectURL(blob); a.download = `출퇴근영어-백업-${TODAY()}.json`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $("#restoreFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (o.type !== "ce-backup") throw new Error();
      S.p = o.progress; S.cards = o.cards; S.set = Object.assign(S.set, o.settings || {});
      S.speak = o.speak || S.speak; S.talks = Array.isArray(o.talks) ? o.talks : S.talks; S.wrong = o.wrong || S.wrong;
      saveP(); saveCards(); save("settings", S.set); save("speak", S.speak); save("talks", S.talks); saveWrong(); toast("백업을 불러왔어요"); renderSaved(); renderChrome();
    } catch (err) { toast("백업 파일이 아니거나 손상됐어요."); }
  });

  // ---------- home ----------
  function renderChrome() {
    $("#topStreak").textContent = displayStreak();
    $("#topXp").textContent = `${S.p.xp} XP`;
    const due = Object.values(S.cards).filter((c) => c.due <= TODAY()).length;
    const b = $("#dueBadge"); b.hidden = !due; b.textContent = due > 99 ? "99+" : due;
  }
  function renderHome() {
    const d = Object.assign({ lines: 0, reviews: 0, spoken: 0 }, S.p.days[TODAY()] || {});
    $("#gSpoken").textContent = `${Math.min(d.spoken, GOAL_SPOKEN)} / ${GOAL_SPOKEN}`;
    $("#gSpokenBar").style.width = Math.min(100, d.spoken / GOAL_SPOKEN * 100) + "%";
    $("#gLines").textContent = `${Math.min(d.lines, GOAL_LINES)} / ${GOAL_LINES}`;
    $("#gLinesBar").style.width = Math.min(100, d.lines / GOAL_LINES * 100) + "%";
    $("#gReviews").textContent = `${Math.min(d.reviews, GOAL_REVIEWS)} / ${GOAL_REVIEWS}`;
    $("#gReviewsBar").style.width = Math.min(100, d.reviews / GOAL_REVIEWS * 100) + "%";
    const st = displayStreak();
    $("#streakText").textContent = st ? `${st}일 연속 학습 중 · 최고 ${S.p.best}일` : "오늘 한 문장만 들어도 연속 기록이 시작돼요";
    const c = S.p.cont && S.packs[S.p.cont.id];
    $("#resume").hidden = !c;
    const nWrong = wrongItems(false).length;
    $("#wrongQuiz").hidden = !nWrong; $("#wrongQuizN").textContent = `틀린 문제 ${nWrong}개 다시 풀기`;
    if (c) { $("#resumeTitle").textContent = c.title; $("#resumePct").textContent = pctOf(c) + "%"; }
    renderInterests();
    const cands = candidates();
    // stays visible even with nothing to show, so the learner can always ask for new videos or change topics
    $("#recoBox").hidden = !S.set.topics;
    const open = S.set.liveOpen !== false;
    $("#liveToggle").setAttribute("aria-expanded", String(open)); $("#candBox").hidden = !open;
    if (candOffset >= cands.length) candOffset = 0;
    $("#candSearch").hidden = !!S.set.ytKey;   // with a key, the refresh button next to the title does the searching
    $("#candHint").hidden = !cands.length; $("#candEmpty").hidden = !!cands.length;
    $("#candEmptyText").textContent = S.set.ytKey
      ? "제목 옆 새로고침 버튼을 누르면 관심 주제에 맞는 영상을 YouTube에서 바로 찾아와요."
      : "위의 실시간 추천 켜기에서 YouTube API 키를 넣으면 여기서 바로 찾을 수 있어요. 키 없이도 아래 버튼으로 요청 글을 복사해 Claude 앱의 Code에서 PC 세션에 붙여넣으면, 영상을 찾아 추천 묶음 파일로 보내 드려요.";
    renderSearchBtn();
    const cl = $("#candList"); cl.textContent = "";
    cands.slice(candOffset, candOffset + 3).forEach((c) => cl.append(candCard(c)));
    const list = $("#packList"); list.textContent = "";
    const packs = Object.values(S.packs);
    if (!packs.length) { list.append(emptyPacks()); return; }
    const fs = folders();
    // folders first, then loose packs newest first, unless the learner arranged them
    const items = Object.keys(fs).sort().map((n) => ({ key: "f:" + n, make: () => folderCard(n, fs[n]) }))
      .concat(packs.filter((p) => !folderOf(p)).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1)).map((p) => ({ key: "p:" + p.id, make: () => packCard(p, null, false) })));
    byOrder(items, (x) => x.key, "").forEach((x) => { const c = x.make(); c.dataset.key = x.key; list.append(c); });
  }
  function emptyPacks() {
    const box = el("div", "panel empty-packs");
    box.append(el("b", "", "아직 콘텐츠가 없어요"));
    const ol = el("ol", "steps-sm");
    ["위의 팩 가져오기를 누르세요.", "파일 선택 창에서 OneDrive → EnglishApp → packs 폴더로 가세요.", "추천-로 시작하는 묶음 파일을 고르면 여러 팩이 한 번에 들어와요."].forEach((t) => ol.append(el("li", "", t)));
    box.append(ol, el("p", "muted small", "새 영상이 보고 싶으면 YouTube 링크를 Claude 앱 → Code에서 PC 세션에 보내 팩을 만들어 달라고 하세요."));
    return box;
  }
  function packCard(p, reasons, reco) {
    const b = el("button", "pack" + (reco ? " reco" : "")); b.type = "button";
    const ic = kindIcon(p);
    const mid = el("span"); mid.style.minWidth = "0";
    const pct = pctOf(p);
    const lv = lvNum(p.level);
    mid.append(el("div", "t", p.title), el("div", "s", [kindOf(p).label, lv != null ? lvName(lv) : "", p.meta.minutes ? `${Math.round(p.meta.minutes)}분` : `${p.lines.length}문장`, p.author].filter(Boolean).join(" · ")));
    if (reasons && reasons.length) {
      const rs = el("div", "reasons");
      reasons.slice(0, 3).forEach((r) => rs.append(el("span", "chip" + (r.fit ? " fit" : ""), r.t || r)));
      mid.append(rs);
    } else {
      mid.append(statsLine(p));
      const bar = el("div", "bar mini"), fill = el("div"); fill.style.width = pct + "%"; bar.append(fill); mid.append(bar);
    }
    b.append(ic, mid, el("span", "pct", pct + "%"));
    b.onclick = () => openPack(p.id);
    return b;
  }

  // ---------- folders: a pack's series from the pack maker, or a folder the learner set ----------
  const folderOf = (p) => ((S.set.packFolder || {})[p.id] ?? (p.meta.series ? p.meta.series.title : "")) || "";
  const folderOrder = (a, b) => ((a.meta.series && a.meta.series.order) || 0) - ((b.meta.series && b.meta.series.order) || 0) || (a.addedAt < b.addedAt ? -1 : 1);
  function folders() {
    const m = {};
    Object.values(S.packs).forEach((p) => { const f = folderOf(p); if (f) (m[f] = m[f] || []).push(p); });
    Object.entries(m).forEach(([name, list]) => { list.sort(folderOrder); m[name] = byOrder(list, (p) => "p:" + p.id, name); });
    return m;
  }
  // the learner's own order: S.set.order[""] for the home list ("f:<folder>" / "p:<id>"), S.set.order[<folder>] inside a folder;
  // items it doesn't know yet (new imports) come first, in their default order
  function byOrder(items, keyOf, ctx) {
    const pos = new Map(((S.set.order || {})[ctx] || []).map((k, i) => [k, i]));
    return items.map((it, i) => ({ it, i, o: pos.has(keyOf(it)) ? pos.get(keyOf(it)) : -1 }))
      .sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.it);
  }
  function saveOrder(ctx, keys) { S.set.order = S.set.order || {}; S.set.order[ctx] = keys; save("settings", S.set); }
  function folderCard(name, list) {
    const b = el("button", "pack folder"); b.type = "button";
    const ic = el("span", "ic"); ic.append(icon("folder"));
    const mid = el("span"); mid.style.minWidth = "0";
    const seen = list.reduce((n, p) => n + Object.keys(seenOf(p.id)).length, 0), total = list.reduce((n, p) => n + p.lines.length, 0);
    const done = list.filter((p) => pctOf(p) >= 90).length;
    mid.append(el("div", "t", name), el("div", "s", `팩 ${list.length}개 · 다 본 팩 ${done}개`));
    const bar = el("div", "bar mini"), fill = el("div"); fill.style.width = (total ? Math.round(seen / total * 100) : 0) + "%"; bar.append(fill); mid.append(bar);
    b.append(ic, mid, el("span", "pct", (total ? Math.round(seen / total * 100) : 0) + "%"));
    b.onclick = () => open("folder", name);
    return b;
  }
  function renderFolder(name) {
    const list = folders()[name] || [];
    $("#topTitle").textContent = name;
    const box = $("#fdList"); box.textContent = "";
    if (!list.length) { box.append(el("p", "muted small", "이 폴더에 팩이 없어요.")); $("#fdNext").hidden = true; $("#fdDelete").hidden = true; return; }
    const next = list.find((p) => pctOf(p) < 90);
    $("#fdNext").hidden = !next;
    if (next) { $("#fdNextTitle").textContent = next.title; $("#fdNext").onclick = () => openPack(next.id); }
    list.forEach((p) => { const c = packCard(p, null, false); c.dataset.key = "p:" + p.id; box.append(c); });
    $("#fdDelete").hidden = false;
    const del = $("#fdDelete"); del.textContent = `폴더의 팩 ${list.length}개 모두 삭제`; delete del.dataset.confirm;
    del.onclick = async () => {
      if (!del.dataset.confirm) { del.dataset.confirm = "1"; del.textContent = "한 번 더 누르면 모두 삭제돼요 (북마크는 남아요)"; setTimeout(() => { delete del.dataset.confirm; del.textContent = `폴더의 팩 ${list.length}개 모두 삭제`; }, 3000); return; }
      for (const p of list) await removePack(p.id);
      go("home");
    };
  }

  // ---------- arranging the pack lists, like a photo album ----------
  // long-press a card to start selecting (then tap more), move the selection to a folder or delete it, drag ≡ to reorder
  const ED = { box: null, ctx: null, sel: new Set() };
  const edCards = () => [...ED.box.querySelectorAll(".pack[data-key]")];
  const packsOfKeys = (keys) => [...keys].flatMap((k) => (k.startsWith("f:") ? folders()[k.slice(2)] || [] : S.packs[k.slice(2)] ? [S.packs[k.slice(2)]] : []));
  function editStart(box, ctx, key) {
    if (ED.box) editEnd();
    ED.box = box; ED.ctx = ctx; ED.sel = new Set([key]);
    box.classList.add("editing");
    edCards().forEach((c) => { const h = el("span", "drag"); h.setAttribute("aria-label", "끌어서 순서 바꾸기"); h.append(icon("grip")); c.append(h); });
    $("#editBar").hidden = false;
    renderSel();
  }
  function editEnd() {
    if (!ED.box) return;
    ED.box.classList.remove("editing");
    ED.box.querySelectorAll(".drag").forEach((h) => h.remove());
    ED.box.querySelectorAll(".pack[aria-checked]").forEach((c) => c.removeAttribute("aria-checked"));
    ED.box = null; ED.sel.clear();
    $("#editBar").hidden = true;
  }
  function renderSel() {
    edCards().forEach((c) => c.setAttribute("aria-checked", String(ED.sel.has(c.dataset.key))));
    const n = ED.sel.size;
    $("#edCount").textContent = n ? `${n}개 선택` : "선택 없음";
    $("#edMove").disabled = !n; $("#edDel").disabled = !n;
    const del = $("#edDel"); delete del.dataset.confirm; del.textContent = "삭제";
  }
  function refreshAfterEdit() {
    if (current !== "folder") { renderHome(); return; }
    if (folders()[ED.ctx]) renderFolder(ED.ctx); else back();   // the folder emptied out
  }
  function arrangeable(box, ctxOf) {
    let timer = 0, sx = 0, sy = 0, fired = false;
    box.addEventListener("pointerdown", (e) => {
      const card = e.target.closest(".pack[data-key]");
      if (!card || ED.box === box) return;
      fired = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => { fired = true; editStart(box, ctxOf(), card.dataset.key); if (navigator.vibrate) navigator.vibrate(15); }, 500);
    });
    const cancel = () => clearTimeout(timer);
    box.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel(); });
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => box.addEventListener(t, cancel));
    box.addEventListener("contextmenu", (e) => { if (e.target.closest(".pack[data-key]")) e.preventDefault(); });
    // while selecting, a tap toggles the card instead of opening it; the click that ends a long-press is swallowed
    box.addEventListener("click", (e) => {
      const card = e.target.closest(".pack[data-key]"); if (!card) return;
      if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); return; }
      if (ED.box !== box) return;
      e.preventDefault(); e.stopPropagation();
      if (e.target.closest(".drag")) return;
      const k = card.dataset.key;
      if (ED.sel.has(k)) ED.sel.delete(k); else ED.sel.add(k);
      renderSel();
    }, true);
    // drag the ≡ handle to reorder; the new order is saved when the finger lifts
    box.addEventListener("pointerdown", (e) => {
      const h = e.target.closest(".drag"); if (!h || ED.box !== box) return;
      e.preventDefault();
      const card = h.closest(".pack"); card.classList.add("dragging");
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* keeps working without capture */ }
      const move = (ev) => {
        const y = ev.clientY;
        if (y < 90) window.scrollBy(0, -12); else if (y > innerHeight - 150) window.scrollBy(0, 12);
        const after = edCards().filter((c) => c !== card).find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
        if (after) { if (card.nextElementSibling !== after) box.insertBefore(card, after); } else if (box.lastElementChild !== card) box.append(card);
      };
      const up = () => {
        h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up);
        card.classList.remove("dragging");
        saveOrder(ED.ctx, edCards().map((c) => c.dataset.key));
      };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
    });
  }
  arrangeable($("#packList"), () => "");
  arrangeable($("#fdList"), () => NAV.stack.length ? NAV.stack[NAV.stack.length - 1].arg : "");
  $("#edDone").onclick = editEnd;
  $("#edMove").onclick = () => { if (ED.sel.size) openMove([...ED.sel], () => { editEnd(); refreshAfterEdit(); }); };
  $("#edDel").onclick = async () => {
    const del = $("#edDel"), list = packsOfKeys(ED.sel);
    if (!list.length) return;
    if (!del.dataset.confirm) { del.dataset.confirm = "1"; del.textContent = `팩 ${list.length}개 삭제?`; setTimeout(() => { if (del.dataset.confirm) renderSel(); }, 3000); return; }
    for (const p of list) await removePack(p.id);
    toast(`팩 ${list.length}개를 삭제했어요 (북마크는 남아요)`);
    editEnd(); refreshAfterEdit();
  };

  // move sheet: pick an existing folder, take packs out of their folder, or make a new one
  let mvKeys = [], mvDone = null;
  function openMove(keys, done) {
    mvKeys = keys; mvDone = done;
    const list = packsOfKeys(keys), from = new Set(list.map(folderOf));
    const box = $("#mvList"); box.textContent = "";
    const fs = folders();
    byOrder(Object.keys(fs).sort(), (n) => "f:" + n, "").forEach((n) => {
      const b = el("button", "mv-item"); b.type = "button";
      const ic = el("span", "ic"); ic.append(icon("folder"));
      b.append(ic, el("span", "t", n), el("span", "s", `${fs[n].length}개`));
      if (from.size === 1 && from.has(n)) { b.disabled = true; b.append(el("span", "s", "지금 여기")); }
      b.onclick = () => moveTo(n);
      box.append(b);
    });
    if ([...from].some(Boolean)) {
      const b = el("button", "mv-item out"); b.type = "button";
      const ic = el("span", "ic"); ic.append(icon("home"));
      b.append(ic, el("span", "t", "폴더에서 빼기"), el("span", "s", "홈 목록으로"));
      b.onclick = () => moveTo("");
      box.append(b);
    }
    $("#mvTitle").textContent = `팩 ${list.length}개 옮기기`;
    $("#mvNew").value = "";
    $("#moveSheet").hidden = false;
  }
  function moveTo(name) {
    const list = packsOfKeys(mvKeys);
    // "" means "no folder", even for a pack whose maker put it in a series
    list.forEach((p) => { S.set.packFolder = S.set.packFolder || {}; S.set.packFolder[p.id] = name; });
    save("settings", S.set);
    $("#moveSheet").hidden = true;
    toast(name ? `팩 ${list.length}개를 "${name}" 폴더로 옮겼어요` : `팩 ${list.length}개를 폴더에서 뺐어요`);
    if (mvDone) mvDone();
  }
  $("#mvCreate").onclick = () => {
    const n = $("#mvNew").value.trim();
    if (!n) { toast("새 폴더 이름을 적어 주세요"); $("#mvNew").focus(); return; }
    moveTo(n);
  };
  $("#mvNew").onkeydown = (e) => { if (e.key === "Enter") $("#mvCreate").click(); };
  $("#mvCancel").onclick = () => { $("#moveSheet").hidden = true; };
  $("#moveSheet").onclick = (e) => { if (e.target.id === "moveSheet") $("#moveSheet").hidden = true; };

  // ---------- interests & live recommendations ----------
  let candOffset = 0;
  $("#liveToggle").onclick = () => { S.set.liveOpen = S.set.liveOpen === false; save("settings", S.set); renderHome(); };
  // refresh: next three of the videos already found, and a new search once those run out (saves the daily quota)
  $("#liveRefresh").onclick = () => {
    if (S.set.liveOpen === false) { S.set.liveOpen = true; save("settings", S.set); }
    if (!S.set.ytKey) { renderHome(); showKeyForm(true); return; }
    if (candOffset + 3 < candidates().length) { candOffset += 3; renderHome(); return; }
    liveSearch();
  };
  function candidates() {
    const topics = S.set.topics || DEFAULT_TOPICS;
    return Object.values(S.cand)
      .filter((c) => !c.hidden && !S.packs["yt-" + c.id] && (!c.topic || topics.includes(c.topic)))
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }
  // ---------- live search for new videos (YouTube Data API, with the learner's own key) ----------
  // keep in step with tools/topics.json, which the PC tools use for the same search
  const SEARCH = {
    min: 180, max: 1200,
    prefer: ["TED", "TED-Ed", "TEDx Talks", "BBC Learning English", "VOA Learning English", "Harvard Business Review", "Asianometry", "Branch Education", "Google Career Certificates", "Stanford Graduate School of Business"],
    topics: {
      tech: ["how semiconductor chips are made", "semiconductor industry explained", "how computer chips work"],
      meeting: ["business English meeting phrases", "how to run effective meetings", "teamwork collaboration talk"],
      present: ["how to give a great presentation", "public speaking tips TED", "how to explain technical ideas simply"],
      career: ["leadership TED talk", "career advice for engineers", "how to be a good manager"],
      habit: ["habits TED talk", "how to avoid burnout", "productivity tips for busy people"],
      daily: ["English small talk conversation", "travel English conversation", "everyday English listening practice"],
      science: ["future of technology talk", "artificial intelligence explained", "science explained short talk"],
      biz: ["business news explained", "how companies make money explained", "supply chain explained"],
      comedy: { min: 15, max: 480, q: ["clean stand up comedy short clip", "funny office comedy sketch shorts", "late night show funny moment clip"] }
    }
  };
  const PER_TOPIC = 3, YT_DATA = "https://www.googleapis.com/youtube/v3/";
  const isoSecs = (d) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "") || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
  const unescapeHtml = (s) => new DOMParser().parseFromString(s || "", "text/html").documentElement.textContent;
  async function ytData(path, params) {
    const res = await fetch(YT_DATA + path + "?" + new URLSearchParams(Object.assign({ key: S.set.ytKey }, params)));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = ((body.error && body.error.errors && body.error.errors[0]) || {}).reason || "";
      const e = new Error(why === "quotaExceeded" ? "오늘 검색 한도를 다 썼어요. 내일 다시 눌러 주세요."
        : why === "keyInvalid" || res.status === 400 ? "API 키가 올바르지 않아요. 키를 다시 확인해 주세요."
        : res.status === 403 ? "이 키로는 검색할 수 없어요. YouTube Data API v3가 켜져 있는지, 웹사이트 제한에 이 주소가 들어 있는지 확인해 주세요."
        : "검색하지 못했어요 (" + res.status + ")");
      e.keyProblem = why !== "quotaExceeded"; throw e;
    }
    return body;
  }
  // one random query per topic, so each tap brings different videos
  async function findTopic(tid, skip) {
    const t = SEARCH.topics[tid]; if (!t) return [];
    const qs = Array.isArray(t) ? t : t.q, lo = t.min || SEARCH.min, hi = t.max || SEARCH.max;
    const q = qs[Math.floor(Math.random() * qs.length)];
    const sr = await ytData("search", {
      part: "snippet", type: "video", q, maxResults: 25, videoCaption: "closedCaption", videoEmbeddable: "true",
      relevanceLanguage: "en", safeSearch: "moderate"
    });
    const ids = (sr.items || []).map((it) => it.id && it.id.videoId).filter((id) => id && !skip.has(id));
    if (!ids.length) return [];
    const vr = await ytData("videos", { part: "snippet,contentDetails,statistics", id: ids.join(",") });
    const prefer = new Set(SEARCH.prefer.map((c) => c.toLowerCase()));
    return (vr.items || []).map((v) => {
      const sn = v.snippet || {}, lang = sn.defaultAudioLanguage || sn.defaultLanguage || "";
      return { id: v.id, title: unescapeHtml(sn.title), channel: sn.channelTitle || "", duration: isoSecs(v.contentDetails && v.contentDetails.duration),
        views: +((v.statistics || {}).viewCount) || 0, lang, live: sn.liveBroadcastContent !== "none" };
    })
      .filter((v) => !v.live && v.duration >= lo && v.duration <= hi && (!v.lang || /^en/i.test(v.lang)))
      .sort((a, b) => (prefer.has(b.channel.toLowerCase()) - prefer.has(a.channel.toLowerCase())) || b.views - a.views)
      .slice(0, PER_TOPIC)
      .map((v) => ({ id: v.id, title: v.title, channel: v.channel, duration: v.duration, topic: tid, shorts: v.duration <= 60 }));
  }
  let searching = false;
  async function liveSearch() {
    if (!S.set.ytKey) { showKeyForm(true); return; }
    if (searching) return;
    searching = true; renderSearchBtn();
    const topics = (S.set.topics || DEFAULT_TOPICS).filter((t) => SEARCH.topics[t]);
    // skip videos already shown, hidden or made into packs
    const skip = new Set(Object.keys(S.cand).concat(Object.keys(S.packs).map((id) => id.replace(/^yt-/, ""))));
    let added = 0;
    try {
      const found = await Promise.all(topics.map((t) => findTopic(t, skip).catch((e) => { if (e.keyProblem !== undefined) throw e; return []; })));
      const now = Date.now();
      found.flat().forEach((c, i) => { if (!S.cand[c.id]) { S.cand[c.id] = Object.assign(c, { addedAt: now - i }); added++; } });
      save("candidates", S.cand);
      candOffset = 0;
      toast(added ? `새 영상 ${added}개를 찾았어요` : "새로 찾은 영상이 없어요. 잠시 뒤 다시 눌러 보세요.");
    } catch (e) {
      toast(e.message || "검색하지 못했어요. 인터넷 연결을 확인해 주세요.");
      if (e.keyProblem) showKeyForm(true);
    } finally {
      searching = false; renderHome();
    }
  }
  function renderSearchBtn() {
    const b = $("#candSearch"); b.disabled = searching;
    b.lastChild.textContent = searching ? " 찾는 중…" : " 실시간 추천 켜기";
    const r = $("#liveRefresh"); r.disabled = searching; r.classList.toggle("spin", searching);
  }
  function showKeyForm(on) {
    $("#keyForm").hidden = !on;
    if (on) { $("#keyInput").value = S.set.ytKey || ""; $("#keyForm").scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  $("#candSearch").onclick = () => liveSearch();
  // the form opens when there is no key or the key stopped working, so this is the one place to set, change or clear it
  $("#keySave").onclick = () => {
    const v = $("#keyInput").value.trim();
    // Google is changing its key format, so only reject what clearly isn't a key; a wrong key shows up on the first search
    if (v && !/^[\w.~-]{20,200}$/.test(v)) { toast("API 키 모양이 아니에요. 사용자 인증 정보의 API 키를 그대로 붙여넣어 주세요."); return; }
    S.set.ytKey = v; save("settings", S.set);
    showKeyForm(false); renderHome();
    if (v) liveSearch(); else toast("API 키를 지웠어요");
  };  const fmtDur = (s) => (s <= 60 ? "쇼츠" : `${Math.floor(s / 60)}분`);
  $("#candAsk").onclick = () => {
    const names = (S.set.topics || DEFAULT_TOPICS).map((t) => TOPICS[t]).filter(Boolean).join(", ");
    copyText(`새 영상 후보 추천해줘 (관심 주제: ${names}, 수준: ${lvName(S.set.target)})`, "복사했어요. Claude 앱 → Code에서 이 PC 세션에 붙여넣으세요.");
  };
  // a thumbnail first; tapping it plays the video right in the card so the learner can judge it before asking for a pack
  function candPreview(c) {
    const wrap = el("div", "cand-media" + (c.shorts ? " vertical" : ""));
    const thumb = el("button", "cand-thumb"); thumb.type = "button"; thumb.setAttribute("aria-label", `${c.title} 미리 보기`);
    const img = el("img"); img.src = `https://i.ytimg.com/vi/${c.id}/hqdefault.jpg`; img.alt = ""; img.loading = "lazy";
    const play = el("span", "play"); play.append(icon("video"));
    thumb.append(img, play);
    thumb.onclick = () => {
      const f = el("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${c.id}?autoplay=1&playsinline=1&rel=0`;
      f.allow = "autoplay; encrypted-media; picture-in-picture"; f.allowFullscreen = true; f.title = c.title;
      wrap.replaceChildren(f);
    };
    wrap.append(thumb);
    return wrap;
  }
  function candCard(c) {
    const box = el("div", "cand");
    box.append(candPreview(c));
    const head = el("div");
    head.append(el("div", "t", c.title), el("div", "s", [c.channel, fmtDur(c.duration), TOPICS[c.topic]].filter(Boolean).join(" · ")));
    const row = el("div", "row");
    const req = el("button", "btn small primary", "팩 요청 복사"); req.type = "button";
    req.onclick = () => copyText(`이 영상으로 팩 만들어줘 (주제: ${TOPICS[c.topic] || "기타"}) https://youtu.be/${c.id}`, "복사했어요. Claude 앱 → Code에서 이 PC 세션에 붙여넣으세요.");
    const yt = el("a", "btn small", "YouTube에서 보기"); yt.href = `https://youtu.be/${c.id}`; yt.target = "_blank"; yt.rel = "noopener";
    const hide = el("button", "link", "관심 없음"); hide.type = "button";
    hide.onclick = () => { c.hidden = true; save("candidates", S.cand); renderHome(); };
    row.append(req, yt);
    box.append(head, row, hide);
    return box;
  }
  // resolves true when the text reached the clipboard
  function copyOut(text) {
    const fallback = () => {
      const ta = el("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
      ta.remove(); return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, fallback);
    return Promise.resolve(fallback());
  }
  function copyText(text, okMsg) { copyOut(text).then((ok) => toast(ok ? okMsg : "복사하지 못했어요: " + text)); }
  let draftTopics = null;
  function renderInterests() {
    const show = !S.set.topics || draftTopics;
    $("#interestPanel").hidden = !show;
    if (!show) return;
    if (!draftTopics) draftTopics = (S.set.topics || DEFAULT_TOPICS).slice();
    const box = $("#topicChips"); box.textContent = "";
    Object.entries(TOPICS).forEach(([id, label]) => {
      const b = el("button", "", label); b.type = "button"; b.setAttribute("aria-pressed", String(draftTopics.includes(id)));
      b.onclick = () => { draftTopics = draftTopics.includes(id) ? draftTopics.filter((x) => x !== id) : draftTopics.concat(id); renderInterests(); };
      box.append(b);
    });
    document.querySelectorAll("#levelSeg button").forEach((b) => b.setAttribute("aria-pressed", String(Math.abs(+b.dataset.lv - S.set.target) < 0.45)));
  }
  document.querySelectorAll("#levelSeg button").forEach((b) => { b.onclick = () => { S.set.target = +b.dataset.lv; renderInterests(); }; });
  $("#interestDone").onclick = () => {
    if (!draftTopics || !draftTopics.length) { toast("주제를 하나 이상 골라 주세요."); return; }
    S.set.topics = draftTopics; draftTopics = null; save("settings", S.set); renderHome(); toast("관심 주제에 맞춰 추천할게요");
    if (S.set.ytKey) liveSearch();
  };
  $("#editInterests").onclick = () => { draftTopics = (S.set.topics || DEFAULT_TOPICS).slice(); renderHome(); $("#interestPanel").scrollIntoView({ block: "start", behavior: "smooth" }); };

  // ---------- rating after finishing a pack ----------
  function checkRating() {
    const p = P.pack; if (!p) return;
    $("#ratePanel").hidden = !(pctOf(p) >= 90 && !S.set.rated[p.id]);
  }
  document.querySelectorAll("[data-rate-v]").forEach((b) => {
    b.onclick = () => {
      const p = P.pack; if (!p) return;
      const v = b.dataset.rateV;
      const unknown = p.lines.filter((_, i) => S.cards[cardId(p.id, i)]).length / p.lines.length;
      const lv = lvNum(p.level); const base = lv == null ? S.set.target : lv;
      // where this pack says the learner is comfortable, nudged by how many sentences were unknown
      const est = base + (v === "easy" ? 0.6 : v === "hard" ? -0.6 : 0) + (unknown < 0.08 ? 0.3 : unknown > 0.25 ? -0.3 : 0);
      let next = S.set.target * 0.7 + est * 0.3;
      if (v === "easy") next = Math.max(S.set.target, next);   // "easy" never makes later picks easier
      if (v === "hard") next = Math.min(S.set.target, next);   // "hard" never makes them harder
      S.set.target = Math.min(4, Math.max(1, Math.round(next * 100) / 100));
      S.set.rated[p.id] = v; save("settings", S.set);
      $("#ratePanel").hidden = true; addXP(5);
      toast(`고마워요. 다음 추천은 ${lvName(S.set.target)} 수준 위주로 할게요`);
    };
  });

  // ---------- delete imported packs (bookmarks and notes stay) ----------
  async function removePack(id) {
    const p = S.packs[id]; if (!p) return false;
    try { await idb.del(id); } catch (e) { toast("삭제하지 못했어요."); return false; }
    if (p._url) URL.revokeObjectURL(p._url);
    (p._slides || []).forEach((u) => u && URL.revokeObjectURL(u));
    delete S.packs[id];
    if (S.p.cont && S.p.cont.id === id) { S.p.cont = null; saveP(); }
    toast(`"${p.title}" 팩을 삭제했어요`);
    return true;
  }
  $("#deletePack").onclick = async () => {
    const btn = $("#deletePack"), p = P.pack; if (!p) return;
    if (!btn.dataset.confirm) { btn.dataset.confirm = "1"; btn.textContent = "한 번 더 누르면 삭제돼요 (북마크는 남아요)"; setTimeout(() => { delete btn.dataset.confirm; btn.textContent = "이 팩 삭제"; }, 3000); return; }
    delete btn.dataset.confirm; btn.textContent = "이 팩 삭제";
    if (await removePack(p.id)) go("home");
  };

  // ---------- pack manager ----------
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");
  const packBytes = (p) => JSON.stringify({ lines: p.lines, speak: p.speak, talkQs: p.talkQs }).length * 2 + (p.media.blob ? p.media.blob.size : 0)
    + (p.media.slideBlobs || []).reduce((s, b) => s + b.size, 0);
  async function renderManage() {
    const packs = Object.values(S.packs).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    const total = packs.reduce((s, p) => s + packBytes(p), 0);
    let usage = `팩 ${packs.length}개 · 약 ${fmtBytes(total)}`;
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.quota) usage += ` (이 앱이 쓸 수 있는 공간 ${fmtBytes(est.quota)} 중 ${fmtBytes(est.usage || 0)} 사용)`;
    } catch (e) { /* estimate is optional */ }
    $("#mgUsage").textContent = usage;
    const list = $("#mgList"); list.textContent = "";
    if (!packs.length) { list.append(el("li", "muted small", "가져온 팩이 없어요.")); return; }
    packs.sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || folderOrder(a, b)).forEach((p) => {
      const li = el("li", "mgitem"), txt = el("div");
      const marks = marksOf(p), added = (p.addedAt || "").slice(0, 10).replace(/-/g, "."), f = folderOf(p);
      txt.append(el("div", "t", p.title), el("div", "s", [f ? `폴더: ${f}` : "", kindOf(p).label, `${p.lines.length}문장`, fmtBytes(packBytes(p)), `진행 ${pctOf(p)}%`, marks ? `북마크 ${marks}` : "", added ? `${added} 추가` : ""].filter(Boolean).join(" · ")));
      const acts = el("div", "acts");
      const fb = el("button", "btn", "폴더 이동"); fb.type = "button"; fb.setAttribute("aria-label", `${p.title} 폴더 옮기기`);
      fb.onclick = () => openMove(["p:" + p.id], renderManage);
      const del = el("button", "btn", "삭제"); del.type = "button"; del.setAttribute("aria-label", `${p.title} 삭제`);
      del.onclick = async () => {
        if (!del.classList.contains("confirm")) {
          del.classList.add("confirm"); del.textContent = "정말 삭제";
          setTimeout(() => { del.classList.remove("confirm"); del.textContent = "삭제"; }, 3000); return;
        }
        if (await removePack(p.id)) renderManage();
      };
      acts.append(fb, del);
      li.append(txt, acts); list.append(li);
    });
  }
  $("#manageOpen").onclick = () => open("manage");
  $("#resume").onclick = () => { if (S.p.cont) openPack(S.p.cont.id); };

  // ---------- navigation ----------
  const TITLES = { home: "출퇴근 영어", saved: "북마크", review: "복습", speak: "말하기", talk: "30초 말하기", ask: "Claude에게 묻기", drive: "운전 모드", manage: "팩 관리", wrong: "오답노트", wquiz: "오답 퀴즈" };
  const NAV = { tab: "home", stack: [] };
  let current = "home";
  function show(name, arg) {
    if (current === "player" && name !== "player") { exitFs(); M.pause(); clearInterval(P.timer); }
    editEnd();
    if (current === "speakrun" && name !== "speakrun") { clearTimeout(SK.timer); micOff(); }
    if (current === "talk" && name !== "talk") talkStop();
    if (current === "drive" && name !== "drive") driveStop();
    if (current !== name || name === "savedpack") stopClip();
    current = name;
    document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== "v-" + name; });
    $("#backBtn").hidden = !NAV.stack.length;
    if (TITLES[name]) $("#topTitle").textContent = TITLES[name];
    document.querySelectorAll(".tabs button").forEach((b) => { if (b.dataset.tab === NAV.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    if (name === "home") renderHome();
    if (name === "saved") renderSaved();
    if (name === "speak") renderSpeak();
    if (name === "speakrun") startSpeak(arg);
    if (name === "talk") renderTalk(true);
    if (name === "drive") openDrive();
    if (name === "manage") renderManage();
    if (name === "folder") renderFolder(arg);
    if (name === "grammar") openGrammar(arg);
    if (name === "wrong") renderWrong();
    if (name === "wquiz") startWrongQuiz();
    if (name === "savedfolder") renderSavedFolder(arg);
    if (name === "ask") initAsk();
    if (name === "savedpack") renderSavedPack(arg);
    if (name === "review") { startReview(); if (RV.queue.length) setTimeout(playClip, 300); }
    renderChrome(); window.scrollTo(0, 0);
  }
  function go(tab) { NAV.tab = tab; NAV.stack = []; show(tab); }
  function open(name, arg) {
    const top = NAV.stack[NAV.stack.length - 1];
    if (top && top.name === name) top.arg = arg; else NAV.stack.push({ name, arg });
    show(name, arg);
  }
  function back() {
    NAV.stack.pop();
    const top = NAV.stack[NAV.stack.length - 1];
    if (!top) { show(NAV.tab); return; }
    if (top.name === "player") { NAV.stack.pop(); openPack(top.arg, true); return; }
    show(top.name, top.arg);
  }
  document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => go(b.dataset.tab); });
  $("#backBtn").onclick = back;

  // ---------- boot ----------
  renderChrome(); renderHome();
  // screens that list pack content draw again once the packs are in
  loadPacks().then(() => { renderHome(); if (current === "wrong") renderWrong(); if (current === "saved") renderSaved(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw", e));
})();
