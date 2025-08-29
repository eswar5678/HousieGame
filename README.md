🎲 Tambola Game (Housie)

An online Tambola (Housie) multiplayer game built with Node.js, Express, and Socket.io.
Players can join rooms, get their tickets, and play in real time with automated number calling and claim detection.

🚀 Features

🎟️ Ticket Generation – Each player gets unique Tambola tickets.

🔢 Auto Number Calling – Numbers are called automatically every second.

🏆 Claim Options – Supports Early Five, Lines, and Full House.

⚡ Real-Time Multiplayer – Built with Socket.io for live updates.

📃 Game Over Page – Shows all claims, winners, and ticket details.

📂 Project Structure
├── public/
│   ├── index.html       # Home page (choose host or player)
│   ├── host.html        # Host dashboard
│   ├── player.html      # Player ticket view
│   ├── game.html        # Game board
│   ├── gameOver.html    # Results page
│
├── server.js            # Node.js + Express + Socket.io backend
├── package.json
├── package-lock.json
└── README.md
Installation & Setup

Clone the repository:

git clone https://github.com/<your-username>/tambola-game.git
cd tambola-game


Install dependencies:

npm install


Start the server:

node server.js


Open in browser:

http://localhost:3000

👨‍💻 Author

Developed by Eswar Marri 🚀
