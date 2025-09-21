const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};
const calledNumbersPerRoom = {};
const pendingTicketsPerRoom = {};
const claimedLinesPerRoom = {};
const claimsPerRoom = {}; // { roomId: [ { player, ticketIndex, claimType } ] }

function shuffle(array) {
  let currentIndex = array.length, randomIndex;
  while (currentIndex != 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex],
    ];
  }
  return array;
}

// Generate Tambola ticket
function generateTambolaTickets() {
  // Column ranges as [min, max]
  const ranges = [
    [1, 9],
    [10, 19],
    [20, 29],
    [30, 39],
    [40, 49],
    [50, 59],
    [60, 69],
    [70, 79],
    [80, 90],
  ];

  // Shuffle helper
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Prepare column number pools
  const colNumbers = ranges.map(([min, max]) =>
    shuffle(Array.from({ length: max - min + 1 }, (_, i) => min + i)),
  );

  const totalPerColumn = colNumbers.map((arr) => arr.length); // [9,10,10,...,11]
  const TICKETS = 6;
  const COLS = 9;

  // counts[ticket][col]
  const counts = Array.from({ length: TICKETS }, () =>
    Array(COLS).fill(1),
  );
  const ticketExtraCapacity = Array(TICKETS).fill(6); // 15 - 9

  // distribute extras per column
  for (let col = 0; col < COLS; col++) {
    let extras = totalPerColumn[col] - TICKETS;
    while (extras > 0) {
      const candidates = Array.from({ length: TICKETS }, (_, t) => t)
        .filter((t) => ticketExtraCapacity[t] > 0 && counts[t][col] < 3)
        .sort((a, b) => ticketExtraCapacity[b] - ticketExtraCapacity[a]);

      if (candidates.length === 0) break;
      const topCap = ticketExtraCapacity[candidates[0]];
      const topCandidates = candidates.filter(
        (t) => ticketExtraCapacity[t] === topCap,
      );
      const chosen =
        topCandidates[Math.floor(Math.random() * topCandidates.length)];

      counts[chosen][col] += 1;
      ticketExtraCapacity[chosen] -= 1;
      extras -= 1;
    }
  }

  // fix mismatches in row sums
  for (let t = 0; t < TICKETS; t++) {
    let sum = counts[t].reduce((a, b) => a + b, 0);
    while (sum < 15) {
      const c = counts[t].findIndex((v) => v < 3);
      if (c === -1) break;
      counts[t][c] += 1;
      sum++;
    }
    while (sum > 15) {
      const c = counts[t].findIndex((v) => v > 1);
      if (c === -1) break;
      counts[t][c] -= 1;
      sum--;
    }
  }

  // assign numbers to tickets
  const ticketsCols = Array.from({ length: TICKETS }, () =>
    Array.from({ length: COLS }, () => []),
  );
  for (let col = 0; col < COLS; col++) {
    for (let t = 0; t < TICKETS; t++) {
      for (let k = 0; k < counts[t][col]; k++) {
        const num = colNumbers[col].pop();
        if (!num) throw new Error("Column depleted unexpectedly");
        ticketsCols[t][col].push(num);
      }
      ticketsCols[t][col].sort((a, b) => a - b);
    }
  }

  // Build 3x9 tickets
  const tickets = Array.from({ length: TICKETS }, () =>
    Array.from({ length: 3 }, () => Array(COLS).fill(0)),
  );

  for (let t = 0; t < TICKETS; t++) {
    const rowFill = [0, 0, 0];
    for (let col = 0; col < COLS; col++) {
      const nums = ticketsCols[t][col];
      const rowOrder = [0, 1, 2].sort((a, b) => rowFill[a] - rowFill[b]);
      nums.forEach((num, i) => {
        tickets[t][rowOrder[i]][col] = num;
        rowFill[rowOrder[i]]++;
      });
    }
  }

  return tickets;
}

function emitRoomUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit("roomUpdate", {
    roomId,
    host: room.hostName,
    roomName: room.roomName,
    numPlayers: room.numPlayers,
    ticketPrice: room.ticketPrice,
    numTickets: room.numTickets,
    players: room.players.map((p) => p.name),
  });
}

function startAutoCall(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.autoCallInterval) clearInterval(room.autoCallInterval);

  room.autoCallInterval = setInterval(() => {
    const calledSet = calledNumbersPerRoom[roomId];
    if (!calledSet) return;

    // End game if all numbers called
    if (calledSet.size >= 90) {
      clearInterval(room.autoCallInterval);
      room.autoCallInterval = null;

      const results = room.players.map(p => {
        const playerClaims = claimsPerRoom[roomId]
          ? claimsPerRoom[roomId].filter(c => c.player === p.name)
          : [];
        // Map claims to ticket index
        const ticketClaims = Array.from({ length: p.tickets.length }, (_, i) => {
          return playerClaims
            .filter(c => c.ticketIndex === i)
            .map(c => c.claimType);
        });
        return {
          name: p.name,
          tickets: p.tickets.length,
          claims: ticketClaims
        };
      });

      io.to(roomId).emit("endGame", { results });
      return;
    }

    // Call next random number
    const remainingNumbers = [];
    for (let i = 1; i <= 90; i++) {
      if (!calledSet.has(i)) remainingNumbers.push(i);
    }
    const nextNum = remainingNumbers[Math.floor(Math.random() * remainingNumbers.length)];
    calledSet.add(nextNum);

    io.to(roomId).emit("numberCalled", nextNum, Array.from(calledSet));
  }, 5000);
}

io.on("connection", (socket) => {
  // Create Room
  socket.on("createRoom", ({ host, numPlayers, roomName, ticketPrice, numTickets }) => {
    let roomId;
    do {
      roomId = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[roomId]);

    rooms[roomId] = {
      hostName: host,
      hostSocketId: socket.id,
      roomName,
      numPlayers,
      ticketPrice,
      numTickets: Number(numTickets) || 1,
      gameStarted: false,
      numbersStarted: false,
      isPaused: false,
      players: [],
      autoCallInterval: null,
      autoCallTimeout: null,
      countdownInterval: null,
      winners: {},
    };

    claimsPerRoom[roomId] = [];

    socket.join(roomId);
    socket.emit("roomCreated", {
      roomId,
      host,
      roomName,
      numPlayers,
      ticketPrice,
      numTickets: rooms[roomId].numTickets,
    });
    emitRoomUpdate(roomId);
  });

  // Join Room
  socket.on("joinRoom", ({ roomId, player, numTickets }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("joinError", "Room does not exist!");
    socket.join(roomId);

    let playerObj = room.players.find((p) => p.name === player);
    const ticketsCount = Math.min(Math.max(numTickets || room.numTickets || 1, 1), 10);

    if (!playerObj) {
      playerObj = { name: player, socketId: socket.id, numTickets: ticketsCount, tickets: [] };
      room.players.push(playerObj);
    } else {
      playerObj.socketId = socket.id;
      playerObj.numTickets = ticketsCount;
    }

    if (room.gameStarted) {
      if (!playerObj.tickets || playerObj.tickets.length === 0) {
        playerObj.tickets = Array.from({ length: playerObj.numTickets }, () => generateTambolaTicket());
      }
      const calledSet = calledNumbersPerRoom[roomId] || new Set();
      socket.emit("yourTickets", {
        roomId,
        tickets: playerObj.tickets,
        calledNumbers: Array.from(calledSet),
      });
      if (calledSet.size > 0) {
        const lastCalled = Array.from(calledSet).pop();
        socket.emit("lastCalledNumber", lastCalled);
      }
      if (room.isPaused) socket.emit("gamePaused");
    }

    socket.emit("roomJoined", { roomId, host: room.hostName });
    emitRoomUpdate(roomId);
  });

  // Ticket selection
  socket.on("getAvailableTickets", ({ roomId, player }) => {
  if (!rooms[roomId]) return;
  pendingTicketsPerRoom[roomId] = pendingTicketsPerRoom[roomId] || {};
  
  // Give each player their own valid strip (6 tickets covering 1–90 exactly once)
  pendingTicketsPerRoom[roomId][player] = generateTambolaTickets();

  socket.emit("availableTickets", pendingTicketsPerRoom[roomId][player]);
});

  socket.on("selectTickets", ({ roomId, player, selectedIndices }) => {
    const room = rooms[roomId];
    if (!room) return;
    const playerObj = room.players.find((p) => p.name === player);
    if (!playerObj) return;
    const availableTickets = pendingTicketsPerRoom[roomId]?.[player];
    if (!availableTickets) return;
    playerObj.tickets = selectedIndices.map((i) => availableTickets[i]).filter(Boolean);
  });

  // Start Game
  socket.on("startGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.gameStarted = true;
    room.numbersStarted = false;
    room.isPaused = false;
    calledNumbersPerRoom[roomId] = new Set();

    room.players.forEach((player) => {
      if (!player.tickets || player.tickets.length === 0) {
        player.tickets = [generateTambolaTicket()];
      }
    });

    io.to(roomId).emit("gameStarted", {
      roomId,
      message: "Game is starting in 10 seconds!",
      countdown: 10,
    });

    room.players.forEach((p) => {
      io.to(p.socketId).emit("yourTickets", {
        roomId,
        tickets: p.tickets,
        calledNumbers: [],
      });
    });

    if (room.autoCallTimeout) clearTimeout(room.autoCallTimeout);
    if (room.autoCallInterval) clearInterval(room.autoCallInterval);
    if (room.countdownInterval) clearInterval(room.countdownInterval);

    let countdown = 10;
    io.to(roomId).emit("countdown", countdown);
    room.countdownInterval = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        io.to(roomId).emit("countdown", countdown);
      } else {
        clearInterval(room.countdownInterval);
        io.to(roomId).emit("countdown", 0);

        room.numbersStarted = true;
        startAutoCall(roomId);
      }
    }, 1000);
  });

  // Handle Claims
  socket.on("ticketClaim", ({ roomId, player, ticketIndex, claimType }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (!claimedLinesPerRoom[roomId]) claimedLinesPerRoom[roomId] = {};
    if (!claimedLinesPerRoom[roomId][ticketIndex]) claimedLinesPerRoom[roomId][ticketIndex] = [];

    // prevent duplicate claim type for same ticket
    const alreadyClaimed = claimsPerRoom[roomId].find(
      c => c.ticketIndex === ticketIndex && c.claimType === claimType
    );
    if (alreadyClaimed) {
      socket.emit("claimRejected", { ticketIndex, claimType, message: `${claimType} already claimed for this ticket!` });
      return;
    }

    // Store claim
    claimedLinesPerRoom[roomId][ticketIndex].push(claimType);
    claimsPerRoom[roomId].push({ player, ticketIndex, claimType });

    io.to(roomId).emit("claimApproved", { player, ticketIndex, claimType });

    // If full house → end game
    if (claimType.toLowerCase() === "full house") {
      clearInterval(room.autoCallInterval);

      const results = room.players.map(p => ({
        name: p.name,
        tickets: p.tickets || [],
        claims: claimsPerRoom[roomId].filter(c => c.player === p.name)
      }));

      io.to(roomId).emit("endGame", { results });
    }
  });

  // Pause/Resume
  socket.on("togglePause", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.gameStarted || !room.numbersStarted) return;

    if (!room.isPaused) {
      room.isPaused = true;
      if (room.autoCallInterval) {
        clearInterval(room.autoCallInterval);
        room.autoCallInterval = null;
      }
      io.to(roomId).emit("gamePaused");
    } else {
      room.isPaused = false;
      io.to(roomId).emit("gameResumed");
      startAutoCall(roomId);
    }
  });

  socket.on("disconnecting", () => {
    Object.entries(rooms).forEach(([roomId, room]) => {
      if (room.hostSocketId === socket.id) {
        if (room.autoCallInterval) clearInterval(room.autoCallInterval);
        if (room.autoCallTimeout) clearTimeout(room.autoCallTimeout);
        if (room.countdownInterval) clearInterval(room.countdownInterval);
        room.autoCallInterval = null;
        room.autoCallTimeout = null;
        room.countdownInterval = null;
      }
    });
  });
});

// ✅ Deployment-ready: use PORT from environment OR fallback to 3000 locally
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server started on port ${PORT}`);
});



