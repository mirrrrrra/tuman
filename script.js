(function () {
  "use strict";

  const sb = window.sb;
  const OWNERS = ["1707227"];
  const isOwner = (id) => OWNERS.includes(String(id));

  const mem = {};
  const store = {
    get(k) {
      try {
        const v = localStorage.getItem(k);
        if (v !== null) return v;
      } catch (e) {}
      return k in mem ? mem[k] : null;
    },
    set(k, v) {
      mem[k] = String(v);
      try {
        localStorage.setItem(k, v);
      } catch (e) {}
    },
    del(k) {
      delete mem[k];
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    },
  };

  const TOKEN_KEY = "tuman_token";
  store.del("tuman_session");

  const session = { token: store.get(TOKEN_KEY) || null };
  let me = null;
  let adminUsers = [];
  let rosterCount = 0;
  let lastAdminJson = "";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $all = (sel, root) =>
    Array.from((root || document).querySelectorAll(sel));
  const isActive = (id) => $("#" + id).classList.contains("active");
  const stageKey = (id) => "tuman_stage_" + id;
  const tieKey = (id) => "tuman_tie_" + id;

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }
  const fmt = (str) =>
    escapeHtml(str).replace(/\*\*(.+?)\*\*/g, '<span class="hl">$1</span>');

  function showScreen(id) {
    $all(".screen").forEach((s) => s.classList.remove("active"));
    $("#" + id).classList.add("active");
    window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  let askEl = null;
  function askConfirm(o) {
    return new Promise((resolve) => {
      if (!askEl) {
        askEl = document.createElement("div");
        askEl.className = "ask-backdrop";
        document.body.appendChild(askEl);
      }
      askEl.innerHTML =
        '<div class="ask-box" role="dialog" aria-modal="true">' +
        '<h3 class="ask-title">' + escapeHtml(o.title || "Подтвердите") + "</h3>" +
        '<div class="ask-line"></div>' +
        '<p class="ask-text">' + escapeHtml(o.text || "") + "</p>" +
        '<div class="ask-btns">' +
        '<button class="btn" data-ask="0">' + escapeHtml(o.cancel || "Отмена") + "</button>" +
        '<button class="btn ' + (o.danger ? "btn-danger" : "btn-primary") +
        '" data-ask="1">' + escapeHtml(o.ok || "Да") + "</button></div></div>";
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close(false);
      };
      const close = (v) => {
        askEl.classList.remove("open");
        document.removeEventListener("keydown", onKey, true);
        askEl.onclick = null;
        resolve(v);
      };
      document.addEventListener("keydown", onKey, true);
      askEl.onclick = (e) => {
        if (e.target === askEl) close(false);
        const b = e.target.closest("[data-ask]");
        if (b) close(b.dataset.ask === "1");
      };
      askEl.classList.add("open");
      const first = askEl.querySelector('[data-ask="0"]');
      if (first) first.focus();
    });
  }

  async function rpc(name, args) {
    let res;
    try {
      res = await sb.rpc(name, args);
    } catch (e) {
      console.error(name, e);
      return { error: "network" };
    }
    if (res.error) {
      console.error(name, res.error);
      return { error: "network" };
    }
    const data = res.data;
    if (data && data.error) {
      if (data.error === "auth" && session.token)
        logoutLocal("Нужно войти заново");
      return { error: data.error };
    }
    return { data };
  }

  function logoutLocal(msg) {
    stopMusic();
    session.token = null;
    me = null;
    adminUsers = [];
    lastAdminJson = "";
    S = null;
    lastJson = "";
    switchTab("tasks");
    const db = $("#dashBox");
    if (db) db.hidden = true;
    store.del(TOKEN_KEY);
    showScreen("screen-auth");
    if (msg) toast(msg);
  }

  function parseRoster(text) {
    const rows = [];
    text.split(/\r?\n/).forEach((line) => {
      const p = line.split("\t");
      if (p.length < 4) return;
      const id = p[1].trim();
      if (!/^\d+$/.test(id)) return;
      rows.push({ id, name: p[2].trim(), role: p[3].trim() });
    });
    return rows;
  }

async function saveRoster(text) {
  const rows = parseRoster(text);
  if (!rows.length) {
    toast("Не нашла строк. Скопируй таблицу целиком");
    return false;
  }
  const res = await rpc("app_roster_save", {
    p_token: session.token,
    p_rows: rows,
  });
  if (res.error) {
    toast(res.error === "forbidden" ? "Нет доступа" : "Не сохранилось");
    return false;
  }
  toast("Сохранено: " + rows.length);
  return true;
}
  async function refreshAdmin(force) {
    if (!session.token) return;
    const res = await rpc("app_admin_list", { p_token: session.token });
    if (res.error) return;
    const next = JSON.stringify(res.data);
    if (!force && next === lastAdminJson) return;
    lastAdminJson = next;
    adminUsers = res.data.users || [];
    rosterCount = res.data.rosterCount || 0;
    if (me && me.isAdmin && isActive("screen-dashboard")) renderAdminPanel();
  }

  function routeAfterLogin() {
    if (!me) return;
    if (!me.approved && !me.isAdmin) {
      $("#pendingName").textContent = "Тебя ждёт туман, " + me.name;
      showScreen("screen-pending");
      return;
    }
    const tie = !me.path && store.get(tieKey(me.id));
    if (tie) {
      try {
        showTieChoice(JSON.parse(tie));
        return;
      } catch (e) {}
    }
    if (me.path && PATHS[me.path] && store.get(stageKey(me.id)) === "result") {
      goToResultScreen();
      return;
    }
    if (me.path) {
      showScreen("screen-dashboard");
      renderDashboard();
    } else showScreen("screen-intro");
  }

  function bindAuth() {
    const idInput = $("#inputId");
    const pinInput = $("#inputPin");
    const btnAuth = $("#btnStartAuth");
    let busy = false;

    const submit = async () => {
      if (busy) return;
      const id = idInput.value.trim();
      const pin = pinInput.value.trim();
      const err = $("#authErr");
      const fail = (msg, html) => {
        if (html) err.innerHTML = msg;
        else err.textContent = msg;
        err.classList.add("show");
      };
      if (!id || !pin) return fail("Заполни ID и пароль.");
      if (!/^\d+$/.test(id)) return fail("ID — это только цифры.");
      if (pin.length < 3) return fail("Пароль — хотя бы 3 символа.");
      err.classList.remove("show");
      busy = true;
      btnAuth.disabled = true;
      try {
        const res = await rpc("app_login", { p_id: id, p_pin: pin });
        if (res.error === "not_in_roster") {
          return fail(
            'Такого ID нет в перекличке. Если вы думаете, что это ошибка, обратитесь к Темь [1707227] <a class="link-red" href="https://vk.ru/mirotvorkaa" target="_blank" rel="noopener">VK</a>.',
            true,
          );
        }
        if (res.error === "bad_pin")
          return fail(
            "Неверный пароль. Забыл — попроси ответственного сбросить.",
          );
        if (res.error === "too_many")
          return fail("Слишком много попыток. Подожди 10 минут.");
        if (res.error === "invalid") return fail("Проверь ID и пароль.");
        if (res.error || !res.data || !res.data.token)
          return fail("Нет связи с сервером. Попробуй ещё раз.");
        session.token = res.data.token;
        store.set(TOKEN_KEY, session.token);
        me = res.data.user;
        pinInput.value = "";
        routeAfterLogin();
      } finally {
        busy = false;
        btnAuth.disabled = false;
      }
    };

    btnAuth.addEventListener("click", submit);
    [idInput, pinInput].forEach((el) =>
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }),
    );
  }

  let visionStep = 0;
  let testTally = { likotvorcy: 0, ratniki: 0, kudesniki: 0 };
  let storyQueue = [],
    storyIndex = 0,
    storyOnComplete = null,
    storyLock = false;
  let choiceLock = false;
  let pickedOpt = null;

  function renderQuestion() {
    const vision = VISIONS[visionStep];
    pickedOpt = null;
    $("#btnTestNext").disabled = true;
    $("#testStep").textContent = visionStep + 1 + " / " + VISIONS.length;
    $("#testFill").style.width =
      Math.round((visionStep / VISIONS.length) * 100) + "%";
    const parts = vision.text.split("\n\n");
    const lead = parts.length > 1 ? parts.pop() : "";
    $("#questionText").innerHTML =
      escapeHtml(parts.join("\n\n")) +
      (lead
        ? '<span class="question-lead">' + escapeHtml(lead) + "</span>"
        : "");
    const wrap = $("#optionList");
    wrap.innerHTML = "";
    vision.options
      .map((opt) => ({ opt, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .forEach(({ opt }) => {
        const div = document.createElement("div");
        div.className = "option-item";
        div.textContent = opt.t;
        div.setAttribute("role", "button");
        div.setAttribute("tabindex", "0");
        const pick = () => {
          pickedOpt = opt;
          $all(".option-item", wrap).forEach((x) =>
            x.classList.toggle("selected", x === div),
          );
          $("#btnTestNext").disabled = false;
        };
        div.addEventListener("click", pick);
        div.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        });
        wrap.appendChild(div);
      });
  }

  function nextQuestion() {
    if (!pickedOpt || choiceLock) return;
    choiceLock = true;
    setTimeout(() => {
      choiceLock = false;
    }, 350);
    testTally[pickedOpt.p]++;
    pickedOpt = null;
    visionStep++;
    if (visionStep < VISIONS.length) {
      renderQuestion();
      window.scrollTo(0, 0);
    } else {
      $("#testFill").style.width = "100%";
      finishTest();
    }
  }

  function renderStoryItem(item) {
    const textEl = $("#storyText");
    textEl.innerHTML =
      '<span class="story-inner">' + fmt(item.text) + "</span>";
    textEl.classList.toggle("emphasis", !!item.emphasis);
    textEl.classList.remove("story-in");
    void textEl.offsetWidth;
    textEl.classList.add("story-in");
  }

  function playStory(items, onComplete) {
    storyQueue = items;
    storyIndex = 0;
    storyOnComplete = onComplete;
    renderStoryItem(storyQueue[0]);
    showScreen("screen-story");
  }

  function finishTest() {
    if (!me) {
      showScreen("screen-auth");
      return;
    }
    const max = Math.max(...Object.values(testTally));
    const leaders = Object.keys(testTally).filter((k) => testTally[k] === max);
    if (leaders.length === 1) applyPath(leaders[0], false);
    else {
      store.set(tieKey(me.id), JSON.stringify(leaders));
      playStory(WAKE_STORY.concat(ITOG_INTRO_STORY, [ITOG_DOUBT]), () =>
        showTieChoice(leaders),
      );
    }
  }

  let saving = false;
  async function applyPath(best, afterTie) {
    if (!me || saving) return;
    saving = true;
    let res;
    for (let i = 0; i < 3; i++) {
      res = await rpc("app_save_path", {
        p_token: session.token,
        p_path: best,
      });
      if (res.error !== "network") break;
      await sleep(800 * (i + 1));
    }
    saving = false;
    if (res.error === "already") {
      const fresh = await rpc("app_me", { p_token: session.token });
      if (fresh.data) {
        me = fresh.data;
        routeAfterLogin();
      }
      return;
    }
    if (res.error) {
      toast("Не сохранилось, проверь интернет");
      if (!afterTie) {
        showTieChoice([best]);
        return;
      }
      $all(".tie-card").forEach((x) => (x.disabled = false));
      return;
    }
    me = res.data.user;
    store.set(stageKey(me.id), "result");
    store.del(tieKey(me.id));
    if (afterTie) goToResultScreen();
    else
      playStory(
        WAKE_STORY.concat(ITOG_INTRO_STORY, [ITOG_KNOWS]),
        goToResultScreen,
      );
  }

  function showTieChoice(leaders) {
    let scr = $("#screen-tie");
    if (!scr) {
      scr = document.createElement("section");
      scr.id = "screen-tie";
      scr.className = "screen";
      document.body.appendChild(scr);
    }
    scr.innerHTML =
      '<div class="tie-box"><p class="tie-text">Выберите, кто вы.</p><div class="tie-cards">' +
      leaders
        .map(
          (k) =>
            '<button class="tie-card" data-path="' +
            k +
            '"><span class="tie-icon">' +
            PATHS[k].icon +
            "</span>" +
            '<span class="tie-name">' +
            escapeHtml(PATHS[k].name) +
            "</span>" +
            '<span class="tie-lore">' +
            escapeHtml(PATHS[k].lore) +
            "</span>" +
            '<span class="tie-buff"><i>Бафф</i> к категории заданий «' +
            escapeHtml(PATHS[k].buffName) +
            "»</span></button>",
        )
        .join("") +
      "</div></div>";
    $all(".tie-card", scr).forEach((b) =>
      b.addEventListener("click", () => {
        $all(".tie-card", scr).forEach((x) => (x.disabled = true));
        applyPath(b.dataset.path, true);
      }),
    );
    showScreen("screen-tie");
  }

  function goToResultScreen() {
    const path = me && PATHS[me.path];
    if (!path) {
      showScreen("screen-dashboard");
      renderDashboard();
      return;
    }
    $("#resultIcon").innerHTML = path.icon;
    $("#resultPathName").textContent = path.title;
    $("#resultBuffText").textContent =
      "Вы получаете бафф к категории заданий «" + path.buffName + "»";
    $("#resultLore").textContent = path.lore;
    showScreen("screen-result");
  }

  function playMusic() {
    const a = $("#bgMusic");
    a.volume = 0.45;
    a.play().catch(() => {});
  }

  let musicTimer = null;
  function stopMusic() {
    const a = $("#bgMusic");
    clearInterval(musicTimer);
    let steps = 0;
    musicTimer = setInterval(() => {
      steps++;
      if (steps < 20 && a.volume > 0.06)
        a.volume = Math.max(0, a.volume - 0.06);
      else {
        clearInterval(musicTimer);
        musicTimer = null;
        a.pause();
        a.currentTime = 0;
      }
    }, 120);
  }

  function bindVision() {
    $("#storyCard").addEventListener("click", () => {
      if (storyLock) return;
      storyLock = true;
      setTimeout(() => {
        storyLock = false;
      }, 300);
      storyIndex++;
      if (storyIndex < storyQueue.length)
        renderStoryItem(storyQueue[storyIndex]);
      else {
        const cb = storyOnComplete;
        storyOnComplete = null;
        if (cb) cb();
      }
    });
    $("#introCard").addEventListener("click", () => {
      playMusic();
      playStory(VISION_INTRO_CARDS, () => {
        visionStep = 0;
        testTally = { likotvorcy: 0, ratniki: 0, kudesniki: 0 };
        renderQuestion();
        showScreen("screen-test");
      });
    });
    $("#btnTestNext").addEventListener("click", nextQuestion);
    $("#btnContinueFromResult").addEventListener("click", () =>
      showScreen("screen-final"),
    );
    $("#btnLeaveVision").addEventListener("click", () => {
      if (me) store.del(stageKey(me.id));
      stopMusic();
      showScreen("screen-dashboard");
      renderDashboard();
    });
  }

  const ADMIN_DONE = {
    approve: "Подтверждён",
    promote: "Права выданы",
    demote: "Права сняты",
    resetpin: "Пароль сброшен",
    delete: "Удалён",
  };

  async function adminAct(act, uid) {
    const u = adminUsers.find((x) => x.id === uid);
    if (!u) return;
    if (act === "delete") {
      if (isOwner(uid)) return toast("Удалить нельзя");
      if (me && me.id === uid) return toast("Нельзя удалить себя");
      if (
        !(await askConfirm({
          title: "Удалить игрока?",
          text: "«" + (u.name || uid) + "» будет удалён насовсем. Действие необратимо.",
          ok: "Удалить",
          danger: true,
        }))
      )
        return;
    }
    if (act === "resetpin") {
      if (
        !(await askConfirm({
          title: "Сбросить пароль?",
          text: "«" + (u.name || uid) + "» введёт новый пароль при следующем входе.",
          ok: "Сбросить",
        }))
      )
        return;
    }
    const res = await rpc("app_admin_set", {
      p_token: session.token,
      p_uid: uid,
      p_action: act,
    });
    if (res.error === "auth") return;
    if (res.error === "forbidden") return toast("Нет доступа");
    if (res.error) return toast("Не получилось, проверь интернет");
    toast(ADMIN_DONE[act]);
    await refreshAdmin(true);
  }

  const peopleOpen = new Set();

  function adminPeople(wrap) {
    const keepText = $("#rosterText") ? $("#rosterText").value : "";
    const keepQuery = $("#manageInput") ? $("#manageInput").value : "";
    const hadFocus =
      document.activeElement && document.activeElement.id === "manageInput";
    const selfId = me ? me.id : null;
    const canManage = isOwner(selfId);

    const all = adminUsers
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const pending = all.filter((u) => !u.isAdmin && !u.approved);
    const admins = all.filter((u) => u.isAdmin);
    const members = all.filter((u) => !u.isAdmin && u.approved);
    const pathMembers = all.filter((u) => u.isAdmin || u.approved);

    const btn = (act, uid, label, cls) =>
      '<button class="adm-btn ' +
      (cls || "") +
      '" data-act="' +
      act +
      '" data-uid="' +
      escapeHtml(uid) +
      '">' +
      label +
      "</button>";
    const del = (u) =>
      isOwner(u.id) || u.id === selfId || (u.isAdmin && !canManage)
        ? ""
        : btn("delete", u.id, "Удалить", "danger");
    const reset = (u) =>
      u.hasPin &&
      !(u.isAdmin && !canManage) &&
      !(isOwner(u.id) && u.id !== selfId)
        ? btn("resetpin", u.id, "Сбросить пароль")
        : "";
    const promote = (u) =>
      canManage ? btn("promote", u.id, "Дать права", "gold") : "";
    const adminActions = (u) =>
      (isOwner(u.id)
        ? '<span class="adm-id">мяу</span>'
        : canManage
          ? btn("demote", u.id, "Снять права", "danger")
          : "") +
      reset(u) +
      del(u);
    const memberActions = (u) =>
      u.isAdmin ? adminActions(u) : promote(u) + reset(u) + del(u);

    const row = (u, actions, pick) =>
      '<div class="pp-row' +
      (pick ? " pickable" : "") +
      '"' +
      (pick ? ' data-pick="' + escapeHtml(u.id) + '"' : "") +
      '><span class="pp-who"><span class="pp-name">' +
      escapeHtml(u.name || "—") +
      '</span><span class="pp-id">' +
      escapeHtml(u.id) +
      "</span></span>" +
      (actions ? '<span class="adm-acts">' + actions + "</span>" : "") +
      "</div>";

    const fold = (key, title, list, empty) =>
      '<details class="pp-fold" data-key="' +
      key +
      '"' +
      (peopleOpen.has(key) ? " open" : "") +
      '><summary><span class="pp-sum-title">' +
      escapeHtml(title) +
      '</span><span class="adm-count">' +
      list.length +
      '</span></summary><div class="pp-list">' +
      (list.length
        ? list.map((u) => row(u, "", canManage)).join("")
        : '<p class="adm-empty">' + escapeHtml(empty) + "</p>") +
      "</div></details>";

    let html =
      '<div class="adm-stats">' +
      '<div class="adm-stat"><b>' +
      all.length +
      "</b><span>всего</span></div>" +
      '<div class="adm-stat' +
      (pending.length ? " hot" : "") +
      '"><b>' +
      pending.length +
      "</b><span>ожидают</span></div>" +
      '<div class="adm-stat"><b>' +
      members.length +
      "</b><span>игроков</span></div>" +
      '<div class="adm-stat"><b>' +
      admins.length +
      "</b><span>ответственных</span></div></div>";

    html +=
      '<section class="adm-card' +
      (pending.length ? " pp-hot" : "") +
      '"><h3 class="adm-title">Ожидают<span class="adm-count">' +
      pending.length +
      '</span></h3><div class="adm-line"></div>' +
      (pending.length
        ? '<div class="pp-list">' +
          pending
            .map((u) => row(u, btn("approve", u.id, "Подтвердить", "gold")))
            .join("") +
          "</div>"
        : '<p class="adm-empty">Новых заявок нет.</p>') +
      "</section>";

    if (canManage) {
      html +=
        '<section class="adm-card"><h3 class="adm-title">Управление</h3><div class="adm-line"></div>' +
        '<p class="adm-hint">Найди игрока по ID или имени (или нажми на него в списках ниже):<br>• <b>Удалить</b>: убрать игрока насовсем<br>• <b>Сбросить пароль</b>: игрок задаст новый при входе<br>• <b>Дать права / Снять права</b>: сделать ответственным или забрать роль</p>' +
        '<input id="manageInput" class="roster-text" type="text" autocomplete="off" placeholder="ID или имя игрока" /><div id="manageResults"></div></section>';
    }

    html +=
      '<section class="adm-card"><h3 class="adm-title">Все участники</h3><div class="adm-line"></div><div class="pp-folds">' +
      ["ratniki", "kudesniki", "likotvorcy"]
        .map((key) =>
          fold(
            key,
            PATHS[key].name,
            pathMembers.filter((u) => u.path === key),
            "Пока никого.",
          ),
        )
        .join("") +
      fold(
        "nopath",
        "Тест не пройден",
        members.filter((u) => !PATHS[u.path]),
        "Все прошли тест.",
      ) +
      fold("admins", "Ответственные", admins, "Пока никого.") +
      "</div></section>";

    html +=
      '<section class="adm-card"><h3 class="adm-title">Список Морёвки<span class="adm-count">' +
      rosterCount +
      '</span></h3><div class="adm-line"></div><textarea id="rosterText" class="roster-text" rows="8" placeholder="Вставь сюда таблицу целиком"></textarea>' +
      '<div class="adm-acts" style="margin-top:8px"><button class="adm-btn gold" id="rosterSave">Сохранить список</button></div></section>';

    wrap.innerHTML = '<div class="adm">' + html + "</div>";

    const ta = $("#rosterText");
    ta.value = keepText;
    $("#rosterSave").addEventListener("click", async () => {
      if (await saveRoster(ta.value)) {
        ta.value = "";
        await refreshAdmin(true);
      }
    });
    $all("[data-act]", wrap).forEach((b) =>
      b.addEventListener("click", () => adminAct(b.dataset.act, b.dataset.uid)),
    );
    $all(".pp-fold", wrap).forEach((d) =>
      d.addEventListener("toggle", () => {
        if (d.open) peopleOpen.add(d.dataset.key);
        else peopleOpen.delete(d.dataset.key);
      }),
    );

    const mi = $("#manageInput");
    const mr = $("#manageResults");
    if (!mi) return;
    const showManage = () => {
      const q = mi.value.trim().toLowerCase();
      if (!q) {
        mr.innerHTML = "";
        return;
      }
      const found = all
        .filter(
          (u) =>
            String(u.id).includes(q) ||
            (u.name || "").toLowerCase().includes(q),
        )
        .slice(0, 8);
      if (!found.length) {
        mr.innerHTML = '<p class="adm-empty">Никого не нашла.</p>';
        return;
      }
      mr.innerHTML =
        '<div class="pp-list">' +
        found.map((u) => row(u, memberActions(u))).join("") +
        "</div>";
      $all("[data-act]", mr).forEach((b) =>
        b.addEventListener("click", () =>
          adminAct(b.dataset.act, b.dataset.uid),
        ),
      );
    };
    mi.addEventListener("input", showManage);
    mi.value = keepQuery;
    showManage();
    if (hadFocus) mi.focus();
    $all("[data-pick]", wrap).forEach((r) =>
      r.addEventListener("click", () => {
        mi.value = r.dataset.pick;
        showManage();
        mi.scrollIntoView({ block: "center", behavior: "smooth" });
      }),
    );
  }

  const ROOT = "1707227";
  const BUCKET = "reports";
  const CONSENT_TAG = "[[blog-ok]]";
  const IMG_CONSENT = "consent:1";
  const hasConsent = (a) => String(a || "").includes(CONSENT_TAG);
  const stripConsent = (a) =>
    String(a || "")
      .replace(CONSENT_TAG, "")
      .trim();
  const taskNeedsConsent = (t) => (t.images || []).includes(IMG_CONSENT);
  const realImages = (t) => (t.images || []).filter((x) => x !== IMG_CONSENT);
    const MAX_IMGS = 3;
  const imgsOf = (s) =>
    Array.isArray(s.images) && s.images.length
      ? s.images
      : s.image
        ? [s.image]
        : [];
  const consentOf = (s) => s.consent === true || hasConsent(s.answer);
  const FINAL_TAG = "[[final]]";
  const isFinal = (r) => String(r || "").includes(FINAL_TAG);
  const SKIP_TAG = "[[skip]]";
  const isSkip = (r) => isFinal(r) && String(r || "").includes(SKIP_TAG);
  const stripFinal = (r) =>
    String(r || "")
      .replace(FINAL_TAG, "")
      .replace(SKIP_TAG, "")
      .trim();
  const stLabel = (id) =>
    stOf(id) === "rejected" && S.progress[id] && isSkip(S.progress[id].reason)
      ? "пропущено"
      : STATUS[stOf(id)];
  const EVENT_DAYS = 7;
  const ROWS_AHEAD = 1;
  const CHAIN_UNLOCK = true;
  const LOCKED_TEXT = "Задания будут доступны с 02.11";
  const TOTAL_TASKS = 21;
  const EVENT_START = new Date(2026, 10, 2);
  const STATUS = {
    none: "не начато",
    pending: "на проверке",
    approved: "принято",
    rejected: "отклонено",
  };
  const TREE_SEED = 170717;
  const SPHERE_NAME = {
    tvorenie: "Забава",
    dvizhenie: "Авантюра",
    slovo: "Интуиция",
  };
  const SPHERE_PREFIX = { tvorenie: "tv", dvizhenie: "dv", slovo: "sl" };
  const BUFF_OF = {
    likotvorcy: "tvorenie",
    ratniki: "dvizhenie",
    kudesniki: "slovo",
  };
  const DAILY_INTRO =""

  const esc = escapeHtml;
  const rich = (s) =>
    esc(s)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a class="link-red" href="$2" target="_blank" rel="noopener">$1</a>',
      )
      .replace(/\*\*(.+?)\*\*/g, '<span class="t-pink">$1</span>')
      .replace(/==(.+?)==/g, '<span class="t-blue">$1</span>')
      .replace(/\*(.+?)\*/g, "<em>$1</em>");
  const plain = (s) =>
    esc(
      String(s == null ? "" : s)
        .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, "")
        .replace(/\*\*|==|\*/g, ""),
    );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round1 = (n) => Math.round(n * 10) / 10;
  const num = (n) => String(round1(Number(n) || 0)).replace(".", ",");
  const pad2 = (n) => (n < 10 ? "0" : "") + n;
  const wordCount = (s) => (String(s || "").match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;

  function dateOf(day) {
    const d = new Date(EVENT_START);
    d.setDate(d.getDate() + day - 1);
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1);
  }

  let S = null;
  let lastJson = "";
  let tab = "tasks";
  let showDone = true;
  let modal = null;
  let drawing = false;
  let tree = null;

  const stOf = (id) => (S && S.progress[id] && S.progress[id].status) || "none";
  const anyModalOpen = () =>
    $("#taskModalBackdrop").classList.contains("open") ||
    $("#reportModalBackdrop").classList.contains("open");

  async function loadState(force) {
    if (!session.token) return;
    const res = await rpc("app_state", { p_token: session.token });
    if (res.error || !res.data) return;
    const j = JSON.stringify(res.data);
    if (!force && j === lastJson) return;
    S = res.data;
    me = S.user;
    if (isActive("screen-dashboard") && !anyModalOpen()) {
      lastJson = j;
      renderAll();
    } else if (!isActive("screen-dashboard")) {
      lastJson = j;
    }
  }
  function renderDashboard() {
    return loadState(true);
  }
  function renderAdminPanel() {
    if (tab === "mod" && modTab === "people") renderMod();
  }

  function renderAll() {
    if (!S || !me) return;
    const locked = !me.isAdmin && S.day < 1;
    $("#lockedBox").hidden = !locked;
    $("#dashBox").hidden = locked;
    $("#lockedText").textContent = LOCKED_TEXT;
    if (locked) return;

    $("#dashName").textContent = me.name;
    $("#dayNum").textContent = S.day;
    const isRoot = me.id === ROOT;
    $("#dayMinus").hidden = !isRoot;
    $("#dayPlus").hidden = !isRoot;
    const p = PATHS[me.path];
    $("#chipPath").textContent = "Путь: " + (p ? p.name : "—");
    $("#chipBuff").textContent = "Бафф: " + (p ? p.buffName : "—");
$("#personalScore").textContent = num(S.score + (S.dailyScore || 0));
const dailyApproved = Object.keys(S.progress || {}).filter(
  (k) => k.indexOf("daily-") === 0 && S.progress[k].status === "approved",
).length;
const taskDone = S.doneCount - dailyApproved;
$("#levelPoints").textContent = taskDone + " / " + TOTAL_TASKS;
$("#levelFill").style.width =
  Math.min(100, (taskDone / TOTAL_TASKS) * 100) + "%";

    $("#modTabBtn").hidden = !me.isAdmin;
    if (!me.isAdmin && tab === "mod") switchTab("tasks");

    renderTasks();
    renderDaily();
    if (me.isAdmin && tab === "mod") safeRenderMod();
  }

  function switchTab(name) {
    tab = name;
    $all(".view-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name),
    );
    const at = $('.view-tab[data-tab="' + name + '"]');
    if (at && at.scrollIntoView)
      at.scrollIntoView({ block: "nearest", inline: "center" });
    $all(".tabview").forEach((v) =>
      v.classList.toggle("active", v.id === "tabview-" + name),
    );
    if (!S) return;
    if (name === "tasks") renderTasks();
        if (name === "daily") renderDaily();
    if (name === "mod") {
      renderMod();
      if (modTab === "people") refreshAdmin(true);
    }
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function layout() {
    const byLayer = [];
    S.tasks.forEach((t) =>
      (byLayer[t.layer] = byLayer[t.layer] || []).push(t.id),
    );
    const layers = [],
      coins = {},
      depends = {};
    byLayer.forEach((arr, li) => {
      if (!arr) return;
      const rng = mulberry32(TREE_SEED + li * 7919);
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      a.forEach((id) => (coins[id] = rng()));
      layers[li] = a;
    });
    layers.forEach((ids, li) => {
      if (!ids) return;
      const P = layers[li - 1];
      if (!li || !P) {
        ids.forEach((id) => (depends[id] = []));
        return;
      }
      const px = (k) => (k + 0.5) / P.length;
      const cx = (j) => (j + 0.5) / ids.length;
      const par = ids.map((id, j) => {
        if (ids.length === P.length) return [j];
        const near = P.map((_, k) => ({ k, d: Math.abs(px(k) - cx(j)) })).sort(
          (x, y) => x.d - y.d,
        );
        const l = [near[0].k];
        if (near[1] && near[1].d < 0.4 && coins[id] < 0.4) l.push(near[1].k);
        return l;
      });
      P.forEach((_, k) => {
        if (par.some((l) => l.includes(k))) return;
        let b = 0,
          bd = 1e9;
        ids.forEach((__, j) => {
          const d = Math.abs(px(k) - cx(j));
          if (d < bd) {
            bd = d;
            b = j;
          }
        });
        par[b].push(k);
      });
      ids.forEach((id, j) => (depends[id] = par[j].map((k) => P[k])));
    });
    return { layers, depends };
  }
  function isUnlocked(id) {
    if (me && me.isAdmin) return true;
    if (stOf(id) !== "none") return true;
    const dep = tree.depends[id] || [];
    if (!dep.length) return true;
    return dep.some(
      (pid) =>
        stOf(pid) === "approved" ||
        stOf(pid) === "pending" ||
        (stOf(pid) === "rejected" && isFinal(S.progress[pid].reason)),
    );
  }

  function renderTasks() {
    const wrap = $("#taskTree");
    if (!wrap || !S) return;
    tree = layout();
    const byId = {};
    S.tasks.forEach((t) => (byId[t.id] = t));
    const isAdm = !!(me && me.isAdmin);
const effDay = isAdm ? 999 : S.day;
    const W = Math.max(280, wrap.clientWidth || 900);
    const mob = W < 720;
    const wide = true;
    wrap.classList.toggle("mob", mob);
    const NW = mob ? 112 : 222;
    const NH = mob ? 120 : 190,
      GAP = mob ? 20 : 70,
      JY = mob ? 10 : 30;
    const TW = Math.min(W, 1040);
    const hash = (s) => {
      let h = 0;
      for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
      return h;
    };
    const place = (r, j, n, li) => {
      const rowW = Math.min(W, Math.max(TW, n * (NW + 14)));
      const x0 = (W - rowW) / 2;
      const cell = rowW / n;
      const room = Math.max(0, (cell - NW) / 2 - 6);
      const jx = (r() * 2 - 1) * Math.min(room, 22);
      const jy = (r() * 2 - 1) * JY * 0.25;
      const dir = li % 2 ? -1 : 1;
      const wave = n > 1 ? (j % 2 ? 0.8 : -0.4) * JY * dir : 0;
      let left = x0 + (j + 0.5) * cell + jx;
      left = Math.max(x0 + NW / 2 + 4, Math.min(x0 + rowW - NW / 2 - 4, left));
      return { left, off: wave + jy };
    };
    const wrapNode = (left, top, node) =>
      '<div class="tree-node-wrap" style="left:' +
      left +
      "px;top:" +
      top +
      "px;width:" +
      NW +
      "px;height:" +
      NH +
      'px">' +
      node +
      "</div>";

const kindOf = (id, li) => {
  const t = byId[id],
    st = stOf(id),
    dayLocked = li + 1 > effDay;
  if (isAdm && t) return null;
  if (!t) return dayLocked ? "day" : "soon";
      if (st === "none" && dayLocked) return "day";
      return null;
    };
    const lockInfo = (kind, li) => {
      const date = dateOf(li + 1);
      return {
        date,
        title:
          kind === "day"
            ? "Откроется " + date
            : kind === "chain"
              ? "Закрыто"
              : "Скоро",
        note:
          kind === "day"
            ? (li === effDay ? "завтра · день " : "день ") + (li + 1)
            : kind === "chain"
              ? "откроется, когда выполнишь задание выше"
              : "откроется позже",
        msg:
          kind === "day"
            ? "Это задание откроется " + date
            : kind === "chain"
              ? "Выполни задание выше, и это откроется"
              : "Это задание появится позже",
        short: kind === "day" ? date : kind === "chain" ? "закрыто" : "скоро",
      };
    };
    const lockAttrs = (id, info) =>
      'data-id="' +
      esc(id) +
      '" data-locked="1" data-msg="' +
      esc(info.msg) +
      '"';

    let h = '<svg class="tree-lines" aria-hidden="true"></svg>';
    if (!wide) h += '<div class="m-list">';
    let y = 40;
    let prevSlots = null;
    let lockedShown = 0;
    const maxRows = Math.max(EVENT_DAYS, tree.layers.length);
const rows = isAdm
  ? tree.layers.length
  : Math.min(maxRows, Math.max(0, effDay) + 1 + ROWS_AHEAD);

    for (let li = 0; li < rows; li++) {
      const real = tree.layers[li] || [];
      const slots = [];
      for (let j = 0; j < Math.max(3, real.length); j++)
        slots.push(real[j] || "ph-" + li + "-" + j);
      slots.forEach((id, j) => {
        if (byId[id]) return;
        tree.depends[id] = prevSlots
          ? [prevSlots[Math.min(j, prevSlots.length - 1)]]
          : [];
      });
      prevSlots = slots;

let vis = slots.filter(
  (id) => (showDone || stOf(id) !== "approved") && (!isAdm || byId[id]),
);
      if (li + 1 > effDay) {
        if (lockedShown >= 3) continue;
        vis = vis.slice(0, 3 - lockedShown);
        lockedShown += vis.length;
      }
      if (!vis.length) continue;

      if (wide) {
        vis.forEach((id, j) => {
          const t = byId[id],
            st = stOf(id);
          let p;
          if (mob) {
            const r = mulberry32(TREE_SEED + hash(id));
            const lane = [0.27, 0.73, 0.42][j % 3];
            const lx = Math.max(
              NW / 2 + 6,
              Math.min(W - NW / 2 - 6, W * lane + (r() * 2 - 1) * 16),
            );
            p = { left: lx, off: j * 74 + (r() * 2 - 1) * 9 };
          } else p = place(mulberry32(TREE_SEED + hash(id)), j, vis.length, li);
          const kind = kindOf(id, li);
          let node;
          if (mob) {
            if (kind) {
              const info = lockInfo(kind, li);
              node =
                '<div class="locked-orb" ' +
                lockAttrs(id, info) +
                ">" +
                '<span class="tno-name dim">' +
                info.short +
                "</span></div>";
            } else {
              node =
                '<div class="task-node-orb state-' +
                st +
                '" data-id="' +
                esc(id) +
                '">' +
                '<span class="tno-pts">+' +
                num(t.pts) +
                "</span>" +
                '<span class="tno-name">' +
                esc(t.name) +
                "</span></div>";
            }
          } else if (kind) {
            const info = lockInfo(kind, li);
            node =
              '<div class="task-node-card locked" ' +
              lockAttrs(id, info) +
              '><div class="tnc-name">' +
              info.title +
              '</div><div class="tnc-lock-note">' +
              info.note +
              "</div></div>";
          } else {
            node =
              '<div class="task-node-card state-' +
              st +
              '" data-id="' +
              esc(id) +
              '">' +
              '<div class="tnc-top"><div class="tnc-name">' +
              esc(t.name) +
              "</div></div>" +
              '<div class="tnc-req">' +
              plain(t.req || "Описание появится позже.") +
              "</div>" +
              '<div class="tnc-bottom"><span class="tnc-pts">баллы: <b>' +
              num(t.pts) +
              '</b></span><span class="tnc-status">' +
              stLabel(id) +
              "</span></div></div>";
          }
          h += wrapNode(p.left, y + p.off, node);
        });
        y += mob ? (vis.length - 1) * 74 + NH + GAP : NH + GAP + JY * 2;
      } else {
        h +=
          '<div class="m-day">День ' +
          (li + 1) +
          " · " +
          dateOf(li + 1) +
          "</div>";
        vis.forEach((id) => {
          const t = byId[id],
            st = stOf(id);
          const kind = kindOf(id, li);
          if (kind) {
            const info = lockInfo(kind, li);
            h +=
              '<div class="m-card locked" ' +
              lockAttrs(id, info) +
              '<span class="m-lock-d">' +
              info.short +
              "</span></div>";
          } else {
            h +=
              '<div class="m-card state-' +
              st +
              '" data-id="' +
              esc(id) +
              '">' +
              '<div class="m-name">' +
              esc(t.name) +
              "</div>" +
              '<div class="m-bottom"><span class="m-pts">+' +
              num(t.pts) +
              '</span><span class="m-st">' +
              STATUS[st] +
              "</span></div></div>";
          }
        });
      }
    }

    if (!wide) h += "</div>";
    wrap.innerHTML = h;
    if (wide) wrap.style.height = y + 20 + "px";
    else {
      wrap.style.height = "";
      tree.noLines = true;
    }
    requestAnimationFrame(drawTreeLines);
  }

  function drawTreeLines() {
    const wrap = $("#taskTree");
    if (!wrap || !tree || !S) return;
    if (tree.noLines) return;
    const svg = wrap.querySelector(".tree-lines");
    if (!svg) return;
    const cr = wrap.getBoundingClientRect();
    if (!cr.width) return;
    svg.setAttribute("width", wrap.clientWidth);
    svg.setAttribute("height", wrap.scrollHeight);
    const pos = {};
    $all("[data-id]", wrap).forEach((n) => {
      const r = n.getBoundingClientRect();
      const mobT = wrap.classList.contains("mob");
      pos[n.dataset.id] = {
        cx: r.left + r.width / 2 - cr.left,
        top: r.top - cr.top,
        bottom: r.bottom - cr.top + (mobT ? 20 : 0),
      };
    });
    let d = "";
    Object.keys(pos).forEach((id) => {
      (tree.depends[id] || []).forEach((pid) => {
        const a = pos[pid],
          b = pos[id];
        if (!a || !b) return;
        const mid = a.bottom + (b.top - a.bottom) * 0.55,
          st = stOf(id);
        d +=
          '<path class="tree-edge' +
          (st === "approved" ? " active" : st === "pending" ? " open" : "") +
          '" d="M' +
          a.cx +
          "," +
          a.bottom +
          " C" +
          a.cx +
          "," +
          mid +
          " " +
          b.cx +
          "," +
          mid +
          " " +
          b.cx +
          "," +
          b.top +
          '"/>';
      });
    });
    svg.innerHTML = d;
  }

function renderDaily() {
  const wrap = $("#dailyWrap");
  if (!wrap || !S) return;
  const d = S.daily;
  const dailyTotal = Math.max(0, (S.totalCount || 0) - S.tasks.length);
  const dailyDone = Object.keys(S.progress || {}).filter(
    (k) =>
      k.indexOf("daily-") === 0 &&
      (S.progress[k].status === "pending" ||
        S.progress[k].status === "approved"),
  ).length;
  const counter =
    '<div class="daily-count"><span class="daily-count-line"></span>' +
    '<span class="daily-count-lbl">выполнено</span>' +
    '<span class="daily-count-val"><span class="t-pink">' +
    dailyDone +
    "</span> / " +
    dailyTotal +
    "</span></div>";
  let h = "";
 if (!d || d.state === "before") {
    h =
      '<section class="stage-card soft"><p class="card-wait">Откроется <b>03.11</b>. Загляни сюда в этот день.</p></section>';
  } else if (d.state === "after") {
    h =
      counter +
      '<section class="stage-card soft"><p class="card-wait">Отчёт отправлен</p></section>';
  } else {
    const st = stOf(d.id);
    const note =
      st === "pending"
        ? "Задание отправлено! Оно на проверке."
        : st === "approved"
          ? "Задание принято!"
          : st === "rejected"
            ? isFinal((S.progress[d.id] || {}).reason)
              ? "Задание отклонено окончательно."
              : "Задание отклонено. Открой его и отправь заново."
            : "";
    h =
      counter +
      '<article class="daily-card daily-big state-' +
      st +
      '" id="dailyCard"><div class="daily-eyebrow">Ежедневное задание · ' +
      dateOf(d.idx + 1) +
      '</div><div class="daily-name">' +
      esc(d.title || "Ежедневное задание") +
      '</div><div class="daily-orn"></div><div class="daily-req">' +
      rich(d.body || "Описание появится позже.") +
      '</div><div class="daily-bottom"><span>баллы: ' +
      num(d.pts) +
      '</span><span class="daily-status">' +
      STATUS[st] +
      "</span></div></article>" +
      (note ? '<p class="daily-note ' + st + '">' + esc(note) + "</p>" : "");
  }
  wrap.innerHTML = h;
  const c = $("#dailyCard", wrap);
  if (c)
    c.onclick = (e) => {
      if (e.target.closest("a")) return;
      openTask(d.id);
    };
}
  function renderRewards() {
    const wrap = $("#rewardsWrap");
    if (!wrap) return;
    wrap.innerHTML =
      '<section class="stage-card"><h3 class="card-title">Дары тумана</h3>' +
      '<div class="rw-now"><span class="rw-now-num">' +
      num(S.score) +
      '</span><span class="rw-now-lbl">ваших баллов</span></div>' +
      '<p class="card-text">Этот раздел дополнится позже. Всё о наградах и порогах баллов смотрите в блоге ивента.</p></section>';
  }

  const ANG = [-36, -26, -16, -6, 5, 15, 25, 35];
  const LEN = [150, 176, 160, 186, 168, 182, 154, 172];
  function jarSvg(pulled) {
    let s =
      '<svg class="jar" viewBox="0 0 300 300" aria-hidden="true"><ellipse class="jar-glow" cx="150" cy="150" rx="130" ry="120"/><g>';
    ANG.forEach((a, i) => {
      s +=
        '<g transform="translate(150 218) rotate(' +
        a +
        ')"><g class="stick' +
        (i === pulled ? " pulled" : pulled >= 0 ? " dim" : "") +
        '" data-i="' +
        i +
        '"><rect x="-2" y="' +
        -LEN[i] +
        '" width="4" height="' +
        LEN[i] +
        '" rx="2"/></g></g>';
    });
    return (
      s +
      '</g><path class="pot" d="M98 206 L106 282 Q150 290 194 282 L202 206"/><line class="pot" x1="92" y1="206" x2="208" y2="206"/></svg>'
    );
  }
  const wordsHtml = (t) =>
    t
      .split(" ")
      .map(
        (w, i) =>
          '<span class="pr-w" style="animation-delay:' +
          (0.15 + i * 0.12).toFixed(2) +
          's">' +
          esc(w) +
          "</span>",
      )
      .join(" ");

  function renderPreds() {
    const wrap = $("#predictionsWrap");
    if (!wrap) return;
    const today = Math.max(1, S.day);
    const mine = S.preds || {};
    const got = mine[today];
    const total = Object.keys(mine).length;
    const past = Object.keys(mine)
      .map(Number)
      .filter((d) => d !== today)
      .sort((a, b) => b - a);
    let h =
      '<section class="stage-card pr-card"><div class="pr-eyebrow">день ' +
      today +
      " · шёпотов получено " +
      total +
      '</div><h3 class="card-title">Шёпот тумана</h3>' +
      '<p class="card-text">Раз в день туман вытянет для тебя одну палочку из кувшина.</p>';
    if (got) {
      h +=
        '<div class="jar-btn done">' +
        jarSvg(4) +
        '</div><div class="pr-tag open"><span class="pr-tag-eyebrow">палочка дня</span><p class="pr-tag-text">' +
        esc(got) +
        '</p></div><p class="pr-note">Сегодня туман уже сказал своё. Завтра в кувшине появятся новые палочки.</p>';
    } else {
      h +=
        '<button type="button" class="jar-btn" id="btnJar" aria-label="Вытянуть палочку">' +
        jarSvg(-1) +
        "</button>" +
        '<p class="wake-hint jar-hint" id="jarHint">коснитесь кувшина</p>' +
        '<div class="pr-tag" id="prTag"><span class="pr-tag-eyebrow">палочка дня</span><p class="pr-tag-text" id="prText"></p></div>';
    }
    h += "</section>";
    if (past.length) {
      h +=
        '<section class="stage-card pr-history"><h3 class="card-sub">Прошлые шёпоты</h3>' +
        past
          .map(
            (d) =>
              '<div class="pr-past"><span class="pr-day">день ' +
              d +
              "</span><p>" +
              esc(mine[d]) +
              "</p></div>",
          )
          .join("") +
        "</section>";
    }
    wrap.innerHTML = h;

    const btn = $("#btnJar", wrap);
    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      drawing = true;
      $("#jarHint", wrap).style.visibility = "hidden";
      const req = rpc("app_pred_draw", { p_token: session.token });
      btn.classList.add("shaking");
      await sleep(1100);
      btn.classList.remove("shaking");
      const res = await req;
      if (res.error || !res.data || !res.data.text) {
        drawing = false;
        toast("Не получилось, попробуй ещё раз");
        renderPreds();
        return;
      }
      const idx = Math.floor(Math.random() * ANG.length);
      $all(".stick", btn).forEach((s) =>
        s.classList.add(+s.dataset.i === idx ? "pulled" : "dim"),
      );
      btn.classList.add("done");
      await sleep(900);
      $("#prText", wrap).innerHTML = wordsHtml(res.data.text);
      $("#prTag", wrap).classList.add("open");
      S.preds[res.data.day] = res.data.text;
      lastJson = JSON.stringify(S);
      await sleep(1600);
      drawing = false;
    };
  }

  let gameFrame = null,
    gameSave = {},
    gameDirty = false,
    gameTimer = null;

  function taskObj(id) {
    const t = S.tasks.find((x) => x.id === id);
    if (t) return Object.assign({}, t, { eyebrow: SPHERE_NAME[t.sphere] });
    const d = S.daily;
    if (d && d.state === "open" && d.id === id)
      return {
        id: d.id,
        daily: true,
        name: d.title || "Ежедневное задание",
        req: d.body || "Описание появится позже.",
        pts: d.pts,
        images: [],
        eyebrow: "Ежедневное задание · " + dateOf(d.idx + 1),
      };
    return null;
  }
  function openTask(id) {
    if (!taskObj(id)) return;
    modal = { id, view: "info", draft: null };
    $("#taskModalBackdrop").classList.add("open");
    renderModal();
  }
  function closeModal() {
    flushGameSave();
    $("#taskModalBackdrop").classList.remove("open");
    $("#taskModal").classList.remove("play");
    $("#taskModalBody").innerHTML = "";
    modal = null;
    gameFrame = null;
    if (S && isActive("screen-dashboard")) renderAll();
  }
  const headHtml = (t) =>
    '<div class="modal-head"><div><div class="modal-eyebrow">' +
    esc(t.eyebrow || "") +
    '</div><h3 class="modal-title">' +
    esc(t.name) +
    "</h3></div></div>";
  function pointsHtml(t) {
    const buffed = !t.daily && BUFF_OF[me.path] === t.sphere;
    const pb = t.pts_buff != null ? t.pts_buff : t.ptsBuff;
    const shown = buffed && pb != null ? pb : t.pts;
    return (
      '<div class="modal-points">' +
      "баллы: " +
      "<b>" +
      num(shown) +
      "</b>" +
      (buffed ? " (благословление тумана)" : "") +
      "</div>"
    );
  }
  const extrasHtml = (t) =>
    realImages(t)
      .map(
        (s) =>
          '<img src="' + esc(s) + '" class="img-preview js-zoomable" alt="">',
      )
      .join("");

  const skipBtn = (t) =>
    me && !me.isAdmin && !t.daily
      ? '<button class="btn btn-skip" id="btnSkip">Пропустить задание</button>'
      : "";
  function bindSkip(t) {
    const b = $("#btnSkip");
    if (b) b.onclick = () => skipTask(t);
  }
  async function skipTask(t) {
    if (
      !(await askConfirm({
        title: "Пропустить задание?",
        text: "«" + t.name + "»: вернуться к нему будет нельзя, баллы за него не начислятся.",
        ok: "Пропустить",
        cancel: "Не пропускать",
        danger: true,
      }))
    )
      return;
    const res = await rpc("app_skip", {
      p_token: session.token,
      p_task: t.id,
    });
    if (res.error)
      return toast(
        {
          locked: "Задание ещё закрыто",
          status: "Это задание уже нельзя пропустить",
        }[res.error] || "Не получилось, проверь интернет",
      );
    toast("Задание пропущено");
    await loadState(true);
    closeModal();
  }

  function renderModal() {
    if (!modal) return;
    const t = taskObj(modal.id);
    if (!t) {
      closeModal();
      return;
    }
    $("#taskModal").classList.remove("play");
    if (t.web) renderWeb(t);
    else renderReport(t);
  }

  function renderWeb(t) {
    const body = $("#taskModalBody");
    if (stOf(t.id) === "approved") {
      body.innerHTML =
        headHtml(t) +
        '<div class="solved-note"><div class="big">Задание пройдено</div><div class="small">Получено баллов: <b>' +
        num(t.pts) +
        "</b></div></div>";
      return;
    }
    body.innerHTML =
      headHtml(t) +
      '<p class="lore-text modal-req">' +
      rich(t.req) +
      "</p>" +
      extrasHtml(t) +
      pointsHtml(t) +
      (stOf(t.id) === "rejected" && isFinal((S.progress[t.id] || {}).reason)
        ? '<p class="status-note rejected">' +
          (isSkip(S.progress[t.id].reason)
            ? "Вы пропустили это задание. Вернуться к нему нельзя."
            : "Задание отклонено окончательно.") +
          "</p>"
        : isUnlocked(t.id)
          ? '<button class="btn btn-primary" id="btnGo">Перейти к заданию</button>' +
            skipBtn(t)
          : '<p class="status-note">Сначала сдайте задание выше, тогда можно будет пройти это.</p>');
    zoomable(body);
    if ($("#btnGo")) $("#btnGo").onclick = () => openGame(t);
    bindSkip(t);
  }

  function flushGameSave() {
    clearTimeout(gameTimer);
    gameTimer = null;
    if (!gameDirty || !session.token) return;
    gameDirty = false;
    rpc("app_game_save", { p_token: session.token, p_data: gameSave });
  }
  function queueGameSave(key, value) {
    if (value === null) delete gameSave[key];
    else gameSave[key] = value;
    gameDirty = true;
    clearTimeout(gameTimer);
    gameTimer = setTimeout(flushGameSave, 800);
  }

  const SIZE_JS =
    "(function(){var l=0;function s(){var h=Math.ceil(document.body.getBoundingClientRect().height);" +
    "if(h&&h!==l){l=h;try{parent.postMessage({mira:'h',h:h},'*');}catch(e){}}}" +
    "function go(){s();if(window.ResizeObserver)new ResizeObserver(s).observe(document.body);addEventListener('load',s);}" +
    "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();})();";

  const GAME_FIT =
    "<style>html.embed,html.embed body{min-height:0!important;height:auto!important;overflow:hidden!important}" +
    "html.embed .head{display:none!important}" +
    "html.embed .final{border:none!important;background:none!important;padding:18px 4px 6px!important}" +
    "html.embed body{padding:2px 2px 6px}" +
    "html.embed .modal{max-width:560px;width:100%;margin:0 auto}" +
    "html.embed .stage:not(.col){width:100%;max-width:var(--maxs,560px);margin-left:auto;margin-right:auto}" +
    "html.embed .stage canvas{max-width:100%;height:auto}" +
    "html.embed .status .sub{display:none}</style>";

  const GAME_SKIN = "";

  function buildGameDoc(html, n, uid) {
    const q = "?t=" + n + "&u=" + encodeURIComponent(uid);
    const shim =
      "<script>(function(){var U=" +
      JSON.stringify(uid + "::") +
      ",S=" +
      JSON.stringify(gameSave).replace(/</g, "\\u003c") +
      ";try{Object.keys(S).forEach(function(k){localStorage.setItem(k,S[k]);});}catch(e){}" +
      "var P=Storage.prototype,s=P.setItem,r=P.removeItem;" +
      "function send(k,v){if(k.indexOf(U)===0){try{parent.postMessage({mira:'save',key:k,value:v},'*');}catch(e){}}}" +
      "P.setItem=function(k,v){send(String(k),String(v));return s.call(this,k,v);};" +
      "P.removeItem=function(k){send(String(k),null);return r.call(this,k);};})();<\/script>" +
      "<script>" +
      SIZE_JS +
      "<\/script>" +
      "<style>:root{--maxs:560px}</style>" +
      GAME_FIT +
      GAME_SKIN;
    const withShim = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + shim)
      : shim + html;
    return withShim
      .replace(
        /new URLSearchParams\(location\.search\)/g,
        "new URLSearchParams(" + JSON.stringify(q) + ")",
      )
      .replace(/,\s*location\.origin\)/g, ", '*')");
  }

  async function fetchLocalGames() {
    try {
      const r = await fetch("games.html", { cache: "no-cache" });
      if (!r.ok) return null;
      const x = await r.text();
      return x.indexOf("__EMBED") >= 0 ? x : null;
    } catch (e) {
      return null;
    }
  }

  async function openGame(t) {
    modal.view = "play";
    $("#taskModal").classList.add("play");
    $("#taskModalBody").innerHTML =
      '<div class="play-bar"><button class="adm-btn" id="btnBack">← Описание</button><span class="play-title">' +
      esc(t.name) +
      '</span></div><div class="game-wrap" id="gameWrap"><p class="game-note">Загрузка…</p></div>';
    $("#btnBack").onclick = () => {
      flushGameSave();
      gameFrame = null;
      modal.view = "info";
      renderModal();
    };
    const [res, local] = await Promise.all([
      rpc("app_game_open", { p_token: session.token }),
      fetchLocalGames(),
    ]);
    if (!modal || modal.view !== "play" || modal.id !== t.id) return;
    const wrap = $("#gameWrap");
    const html = local || (res.data && res.data.html) || null;
    if (!html) {
      wrap.innerHTML =
        '<p class="game-note">Игры ещё не загружены. Напиши ответственным.</p>';
      return;
    }
    gameSave =
      res.data && res.data.save && typeof res.data.save === "object"
        ? res.data.save
        : {};
    gameDirty = false;
    const f = document.createElement("iframe");
    f.className = "web-task-frame";
    f.setAttribute("allow", "fullscreen");
    f.srcdoc = buildGameDoc(html, t.web, me.id);
    gameFrame = f;
    wrap.innerHTML = "";
    wrap.appendChild(f);
  }
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || !gameFrame || e.source !== gameFrame.contentWindow) return;
    if (d.mira === "h") {
      const h = Math.max(60, Math.min(Number(d.h) || 0, 4000));
      gameFrame.style.height = h + "px";
      return;
    }
    if (d.mira === "save" && typeof d.key === "string") {
      queueGameSave(d.key, d.value === null ? null : String(d.value));
      return;
    }
    if (d.mira !== "done") return;
    const res = await rpc("app_game_done", {
      p_token: session.token,
      p_game: Number(d.task),
    });
    if (res.error) {
      toast("Не засчиталось, попробуй ещё раз");
      return;
    }
    toast("Туман принял твой ответ");
    await loadState(true);
    closeModal();
  });

  function uploadBlock(items) {
    return (
      '<div class="img-upload"><div class="img-upload-grid">' +
      items
        .map(
          (it, i) =>
            '<div class="img-upload-preview"><img src="' +
            esc(it.src) +
            '" class="js-zoomable" alt="Отчёт"><button type="button" class="img-upload-remove" data-rm="' +
            i +
            '" title="Убрать фото">×</button></div>',
        )
        .join("") +
      "</div>" +
      (items.length < MAX_IMGS
        ? '<label class="img-upload-dropzone" id="imgDropzone" for="modalImage"><div class="img-upload-hint">Выбрать или перетащить фото (' +
          items.length +
          " / " +
          MAX_IMGS +
          ")</div></label>"
        : "") +
      '<input type="file" id="modalImage" accept="image/*" multiple class="visually-hidden"></div>'
    );
  }
  function bindUpload(items, onChange) {
    const addFiles = (list) => {
      const files = Array.from(list || []).filter((f) =>
        f.type.startsWith("image/"),
      );
      for (const f of files) {
        if (items.length >= MAX_IMGS) {
          toast("Максимум " + MAX_IMGS + " фото");
          break;
        }
        if (f.size > 6 * 1024 * 1024) {
          toast("Фото больше 6 МБ: " + f.name);
          continue;
        }
        items.push({ src: URL.createObjectURL(f), file: f });
      }
      onChange();
    };
    const input = $("#modalImage");
    if (input) input.addEventListener("change", () => addFiles(input.files));
    const dz = $("#imgDropzone");
    if (dz) {
      dz.addEventListener("dragover", (e) => {
        e.preventDefault();
        dz.classList.add("dragover");
      });
      dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
      dz.addEventListener("drop", (e) => {
        e.preventDefault();
        dz.classList.remove("dragover");
        addFiles(e.dataTransfer && e.dataTransfer.files);
      });
    }
    $all("[data-rm]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.preventDefault();
        items.splice(Number(b.dataset.rm), 1);
        onChange();
      }),
    );
  }

  async function uploadImage(file) {
    const ext = (file.name.split(".").pop() || "png")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const path =
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2, 10) +
      "." +
      (ext || "png");
    const { error } = await sb.storage
      .from(BUCKET)
      .upload(path, file, { cacheControl: "3600", upsert: false });
    if (error) throw error;
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  function renderReport(t) {
    const st = S.progress[t.id] || {};
    const status = st.status || "none";
    if (!modal.draft)
      modal.draft = {
        answer: stripConsent(st.answer),
        consent: st.consent != null ? !!st.consent : hasConsent(st.answer),
        items: imgsOf(st).map((u) => ({ src: u, url: u })),
      };
    const form = () =>
      '<div class="field"><label for="modalAnswer">Ответ</label><textarea id="modalAnswer" rows="4" placeholder=" ">' +
      esc(modal.draft.answer) +
      '</textarea></div><div class="field"><label>Изображение / скриншоты</label>' +
      uploadBlock(modal.draft.items) +
      "</div>" +
      (taskNeedsConsent(t)
        ? '<label class="consent"><input type="checkbox" id="modalConsent"' +
          (modal.draft.consent ? " checked" : "") +
          "><span>Я согласен(на), что мою работу могут показать в блоге с итогами ивента (если он будет) </span></label>"
        : "");
    let area;
    if (status === "pending")
      area =
        '<p class="status-note pending">Отчёт отправлен и проверяется.</p>';
    else if (status === "approved")
      area =
        '<p class="status-note approved">Задание принято. Получено баллов: <b>' +
        num(t.pts) +
        "</b></p>";
    else if (status === "rejected" && isSkip(st.reason))
      area =
        '<p class="status-note rejected">Вы пропустили это задание. Вернуться к нему нельзя, баллы не начисляются.</p>';
    else if (status === "rejected" && isFinal(st.reason))
      area =
        '<p class="status-note rejected">Отклонено окончательно: ' +
        esc(stripFinal(st.reason) || "без указания причины") +
        ". Отправить заново нельзя.</p>";
    else if (status === "rejected")
      area =
        '<p class="status-note rejected">Отклонено: ' +
        esc(st.reason || "без указания причины") +
        "</p>" +
        form() +
        '<button class="btn btn-primary" id="btnSubmitTask">Отправить заново</button>' +
        skipBtn(t);
    else if (!isUnlocked(t.id))
      area =
        '<p class="status-note">Отправить отчёт можно будет после выполнения предыдущего задания</p>';
    else
      area =
        form() +
        '<button class="btn btn-primary" id="btnSubmitTask">Отправить</button>' +
        skipBtn(t);

    $("#taskModalBody").innerHTML =
      headHtml(t) +
      '<p class="lore-text modal-req">' +
      rich(t.req) +
      "</p>" +
      extrasHtml(t) +
      pointsHtml(t) +
      area;
    zoomable($("#taskModalBody"));
    bindUpload(modal.draft.items, () => {
      const a = $("#modalAnswer");
      if (a) modal.draft.answer = a.value;
      const c = $("#modalConsent");
      if (c) modal.draft.consent = c.checked;
      renderReport(t);
    });
    const b = $("#btnSubmitTask");
    if (b) b.onclick = () => submitReport(t, b);
    bindSkip(t);
  }
    async function submitReport(t, btn) {
    const answer = ($("#modalAnswer") ? $("#modalAnswer").value : "").trim();
    const consent = !!($("#modalConsent") && $("#modalConsent").checked);
    const items = modal.draft.items;
    if (!answer && !items.length) return toast("Добавь ответ или изображение");
    btn.disabled = true;
    const urls = [];
    try {
      for (let i = 0; i < items.length; i++) {
        if (items[i].url) {
          urls.push(items[i].url);
          continue;
        }
        toast("Загружаю фото " + (i + 1) + " / " + items.length + "…");
        items[i].url = await uploadImage(items[i].file);
        urls.push(items[i].url);
      }
    } catch (e) {
      console.error(e);
      toast("Не удалось загрузить фото");
      btn.disabled = false;
      return;
    }
    const res = await rpc("app_submit", {
      p_token: session.token,
      p_task: modal.id,
      p_answer: answer,
      p_image: urls[0] || null,
      p_images: urls,
      p_consent: consent,
    });
    if (res.error) {
      btn.disabled = false;
      toast(
        {
          closed: "Приём этого задания закрыт",
          locked: "Задание ещё закрыто",
          status: "Отчёт уже отправлен",
          empty: "Добавь ответ или изображение",
          too_many: "Максимум 3 фото",
          final: "Это задание закрыто окончательно",
        }[res.error] || "Не отправилось, проверь интернет",
      );
      return;
    }
    toast("Отчёт отправлен");
    await loadState(true);
    closeModal();
  }

  function zoomable(root) {
    if (!root) return;
    $all("img.img-preview, img.js-zoomable", root).forEach((img) => {
      img.style.cursor = "zoom-in";
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        $("#imageViewerImg").src = img.src;
        $("#imageViewer").classList.add("open");
      });
    });
  }

  let modTab = "reports",
    repFilter = "pending",
    lastRepJson = "",
    modStamp = 0;
  let repTask = "",
    repQuery = "",
    repSort = "new";
  const MOD_TABS = [
    ["reports", "Отчёты"],
    ["tasks", "Задания"],
    ["people", "Участники"],
    ["scores", "Баллы"],
    ["daily", "Ежедневные"],
    ["preds", "Предсказания"],
    ["allowed", "Разрешённые"],
    ["games", "Игры"],
  ];

  const OWNER_TABS = ["tasks", "daily", "games"];
  function renderMod() {
    const stamp = ++modStamp;
    const bar = $(".mod-subtabs");
    bar.innerHTML = "";
    const owner = !!(me && isOwner(me.id));
    if (!owner && OWNER_TABS.includes(modTab)) modTab = "reports";
    MOD_TABS.filter(([k]) => owner || !OWNER_TABS.includes(k)).forEach(([k, l]) => {
      const b = document.createElement("button");
      b.className = "adm-btn" + (modTab === k ? " gold" : "");
      b.textContent = l;
      b.onclick = () => {
        modTab = k;
        renderMod();
        if (k === "people") refreshAdmin(true);
      };
      bar.appendChild(b);
    });
    const p = $("#adminPanel");
    p.innerHTML = "";

    const f = {
      reports: adminReports,
      tasks: adminTasks,
      people: adminPeople,
      scores: adminScores,
      daily: adminDaily,
      preds: adminPreds,
      allowed: adminAllowed,
      games: adminGames,
    }[modTab];
    f(p, () => stamp === modStamp);
  }
  function safeRenderMod() {
    const a = document.activeElement;
    if (
      a &&
      $("#adminPanel").contains(a) &&
      /TEXTAREA|INPUT|SELECT/.test(a.tagName)
    )
      return;
    if (modTab === "people") renderMod();
  }
  async function pollReports() {
    const res = await rpc("app_admin_reports", {
      p_token: session.token,
      p_status: repFilter,
    });
    if (res.error || !res.data) return;
    if (JSON.stringify(res.data.items) !== lastRepJson && !anyModalOpen())
      renderMod();
  }
  async function adminAllowed(p, alive) {
    const res = await rpc("app_admin_reports", {
      p_token: session.token,
      p_status: "all",
    });
    if (!alive()) return;
    const card = document.createElement("section");
    card.className = "adm-card";
    if (res.error || !res.data) {
      card.innerHTML = '<p class="adm-empty">Не удалось загрузить.</p>';
      p.appendChild(card);
      return;
    }
    const items = (res.data.items || []).filter(
      (s) => consentOf(s) && s.status !== "rejected",
    );
    card.innerHTML =
      '<h3 class="adm-title">Разрешённые работы<span class="adm-count">' +
      items.length +
      '</span></h3><div class="adm-line"></div>' +
      '<p class="adm-empty">Авторы этих работ разрешили показать их в блоге с итогами.</p>' +
      (items.length ? "" : '<p class="adm-empty">Пока никого.</p>');
    items.forEach((s) => {
      const row = document.createElement("div");
      row.className = "adm-row adm-click";
      const when = s.at ? new Date(s.at).toLocaleString("ru-RU") : "—";
      row.innerHTML =
        '<div class="adm-who"><span class="adm-name">' +
        esc(s.uname) +
        " · ID " +
        esc(s.uid) +
        '</span><span class="adm-id">' +
        esc(s.tname) +
        " · " +
        when +
        '</span></div><div class="adm-acts"><span class="adm-tag ' +
        s.status +
        '">' +
        STATUS[s.status] +
        "</span></div>";
      row.onclick = () => openReport(s);
      card.appendChild(row);
    });
    p.appendChild(card);
  }
  async function adminReports(p, alive) {
    const fr = document.createElement("div");
    fr.className = "adm-filters";
    [
      ["pending", "На проверке"],
      ["approved", "Принятые"],
      ["rejected", "Отклонённые"],
      ["all", "Все"],
    ].forEach(([k, l]) => {
      const b = document.createElement("button");
      b.className = "adm-btn" + (repFilter === k ? " gold" : "");
      b.textContent = l;
      b.onclick = () => {
        repFilter = k;
        renderMod();
      };
      fr.appendChild(b);
    });
    const addBtn = document.createElement("button");
    addBtn.className = "adm-btn gold";
    addBtn.textContent = "+ Отчёт за участника";
    addBtn.onclick = openProxyReport;
    fr.appendChild(addBtn);
    p.appendChild(fr);
    const res = await rpc("app_admin_reports", {
      p_token: session.token,
      p_status: repFilter,
    });
    if (!alive()) return;
    const card = document.createElement("section");
    card.className = "adm-card";
    if (res.error || !res.data) {
      card.innerHTML = '<p class="adm-empty">Не удалось загрузить.</p>';
      p.appendChild(card);
      return;
    }
    const items = (res.data.items || []).filter((s) => !isSkip(s.reason));
    lastRepJson = JSON.stringify(items);
    const taskOrder = (id) => {
      const i = S ? S.tasks.findIndex((x) => x.id === id) : -1;
      if (i >= 0) return S.tasks[i].layer * 100 + i;
      if (String(id).indexOf("daily-") === 0)
        return 10000 + (Number(String(id).slice(6)) || 0);
      return 99999;
    };
    const tmap = {};
    items.forEach((s) => {
      if (!tmap[s.task]) tmap[s.task] = { name: s.tname, n: 0 };
      tmap[s.task].n++;
    });
    const taskIds = Object.keys(tmap).sort(
      (a, b) => taskOrder(a) - taskOrder(b),
    );
    if (repTask && !tmap[repTask]) repTask = "";

    card.innerHTML =
      '<h3 class="adm-title">Отчёты<span class="adm-count" id="repCount">0</span></h3><div class="adm-line"></div>' +
      '<div class="rep-tools">' +
      '<label class="rep-field"><span class="rep-lbl">Задание</span>' +
      '<select class="rep-ctl" id="repTaskSel"><option value="">Все задания</option>' +
      taskIds
        .map(
          (id) =>
            '<option value="' +
            esc(id) +
            '"' +
            (id === repTask ? " selected" : "") +
            ">" +
            esc(tmap[id].name) +
            " (" +
            tmap[id].n +
            ")</option>",
        )
        .join("") +
      "</select></label>" +
      '<label class="rep-field"><span class="rep-lbl">Сортировка</span>' +
      '<select class="rep-ctl" id="repSortSel">' +
      [
        ["new", "Сначала новые"],
        ["old", "Сначала старые"],
        ["task", "По заданиям"],
        ["user", "По участникам (А–Я)"],
      ]
        .map(
          ([k, l]) =>
            '<option value="' +
            k +
            '"' +
            (k === repSort ? " selected" : "") +
            ">" +
            l +
            "</option>",
        )
        .join("") +
      "</select></label>" +
      '<label class="rep-field rep-search"><span class="rep-lbl">Поиск</span>' +
      '<input class="rep-ctl" id="repSearch" type="text" autocomplete="off" placeholder="Имя, ID или задание" value="' +
      esc(repQuery) +
      '"></label>' +
      '</div><div id="repList"></div>';
    p.appendChild(card);

    const list = $("#repList", card);
    const paintList = () => {
      const q = repQuery.trim().toLowerCase();
      const time = (s) => (s.at ? new Date(s.at).getTime() : 0);
      const byName = (a, b) => (a.uname || "").localeCompare(b.uname || "");
      const arr = items.filter(
        (s) =>
          (!repTask || s.task === repTask) &&
          (!q ||
            (s.uname || "").toLowerCase().includes(q) ||
            String(s.uid).includes(q) ||
            (s.tname || "").toLowerCase().includes(q)),
      );
      arr.sort((a, b) => {
        if (repSort === "old") return time(a) - time(b);
        if (repSort === "user") return byName(a, b) || time(b) - time(a);
        if (repSort === "task")
          return (
            taskOrder(a.task) - taskOrder(b.task) ||
            byName(a, b) ||
            time(a) - time(b)
          );
        return time(b) - time(a);
      });
      $("#repCount", card).textContent = arr.length;
      list.innerHTML = arr.length
        ? ""
        : '<p class="adm-empty">Ничего не найдено.</p>';
      arr.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "adm-row adm-click";
        const when = s.at ? new Date(s.at).toLocaleString("ru-RU") : "—";
        row.innerHTML =
          '<div class="adm-who"><span class="adm-name">' +
          esc(s.uname) +
          " · ID " +
          esc(s.uid) +
          '</span><span class="adm-id">' +
          esc(s.tname) +
          " · " +
          when +
          (consentOf(s) ? " · ✓ блог" : "") +
          '</span></div><div class="adm-acts"><span class="adm-tag ' +
          s.status +
          '">' +
          STATUS[s.status] +
          "</span></div>";
        row.onclick = () => openReportAt(arr, i);
        list.appendChild(row);
      });
    };
    $("#repTaskSel", card).onchange = (e) => {
      repTask = e.target.value;
      paintList();
    };
    $("#repSortSel", card).onchange = (e) => {
      repSort = e.target.value;
      paintList();
    };
    $("#repSearch", card).oninput = (e) => {
      repQuery = e.target.value;
      paintList();
    };
    paintList();
  }

  async function openProxyReport() {
    const res = await rpc("app_admin_list", { p_token: session.token });
    if (res.error || !res.data) return toast("Не удалось загрузить участников");
    const users = (res.data.users || [])
      .filter((u) => u.isAdmin || u.approved)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const tasks = S.tasks.slice().sort((a, b) => a.layer - b.layer);
    const dres = await rpc("app_admin_daily_get", { p_token: session.token });
    if (dres.data && dres.data.items)
      dres.data.items.forEach((c) =>
        tasks.push({
          id: "daily-" + c.idx,
          name: "Ежедневное " + dateOf(c.idx + 1) + ": " + (c.title || ""),
          layer: 99,
        }),
      );

    const draft = {
      user: "",
      task: tasks[0] ? tasks[0].id : "",
      answer: "",
      consent: false,
      approve: true,
      items: [],
    };

    const collect = () => {
      const g = (id) => $("#" + id);
      if (g("pxUser")) draft.user = g("pxUser").value;
      if (g("pxTask")) draft.task = g("pxTask").value;
      if (g("modalAnswer")) draft.answer = g("modalAnswer").value;
      if (g("modalConsent")) draft.consent = g("modalConsent").checked;
      if (g("pxApprove")) draft.approve = g("pxApprove").checked;
    };

    const paint = () => {
      $("#reportModalBody").innerHTML =
        '<div class="modal-head"><div><div class="modal-eyebrow">Ответственные</div>' +
        '<h3 class="modal-title">Отчёт за участника</h3></div></div>' +
        '<div class="field"><label for="pxUser">Участник (ID или имя)</label>' +
        '<input id="pxUser" list="pxUsers" autocomplete="off" placeholder=" " value="' +
        esc(draft.user) +
        '"><datalist id="pxUsers">' +
        users
          .map(
            (u) =>
              '<option value="' +
              esc(u.id + " · " + (u.name || "")) +
              '"></option>',
          )
          .join("") +
        "</datalist></div>" +
        '<div class="field"><label for="pxTask">Задание</label>' +
        '<select id="pxTask" class="roster-text">' +
        [
          ["Задания", tasks.filter((t) => t.layer !== 99)],
          ["Ежедневные", tasks.filter((t) => t.layer === 99)],
        ]
          .map(
            ([label, list]) =>
              '<optgroup label="' +
              label +
              '">' +
              list
                .map(
                  (t) =>
                    '<option value="' +
                    esc(t.id) +
                    '"' +
                    (t.id === draft.task ? " selected" : "") +
                    ">" +
                    esc(t.name) +
                    "</option>",
                )
                .join("") +
              "</optgroup>",
          )
          .join("") +
        "</select></div>" +
        '<div class="field"><label for="modalAnswer">Ответ</label>' +
        '<textarea id="modalAnswer" rows="5" placeholder=" ">' +
        esc(draft.answer) +
        "</textarea></div>" +
        '<div class="field"><label>Изображение / скриншоты</label>' +
        uploadBlock(draft.items) +
        "</div>" +
        '<label class="consent"><input type="checkbox" id="modalConsent"' +
        (draft.consent ? " checked" : "") +
        "><span>Автор разрешил показать работу в блоге</span></label>" +
        '<label class="consent"><input type="checkbox" id="pxApprove"' +
        (draft.approve ? " checked" : "") +
        "><span>Сразу принять (иначе уйдёт на проверку)</span></label>" +
        '<button class="btn btn-primary" id="pxSend">Добавить</button>';
      zoomable($("#reportModalBody"));
      bindUpload(draft.items, () => {
        collect();
        paint();
      });
      $("#pxSend").onclick = send;
    };

    const send = async () => {
      collect();
      const m = /^\s*(\d+)/.exec(draft.user);
      const u = m && users.find((x) => String(x.id) === m[1]);
      if (!u) return toast("Выбери участника из списка");
      const answer = draft.answer.trim();
      if (!answer && !draft.items.length)
        return toast("Добавь ответ или изображение");
      const btn = $("#pxSend");
      btn.disabled = true;
      const urls = [];
      try {
        for (let i = 0; i < draft.items.length; i++) {
          if (!draft.items[i].url) {
            toast("Загружаю фото " + (i + 1) + " / " + draft.items.length + "…");
            draft.items[i].url = await uploadImage(draft.items[i].file);
          }
          urls.push(draft.items[i].url);
        }
      } catch (e) {
        console.error(e);
        btn.disabled = false;
        return toast("Не удалось загрузить фото");
      }
      const r = await rpc("app_admin_submit", {
        p_token: session.token,
        p_uid: String(u.id),
        p_task: draft.task,
        p_answer: answer,
        p_image: urls[0] || null,
        p_images: urls,
        p_consent: draft.consent,
        p_approve: draft.approve,
      });
      btn.disabled = false;
      if (r.error)
        return toast(
          {
            forbidden: "Нет доступа",
            no_user: "Участник не найден",
            no_task: "Задание не найдено",
            status: "У участника это задание уже принято",
            empty: "Добавь ответ или изображение",
            too_many: "Максимум 3 фото",
          }[r.error] || "Не получилось",
        );
      toast("Отчёт добавлен для " + (u.name || u.id));
      closeReport();
      renderMod();
    };

    paint();
    $("#reportModalBackdrop").classList.add("open");
  }

  let revList = [],
    revIdx = -1,
    revDirty = false;
  function openReportAt(list, i) {
    revList = list;
    revIdx = i;
    openReport(list[i]);
  }
  function stepReport(d) {
    const j = revIdx + d;
    if (j < 0 || j >= revList.length) return;
    revIdx = j;
    openReport(revList[j]);
  }
  function openReport(s) {
    const when = s.at ? new Date(s.at).toLocaleString("ru-RU") : "—";
    const nav =
      revList.length > 1 && revList[revIdx] === s
        ? '<div class="rev-nav"><button class="adm-btn" id="revPrev"' +
          (revIdx <= 0 ? " disabled" : "") +
          '>‹</button><span class="rev-pos">' +
          (revIdx + 1) +
          " / " +
          revList.length +
          '</span><button class="adm-btn" id="revNext"' +
          (revIdx >= revList.length - 1 ? " disabled" : "") +
          ">›</button></div>"
        : "";
    const acts =
      s.status === "pending"
        ? '<div class="field"><label for="repReason">Причина (если отклоняете)</label><textarea id="repReason" rows="2" placeholder=" "></textarea></div>' +
          '<div class="acts-row"><button class="btn btn-danger" id="repNo">Отклонить</button><button class="btn btn-primary" id="repOk">Принять</button></div>' +
          '<div class="acts-row"><button class="btn btn-danger btn-final" id="repFinal">Отклонить окончательно</button></div>'
        : '<p class="status-note ' +
          s.status +
          '">' +
          STATUS[s.status] +
          (s.status === "rejected"
            ? (isFinal(s.reason) ? " окончательно" : "") +
              ": " +
              esc(stripFinal(s.reason) || "—")
            : "") +
          "</p>" +
          '<div class="acts-row"><button class="btn" id="repUndo">Вернуть на проверку</button></div>';
    $("#reportModalBody").innerHTML =
      '<div class="modal-head"><div><div class="modal-eyebrow">Отчёт</div><h3 class="modal-title">' +
      esc(s.tname) +
      "</h3></div></div>" +
      nav +
      '<p class="lore-text modal-req">' +
      rich(s.treq) +
      "</p>" +
      '<div class="report-meta"><span><b>Кто:</b> ' +
      esc(s.uname) +
      " · ID " +
      esc(s.uid) +
      "</span><span><b>Отправлено:</b> " +
      when +
      "</span></div>" +
      imgsOf(s)
        .map(
          (u) =>
            '<img src="' +
            esc(u) +
            '" class="img-preview js-zoomable" alt="Отчёт">',
        )
        .join("") +
      (consentOf(s)
        ? '<p class="status-note approved">Автор разрешил использовать работу в блоге</p>'
        : "") +
      (stripConsent(s.answer)
        ? '<div class="report-answer-head"><span>Ответ</span><span class="report-words">слов: <b>' +
          wordCount(stripConsent(s.answer)) +
          "</b></span></div>" +
          '<p class="lore-text report-answer">' +
          esc(stripConsent(s.answer)) +
          "</p>"
        : '<p class="lore-text"><i>без текста</i></p>') +
      acts;
    zoomable($("#reportModalBody"));
    const decide = async (ok, final) => {
      const reason = ($("#repReason") ? $("#repReason").value : "").trim();
      const sent = final ? FINAL_TAG + reason : reason;
      const btns = ["repOk", "repNo", "repFinal"].map((id) => $("#" + id));
      btns.forEach((b) => b && (b.disabled = true));
      const res = await rpc("app_admin_decide", {
        p_token: session.token,
        p_uid: s.uid,
        p_task: s.task,
        p_ok: ok,
        p_reason: sent,
      });
      if (res.error) {
        btns.forEach((b) => b && (b.disabled = false));
        return toast("Не получилось");
      }
      toast(ok ? "Принято" : final ? "Отклонено окончательно" : "Отклонено");
      s.status = ok ? "approved" : "rejected";
      s.reason = sent;
      revDirty = true;
      let next = -1;
      if (revList[revIdx] === s) {
        for (let k = revIdx + 1; k < revList.length && next < 0; k++)
          if (revList[k].status === "pending") next = k;
        for (let k = 0; k < revIdx && next < 0; k++)
          if (revList[k].status === "pending") next = k;
      }
      if (next >= 0) {
        revIdx = next;
        openReport(revList[next]);
      } else closeReport();
    };
    if ($("#repOk")) $("#repOk").onclick = () => decide(true);
    if ($("#repNo")) $("#repNo").onclick = () => decide(false);
    if ($("#repFinal"))
      $("#repFinal").onclick = async () => {
        if (
          await askConfirm({
            title: "Отклонить окончательно?",
            text: "Участник не сможет отправить это задание заново.",
            ok: "Отклонить",
            danger: true,
          })
        )
          decide(false, true);
      };
    if ($("#repUndo"))
      $("#repUndo").onclick = async () => {
        if (
          !(await askConfirm({
            title: "Вернуть на проверку?",
            text: "Баллы за этот отчёт снимутся.",
            ok: "Вернуть",
          }))
        )
          return;
        const res = await rpc("app_admin_revert", {
          p_token: session.token,
          p_uid: s.uid,
          p_task: s.task,
        });
        if (res.error) return toast("Не получилось");
        toast("Возвращено на проверку");
        s.status = "pending";
        revDirty = true;
        openReport(s);
      };
    if ($("#revPrev")) $("#revPrev").onclick = () => stepReport(-1);
    if ($("#revNext")) $("#revNext").onclick = () => stepReport(1);
    $("#reportModal").scrollTop = 0;
    $("#reportModalBackdrop").classList.add("open");
  }
  function closeReport() {
    $("#reportModalBackdrop").classList.remove("open");
    if (S && isActive("screen-dashboard")) renderAll();
    if (revDirty) {
      revDirty = false;
      if (tab === "mod") renderMod();
    }
  }

  async function adminTasks(p, alive) {
    const res = await rpc("app_admin_tasks_get", { p_token: session.token });
    if (!alive()) return;
    if (res.error || !res.data) {
      p.insertAdjacentHTML(
        "beforeend",
        '<section class="adm-card"><p class="adm-empty">Не удалось загрузить задания.</p></section>',
      );
      return;
    }
    let draft = (res.data.items || []).map((t) => ({
      id: String(t.id),
      sphere: SPHERE_NAME[t.sphere] ? t.sphere : "tvorenie",
      name: t.name || "",
      req: t.req || "",
      pts: Number(t.pts) || 0,
      pts_buff:
        t.pts_buff != null
          ? Number(t.pts_buff)
          : t.ptsBuff != null
            ? Number(t.ptsBuff)
            : null,
      layer: Math.max(0, Number(t.layer) || 0),
      web: t.web ? Number(t.web) : 0,
      images: Array.isArray(t.images)
        ? t.images.filter((x) => x !== IMG_CONSENT)
        : [],
      consent: Array.isArray(t.images) && t.images.includes(IMG_CONSENT),
    }));
    const wrap = document.createElement("div");
    p.appendChild(wrap);

    const newId = (sphere) => {
      const pre = SPHERE_PREFIX[sphere] || "tk";
      let n = 1;
      while (draft.some((x) => x.id === pre + "-" + n)) n++;
      return pre + "-" + n;
    };
    const collect = () => {
      $all(".tk-card", wrap).forEach((c) => {
        const t = draft.find((x) => x.id === c.dataset.id);
        if (!t) return;
        t.name = $('[data-f="name"]', c).value.trim();
        t.req = $('[data-f="req"]', c).value.trim();
        t.pts = Number($('[data-f="pts"]', c).value) || 0;
        const pb = $('[data-f="ptsbuff"]', c).value.trim();
        t.pts_buff = pb === "" ? null : Number(pb) || 0;
        t.sphere = $('[data-f="sphere"]', c).value;
        t.layer = Math.max(0, (Number($('[data-f="day"]', c).value) || 1) - 1);
        const game = $('[data-f="mode"]', c).value === "game";
        const g = Math.floor(Number($('[data-f="web"]', c).value) || 0);
        t.web = game && g > 0 ? g : 0;
        t.images = $('[data-f="images"]', c)
          .value.split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
        t.consent = $('[data-f="consent"]', c).checked;
      });
    };

    const paint = () => {
      wrap.innerHTML = "";
      const maxLayer = draft.reduce(
        (m, t) => Math.max(m, t.layer),
        EVENT_DAYS - 1,
      );
      const days = maxLayer + 1;
      const top = document.createElement("section");
      top.className = "adm-card";
      top.innerHTML =
        '<h3 class="adm-title">Задания<span class="adm-count">' +
        draft.length +
        '</span></h3><div class="adm-line"></div>'  +
        '<div class="adm-acts" style="justify-content:center;margin-top:8px"><button class="adm-btn gold" data-top="save">Сохранить всё</button></div>';
      wrap.appendChild(top);

      for (let li = 0; li < days; li++) {
        const list = draft.filter((t) => t.layer === li);
        const sec = document.createElement("section");
        sec.className = "adm-card";
        let h =
          '<h3 class="adm-title">День ' +
          (li + 1) +
          " · " +
          dateOf(li + 1) +
          '<span class="adm-count">' +
          list.length +
          '</span></h3><div class="adm-line"></div>';
        list.forEach((t) => {
          const isGame = !!t.web;
          h +=
            '<div class="tk-card" data-id="' +
            esc(t.id) +
            '">' +
            '<div class="tk-row"><span></span><span class="adm-acts"><button class="adm-btn danger" data-a="del" type="button">Удалить</button></span></div>' +
            '<input class="roster-text" data-f="name" placeholder="Название" value="' +
            esc(t.name) +
            '">' +
            '<textarea class="roster-text" data-f="req" rows="4" placeholder="Описание задания">' +
            esc(t.req) +
            "</textarea>" +
            '<div class="tk-grid">' +
            '<label>Баллы<input class="roster-text" data-f="pts" type="number" min="0" step="0.5" value="' +
            esc(t.pts) +
            '"></label>' +
            '<label>Баллы с баффом<input class="roster-text" data-f="ptsbuff" type="number" min="0" step="0.5" value="' +
            (t.pts_buff == null ? "" : esc(t.pts_buff)) +
            '"></label>' +
            '<label>Категория<select class="roster-text" data-f="sphere">' +
            Object.keys(SPHERE_NAME)
              .map(
                (k) =>
                  '<option value="' +
                  k +
                  '"' +
                  (k === t.sphere ? " selected" : "") +
                  ">" +
                  esc(SPHERE_NAME[k]) +
                  "</option>",
              )
              .join("") +
            "</select></label>" +
            '<label>День<select class="roster-text" data-f="day">' +
            Array.from(
              { length: days },
              (_, d) =>
                '<option value="' +
                (d + 1) +
                '"' +
                (d === t.layer ? " selected" : "") +
                ">" +
                (d + 1) +
                " · " +
                dateOf(d + 1) +
                "</option>",
            ).join("") +
            "</select></label>" +
            '<label>Способ<select class="roster-text" data-f="mode"><option value="report"' +
            (isGame ? "" : " selected") +
            '>Отчёт</option><option value="game"' +
            (isGame ? " selected" : "") +
            ">Игра</option></select></label>" +
            '<label>№ игры<input class="roster-text" data-f="web" type="number" min="1" step="1" value="' +
            esc(t.web || "") +
            '"></label>' +
            "</div>" +
            '<textarea class="roster-text" data-f="images" rows="2" placeholder="Картинки к заданию: по ссылке в строке (необязательно)">' +
            esc(t.images.join("\n")) +
            "</textarea>" +
            '<label class="consent"><input type="checkbox" data-f="consent"' +
            (t.consent ? " checked" : "") +
            "><span>Показывать участнику галочку «согласен на публикацию в блоге»</span></label>" +
            '<label class="adm-btn tk-upload">Загрузить картинку с устройства<input type="file" accept="image/*" class="visually-hidden" data-up></label>' +
            "</div>";
        });
        if (!list.length)
          h += '<p class="adm-empty">В этот день заданий нет.</p>';
        h +=
          '<div class="tk-add"><button class="adm-btn" data-add="' +
          li +
          '" type="button">Добавить задание на этот день</button></div>';
        sec.innerHTML = h;
        wrap.appendChild(sec);
      }

      $all(".tk-card [data-up]", wrap).forEach((inp) => {
        inp.onchange = async () => {
          const f = inp.files[0];
          if (!f) return;
          if (f.size > 6 * 1024 * 1024) {
            toast("Картинка больше 6 МБ");
            inp.value = "";
            return;
          }
          toast("Загружаю картинку…");
          try {
            const url = await uploadImage(f);
            const ta = $('[data-f="images"]', inp.closest(".tk-card"));
            ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + url;
            toast("Картинка добавлена. Нажми «Сохранить всё»");
          } catch (e) {
            console.error(e);
            toast("Не удалось загрузить картинку");
          }
          inp.value = "";
        };
      });
      $all('.tk-card [data-f="day"]', wrap).forEach((sel) => {
        sel.onchange = () => {
          collect();
          paint();
        };
      });
      $all('.tk-card [data-f="mode"]', wrap).forEach((sel) => {
        sel.onchange = () => {
          const g = $('[data-f="web"]', sel.closest(".tk-card"));
          if (sel.value === "game" && !g.value) g.value = 1;
        };
      });
      $all(".tk-card [data-a=del]", wrap).forEach((b) => {
        b.onclick = async () => {
          collect();
          const t = draft.find(
            (x) => x.id === b.closest(".tk-card").dataset.id,
          );
          if (!t) return;
          if (
            !(await askConfirm({
              title: "Удалить задание?",
              text: "«" + (t.name || t.id) + "»: отчёты по нему останутся в базе, но баллы за него перестанут считаться.",
              ok: "Удалить",
              danger: true,
            }))
          )
            return;
          draft = draft.filter((x) => x !== t);
          paint();
        };
      });
      $all("[data-add]", wrap).forEach((b) => {
        b.onclick = () => {
          collect();
          draft.push({
            id: newId("tvorenie"),
            sphere: "tvorenie",
            name: "Новое задание",
            req: "",
            pts: 5,
            pts_buff: null,
            layer: Number(b.dataset.add),
            web: 0,
            images: [],
            consent: false,
          });
          paint();
        };
      });
      $('[data-top="save"]', wrap).onclick = async (e) => {
        collect();
        const bad = draft.find((t) => !t.name);
        if (bad) return toast("У задания " + bad.id + " нет названия");
        const noGame = draft.find(
          (t) =>
            $all('.tk-card[data-id="' + t.id + '"] [data-f="mode"]', wrap).some(
              (m) => m.value === "game",
            ) && !t.web,
        );
        if (noGame)
          return toast("У задания " + noGame.id + " не указан номер игры");
        const btn = e.currentTarget;
        btn.disabled = true;
        const items = draft.map((t) => ({
          id: t.id,
          sphere: t.sphere,
          name: t.name,
          req: t.req,
          pts: t.pts,
          pts_buff: t.pts_buff,
          layer: t.layer,
          web: t.web || null,
          images: t.images.concat(t.consent ? [IMG_CONSENT] : []),
        }));
        const r = await rpc("app_admin_tasks_save", {
          p_token: session.token,
          p_items: items,
        });
        btn.disabled = false;
        if (r.error)
          return toast(
            r.error === "forbidden" ? "Нет доступа" : "Не сохранилось",
          );
        toast("Сохранено: " + items.length);
        await loadState(true);
        renderMod();
      };
    };
    paint();
  }

  const scOpen = new Set();
  async function adminScores(p, alive) {
    const [lr, rr, dr] = await Promise.all([
      rpc("app_admin_list", { p_token: session.token }),
      rpc("app_admin_reports", { p_token: session.token, p_status: "all" }),
      rpc("app_admin_daily_get", { p_token: session.token }),
    ]);
    if (!alive()) return;
    const card = document.createElement("section");
    card.className = "adm-card";
    if (lr.error || rr.error || !lr.data || !rr.data) {
      card.innerHTML = '<p class="adm-empty">Не удалось загрузить.</p>';
      p.appendChild(card);
      return;
    }
    const users = (lr.data.users || []).filter((u) => u.isAdmin || u.approved);
    const dailyPts = {};
    ((dr.data && dr.data.items) || []).forEach((c) => {
      if (c.pts != null) dailyPts["daily-" + c.idx] = Number(c.pts) || 0;
    });
    const fallbackDaily = (S && S.daily && Number(S.daily.pts)) || 0;
    const byTask = {};
    (S ? S.tasks : []).forEach((t) => (byTask[t.id] = t));

    const stat = {};
    users.forEach((u) => (stat[u.id] = { u, score: 0, done: 0, items: [] }));
    (rr.data.items || []).forEach((s) => {
      if (s.status !== "approved") return;
      const row = stat[String(s.uid)];
      if (!row) return;
      const t = byTask[s.task];
      let pts = 0;
      if (t) {
        const pb = t.pts_buff != null ? t.pts_buff : t.ptsBuff;
        const buffed = BUFF_OF[row.u.path] === t.sphere;
        pts = Number(buffed && pb != null ? pb : t.pts) || 0;
      } else if (String(s.task).indexOf("daily-") === 0) {
        pts = dailyPts[s.task] != null ? dailyPts[s.task] : fallbackDaily;
      }
      row.score += pts;
      row.done++;
      row.items.push({ s, pts });
    });
    const list = Object.values(stat).sort(
      (a, b) =>
        b.score - a.score || (a.u.name || "").localeCompare(b.u.name || ""),
    );
    const total = list.reduce((m, r) => m + r.score, 0);

    card.innerHTML =
      '<h3 class="adm-title">Баллы<span class="adm-count">' +
      list.length +
      '</span></h3><div class="adm-line"></div>' +
      '<div class="rep-tools"><label class="rep-field rep-search"><span class="rep-lbl">Поиск</span>' +
      '<input class="rep-ctl" id="scSearch" type="text" autocomplete="off" placeholder="Имя или ID"></label></div>' +
      '<div class="pp-list" id="scList"></div>';
    p.appendChild(card);

    const box = $("#scList", card);
    const paint = () => {
      const q = $("#scSearch", card).value.trim().toLowerCase();
      const rows = list.filter(
        (r) =>
          !q ||
          String(r.u.id).includes(q) ||
          (r.u.name || "").toLowerCase().includes(q),
      );
      box.innerHTML = rows.length
        ? rows
            .map((r) => {
              const rank = list.indexOf(r) + 1;
              const id = String(r.u.id);
              const items = r.items.length
                ? r.items
                    .map(
                      (it, i) =>
                        '<div class="sc-item" data-u="' +
                        esc(id) +
                        '" data-i="' +
                        i +
                        '"><span class="sc-item-name">' +
                        esc(it.s.tname) +
                        '</span><span class="sc-item-pts">+' +
                        num(it.pts) +
                        "</span></div>",
                    )
                    .join("")
                : '<p class="adm-empty">Принятых заданий нет.</p>';
              return (
                '<details class="pp-fold sc-fold" data-u="' +
                esc(id) +
                '"' +
                (scOpen.has(id) ? " open" : "") +
                '><summary><span class="sc-rank">' +
                rank +
                '</span><span class="pp-who"><span class="pp-name">' +
                esc(r.u.name || "—") +
                '</span><span class="pp-id">' +
                esc(id) +
                " · принято: " +
                r.done +
                '</span></span><span class="sc-val">' +
                num(r.score) +
                '</span></summary><div class="sc-items">' +
                items +
                "</div></details>"
              );
            })
            .join("")
        : '<p class="adm-empty">Никого не нашла.</p>';
      $all(".sc-fold", box).forEach((d) =>
        d.addEventListener("toggle", () => {
          if (d.open) scOpen.add(d.dataset.u);
          else scOpen.delete(d.dataset.u);
        }),
      );
      $all(".sc-item", box).forEach((el) => {
        el.onclick = () => {
          const r = list.find((x) => String(x.u.id) === el.dataset.u);
          if (r)
            openReportAt(
              r.items.map((x) => x.s),
              Number(el.dataset.i),
            );
        };
      });
    };
    $("#scSearch", card).oninput = paint;
    paint();
  }

  async function adminDaily(p, alive) {
    const res = await rpc("app_admin_daily_get", { p_token: session.token });
    if (!alive() || res.error || !res.data) return;
    res.data.items.forEach((c) => {
      const card = document.createElement("section");
      card.className = "adm-card";
      card.innerHTML =
        '<h3 class="adm-title">Ежедневное №' +
        c.idx +
        " · " +
        dateOf(c.idx + 1) +
        '</h3><div class="adm-line"></div>' +
        '<input class="roster-text" data-f="title" placeholder="Название" value="' +
        esc(c.title) +
        '" style="margin-bottom:8px">' +
        '<textarea class="roster-text" data-f="body" rows="5" placeholder="Текст задания">' +
        esc(c.body) +
        "</textarea>" +
        '<div class="adm-acts" style="margin-top:8px"><button class="adm-btn gold">Сохранить</button></div>';
      $("button", card).onclick = async () => {
        const r = await rpc("app_admin_daily_save", {
          p_token: session.token,
          p_idx: c.idx,
          p_title: $('[data-f="title"]', card).value.trim(),
          p_body: $('[data-f="body"]', card).value.trim(),
        });
        toast(r.error ? "Не сохранилось" : "Сохранено");
        if (!r.error) loadState(true);
      };
      p.appendChild(card);
    });
  }

  async function adminPreds(p, alive) {
    const res = await rpc("app_admin_preds_get", { p_token: session.token });
    if (!alive() || res.error || !res.data) return;
    const lines = res.data.lines || [];
    const card = document.createElement("section");
    card.className = "adm-card";
    card.innerHTML =
      '<h3 class="adm-title">Предсказания<span class="adm-count">' +
      lines.length +
      '</span></h3><div class="adm-line"></div>' +
      '<textarea class="roster-text" id="predText" rows="12">' +
      esc(lines.join("\n")) +
      "</textarea>" +
      '<div class="adm-acts" style="margin-top:10px"><button class="adm-btn gold" id="predSave">Сохранить</button></div>';
    p.appendChild(card);
    $("#predSave", card).onclick = async () => {
      const arr = $("#predText")
        .value.split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const r = await rpc("app_admin_preds_save", {
        p_token: session.token,
        p_lines: arr,
      });
      toast(r.error ? "Не сохранилось" : "Сохранено: " + arr.length);
      if (!r.error) renderMod();
    };
  }

  async function adminGames(p, alive) {
    const card = document.createElement("section");
    card.className = "adm-card";
    card.innerHTML =
      '<h3 class="adm-title">Игры</h3><div class="adm-line"></div><p class="adm-empty" id="gameStatus">Проверяю…</p>' +
      '<div class="adm-acts" style="justify-content:center"><label class="adm-btn gold" style="display:inline-flex;align-items:center;cursor:pointer">' +
      'Выбрать games.html<input type="file" id="gameFile" accept=".html,text/html" class="visually-hidden"></label></div>';
    p.appendChild(card);
    const [res, local] = await Promise.all([
      rpc("app_admin_game_info", { p_token: session.token }),
      fetchLocalGames(),
    ]);
    if (!alive()) return;
    const parts = [];
    parts.push(
      local
        ? "Файл games.html найден на сайте"
        : "Файл games.html на сайте не найден",
    );
    if (res.data && res.data.size)
      parts.push(
        ": " +
          Math.round(res.data.size / 1024) +
          " КБ · " +
          new Date(res.data.updated).toLocaleString("ru-RU"),
      );
    $("#gameStatus", card).textContent = parts.join(" · ");
    $("#gameFile", card).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const html = await f.text();
      if (html.indexOf("__EMBED") < 0)
        return toast("Это не похоже на games.html");
      const r = await rpc("app_admin_game_save", {
        p_token: session.token,
        p_html: html,
      });
      toast(r.error ? "Не сохранилось" : "Игры загружены");
      if (!r.error) renderMod();
    };
  }

  async function bumpDay(delta) {
    const res = await rpc("app_set_day", {
      p_token: session.token,
      p_delta: delta,
    });
    if (res.error) return toast("Нет доступа");
    toast("День " + res.data.day);
    const dv = $("#dayVal");
    if (dv) dv.textContent = res.data.day;
    await loadState(true);
  }
  function bindDash() {
    $("#dayMinus").onclick = () => bumpDay(-1);
    $("#dayPlus").onclick = () => bumpDay(1);
    $all(".view-tab").forEach(
      (t) => (t.onclick = () => switchTab(t.dataset.tab)),
    );
    $("#btnToggleDone").onclick = () => {
      showDone = !showDone;
      $("#btnToggleDone").textContent = showDone
        ? "Скрыть выполненные"
        : "Показать выполненные";
      if (S) renderTasks();
    };
    $("#taskTree").addEventListener("click", (e) => {
      const n = e.target.closest("[data-id]");
      if (!n) return;
      if (n.dataset.locked) toast(n.dataset.msg || "Пока закрыто");
      else openTask(n.dataset.id);
    });
    let lastW = innerWidth,
      rt = null;
    window.addEventListener("resize", () => {
      if (innerWidth === lastW) return;
      lastW = innerWidth;
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (S) renderTasks();
      }, 200);
    });
    $("#modalCloseBtn").onclick = closeModal;
    $("#taskModalBackdrop").onclick = (e) => {
      if (e.target.id === "taskModalBackdrop") closeModal();
    };
    $("#reportModalCloseBtn").onclick = closeReport;
    $("#reportModalBackdrop").onclick = (e) => {
      if (e.target.id === "reportModalBackdrop") closeReport();
    };
    $("#imageViewerClose").onclick = () =>
      $("#imageViewer").classList.remove("open");
    $("#imageViewer").onclick = (e) => {
      if (e.target.id === "imageViewer")
        $("#imageViewer").classList.remove("open");
    };
    document.addEventListener("keydown", (e) => {
      if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        $("#reportModalBackdrop").classList.contains("open") &&
        !$("#imageViewer").classList.contains("open") &&
        !/TEXTAREA|INPUT|SELECT/.test(
          (document.activeElement || {}).tagName || "",
        )
      ) {
        stepReport(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (e.key !== "Escape") return;
      if ($("#imageViewer").classList.contains("open"))
        $("#imageViewer").classList.remove("open");
      else if ($("#reportModalBackdrop").classList.contains("open"))
        closeReport();
      else if ($("#taskModalBackdrop").classList.contains("open")) closeModal();
    });
  }

  let polling = false;
  async function poll() {
    if (polling || !session.token || document.hidden) return;
    polling = true;
    try {
      if (isActive("screen-dashboard")) {
        await loadState(false);
        if (me && me.isAdmin && tab === "mod") {
          if (modTab === "people") await refreshAdmin(false);
          else if (modTab === "reports") await pollReports();
        }
        return;
      }
      const res = await rpc("app_me", { p_token: session.token });
      if (res.error) return;
      if (!res.data) {
        logoutLocal("Нужно войти заново");
        return;
      }
      me = res.data;
      if (isActive("screen-pending") && me.approved) routeAfterLogin();
    } finally {
      polling = false;
    }
  }
  function startPolling() {
    setInterval(poll, 6000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
    });
  }

  function hideLoader() {
    const l = $("#pageLoader");
    if (!l) return;
    l.classList.add("hide");
    setTimeout(() => l.remove(), 600);
  }
  setTimeout(hideLoader, 10000);

  async function init() {
    bindAuth();
    bindVision();
    bindDash();
    if (!sb) {
      toast("Не загрузилось, обнови страницу");
      hideLoader();
      return;
    }
    if (session.token) {
      const res = await rpc("app_me", { p_token: session.token });
      if (res.error === "network") {
        toast("Не удалось загрузить данные, обнови страницу");
        showScreen("screen-auth");
      } else if (res.data) {
        me = res.data;
        $("#inputId").value = me.id;
        routeAfterLogin();
      } else {
        session.token = null;
        store.del(TOKEN_KEY);
        showScreen("screen-auth");
      }
    } else showScreen("screen-auth");
    startPolling();
    hideLoader();
  }

  init();
})();
