require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { customAlphabet } = require("nanoid");
const { buildIpRateLimiter, buildFailurePenalty, hashIp, clientIp } = require("@epheme/core/rateLimiter");
const { recordHit } = require("@epheme/core/metrics");
const { createDeviceRegistry } = require("@epheme/core/deviceRegistry");

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*"
  }
});

const roomIdGen = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const tokenGen = customAlphabet("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", 16);

const PORT = Number(process.env.PORT || 8787);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 1000 * 60 * 60 * 2);
const CLEANUP_EVERY_MS = 30_000;

// ── Redis (optional — all rate limiting and metrics degrade gracefully without it) ──
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require("ioredis");
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, enableReadyCheck: false });
    redis.on("error", (err) => console.warn("[redis] error:", err.message));
    redis.on("connect", () => console.log("[redis] connected"));
  } catch (e) {
    console.warn("[redis] ioredis unavailable, skipping:", e.message);
  }
}

// ── Rate limiters (no-op when redis is null — buildIpRateLimiter fails open) ──
const createRoomLimiter = redis
  ? buildIpRateLimiter(redis, "ephemedeck:create", 60, Number(process.env.CREATE_ROOM_RATE_LIMIT || 10))
  : (_req, _res, next) => next();

const joinRoomLimiter = redis
  ? buildIpRateLimiter(redis, "ephemedeck:join", 60, Number(process.env.JOIN_ROOM_RATE_LIMIT || 30))
  : (_req, _res, next) => next();

const { penaltyMiddleware: joinPenalty, recordFailure: recordBadJoin } = redis
  ? buildFailurePenalty(redis, "ephemedeck:join")
  : { penaltyMiddleware: (_req, _res, next) => next(), recordFailure: () => {} };

// ── Player identity JWTs (stable across page refreshes) ──
const PLAYER_JWT_SECRET = process.env.PLAYER_JWT_SECRET || null;
const playerRegistry = PLAYER_JWT_SECRET
  ? createDeviceRegistry({ deviceJwtSecret: PLAYER_JWT_SECRET, deviceJwtTtl: 60 * 60 * 24 * 7 }) // 7 days
  : null;

const rooms = new Map();

function createDeck(roomId, deckCount = 1) {
  const suits = ["spades", "hearts", "diamonds", "clubs"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];

  let offset = 0;
  for (let d = 0; d < deckCount; d += 1) {
    const suffix = deckCount > 1 ? `-d${d}` : "";
    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({
          id: `${roomId}-${suit}-${rank}${suffix}`,
          suit,
          rank,
          faceUp: false,
          x: 49.5 + (offset % 8) * 0.15,
          y: 49.5 + (offset % 8) * 0.15,
          z: offset,
          holder: "table",
          privateHolder: null
        });
        offset += 1;
      }
    }
  }

  return deck;
}

function now() {
  return Date.now();
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function touchRoom(room) {
  room.lastActiveAt = now();
  room.expiresAt = room.lastActiveAt + ROOM_TTL_MS;
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    expiresAt: room.expiresAt,
    revision: room.revision,
    activeTurn: room.activeTurn || null,
    pileX: room.pileX,
    pileY: room.pileY,
    names: Object.fromEntries(room.memberNames),
    // Mask privately held cards for public broadcast: everyone sees the back
    cards: room.cards.map((c) =>
      c.privateHolder ? { ...c, faceUp: false } : c
    ),
    members: Array.from(room.members)
  };
}

// Send the real (unmasked) card data to just the holder's socket
function sendPrivatePatches(room, memberId) {
  const socketId = room.memberSockets.get(memberId);
  if (!socketId) { return; }
  for (const card of room.cards) {
    if (card.privateHolder === memberId) {
      io.to(socketId).emit("card:private", { card });
    }
  }
}

function assertRoomToken(room, token) {
  return room && token && room.inviteToken === token;
}

function roomChannel(roomId) {
  return `room:${roomId}`;
}

function pruneExpiredRooms() {
  const ts = now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.expiresAt <= ts) {
      io.to(roomChannel(roomId)).emit("room:expired", { roomId });
      io.in(roomChannel(roomId)).socketsLeave(roomChannel(roomId));
      rooms.delete(roomId);
    }
  }
}

setInterval(pruneExpiredRooms, CLEANUP_EVERY_MS);

app.get("/healthz", (_req, res) => res.sendStatus(200));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

/**
 * POST /api/identity
 * Issues (or renews) a player JWT so identity is stable across page refreshes.
 * Body: { playerId?, displayName? }
 * The client should store the returned token in localStorage and send it as
 * handshake auth: { playerToken }.
 */
app.post("/api/identity", (req, res) => {
  if (!playerRegistry) {
    // No secret configured — fall back to anonymous random IDs (existing behaviour)
    const { customAlphabet: ca } = require("nanoid");
    const id = (ca || customAlphabet)("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", 12)();
    return res.json({ playerId: id, token: null, anonymous: true });
  }

  const { playerId, displayName } = req.body || {};
  // Re-use supplied ID if it looks valid, otherwise generate a new one
  const validIdRe = /^[a-zA-Z0-9_-]{8,32}$/;
  const id = (playerId && validIdRe.test(playerId)) ? playerId : `p-${tokenGen()}`;
  const name = String(displayName || "").slice(0, 24).trim() || `Player`;

  const token = playerRegistry.issueDeviceJWT({
    id,
    tenant: "ephemedeck",
    role: "player",
    displayName: name,
  });

  return res.json({ playerId: id, token, anonymous: false });
});

app.post("/api/rooms", createRoomLimiter, (req, res) => {
  const deckCount   = Math.max(1, Math.min(6, Number((req.body || {}).deckCount) || 1));
  const roomId      = roomIdGen();
  const inviteToken = tokenGen();
  const createdAt   = now();

  const room = {
    roomId,
    inviteToken,
    createdAt,
    lastActiveAt: createdAt,
    expiresAt: createdAt + ROOM_TTL_MS,
    revision: 1,
    cards: createDeck(roomId, deckCount),
    dealCursor: 0,
    pileX: 50,          // % — pile centre, updated by pile:move
    pileY: 50,
    activeTurn: null,   // memberId whose turn it is, or null
    memberNames: new Map(), // memberId → display name (no turn tracking)
    members: new Set(),
    memberSockets: new Map()
  };

  rooms.set(roomId, room);

  recordHit();
  res.status(201).json({
    roomId,
    inviteToken,
    expiresAt: room.expiresAt,
    joinPath: `/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(inviteToken)}`
  });
});

app.post("/api/rooms/:roomId/join", joinRoomLimiter, joinPenalty, (req, res) => {
  const room = getRoom(req.params.roomId);
  const { token } = req.body || {};

  if (!assertRoomToken(room, token)) {
    if (redis) { recordBadJoin(hashIp(clientIp(req))); }
    return res.status(403).json({ error: "invalid_invite" });
  }

  touchRoom(room);
  recordHit();
  return res.json({ ok: true, room: serializeRoom(room) });
});

app.use(express.static(path.join(__dirname, "public")));

io.use((socket, next) => {
  const { roomId, token, memberId, playerToken, displayName } = socket.handshake.auth || {};
  const room = getRoom(roomId);

  if (!assertRoomToken(room, token)) {
    return next(new Error("invalid_invite"));
  }

  socket.data.roomId = roomId;

  // If a player JWT is present and a secret is configured, use the stable ID from it.
  // Otherwise fall back to the supplied memberId (anonymous / legacy).
  if (playerToken && playerRegistry) {
    const payload = playerRegistry.verifyDeviceJWT(playerToken);
    if (payload) {
      socket.data.memberId = payload.device_id;
      socket.data.displayName = payload.displayName || null;
    } else {
      socket.data.memberId = memberId || `anon-${Math.random().toString(16).slice(2, 8)}`;
    }
  } else {
    socket.data.memberId = memberId || `anon-${Math.random().toString(16).slice(2, 8)}`;
  }
  // Store display name from handshake (sanitised, max 20 chars)
  const rawName = String(displayName || "").trim().slice(0, 20);
  socket.data.displayName = rawName || null;

  return next();
});

io.on("connection", (socket) => {
  const room = getRoom(socket.data.roomId);
  if (!room) {
    socket.emit("room:expired", { roomId: socket.data.roomId });
    socket.disconnect(true);
    return;
  }

  touchRoom(room);
  room.members.add(socket.data.memberId);
  room.memberSockets.set(socket.data.memberId, socket.id);
  if (socket.data.displayName) {
    room.memberNames.set(socket.data.memberId, socket.data.displayName);
  }
  socket.join(roomChannel(room.roomId));

  socket.emit("room:snapshot", serializeRoom(room));
  sendPrivatePatches(room, socket.data.memberId);
  io.to(roomChannel(room.roomId)).emit("room:presence", {
    members: Array.from(room.members),
    names: Object.fromEntries(room.memberNames)
  });

  socket.on("card:move", ({ id, x, y }) => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) {
      return;
    }

    const card = activeRoom.cards.find((item) => item.id === id);
    if (!card) {
      return;
    }

    touchRoom(activeRoom);
    activeRoom.revision += 1;
    card.x = Number.isFinite(x) ? x : card.x;
    card.y = Number.isFinite(y) ? y : card.y;
    card.z = activeRoom.revision;

    // Broadcast masked version so privately held cards stay hidden
    const publicCard = card.privateHolder ? { ...card, faceUp: false } : card;
    io.to(roomChannel(activeRoom.roomId)).emit("card:patch", {
      revision: activeRoom.revision,
      card: publicCard
    });
    // If this card is held privately, also send the real data to the holder
    if (card.privateHolder) {
      const holderSocketId = activeRoom.memberSockets.get(card.privateHolder);
      if (holderSocketId) {
        io.to(holderSocketId).emit("card:private", { card });
      }
    }
  });

  socket.on("card:flip", ({ id }) => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) {
      return;
    }

    const card = activeRoom.cards.find((item) => item.id === id);
    if (!card) {
      return;
    }
    // Cannot flip a card held privately by another player
    if (card.privateHolder && card.privateHolder !== socket.data.memberId) {
      return;
    }

    touchRoom(activeRoom);
    activeRoom.revision += 1;
    card.faceUp = !card.faceUp;
    card.z = activeRoom.revision;

    const publicCard = card.privateHolder ? { ...card, faceUp: false } : card;
    io.to(roomChannel(activeRoom.roomId)).emit("card:patch", {
      revision: activeRoom.revision,
      card: publicCard
    });
    if (card.privateHolder) {
      const holderSocketId = activeRoom.memberSockets.get(card.privateHolder);
      if (holderSocketId) { io.to(holderSocketId).emit("card:private", { card }); }
    }
  });

  socket.on("card:take", ({ id }) => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) { return; }

    const card = activeRoom.cards.find((item) => item.id === id);
    if (!card) { return; }
    // Already held by someone else — ignore
    if (card.privateHolder && card.privateHolder !== socket.data.memberId) { return; }

    touchRoom(activeRoom);
    activeRoom.revision += 1;
    card.privateHolder = socket.data.memberId;
    card.faceUp = true;
    card.z = activeRoom.revision;

    // Move the card toward the holder's seat anchor so it slides there visually
    const SEAT_ANCHORS = [
      [50, 82], // seat 0 — bottom
      [50, 13], // seat 1 — top
      [10, 50], // seat 2 — left
      [90, 50], // seat 3 — right
      [20, 20], // seat 4 — top-left
      [80, 20], // seat 5 — top-right
    ];
    const memberList = Array.from(activeRoom.members);
    const seatIdx = memberList.indexOf(socket.data.memberId);
    const [ax, ay] = SEAT_ANCHORS[Math.max(0, seatIdx) % SEAT_ANCHORS.length];

    // Fan held cards so they don't stack exactly — count how many this player already holds
    const heldCount = activeRoom.cards.filter(
      (c) => c.id !== card.id && c.privateHolder === socket.data.memberId
    ).length;
    const SPREAD = 6;
    const horizontalSeats = new Set([0, 1, 4, 5]);
    const offset = heldCount * SPREAD;
    card.x = horizontalSeats.has(seatIdx) ? ax + offset : ax;
    card.y = horizontalSeats.has(seatIdx) ? ay           : ay + offset;

    // Broadcast back-facing patch to room; send real card to holder only
    io.to(roomChannel(activeRoom.roomId)).emit("card:patch", {
      revision: activeRoom.revision,
      card: { ...card, faceUp: false }
    });
    socket.emit("card:private", { card });
    recordHit();
  });

  socket.on("card:release", ({ id, faceUp = false }) => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) { return; }

    const card = activeRoom.cards.find((item) => item.id === id);
    if (!card || card.privateHolder !== socket.data.memberId) { return; }

    touchRoom(activeRoom);
    activeRoom.revision += 1;
    card.privateHolder = null;
    card.faceUp = Boolean(faceUp);
    card.z = activeRoom.revision;

    io.to(roomChannel(activeRoom.roomId)).emit("card:patch", {
      revision: activeRoom.revision,
      card
    });
  });

  socket.on("deck:shuffle", () => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) {
      return;
    }

    touchRoom(activeRoom);
    const cards = activeRoom.cards;
    // Release all privately held cards before shuffling
    cards.forEach((c) => { c.privateHolder = null; });
    for (let i = cards.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = cards[i];
      cards[i] = cards[j];
      cards[j] = tmp;
    }

    activeRoom.revision += 1;
    activeRoom.dealCursor = 0;
    activeRoom.activeTurn = null;
    activeRoom.pileX = 50;
    activeRoom.pileY = 50;
    cards.forEach((card, index) => {
      card.x = 49.5 + (index % 8) * 0.15;
      card.y = 49.5 + (index % 8) * 0.15;
      card.z = activeRoom.revision + index;
      card.faceUp = false;
    });

    io.to(roomChannel(activeRoom.roomId)).emit("room:snapshot", serializeRoom(activeRoom));
    recordHit();
  });

  socket.on("deck:deal", ({ players = 4, count = 5 }) => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) { return; }

    const safePlayers = Math.max(1, Math.min(6, Number(players) || 2));
    const safeCount   = Math.max(1, Math.min(13, Number(count) || 5));

    touchRoom(activeRoom);

    const SEAT_ANCHORS = [
      [50, 80], [50, 15], [12, 50], [88, 50], [22, 22], [78, 22],
    ];
    const CARD_SPREAD     = 7;
    const HORIZONTAL_SEATS = new Set([0, 1, 4, 5]);

    // Deck origin — where cards appear to fly from (tracks movable pile)
    const DECK_X = activeRoom.pileX;
    const DECK_Y = activeRoom.pileY;

    // Build the deal sequence in round-robin order (player 0 card 0, player 1 card 0, …)
    // so animation feels like real dealing around the table.
    const flights = [];
    const playerCards = Array.from({ length: safePlayers }, () => []);

    for (let c = 0; c < safeCount; c += 1) {
      for (let p = 0; p < safePlayers; p += 1) {
        const card = activeRoom.cards[activeRoom.dealCursor];
        if (!card) { break; }

        const [ax, ay]    = SEAT_ANCHORS[p % SEAT_ANCHORS.length];
        const fanH        = HORIZONTAL_SEATS.has(p);
        // We compute the final fan position once we know how many cards this player ends up with.
        playerCards[p].push({ card, c });
        activeRoom.dealCursor += 1;
      }
    }

    // Flatten into round-robin order, computing final positions now that counts are known
    let globalIdx = 0;
    for (let c = 0; c < safeCount; c += 1) {
      for (let p = 0; p < safePlayers; p += 1) {
        const entry = playerCards[p][c];
        if (!entry) { continue; }
        const { card } = entry;
        const [ax, ay] = SEAT_ANCHORS[p % SEAT_ANCHORS.length];
        const fanH     = HORIZONTAL_SEATS.has(p);
        const n        = playerCards[p].length;
        const halfSpan = ((n - 1) * CARD_SPREAD) / 2;
        const offset   = c * CARD_SPREAD - halfSpan;

        activeRoom.revision += 1;
        card.x      = fanH ? ax + offset : ax;
        card.y      = fanH ? ay          : ay + offset;
        card.z      = activeRoom.revision;
        card.faceUp = false;

        flights.push({ card: { ...card }, deckX: DECK_X, deckY: DECK_Y, delay: globalIdx * 80 });
        globalIdx += 1;
      }
    }

    // Stagger individual card flight events; each client animates from deck → seat
    const channel = roomChannel(activeRoom.roomId);
    for (const flight of flights) {
      setTimeout(() => {
        io.to(channel).emit("card:deal-flight", {
          card:  flight.card,
          deckX: flight.deckX,
          deckY: flight.deckY,
        });
      }, flight.delay);
    }

    recordHit();
  });

  // ── Pile move ──
  socket.on("pile:move", ({ x, y }) => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) { return; }
    const nx = Number.isFinite(x) ? Math.max(5, Math.min(95, x)) : activeRoom.pileX;
    const ny = Number.isFinite(y) ? Math.max(5, Math.min(95, y)) : activeRoom.pileY;
    const dx = nx - activeRoom.pileX;
    const dy = ny - activeRoom.pileY;
    activeRoom.pileX = nx;
    activeRoom.pileY = ny;
    touchRoom(activeRoom);
    activeRoom.revision += 1;
    // Batch-move all pile cards (face-down, unowned, close to old centre)
    const PILE_THRESHOLD = 6;
    activeRoom.cards.forEach((card) => {
      if (!card.faceUp && !card.privateHolder) {
        card.x = Math.max(2, Math.min(98, card.x + dx));
        card.y = Math.max(2, Math.min(98, card.y + dy));
        card.z = activeRoom.revision;
      }
    });
    io.to(roomChannel(activeRoom.roomId)).emit("pile:moved", { x: nx, y: ny });
  });

  // ── Turn tracking (social cue only — no enforcement) ──
  socket.on("turn:pass", () => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) { return; }
    touchRoom(activeRoom);
    const members = Array.from(activeRoom.members);
    if (members.length === 0) { return; }
    // If no active turn yet, start with the member after the caller
    const currentIdx = activeRoom.activeTurn
      ? members.indexOf(activeRoom.activeTurn)
      : members.indexOf(socket.data.memberId);
    const nextIdx = (currentIdx + 1) % members.length;
    activeRoom.activeTurn = members[nextIdx];
    io.to(roomChannel(activeRoom.roomId)).emit("turn:update", { activeTurn: activeRoom.activeTurn });
  });

  socket.on("turn:clear", () => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) { return; }
    touchRoom(activeRoom);
    activeRoom.activeTurn = null;
    io.to(roomChannel(activeRoom.roomId)).emit("turn:update", { activeTurn: null });
  });

  socket.on("disconnect", () => {
    const activeRoom = getRoom(socket.data.roomId);
    if (!activeRoom) {
      return;
    }

    activeRoom.members.delete(socket.data.memberId);
    activeRoom.memberSockets.delete(socket.data.memberId);
    activeRoom.memberNames.delete(socket.data.memberId);

    // Release all privately held cards back to the table
    let released = false;
    activeRoom.cards.forEach((card) => {
      if (card.privateHolder === socket.data.memberId) {
        card.privateHolder = null;
        card.faceUp = false;
        activeRoom.revision += 1;
        card.z = activeRoom.revision;
        io.to(roomChannel(activeRoom.roomId)).emit("card:patch", { revision: activeRoom.revision, card });
        released = true;
      }
    });

    io.to(roomChannel(activeRoom.roomId)).emit("room:presence", {
      members: Array.from(activeRoom.members),
      names: Object.fromEntries(activeRoom.memberNames)
    });
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`EphemePlay backend listening on http://localhost:${PORT}`);
});
