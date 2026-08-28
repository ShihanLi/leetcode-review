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
  reviewView: document.getElementById("review-view"),
  addView: document.getElementById("add-view"),
  addForm: document.getElementById("add-form"),
  addUrl: document.getElementById("add-url"),
  addTitle: document.getElementById("add-title"),
  addInsight: document.getElementById("add-insight"),
  addStatus: document.getElementById("add-status"),
};

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

function showReviewView() {
  els.navReview.classList.add("active");
  els.navAdd.classList.remove("active");
  els.reviewView.hidden = false;
  els.addView.hidden = true;
}

function showAddView() {
  els.navAdd.classList.add("active");
  els.navReview.classList.remove("active");
  els.addView.hidden = false;
  els.reviewView.hidden = true;
  els.addStatus.textContent = "";
  els.addStatus.className = "";
}

els.navReview.addEventListener("click", () => {
  showReviewView();
  loadQueue();
});
els.navAdd.addEventListener("click", showAddView);

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

async function init() {
  await loadQueue();
}

init();
