// public/client.js

const socket = io();

// Host: create room
function createRoomFlow(data) {
  socket.emit('createRoom', data);
}

socket.on('roomCreated', (roomData) => {
  // Redirect to room page with roomId as query
  window.location.href = `room.html?roomId=${roomData.roomId}`;
});


// Player: join room
function joinRoomFlow(roomId, playerName) {
  socket.emit('joinRoom', { roomId, player: playerName });
}

socket.on('roomJoined', (roomData) => {
  window.location.href = `room.html?roomId=${roomData.roomId}`;
});

socket.on('joinError', (msg) => {
  alert(msg);
});

// Room: update UI
socket.on('roomUpdate', (roomData) => {
  // Use this to update members list in real-time (see room.html)
  updateRoomUI(roomData);
});
socket.on('numberCalled', number => {
  console.log('Received called number:', number);
  calledNumbersSet.add(number);
  showCurrentNumber(number);
  if (calledNumbersList.style.display === 'block') {
    renderCalledNumbersGrid();
  }
});

socket.on('yourTickets', data => {
  console.log('Received tickets:', data);
  if (data.tickets && data.tickets.length > 0) createTickets(data.tickets);
  calledNumbersSet = new Set(data.calledNumbers);
  if (calledNumbersList.style.display === 'block') {
    renderCalledNumbersGrid();
  }
});
