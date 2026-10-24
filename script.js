(function () {
  "use strict";

  const sb = window.sb;

  const OWNERS = ["1707227", "1634921"];
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
    session.token = null;
    me = null;
    adminUsers = [];
    lastAdminJson = "";
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
    for (let i = 0; i < rows.length; i += 500) {
      const res = await rpc("app_roster_save", {
        p_token: session.token,
        p_rows: rows.slice(i, i + 500),
      });
      if (res.error) {
        toast(res.error === "forbidden" ? "Нет доступа" : "Не сохранилось");
        return false;
      }
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
    $('#btnTestNext').disabled = true;
    $('#testStep').textContent = (visionStep + 1) + ' / ' + VISIONS.length;
    $('#testFill').style.width = Math.round((visionStep / VISIONS.length) * 100) + '%';
    const parts = vision.text.split('\n\n');
    const lead = parts.length > 1 ? parts.pop() : '';
    $('#questionText').innerHTML = escapeHtml(parts.join('\n\n'))
      + (lead ? '<span class="question-lead">' + escapeHtml(lead) + '</span>' : '');

    const wrap = $('#optionList');
    wrap.innerHTML = '';
    vision.options
      .map(opt => ({ opt, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .forEach(({ opt }) => {
        const div = document.createElement('div');
        div.className = 'option-item';
        div.textContent = opt.t;
        div.setAttribute('role', 'button');
        div.setAttribute('tabindex', '0');
        const pick = () => {
          pickedOpt = opt;
          $all('.option-item', wrap).forEach(x => x.classList.toggle('selected', x === div));
          $('#btnTestNext').disabled = false;
        };
        div.addEventListener('click', pick);
        div.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });
        wrap.appendChild(div);
      });
  }

  function nextQuestion() {
    if (!pickedOpt || choiceLock) return;
    choiceLock = true;
    setTimeout(() => { choiceLock = false; }, 350);
    testTally[pickedOpt.p]++;
    pickedOpt = null;
    visionStep++;
    if (visionStep < VISIONS.length) { renderQuestion(); window.scrollTo(0, 0); }
    else { $('#testFill').style.width = '100%'; finishTest(); }
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
    if (leaders.length === 1) {
      applyPath(leaders[0], false);
    } else {
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
    const res = await rpc("app_save_path", {
      p_token: session.token,
      p_path: best,
    });
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
            '">' +
            '<span class="tie-icon">' +
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
            "»</span>" +
            "</button>",
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
      if (steps < 20 && a.volume > 0.06) {
        a.volume = Math.max(0, a.volume - 0.06);
      } else {
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
      if (isOwner(uid)) {
        toast("Удалить нельзя");
        return;
      }
      if (me && me.id === uid) {
        toast("Нельзя удалить себя");
        return;
      }
      if (
        !confirm(
          "Удалить игрока «" + (u.name || uid) + "»? Действие необратимо.",
        )
      )
        return;
    }
    if (act === "resetpin") {
      if (
        !confirm(
          "Сбросить пароль игроку «" +
            (u.name || uid) +
            "»? Он введёт новый при следующем входе.",
        )
      )
        return;
    }
    const res = await rpc("app_admin_set", {
      p_token: session.token,
      p_uid: uid,
      p_action: act,
    });
    if (res.error === "auth") return;
    if (res.error === "forbidden") {
      toast("Нет доступа");
      return;
    }
    if (res.error) {
      toast("Не получилось, проверь интернет");
      return;
    }
    toast(ADMIN_DONE[act]);
    await refreshAdmin(true);
  }

  function renderAdminPanel() {
    const wrap = $("#adminPanel");
    const keepText = $("#rosterText") ? $("#rosterText").value : "";
    const selfId = me ? me.id : null;
    const canManage = isOwner(selfId);

    const all = adminUsers
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const pending = all.filter((u) => !u.isAdmin && !u.approved);
    const admins = all.filter((u) => u.isAdmin);
    const members = all.filter((u) => !u.isAdmin && u.approved);

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
      canManage ? btn("promote", u.id, "Сделать ответственным", "gold") : "";

    function group(title, list, emptyText, actions) {
      let h =
        '<section class="adm-card"><h3 class="adm-title">' +
        escapeHtml(title) +
        '<span class="adm-count">' +
        list.length +
        '</span></h3><div class="adm-line"></div>';
      if (!list.length)
        h += '<p class="adm-empty">' + escapeHtml(emptyText) + "</p>";
      list.forEach((u) => {
        h +=
          '<div class="adm-row"><div class="adm-who"><span class="adm-name">' +
          escapeHtml(u.name || "—") +
          '</span><span class="adm-id">' +
          escapeHtml(u.id) +
          "</span></div>" +
          '<div class="adm-acts">' +
          actions(u) +
          "</div></div>";
      });
      return h + "</section>";
    }

    const memberActions = (u) => promote(u) + reset(u) + del(u);
    let html = group(
      "Ожидают",
      pending,
      "Новых заявок нет.",
      (u) => btn("approve", u.id, "Подтвердить", "gold") + del(u),
    );

    ["ratniki", "kudesniki", "likotvorcy"].forEach((key) => {
      html += group(
        PATHS[key].name,
        members.filter((u) => u.path === key),
        "Пока никого.",
        memberActions,
      );
    });
    const noPath = members.filter((u) => !PATHS[u.path]);
    if (noPath.length)
      html += group("Тест не пройден", noPath, "", memberActions);

    html += group(
      "Ответственные",
      admins,
      "Пока никого.",
      (u) =>
        (isOwner(u.id)
          ? '<span class="adm-id">мяу</span>'
          : canManage
            ? btn("demote", u.id, "Снять права", "danger")
            : "") +
        reset(u) +
        del(u),
    );

    html +=
      '<section class="adm-card"><h3 class="adm-title">Список Морёвки<span class="adm-count">' +
      rosterCount +
      '</span></h3><div class="adm-line"></div>' +
      '<textarea id="rosterText" class="roster-text" rows="8" placeholder="Вставь сюда таблицу целиком"></textarea>' +
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
  }

  function renderDashboard() {
    if (!me) return;
    $("#lockedBox").hidden = me.isAdmin;
    $("#adminBox").hidden = !me.isAdmin;
    $("#lockedText").textContent = LOCKED_TEXT;
    if (me.isAdmin) {
      $("#dashName").textContent = me.name;
      const p = PATHS[me.path];
      $("#chipPath").textContent = "Путь: " + (p ? p.name : "—");
      $("#chipBuff").textContent = "Бафф: " + (p ? p.buffName : "—");
      renderAdminPanel();
      refreshAdmin(true);
    }
  }

  let polling = false;
  async function poll() {
    if (polling || !session.token || document.hidden) return;
    polling = true;
    try {
      const res = await rpc("app_me", { p_token: session.token });
      if (res.error) return;
      if (!res.data) {
        logoutLocal("Нужно войти заново");
        return;
      }
      const wasAdmin = me && me.isAdmin;
      me = res.data;
      if (isActive("screen-pending") && me.approved) {
        routeAfterLogin();
        return;
      }
      if (isActive("screen-dashboard")) {
        if (wasAdmin !== me.isAdmin) renderDashboard();
        else if (me.isAdmin) await refreshAdmin(false);
      }
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
        const hintEl = $("#adminCodeHint");
        if (hintEl && isOwner(me.id)) hintEl.classList.add("show");
        routeAfterLogin();
      } else {
        session.token = null;
        store.del(TOKEN_KEY);
        showScreen("screen-auth");
      }
    } else {
      showScreen("screen-auth");
    }

    startPolling();
    hideLoader();
  }

  init();
})();
