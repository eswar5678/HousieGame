const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const app = express();
const server = http.createServer(app);  
const io = socketIo(server);

app.use(express.static("public"));

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
function generateTambolaTicket() {
  const tambola = { rows: [] };
  const rowRange = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  for (let i = 0; i < 3; i++) {
    const row_values = shuffle(rowRange.slice()).slice(0, 5).sort((a, b) => a - b);
    tambola.rows.push(row_values);
  }

  const columns = [];
  for (let i = 0; i < 9; i++) {
    const range = [];
    const max_count = i === 8 ? 10 : 9;
    for (let j = 0; j < max_count; j++) {
      range.push(i * 10 + j + 1);
    }
    columns.push(shuffle(range).slice(0, 3).sort((a, b) => a - b));
  }

  let result = Array(3).fill(null).map(() => Array(9).fill(null));
  for (let r = 0; r < 3; r++) {
    const rowCols = tambola.rows[r];
    for (let c = 0; c < rowCols.length; c++) {
      const colIndex = rowCols[c] - 1;
      result[r][colIndex] = columns[colIndex].shift();
    }
  }
  return result;
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
  }, 3000);
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
    pendingTicketsPerRoom[roomId][player] = Array.from({ length: 6 }, () => generateTambolaTicket());
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
  // Handle Claims
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
    //console.log("✅ Full House claimed by:", player, "in room:", roomId);

    clearInterval(room.autoCallInterval);

    const results = room.players.map(p => ({
      name: p.name,
      tickets: p.tickets || [],
      claims: claimsPerRoom[roomId].filter(c => c.player === p.name)
    }));

    //console.log("👉 Sending endGame event with results:", results);

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

server.listen(3000, () => {
  console.log("Server started on port 3000");
});
