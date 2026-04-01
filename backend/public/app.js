/* ═══════════════════════════════════════
   EphemeDeck  — app.js
════════════════════════════════════════ */

/* DOM refs — landing */
const statusEl            = document.getElementById("status");
const createRoomBtn       = document.getElementById("createRoom");
const createRoomSecondary = document.getElementById("createRoomSecondary");
const deckCountDown       = document.getElementById("deckCountDown");
const deckCountUp         = document.getElementById("deckCountUp");
const deckCountValEl      = document.getElementById("deckCountVal");
const joinFromUrlBtn      = document.getElementById("joinFromUrl");
const findPlayersBtn      = document.getElementById("findPlayers");

/* DOM refs — table view */
const tableViewEl   = document.getElementById("tableView");
const landingViewEl = document.getElementById("landingView");
const lobbyViewEl   = document.getElementById("lobbyView");
const tableEl       = document.getElementById("table");
const tRoomIdEl     = document.getElementById("tRoomId");
const tExpiryEl     = document.getElementById("tExpiry");
const tSeatsEl      = document.getElementById("tSeats");
const shuffleBtn    = document.getElementById("shuffleDeck");
const dealBtn       = document.getElementById("dealCards");
const dealCountDown = document.getElementById("dealCountDown");
const dealCountUp   = document.getElementById("dealCountUp");
const dealCountVal  = document.getElementById("dealCountVal");
const passTurnBtn   = document.getElementById("passTurn");
const copyLinkBtn   = document.getElementById("copyLink");
const leaveBtn      = document.getElementById("leaveTable");

/* DOM refs — global lobby */
const leaveLobbyBtn       = document.getElementById("leaveLobby");
const lobbyPlayersEl      = document.getElementById("lobbyPlayers");
const lobbyStatusEl       = document.getElementById("lobbyStatus");
const lobbySignalsEl      = document.getElementById("lobbySignals");
const lobbyIncomingEl     = document.getElementById("lobbyIncoming");
const lobbyIncomingTextEl = document.getElementById("lobbyIncomingText");
const acceptProposalBtn   = document.getElementById("acceptProposal");
const declineProposalBtn  = document.getElementById("declineProposal");
const lobbyDeckDownBtn    = document.getElementById("lobbyDeckDown");
const lobbyDeckUpBtn      = document.getElementById("lobbyDeckUp");
const lobbyDeckValEl      = document.getElementById("lobbyDeckVal");

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
let dealCount        = 5;         // cards per player for the next deal
let deckCount        = 1;         // number of decks to use when creating a room
let activeTurn       = null;      // memberId whose turn it is, or null
let inLobby          = false;
let lobbyPlayers     = [];
let lobbySignal      = "ready";
let lobbyDeckCount   = 1;
let pendingProposal  = null;
let lobbyHeartbeat   = null;

const LOBBY_SIGNAL_LABELS = {
  ready: "👍 Ready",
  quick: "⚡ Quick",
  casual: "🎲 Casual",
  "1min": "⏳ 1 min",
  brb: "☕ BRB",
  pass: "🚫 Pass"
};

/* Deck pile — visual stack of face-down undealt cards near table centre */
let PILE_CX          = 50;        // % — synced with server
let PILE_CY          = 50;
const PILE_THRESHOLD = 4;         // cards within 4% distance = part of pile
const PILE_DROP_R    = 14;        // drop within 14% = snaps back to pile
const dealInFlight   = new Set(); // card IDs currently animating from pile — exempt from isPileCard

function isPileCard(card) {
  return !dealInFlight.has(card.id) && !card.faceUp && !card.privateHolder &&
    Math.hypot(card.x - PILE_CX, card.y - PILE_CY) < PILE_THRESHOLD;
}

function updatePileWidget() {
  const pileEl = document.getElementById("deckPile");
  if (!pileEl) { return; }
  const count = Array.from(cardsById.values()).filter(isPileCard).length;
  pileEl.hidden = count === 0;
  const badge = pileEl.querySelector(".dp-count");
  if (badge) { badge.textContent = String(count); }
  // Keep widget visually centred on the pile position
  pileEl.style.left = `${PILE_CX}%`;
  pileEl.style.top  = `${PILE_CY}%`;
}

/* Player identity — stable across page refreshes via localStorage + server JWT */
const PLAYER_ID_KEY      = "ephemedeck_player_id";
const PLAYER_TOKEN_KEY   = "ephemedeck_player_token";
const PLAYER_NAME_KEY    = "ephemedeck_display_name";

let localMemberId    = localStorage.getItem(PLAYER_ID_KEY)
                       || `anon-${Math.random().toString(16).slice(2, 8)}`;
let localPlayerToken = localStorage.getItem(PLAYER_TOKEN_KEY) || null;
let localDisplayName = localStorage.getItem(PLAYER_NAME_KEY) || "";

// Wire name input
const playerNameInput = document.getElementById("playerName");
const nameSavedEl    = document.getElementById("nameSaved");
let nameSavedTimer   = null;
if (playerNameInput) {
  playerNameInput.value = localDisplayName;
  playerNameInput.addEventListener("input", () => {
    localDisplayName = playerNameInput.value.trim().slice(0, 20);
    localStorage.setItem(PLAYER_NAME_KEY, localDisplayName);
    if (nameSavedEl) {
      nameSavedEl.textContent = localDisplayName ? "\u2713 Saved" : "";
      nameSavedEl.classList.add("visible");
      clearTimeout(nameSavedTimer);
      nameSavedTimer = setTimeout(() => { nameSavedEl.classList.remove("visible"); }, 1800);
    }
  });
}

/* memberId → display name, populated from room:presence */
let memberNames = new Map();

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
  inLobby = false;
  stopLobbyHeartbeat();
  lobbyViewEl.classList.add("hidden");
  landingViewEl.classList.add("hidden");
  tableViewEl.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function showLandingView() {
  inLobby = false;
  stopLobbyHeartbeat();
  tableViewEl.classList.add("hidden");
  lobbyViewEl.classList.add("hidden");
  landingViewEl.classList.remove("hidden");
  document.body.style.overflow = "";
  stopExpiryCountdown();
}

function showLobbyView() {
  inLobby = true;
  pendingProposal = null;
  tableViewEl.classList.add("hidden");
  landingViewEl.classList.add("hidden");
  lobbyViewEl.classList.remove("hidden");
  document.body.style.overflow = "";
  stopExpiryCountdown();
}

function stopLobbyHeartbeat() {
  if (lobbyHeartbeat) {
    clearInterval(lobbyHeartbeat);
    lobbyHeartbeat = null;
  }
}

function signalLabel(signal) {
  return LOBBY_SIGNAL_LABELS[signal] || "Ready";
}

function renderLobbySignals() {
  if (!lobbySignalsEl) { return; }
  for (const chip of lobbySignalsEl.querySelectorAll(".lobby-chip")) {
    chip.classList.toggle("active", chip.dataset.signal === lobbySignal);
  }
}

function renderLobbyIncoming() {
  if (!lobbyIncomingEl || !lobbyIncomingTextEl) { return; }
  if (!pendingProposal || pendingProposal.direction !== "incoming") {
    lobbyIncomingEl.classList.add("hidden");
    return;
  }
  const from = lobbyPlayers.find((p) => p.memberId === pendingProposal.fromMemberId);
  const deckLabel = pendingProposal.deckCount > 1 ? ` with ${pendingProposal.deckCount} decks` : "";
  lobbyIncomingTextEl.textContent = `${from?.displayName || "Player"} wants to start a game${deckLabel}.`;
  lobbyIncomingEl.classList.remove("hidden");
}

function renderLobbyPlayers() {
  if (!lobbyPlayersEl) { return; }
  lobbyPlayersEl.innerHTML = "";

  const others = lobbyPlayers.filter((p) => p.memberId !== localMemberId);
  if (others.length === 0) {
    const item = document.createElement("li");
    item.className = "lobby-empty";
    item.textContent = "No other players yet.";
    lobbyPlayersEl.appendChild(item);
    return;
  }

  for (const player of others) {
    const li = document.createElement("li");
    li.className = "lobby-player";

    const left = document.createElement("div");
    left.className = "lobby-player-meta";
    const strong = document.createElement("strong");
    strong.textContent = player.displayName;
    const signal = document.createElement("span");
    signal.textContent = signalLabel(player.signal);
    left.appendChild(strong);
    left.appendChild(signal);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "t-tool-btn";
    btn.textContent = "Propose Match";
    btn.disabled = !!pendingProposal;
    btn.addEventListener("click", () => {
      if (!socket) { return; }
      socket.emit("lobby:propose", { targetMemberId: player.memberId, deckCount: lobbyDeckCount });
      lobbyStatusEl.textContent = `Proposal sent to ${player.displayName}...`;
    });

    li.appendChild(left);
    li.appendChild(btn);
    lobbyPlayersEl.appendChild(li);
  }
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
    const isActive = occupant && occupant === activeTurn;
    if (isActive) { pip.classList.add("active-turn"); }
    if (occupant) {
      pip.classList.add("active");
      const isYou = occupant === localMemberId;
      const label = isYou ? (localDisplayName || "You") : (memberNames.get(occupant) || `P${i + 1}`);
      pip.title = isYou ? (localDisplayName || "You") : label;
      pip.textContent = label.slice(0, 4);
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
    const isActive = occupant && occupant === activeTurn;
    zone.classList.toggle("active-turn", !!isActive);
    if (occupant) {
      const isYou = occupant === localMemberId;
      const name  = isYou ? (localDisplayName || "You") : (memberNames.get(occupant) || `Player ${i + 1}`);
      zone.dataset.label  = isYou ? `\u25B6 ${name}` : name;
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
  if (memberId === localMemberId) {
    return localDisplayName || "You";
  }
  const name = memberNames.get(memberId);
  if (name) { return name; }
  const idx = activeMembers.indexOf(memberId);
  return idx >= 0 ? `P${idx + 1}` : "?";
}

/* Apply/remove active-turn glow on the seat zone surface elements */
function applyTurnHighlight() {
  const SEAT_SLOT_ATTRS = ["t-sz-bottom","t-sz-top","t-sz-left","t-sz-right","t-sz-top-left","t-sz-top-right"];
  const isMyTurn = activeTurn && activeTurn === localMemberId;
  if (passTurnBtn) {
    const multiPlayer = activeMembers.filter(Boolean).length > 1;
    const turnGroup = document.getElementById("turnGroup");
    if (turnGroup) turnGroup.hidden = !multiPlayer;
    passTurnBtn.disabled = !multiPlayer;
    passTurnBtn.title = activeTurn ? "Pass turn to next player (double-click to stop)" : "Start turn tracking";
    passTurnBtn.classList.toggle("t-tool-btn--turn-active", !!activeTurn);
  }
  SEAT_SLOT_ATTRS.forEach((cls, i) => {
    const zone = document.querySelector(`.${cls}`);
    if (!zone) { return; }
    zone.classList.toggle("active-turn", activeMembers[i] === activeTurn && !!activeTurn);
  });
  // Flash the whole table edge if it's your turn
  const tableWrap = document.querySelector(".t-room");
  if (tableWrap) { tableWrap.classList.toggle("your-turn", !!isMyTurn); }
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
    let ptrStartX = 0, ptrStartY = 0;

    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      const r  = tableEl.getBoundingClientRect();
      ptrOffX  = (e.clientX - r.left) / r.width  * 100 - (parseFloat(el.style.left)  || card.x);
      ptrOffY  = (e.clientY - r.top)  / r.height * 100 - (parseFloat(el.style.top)   || card.y);
      ptrStartX = e.clientX;
      ptrStartY = e.clientY;
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
      // Only broadcast a move if the pointer actually travelled (not a plain click)
      const dx = e.clientX - ptrStartX;
      const dy = e.clientY - ptrStartY;
      if (dx * dx + dy * dy < 25) { return; } // < 5px — treat as click, not drag
      const r = tableEl.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width)  * 100;
      const y = ((e.clientY - r.top)  / r.height) * 100;
      // If dropped near the pile centre, snap back into the pile
      if (!card.privateHolder && Math.hypot(x - PILE_CX, y - PILE_CY) < PILE_DROP_R) {
        const pileCount = Array.from(cardsById.values()).filter(isPileCard).length;
        const px = PILE_CX + (pileCount % 8) * 0.15;
        const py = PILE_CY + (pileCount % 8) * 0.15;
        if (socket) { socket.emit("card:move", { id: card.id, x: px, y: py }); }
        return;
      }
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

  // Visually hide cards that are part of the pile — the pile widget covers them
  const inPile = isPileCard(card);
  el.style.visibility  = inPile ? "hidden" : "";
  el.style.pointerEvents = inPile ? "none" : "";
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
    if (child.id === "deckPile") { return; } // keep pile widget
    if (!knownIds.has(child.id)) { child.remove(); }
  });

  snapshot.cards.forEach(upsertCardElement);
  updatePileWidget();

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
    auth: { roomId, token: inviteToken, memberId: localMemberId, playerToken: localPlayerToken, displayName: localDisplayName || undefined }
  });

  socket.on("connect", () => {
    tRoomIdEl.textContent = roomId;
    showTableView();
  });

  socket.on("card:deal-flight", ({ card, deckX, deckY }) => {
    // Mark card as in-flight so isPileCard doesn't hide it at the pile origin
    dealInFlight.add(card.id);
    cardsById.set(card.id, card);
    upsertCardElement({ ...card, x: deckX, y: deckY });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        cardsById.set(card.id, card);
        upsertCardElement(card);
        dealInFlight.delete(card.id);
        updatePileWidget();
      });
    });
  });

  socket.on("pile:moved", ({ x, y }) => {
    const dx = x - PILE_CX;
    const dy = y - PILE_CY;
    PILE_CX = x;
    PILE_CY = y;
    // Apply delta to all pile cards in local state AND in the DOM
    for (const card of cardsById.values()) {
      if (!card.faceUp && !card.privateHolder) {
        card.x += dx;
        card.y += dy;
        // Update DOM position so the deal animation starts from the right place
        const el = document.getElementById(card.id);
        if (el) {
          el.style.transition = "none"; // instant reposition, no slide
          el.style.left = `${card.x}%`;
          el.style.top  = `${card.y}%`;
          // Re-enable transition on next frame
          requestAnimationFrame(() => { el.style.transition = ""; });
        }
      }
    }
    updatePileWidget();
  });

  socket.on("turn:update", ({ activeTurn: t }) => {
    activeTurn = t || null;
    applyTurnHighlight();
    renderSeats(activeMembers);
  });

  socket.on("room:snapshot", (snapshot) => {
    if (snapshot.activeTurn !== undefined) { activeTurn = snapshot.activeTurn; }
    if (snapshot.pileX !== undefined) { PILE_CX = snapshot.pileX; }
    if (snapshot.pileY !== undefined) { PILE_CY = snapshot.pileY; }
    if (snapshot.names) { memberNames = new Map(Object.entries(snapshot.names)); }
    renderSnapshot(snapshot);
    if (snapshot.members) { renderSeats(snapshot.members); }
  });

  socket.on("room:presence", ({ members, names }) => {
    if (names) { memberNames = new Map(Object.entries(names)); }
    renderSeats(members);
  });

  socket.on("card:patch", ({ card }) => {
    // If the card is released from private, clear it from our local hand
    if (!card.privateHolder || card.privateHolder !== localMemberId) {
      myPrivateCards.delete(card.id);
    }
    cardsById.set(card.id, card);
    upsertCardElement(card);
    updatePileWidget();
  });

  socket.on("card:private", ({ card }) => {
    // Server is sending us the real (unmasked) data for one of our held cards
    myPrivateCards.set(card.id, card);
    cardsById.set(card.id, card);
    upsertCardElement(card);
    updatePileWidget();
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

function connectGlobalLobby() {
  if (socket) { socket.disconnect(); }
  socket = io({
    auth: {
      mode: "lobby",
      memberId: localMemberId,
      playerToken: localPlayerToken,
      displayName: localDisplayName || undefined
    }
  });

  socket.on("connect", () => {
    showLobbyView();
    renderLobbySignals();
    lobbyStatusEl.textContent = "Connected. Pick a signal and propose a match.";
    stopLobbyHeartbeat();
    lobbyHeartbeat = setInterval(() => {
      if (socket && inLobby) { socket.emit("lobby:heartbeat"); }
    }, 10_000);
  });

  socket.on("lobby:snapshot", ({ players, proposals }) => {
    lobbyPlayers = Array.isArray(players) ? players : [];
    const incoming = (proposals || []).find((p) => p.toMemberId === localMemberId);
    const outgoing = (proposals || []).find((p) => p.fromMemberId === localMemberId);
    pendingProposal = incoming
      ? { direction: "incoming", proposalId: incoming.proposalId, fromMemberId: incoming.fromMemberId }
      : outgoing
        ? { direction: "outgoing", proposalId: outgoing.proposalId, toMemberId: outgoing.toMemberId }
        : null;
    if (!pendingProposal) {
      lobbyStatusEl.textContent = "Waiting for players...";
    }
    renderLobbyIncoming();
    renderLobbyPlayers();
  });

  socket.on("lobby:proposal:incoming", ({ proposalId, fromMemberId, deckCount }) => {
    pendingProposal = { direction: "incoming", proposalId, fromMemberId, deckCount };
    lobbyStatusEl.textContent = "Incoming match proposal.";
    renderLobbyIncoming();
    renderLobbyPlayers();
  });

  socket.on("lobby:proposal:outgoing", ({ proposalId, toMemberId }) => {
    pendingProposal = { direction: "outgoing", proposalId, toMemberId };
    const target = lobbyPlayers.find((p) => p.memberId === toMemberId);
    lobbyStatusEl.textContent = `Waiting for ${target?.displayName || "player"} to respond...`;
    renderLobbyIncoming();
    renderLobbyPlayers();
  });

  socket.on("lobby:proposal:closed", ({ reason }) => {
    pendingProposal = null;
    lobbyStatusEl.textContent = reason === "declined"
      ? "Proposal declined. You can try another player."
      : "Proposal closed. Try again.";
    renderLobbyIncoming();
    renderLobbyPlayers();
  });

  socket.on("lobby:match:ready", async ({ roomId: nextRoomId, inviteToken: nextInviteToken }) => {
    lobbyStatusEl.textContent = "Match accepted. Joining table...";
    try {
      await joinRoom(nextRoomId, nextInviteToken);
      const url = new URL(window.location.href);
      url.searchParams.set("room", nextRoomId);
      url.searchParams.set("token", nextInviteToken);
      window.history.replaceState({}, "", url);
    } catch (_e) {
      lobbyStatusEl.textContent = "Could not join generated room. Please retry.";
    }
  });

  socket.on("lobby:error", ({ code }) => {
    if (code === "proposal_rate_limited") {
      lobbyStatusEl.textContent = "Slow down a bit before sending another proposal.";
      return;
    }
    if (code === "player_busy") {
      lobbyStatusEl.textContent = "That player is already considering another proposal.";
      return;
    }
    if (code === "invalid_target") {
      lobbyStatusEl.textContent = "That player is no longer available.";
      return;
    }
    lobbyStatusEl.textContent = "Lobby action failed. Please try again.";
  });

  socket.on("connect_error", () => {
    showLandingView();
    setStatus("Could not connect to global lobby.", "error");
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
    const res     = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckCount }),
    });
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
deckCountDown?.addEventListener("click", () => {
  deckCount = Math.max(1, deckCount - 1);
  if (deckCountValEl) { deckCountValEl.textContent = deckCount; }
});
deckCountUp?.addEventListener("click", () => {
  deckCount = Math.min(6, deckCount + 1);
  if (deckCountValEl) { deckCountValEl.textContent = deckCount; }
});
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

findPlayersBtn?.addEventListener("click", () => {
  connectGlobalLobby();
});

lobbySignalsEl?.addEventListener("click", (event) => {
  const target = event.target.closest(".lobby-chip");
  if (!target || !socket) { return; }
  lobbySignal = target.dataset.signal;
  renderLobbySignals();
  socket.emit("lobby:signal", { signal: lobbySignal });
});

acceptProposalBtn?.addEventListener("click", () => {
  if (!socket || !pendingProposal || pendingProposal.direction !== "incoming") { return; }
  socket.emit("lobby:proposal:respond", { proposalId: pendingProposal.proposalId, accept: true });
  lobbyStatusEl.textContent = "Accepted. Creating room...";
});

declineProposalBtn?.addEventListener("click", () => {
  if (!socket || !pendingProposal || pendingProposal.direction !== "incoming") { return; }
  socket.emit("lobby:proposal:respond", { proposalId: pendingProposal.proposalId, accept: false });
  pendingProposal = null;
  renderLobbyIncoming();
  renderLobbyPlayers();
});

lobbyDeckDownBtn?.addEventListener("click", () => {
  lobbyDeckCount = Math.max(1, lobbyDeckCount - 1);
  if (lobbyDeckValEl) { lobbyDeckValEl.textContent = String(lobbyDeckCount); }
});

lobbyDeckUpBtn?.addEventListener("click", () => {
  lobbyDeckCount = Math.min(6, lobbyDeckCount + 1);
  if (lobbyDeckValEl) { lobbyDeckValEl.textContent = String(lobbyDeckCount); }
});

leaveLobbyBtn?.addEventListener("click", () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  inLobby = false;
  pendingProposal = null;
  lobbyPlayers = [];
  stopLobbyHeartbeat();
  showLandingView();
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
  const players = Math.max(1, Math.min(6, activeMembers.length || 1));
  if (socket) {
    dealBtn.disabled = true;
    const totalCards  = players * dealCount;
    const animMs      = totalCards * 80 + 500; // matches server stagger + one extra card
    socket.emit("deck:deal", { players, count: dealCount });
    setTimeout(() => { dealBtn.disabled = false; }, animMs);
  }
});

dealCountDown?.addEventListener("click", () => {
  dealCount = Math.max(1, dealCount - 1);
  if (dealCountVal) { dealCountVal.textContent = dealCount; }
});
dealCountUp?.addEventListener("click", () => {
  dealCount = Math.min(13, dealCount + 1);
  if (dealCountVal) { dealCountVal.textContent = dealCount; }
});

/* Pile click — draw the top card out to just below the pile */
let pileJustDragged = false;
document.getElementById("deckPile")?.addEventListener("click", () => {
  if (pileJustDragged) { pileJustDragged = false; return; }
  if (!socket) { return; }
  const pileCards = Array.from(cardsById.values()).filter(isPileCard);
  if (pileCards.length === 0) { return; }
  const topCard = pileCards.reduce((a, b) => (a.z > b.z ? a : b));
  socket.emit("card:move", { id: topCard.id, x: PILE_CX, y: PILE_CY + 20 });
});

/* Pile drag — move the whole pile */
(function wirePileDrag() {
  const pileEl = document.getElementById("deckPile");
  if (!pileEl) { return; }
  let dragging = false;
  let didDrag  = false;
  let startPx, startPy, startCX, startCY;

  pileEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) { return; }
    dragging  = true;
    didDrag   = false;
    startPx   = e.clientX;
    startPy   = e.clientY;
    startCX   = PILE_CX;
    startCY   = PILE_CY;
    pileEl.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });

  pileEl.addEventListener("pointermove", (e) => {
    if (!dragging) { return; }
    const r  = tableEl.getBoundingClientRect();
    const dx = (e.clientX - startPx) / r.width  * 100;
    const dy = (e.clientY - startPy) / r.height * 100;
    if (dx * dx + dy * dy > 0.25) { didDrag = true; } // > ~0.5% movement
    const nx = Math.max(5, Math.min(95, startCX + dx));
    const ny = Math.max(5, Math.min(95, startCY + dy));
    pileEl.style.left = `${nx}%`;
    pileEl.style.top  = `${ny}%`;
  });

  pileEl.addEventListener("pointerup", (e) => {
    if (!dragging) { return; }
    dragging = false;
    pileEl.releasePointerCapture(e.pointerId);
    const dx = e.clientX - startPx;
    const dy = e.clientY - startPy;
    if (dx * dx + dy * dy < 25) { didDrag = false; return; } // treat as click
    pileJustDragged = true;
    const r2 = tableEl.getBoundingClientRect();
    const nx = Math.max(5, Math.min(95, startCX + (e.clientX - startPx) / r2.width  * 100));
    const ny = Math.max(5, Math.min(95, startCY + (e.clientY - startPy) / r2.height * 100));
    if (socket) { socket.emit("pile:move", { x: nx, y: ny }); }
  });

  // Suppress the click event that the browser fires after a drag pointerup
  pileEl.addEventListener("click", (e) => {
    if (didDrag) {
      didDrag = false;
      e._pileDragSuppressed = true;
      e.stopImmediatePropagation();
    }
  });
}());

/* Pass Turn — click to advance, click again when it's your turn to pass,
   or double-click to stop turn tracking entirely */
let passTurnClickTimer = null;
passTurnBtn?.addEventListener("click", () => {
  if (!socket) { return; }
  // Double-click within 350ms = clear turn tracking
  if (passTurnClickTimer) {
    clearTimeout(passTurnClickTimer);
    passTurnClickTimer = null;
    socket.emit("turn:clear");
    return;
  }
  passTurnClickTimer = setTimeout(() => {
    passTurnClickTimer = null;
    socket.emit("turn:pass");
  }, 350);
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
