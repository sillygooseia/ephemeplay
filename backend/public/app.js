/* ═══════════════════════════════════════
   EphemeDeck  — app.js
════════════════════════════════════════ */

/* DOM refs — landing */
const statusEl            = document.getElementById("status");
const createRoomBtn       = document.getElementById("createRoom");
const createRoomSecondary = document.getElementById("createRoomSecondary");
const joinFromUrlBtn      = document.getElementById("joinFromUrl");

/* DOM refs — table view */
const tableViewEl   = document.getElementById("tableView");
const landingViewEl = document.getElementById("landingView");
const tableEl       = document.getElementById("table");
const tRoomIdEl     = document.getElementById("tRoomId");
const tExpiryEl     = document.getElementById("tExpiry");
const tSeatsEl      = document.getElementById("tSeats");
const shuffleBtn    = document.getElementById("shuffleDeck");
const dealBtn       = document.getElementById("dealCards");
const copyLinkBtn   = document.getElementById("copyLink");
const leaveBtn      = document.getElementById("leaveTable");

/* State */
let socket           = null;
let roomId           = null;
let inviteToken      = null;
let expiresAt        = null;
let cardsById        = new Map();
let currentInviteLink = "";
let expiryTimer      = null;
let activeMembers    = [];
let myPrivateCards   = new Map(); // cardId → real card data (only cards I hold)

/* Player identity — stable across page refreshes via localStorage + server JWT */
const PLAYER_ID_KEY    = "ephemedeck_player_id";
const PLAYER_TOKEN_KEY = "ephemedeck_player_token";

let localMemberId  = localStorage.getItem(PLAYER_ID_KEY)
                     || `anon-${Math.random().toString(16).slice(2, 8)}`;
let localPlayerToken = localStorage.getItem(PLAYER_TOKEN_KEY) || null;

/**
 * Fetch (or refresh) a player identity JWT from the server.
 * Runs once at startup. The token is stored in localStorage so it survives refreshes.
 */
async function ensurePlayerIdentity() {
  try {
    const res = await fetch("/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: localMemberId,
        displayName: localStorage.getItem("ephemedeck_display_name") || undefined,
      }),
    });
    if (!res.ok) { return; }
    const { playerId, token } = await res.json();
    if (playerId) {
      localMemberId = playerId;
      localStorage.setItem(PLAYER_ID_KEY, playerId);
    }
    if (token) {
      localPlayerToken = token;
      localStorage.setItem(PLAYER_TOKEN_KEY, token);
    }
  } catch (_e) {
    // Server not ready or no identity endpoint — continue with anonymous ID
  }
}

/* Seat colours matching CSS vars */
const SEAT_COLORS = [
  "#f5c84a","#55c4f0","#f07055","#72db7a","#c075f5","#f0a040"
];

/* Suit symbol + colour helpers */
const SUIT_SYMBOLS = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
const RED_SUITS    = new Set(["hearts", "diamonds"]);

function suitSymbol(suit)  { return SUIT_SYMBOLS[suit] || suit; }
function isRedSuit(suit)   { return RED_SUITS.has(suit); }

/* ──────────────────────────────────────
   View switching
────────────────────────────────────── */
function showTableView() {
  landingViewEl.classList.add("hidden");
  tableViewEl.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function showLandingView() {
  tableViewEl.classList.add("hidden");
  landingViewEl.classList.remove("hidden");
  document.body.style.overflow = "";
  stopExpiryCountdown();
}

/* ──────────────────────────────────────
   Expiry countdown
────────────────────────────────────── */
function startExpiryCountdown(ts) {
  expiresAt = ts;
  stopExpiryCountdown();
  expiryTimer = setInterval(() => tickExpiry(), 1000);
  tickExpiry();
}

function stopExpiryCountdown() {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

function tickExpiry() {
  if (!expiresAt) { return; }
  const ms  = expiresAt - Date.now();
  if (ms <= 0) {
    tExpiryEl.textContent = "expired";
    tExpiryEl.classList.add("warn");
    return;
  }
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  tExpiryEl.textContent = h > 0
    ? `${h}h ${m}m`
    : m > 0
      ? `${m}m ${String(s).padStart(2,"0")}s`
      : `${s}s`;
  tExpiryEl.classList.toggle("warn", totalSec < 300);
}

/* ──────────────────────────────────────
   Seat presence indicators
────────────────────────────────────── */
/* Assign each memberId a stable colour index */
const seatIndex = new Map();
let nextSeatIdx = 0;

function getSeatIndex(memberId) {
  if (!seatIndex.has(memberId)) {
    seatIndex.set(memberId, nextSeatIdx % SEAT_COLORS.length);
    nextSeatIdx += 1;
  }
  return seatIndex.get(memberId);
}

function renderSeats(members) {
  activeMembers = members;

  /* Build/update HUD seat pips */
  tSeatsEl.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const pip = document.createElement("div");
    pip.className = "t-seat-pip";
    pip.style.background = SEAT_COLORS[i];

    const occupant = members[i];
    if (occupant) {
      pip.classList.add("active");
      const isYou = occupant === localMemberId;
      pip.title = isYou ? "You" : `Player ${i + 1}`;
      pip.textContent = isYou ? "YOU" : String(i + 1);
    } else {
      pip.title = `Seat ${i + 1} — empty`;
      pip.textContent = String(i + 1);
    }
    tSeatsEl.appendChild(pip);
  }

  /* Update seat zone labels around the table */
  const SEAT_SLOT_ATTRS = ["t-sz-bottom","t-sz-top","t-sz-left","t-sz-right","t-sz-top-left","t-sz-top-right"];
  SEAT_SLOT_ATTRS.forEach((cls, i) => {
    const zone = document.querySelector(`.${cls}`);
    if (!zone) { return; }
    const occupant = members[i];
    if (occupant) {
      const isYou = occupant === localMemberId;
      zone.dataset.label  = isYou ? "▶ You" : `Player ${i + 1}`;
      zone.classList.add("occupied");
      zone.classList.remove("empty");
    } else {
      zone.dataset.label  = `\u00D7 Empty`;
      zone.classList.remove("occupied");
      zone.classList.add("empty");
    }
  });
}

/* ──────────────────────────────────────
   Card rendering
────────────────────────────────────── */

/**
 * Returns a short display label for a memberId.
 * "You" for the local player, "Player N" (1-based seat) for others.
 */
function getPlayerLabel(memberId) {
  if (memberId === localMemberId) { return "You"; }
  const idx = activeMembers.indexOf(memberId);
  return idx >= 0 ? `P${idx + 1}` : "?";
}
function buildCardFace(card) {
  const sym    = suitSymbol(card.suit);
  const red    = isRedSuit(card.suit);
  const colour = red ? "red" : "black";

  const tl = document.createElement("span");
  tl.className = "card-rank-tl";
  tl.innerHTML = `${card.rank}<span class="suit-pip">${sym}</span>`;

  const br = document.createElement("span");
  br.className = "card-rank-br";
  br.innerHTML = `${card.rank}<span class="suit-pip">${sym}</span>`;

  const center = document.createElement("span");
  center.className = "card-center-suit";
  center.textContent = sym;

  return { tl, br, center, colour };
}

function upsertCardElement(card) {
  // If this card is in our private hand, use the real (unmasked) data for rendering
  const renderCard = myPrivateCards.has(card.id) ? myPrivateCards.get(card.id) : card;
  let el = document.getElementById(card.id);
  const isNew = !el;

  if (isNew) {
    el = document.createElement("button");
    el.id   = card.id;
    el.type = "button";

    el.addEventListener("dblclick", () => {
      if (socket) { socket.emit("card:flip", { id: card.id }); }
    });

    // Right-click: open card context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCardMenu(card.id, e.clientX, e.clientY);
    });

    let ptrOffX = 0, ptrOffY = 0;

    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      const r  = tableEl.getBoundingClientRect();
      ptrOffX  = (e.clientX - r.left) / r.width  * 100 - (parseFloat(el.style.left)  || card.x);
      ptrOffY  = (e.clientY - r.top)  / r.height * 100 - (parseFloat(el.style.top)   || card.y);
      el.dataset.dragging = "true";
      el.style.transition = "box-shadow 100ms"; // suppress position glide during drag
    });

    el.addEventListener("pointermove", (e) => {
      if (el.dataset.dragging !== "true") { return; }
      const r = tableEl.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width)  * 100 - ptrOffX;
      const y = ((e.clientY - r.top)  / r.height) * 100 - ptrOffY;
      el.style.left = `${Math.max(2, Math.min(98, x))}%`;
      el.style.top  = `${Math.max(2, Math.min(98, y))}%`;
    });

    el.addEventListener("pointerup", (e) => {
      if (el.dataset.dragging !== "true") { return; }
      el.releasePointerCapture(e.pointerId);
      el.dataset.dragging = "false";
      el.style.transition = ""; // restore CSS transition for animated moves
      const r = tableEl.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width)  * 100;
      const y = ((e.clientY - r.top)  / r.height) * 100;
      if (socket) { socket.emit("card:move", { id: card.id, x, y }); }
    });

    tableEl.appendChild(el);
  }

  /* Sync visual state */
  const wasUp   = el.classList.contains("face-up");
  const nowUp   = renderCard.faceUp;
  const isMine  = myPrivateCards.has(card.id);
  const holder  = card.privateHolder; // may be null (public) or a memberId

  el.className = "card";
  if (isMine) { el.classList.add("held"); }
  if (holder)  { el.classList.add("private"); }

  if (nowUp) {
    const { tl, br, center, colour } = buildCardFace(renderCard);
    el.classList.add("face-up", colour);
    el.innerHTML = "";
    el.appendChild(tl);
    el.appendChild(center);
    el.appendChild(br);
  } else {
    el.classList.add("face-down");
    el.innerHTML = "";
  }

  // Holder tag — always re-render so label stays current
  if (holder) {
    const tag = document.createElement("span");
    tag.className = "card-holder-tag" + (isMine ? " is-mine" : "");
    tag.textContent = getPlayerLabel(holder);
    el.appendChild(tag);
  }

  el.style.left    = `${card.x}%`;
  el.style.top     = `${card.y}%`;
  el.style.zIndex  = String(card.z || 1);
}

function renderSnapshot(snapshot) {
  // Prune myPrivateCards to only cards still held by us in this snapshot
  const stillHeld = new Set(
    snapshot.cards.filter((c) => c.privateHolder === localMemberId).map((c) => c.id)
  );
  for (const id of myPrivateCards.keys()) {
    if (!stillHeld.has(id)) { myPrivateCards.delete(id); }
  }

  cardsById = new Map(snapshot.cards.map((c) => [c.id, c]));

  const knownIds = new Set(snapshot.cards.map((c) => c.id));
  Array.from(tableEl.children).forEach((child) => {
    if (!knownIds.has(child.id)) { child.remove(); }
  });

  snapshot.cards.forEach(upsertCardElement);

  if (snapshot.expiresAt) {
    startExpiryCountdown(snapshot.expiresAt);
  }
}

/* ──────────────────────────────────────
   Card context menu
────────────────────────────────────── */
const cardMenuEl  = document.getElementById("cardMenu");
const cmTakeBtn   = document.getElementById("cmTake");
const cmReleaseBtn= document.getElementById("cmRelease");
const cmRevealBtn = document.getElementById("cmReveal");
const cmFlipBtn   = document.getElementById("cmFlip");

let menuTargetId  = null;

function openCardMenu(cardId, clientX, clientY) {
  if (!socket) { return; }
  menuTargetId = cardId;

  const isMine   = myPrivateCards.has(cardId);
  const cardData = cardsById.get(cardId);
  const isHeldByOther = cardData && cardData.privateHolder && !isMine;

  // Enable/disable items based on state
  cmTakeBtn.disabled    = isMine || isHeldByOther;
  cmReleaseBtn.disabled = !isMine;
  cmRevealBtn.disabled  = !isMine;
  cmFlipBtn.disabled    = isHeldByOther; // can't flip another player's private card

  cardMenuEl.removeAttribute("hidden");

  // Position near cursor, keeping it inside the viewport
  const menuW = 180, menuH = 160;
  const x = Math.min(clientX + 4, window.innerWidth  - menuW - 8);
  const y = Math.min(clientY + 4, window.innerHeight - menuH - 8);
  cardMenuEl.style.left = `${x}px`;
  cardMenuEl.style.top  = `${y}px`;
}

function closeCardMenu() {
  cardMenuEl.setAttribute("hidden", "");
  menuTargetId = null;
}

cmTakeBtn.addEventListener("click", () => {
  if (socket && menuTargetId) { socket.emit("card:take", { id: menuTargetId }); }
  closeCardMenu();
});

cmReleaseBtn.addEventListener("click", () => {
  if (socket && menuTargetId) { socket.emit("card:release", { id: menuTargetId, faceUp: false }); }
  closeCardMenu();
});

cmRevealBtn.addEventListener("click", () => {
  if (socket && menuTargetId) { socket.emit("card:release", { id: menuTargetId, faceUp: true }); }
  closeCardMenu();
});

cmFlipBtn.addEventListener("click", () => {
  if (socket && menuTargetId) { socket.emit("card:flip", { id: menuTargetId }); }
  closeCardMenu();
});

// Close menu on click outside or Escape
document.addEventListener("pointerdown", (e) => {
  if (!cardMenuEl.hidden && !cardMenuEl.contains(e.target)) { closeCardMenu(); }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeCardMenu(); }
});

/* ──────────────────────────────────────
   Socket connection
────────────────────────────────────── */
function connectRoom() {
  if (!roomId || !inviteToken) { return; }
  if (socket) { socket.disconnect(); }

  socket = io({
    auth: { roomId, token: inviteToken, memberId: localMemberId, playerToken: localPlayerToken }
  });

  socket.on("connect", () => {
    tRoomIdEl.textContent = roomId;
    showTableView();
  });

  socket.on("room:snapshot", (snapshot) => {
    renderSnapshot(snapshot);
    if (snapshot.members) { renderSeats(snapshot.members); }
  });

  socket.on("room:presence", ({ members }) => {
    renderSeats(members);
  });

  socket.on("card:patch", ({ card }) => {
    // If the card is released from private, clear it from our local hand
    if (!card.privateHolder || card.privateHolder !== localMemberId) {
      myPrivateCards.delete(card.id);
    }
    cardsById.set(card.id, card);
    upsertCardElement(card);
  });

  socket.on("card:private", ({ card }) => {
    // Server is sending us the real (unmasked) data for one of our held cards
    myPrivateCards.set(card.id, card);
    cardsById.set(card.id, card);
    upsertCardElement(card);
  });

  socket.on("room:expired", () => {
    stopExpiryCountdown();
    showLandingView();
    setStatus("That table expired. Create a new one.", "error");
  });

  socket.on("connect_error", () => {
    showLandingView();
    setStatus("Could not connect — invite may be expired.", "error");
  });
}

/* ──────────────────────────────────────
   Room join / create
────────────────────────────────────── */
async function joinRoom(targetRoomId, targetToken) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(targetRoomId)}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: targetToken })
  });

  if (!res.ok) {
    let reason = "Could not join — please try again.";
    if (res.status === 403) {
      reason = "Invite link is invalid or has expired.";
    } else if (res.status === 404) {
      reason = "That room no longer exists.";
    } else if (res.status === 429) {
      reason = "Too many attempts — please wait a moment and try again.";
    }
    // Try to surface any message from the server body
    try {
      const body = await res.json();
      if (body?.error) { reason += ` (${body.error})`; }
    } catch (_) { /* ignore parse errors */ }
    setStatus(reason, "error");
    throw new Error(reason);
  }
  const payload = await res.json();
  roomId         = targetRoomId;
  inviteToken    = targetToken;
  currentInviteLink = `${window.location.origin}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(inviteToken)}`;

  renderSnapshot(payload.room);
  connectRoom();
}

async function createRoom() {
  setStatus("Creating table…");

  try {
    const res     = await fetch("/api/rooms", { method: "POST" });
    const payload = await res.json();

    await joinRoom(payload.roomId, payload.inviteToken);

    const url = new URL(window.location.href);
    url.searchParams.set("room", payload.roomId);
    url.searchParams.set("token", payload.inviteToken);
    window.history.replaceState({}, "", url);
  } catch (_e) {
    setStatus("Could not create room — please try again.", "error");
  }
}

function setStatus(text, type = "info") {
  if (!statusEl) { return; }
  // Re-trigger animation on repeated errors by briefly removing the class
  statusEl.classList.remove("status--error", "status--info");
  void statusEl.offsetWidth; // force reflow
  statusEl.textContent = text;
  statusEl.classList.add(type === "error" ? "status--error" : "status--info");
}

/* ──────────────────────────────────────
   Event wiring
────────────────────────────────────── */
createRoomBtn?.addEventListener("click", createRoom);
createRoomSecondary?.addEventListener("click", createRoom);

joinFromUrlBtn?.addEventListener("click", async () => {
  const p = new URLSearchParams(window.location.search);
  const r = p.get("room");
  const t = p.get("token");
  if (!r || !t) {
    setStatus("No room URL detected — use an invite link.", "error");
    return;
  }
  setStatus("Joining…");
  try {
    await joinRoom(r, t);
  } catch (_e) {
    // joinRoom already called setStatus with a specific message
  }
});

copyLinkBtn?.addEventListener("click", async () => {
  if (!currentInviteLink) { return; }
  try {
    await navigator.clipboard.writeText(currentInviteLink);
    const orig = copyLinkBtn.textContent;
    copyLinkBtn.textContent = "✓ Copied!";
    setTimeout(() => { copyLinkBtn.textContent = orig; }, 2000);
  } catch (_e) {
    prompt("Copy this invite link:", currentInviteLink);
  }
});

shuffleBtn?.addEventListener("click", () => {
  if (socket) { socket.emit("deck:shuffle"); }
});

dealBtn?.addEventListener("click", () => {
  /* Deal 5 cards to up to however many members are at the table (max 6) */
  const players = Math.max(1, Math.min(6, activeMembers.length || 1));
  if (socket) { socket.emit("deck:deal", { players, count: 5 }); }
});

leaveBtn?.addEventListener("click", () => {
  if (socket) { socket.disconnect(); socket = null; }
  roomId = null; inviteToken = null;
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url);
  showLandingView();
});

/* Boot: establish stable player identity, then auto-join if URL params present */
(async function boot() {
  await ensurePlayerIdentity();

  const p = new URLSearchParams(window.location.search);
  const r = p.get("room");
  const t = p.get("token");
  if (r && t) {
    joinRoom(r, t).catch(() => { /* joinRoom already called setStatus */ });
  }
}());
