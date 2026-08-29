import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.2";
import { python } from "https://esm.sh/@codemirror/lang-python@6.2.1";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6.1.3";

const REVIEW_SECONDS = 180;

let queue = [];
let idx = 0;
let timerInterval = null;
let remaining = REVIEW_SECONDS;
let startedAt = null;
let editorView = null;

const els = {
  progress: document.getElementById("progress"),
  card: document.getElementById("card"),
  empty: document.getElementById("empty"),
  loading: document.getElementById("loading"),
  title: document.getElementById("card-title"),
  timer: document.getElementById("timer"),
  editorContainer: document.getElementById("editor"),
  revealBtn: document.getElementById("reveal-btn"),
  insightPanel: document.getElementById("insight-panel"),
  insightText: document.getElementById("insight-text"),
  ratings: document.getElementById("ratings"),
  ratingButtons: document.querySelectorAll(".rating"),
  editBtn: document.getElementById("edit-btn"),
  editPanel: document.getElementById("edit-panel"),
  editUrl: document.getElementById("edit-url"),
  editTitle: document.getElementById("edit-title"),
  editInsight: document.getElementById("edit-insight"),
  editStatus: document.getElementById("edit-status"),
  editSave: document.getElementById("edit-save"),
  editCancel: document.getElementById("edit-cancel"),
  navReview: document.getElementById("nav-review"),
  navAdd: document.getElementById("nav-add"),
  navCards: document.getElementById("nav-cards"),
  reviewView: document.getElementById("review-view"),
  addView: document.getElementById("add-view"),
  cardsView: document.getElementById("cards-view"),
  addForm: document.getElementById("add-form"),
  addUrl: document.getElementById("add-url"),
  addTitle: document.getElementById("add-title"),
  addInsight: document.getElementById("add-insight"),
  addStatus: document.getElementById("add-status"),
  cardsLoading: document.getElementById("cards-loading"),
  cardsEmpty: document.getElementById("cards-empty"),
  cardsList: document.getElementById("cards-list"),
  streakBadge: document.getElementById("streak-badge"),
  streakCount: document.getElementById("streak-count"),
  heatmapMonths: document.getElementById("heatmap-months"),
  heatmapDays: document.getElementById("heatmap-days"),
  heatmapGrid: document.getElementById("heatmap-grid"),
  heatmapTotal: document.getElementById("heatmap-total"),
  heatmapTip: document.getElementById("heatmap-tip"),
};

const WEEKDAY_LABELS = { 1: "Mon", 3: "Wed", 5: "Fri" };

function parseISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toISODate(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

// Scaled against the busiest day, the way GitHub calibrates to each user's own volume.
function levelFor(count, max) {
  if (!count) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ordinal(n) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function renderHeatmap({ year, grid_start, range_start, range_end, today, weeks, counts, total, max }) {
  const gridStart = parseISODate(grid_start);
  const rangeStart = parseISODate(range_start);
  const rangeEnd = parseISODate(range_end);
  // Days past today have no data to show, so the year stops at whichever comes first.
  const lastDataDay = new Date(Math.min(rangeEnd.getTime(), parseISODate(today).getTime()));

  els.heatmapTotal.textContent = `${plural(total, "review")} in ${year}`;
  els.heatmapGrid.style.setProperty("--hm-weeks", weeks);
  els.heatmapMonths.style.setProperty("--hm-weeks", weeks);
  els.heatmapGrid.innerHTML = "";
  els.heatmapMonths.innerHTML = "";
  els.heatmapDays.innerHTML = "";

  for (let row = 0; row < 7; row++) {
    const label = document.createElement("span");
    label.textContent = WEEKDAY_LABELS[row] || "";
    els.heatmapDays.appendChild(label);
  }

  const cells = document.createDocumentFragment();
  let lastLabelMonth = -1;
  let lastLabelCol = -3;

  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + col * 7 + row);

      // Every square is drawn, including days outside the window and days still to
      // come this week; they just carry no data and no tooltip.
      const cell = document.createElement("div");
      cell.className = "hm-cell";
      cell.style.gridColumn = col + 1;
      cell.style.gridRow = row + 1;

      if (day >= rangeStart && day <= lastDataDay) {
        const count = counts[toISODate(day)] || 0;
        cell.dataset.level = levelFor(count, max);
        const label = count ? plural(count, "review") : "No reviews";
        const month = day.toLocaleDateString(undefined, { month: "long" });
        cell.dataset.tip = `${label} on ${month} ${ordinal(day.getDate())}.`;
      }
      cells.appendChild(cell);
    }

    // Label each column by the first day in it that belongs to the year, so the
    // leading days from the previous December don't produce a stray label.
    let colDay = null;
    for (let row = 0; row < 7 && !colDay; row++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + col * 7 + row);
      if (day >= rangeStart && day <= rangeEnd) colDay = day;
    }
    if (colDay && colDay.getMonth() !== lastLabelMonth && col - lastLabelCol >= 3) {
      const label = document.createElement("span");
      label.textContent = colDay.toLocaleDateString(undefined, { month: "short" });
      label.style.gridColumn = col + 1;
      els.heatmapMonths.appendChild(label);
      lastLabelMonth = colDay.getMonth();
      lastLabelCol = col;
    }
  }

  els.heatmapGrid.appendChild(cells);
}

function showTip(cell) {
  els.heatmapTip.textContent = cell.dataset.tip;
  els.heatmapTip.hidden = false;
  const cellRect = cell.getBoundingClientRect();
  const tipRect = els.heatmapTip.getBoundingClientRect();
  const left = cellRect.left + cellRect.width / 2 - tipRect.width / 2;
  const clamped = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
  els.heatmapTip.style.left = `${clamped + window.scrollX}px`;
  els.heatmapTip.style.top = `${cellRect.top - tipRect.height - 6 + window.scrollY}px`;
}

els.heatmapGrid.addEventListener("mouseover", (e) => {
  const cell = e.target.closest(".hm-cell");
  if (cell && cell.dataset.tip) showTip(cell);
});
els.heatmapGrid.addEventListener("mouseleave", () => {
  els.heatmapTip.hidden = true;
});

async function loadHeatmap() {
  const res = await fetch("/api/heatmap");
  renderHeatmap(await res.json());
}

let lastStreakCount = null;

async function loadStreak() {
  const res = await fetch("/api/streak");
  const data = await res.json();
  els.streakCount.textContent = data.current_streak;
  els.streakBadge.classList.toggle("active", data.reviewed_today);
  els.streakBadge.title = data.longest_streak
    ? `Longest streak: ${data.longest_streak} day${data.longest_streak === 1 ? "" : "s"} · ${data.total_reviews} reviews total`
    : "Review a card to start your streak";
  if (lastStreakCount !== null && data.current_streak > lastStreakCount) {
    els.streakBadge.classList.remove("bump");
    void els.streakBadge.offsetWidth;
    els.streakBadge.classList.add("bump");
  }
  lastStreakCount = data.current_streak;
}

function formatTime(sec) {
  const sign = sec < 0 ? "-" : "";
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

function startTimer() {
  remaining = REVIEW_SECONDS;
  startedAt = Date.now();
  els.timer.textContent = formatTime(remaining);
  els.timer.classList.remove("expired");
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    remaining -= 1;
    els.timer.textContent = formatTime(remaining);
    if (remaining <= 0) {
      els.timer.classList.add("expired");
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function elapsedSeconds() {
  return Math.round((Date.now() - startedAt) / 1000);
}

function ensureEditor() {
  if (editorView) return;
  editorView = new EditorView({
    doc: "",
    extensions: [basicSetup, python(), oneDark],
    parent: els.editorContainer,
  });
}

function clearEditor() {
  ensureEditor();
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: "" },
  });
}

function renderCard() {
  if (idx >= queue.length) {
    els.card.hidden = true;
    els.empty.hidden = false;
    els.progress.textContent = "";
    stopTimer();
    return;
  }
  const card = queue[idx];
  els.empty.hidden = true;
  els.card.hidden = false;
  els.progress.textContent = `${idx + 1} / ${queue.length}`;
  els.title.textContent = card.title;
  els.title.href = card.url;
  els.insightText.textContent = card.insight;
  els.insightPanel.hidden = true;
  els.ratings.hidden = true;
  els.revealBtn.hidden = false;
  closeEditPanel();
  clearEditor();
  startTimer();
}

els.revealBtn.addEventListener("click", () => {
  els.insightPanel.hidden = false;
  els.ratings.hidden = false;
  els.revealBtn.hidden = true;
});

function closeEditPanel() {
  els.editPanel.hidden = true;
  els.editBtn.hidden = false;
  els.editStatus.textContent = "";
  els.editStatus.className = "";
}

els.editBtn.addEventListener("click", () => {
  const card = queue[idx];
  els.editUrl.value = card.url;
  els.editTitle.value = card.title;
  els.editInsight.value = card.insight;
  els.editStatus.textContent = "";
  els.editStatus.className = "";
  els.editPanel.hidden = false;
  els.editBtn.hidden = true;
});

els.editCancel.addEventListener("click", closeEditPanel);

els.editSave.addEventListener("click", async () => {
  const card = queue[idx];
  const body = {
    url: els.editUrl.value.trim(),
    title: els.editTitle.value.trim(),
    insight: els.editInsight.value.trim(),
  };

  const res = await fetch(`/api/cards/${card.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    Object.assign(card, body);
    els.title.textContent = card.title;
    els.title.href = card.url;
    els.insightText.textContent = card.insight;
    closeEditPanel();
  } else {
    const err = await res.json().catch(() => ({}));
    els.editStatus.textContent = err.detail || "Failed to save card.";
    els.editStatus.className = "status-error";
  }
});

async function submitRating(rating) {
  const card = queue[idx];
  const elapsed = elapsedSeconds();
  stopTimer();
  await fetch(`/api/reviews/${card.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating, elapsed_seconds: elapsed }),
  });
  idx += 1;
  renderCard();
  loadStreak();
  loadHeatmap();
}

els.ratingButtons.forEach((btn) => {
  btn.addEventListener("click", () => submitRating(Number(btn.dataset.rating)));
});

async function loadQueue() {
  els.loading.hidden = false;
  const res = await fetch("/api/queue");
  queue = await res.json();
  els.loading.hidden = true;
  idx = 0;
  renderCard();
}

function showView(name) {
  els.navReview.classList.toggle("active", name === "review");
  els.navAdd.classList.toggle("active", name === "add");
  els.navCards.classList.toggle("active", name === "cards");
  els.reviewView.hidden = name !== "review";
  els.addView.hidden = name !== "add";
  els.cardsView.hidden = name !== "cards";
}

function showReviewView() {
  showView("review");
}

function showAddView() {
  showView("add");
  els.addStatus.textContent = "";
  els.addStatus.className = "";
}

function showCardsView() {
  showView("cards");
}

els.navReview.addEventListener("click", () => {
  showReviewView();
  loadQueue();
});
els.navAdd.addEventListener("click", showAddView);
els.navCards.addEventListener("click", () => {
  showCardsView();
  loadAllCards();
});

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.addStatus.textContent = "";
  els.addStatus.className = "";

  const body = {
    url: els.addUrl.value.trim(),
    insight: els.addInsight.value.trim(),
    title: els.addTitle.value.trim() || null,
  };

  const res = await fetch("/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    els.addForm.reset();
    els.addStatus.textContent = "Card added.";
    els.addStatus.className = "status-ok";
  } else {
    const err = await res.json().catch(() => ({}));
    els.addStatus.textContent = err.detail || "Failed to add card.";
    els.addStatus.className = "status-error";
  }
});

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.forEach((c) => node.appendChild(c));
  return node;
}

function formatDue(iso) {
  const due = new Date(iso);
  const diffMs = due.getTime() - Date.now();
  const past = diffMs <= 0;
  const absMs = Math.abs(diffMs);

  const minutes = Math.round(absMs / 60000);
  const hours = Math.round(absMs / 3600000);
  const days = Math.round(absMs / 86400000);

  let span;
  if (minutes < 1) span = "less than a minute";
  else if (minutes < 60) span = plural(minutes, "minute");
  else if (hours < 24) span = plural(hours, "hour");
  else span = plural(days, "day");

  return past ? `Overdue by ${span}` : `Due in ${span}`;
}

function buildCardRow(card) {
  const dueDate = new Date(card.due);
  const dueSpan = el("span", {
    className: "card-row-due" + (dueDate.getTime() <= Date.now() ? " due-now" : ""),
    textContent: formatDue(card.due),
    title: dueDate.toLocaleString(),
  });
  const titleLink = el("a", {
    className: "card-row-title",
    href: card.url,
    target: "_blank",
    rel: "noopener",
    textContent: card.title,
  });

  const editBtn = el("button", { className: "card-row-edit", type: "button", textContent: "Edit" });
  const deleteBtn = el("button", { className: "card-row-delete", type: "button", textContent: "Delete" });

  const urlInput = el("input", { type: "url", className: "card-row-edit-url", value: card.url });
  const titleInput = el("input", { type: "text", className: "card-row-edit-title", value: card.title });
  const insightInput = el("textarea", { rows: 4, className: "card-row-edit-insight", value: card.insight });
  const status = el("div", { className: "card-row-edit-status" });
  const saveBtn = el("button", { className: "card-row-save", type: "button", textContent: "Save" });
  const cancelBtn = el("button", { className: "card-row-cancel", type: "button", textContent: "Cancel" });

  const editPanel = el("div", { className: "card-row-edit-panel", hidden: true }, [
    el("label", { textContent: "URL" }),
    urlInput,
    el("label", { textContent: "Title" }),
    titleInput,
    el("label", { textContent: "Insight" }),
    insightInput,
    status,
    el("div", { className: "edit-actions" }, [saveBtn, cancelBtn]),
  ]);

  const row = el("div", { className: "card-row" }, [
    el("div", { className: "card-row-main" }, [titleLink, dueSpan]),
    el("div", { className: "card-row-actions" }, [editBtn, deleteBtn]),
    editPanel,
  ]);
  row.dataset.id = card.id;
  return row;
}

function resetDeleteButton(btn) {
  btn.classList.remove("confirm");
  btn.textContent = "Delete";
  clearTimeout(btn._confirmTimer);
}

els.cardsList.addEventListener("click", async (e) => {
  const row = e.target.closest(".card-row");
  if (!row) return;
  const id = Number(row.dataset.id);

  if (e.target.classList.contains("card-row-delete")) {
    const btn = e.target;
    if (!btn.classList.contains("confirm")) {
      btn.classList.add("confirm");
      btn.textContent = "Confirm?";
      btn._confirmTimer = setTimeout(() => resetDeleteButton(btn), 3000);
      return;
    }
    resetDeleteButton(btn);
    const res = await fetch(`/api/cards/${id}`, { method: "DELETE" });
    if (res.ok) {
      row.remove();
      if (!els.cardsList.children.length) els.cardsEmpty.hidden = false;
    }
    return;
  }

  if (e.target.classList.contains("card-row-edit")) {
    const panel = row.querySelector(".card-row-edit-panel");
    panel.hidden = !panel.hidden;
    return;
  }

  if (e.target.classList.contains("card-row-cancel")) {
    row.querySelector(".card-row-edit-panel").hidden = true;
    return;
  }

  if (e.target.classList.contains("card-row-save")) {
    const panel = row.querySelector(".card-row-edit-panel");
    const status = panel.querySelector(".card-row-edit-status");
    const body = {
      url: panel.querySelector(".card-row-edit-url").value.trim(),
      title: panel.querySelector(".card-row-edit-title").value.trim(),
      insight: panel.querySelector(".card-row-edit-insight").value.trim(),
    };
    const res = await fetch(`/api/cards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      row.querySelector(".card-row-title").textContent = body.title;
      row.querySelector(".card-row-title").href = body.url;
      panel.hidden = true;
      status.textContent = "";
      status.className = "card-row-edit-status";
    } else {
      const err = await res.json().catch(() => ({}));
      status.textContent = err.detail || "Failed to save card.";
      status.className = "card-row-edit-status status-error";
    }
  }
});

async function loadAllCards() {
  els.cardsLoading.hidden = false;
  els.cardsEmpty.hidden = true;
  els.cardsList.innerHTML = "";
  const res = await fetch("/api/cards");
  const cards = await res.json();
  els.cardsLoading.hidden = true;
  if (!cards.length) {
    els.cardsEmpty.hidden = false;
    return;
  }
  const fragment = document.createDocumentFragment();
  cards.forEach((card) => fragment.appendChild(buildCardRow(card)));
  els.cardsList.appendChild(fragment);
}

async function init() {
  await loadQueue();
  await loadStreak();
  await loadHeatmap();
}

init();
