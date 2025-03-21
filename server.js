const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const bcrypt = require('bcrypt'); // For password hashing
const session = require('express-session'); // For session management
const bodyParser = require('body-parser');


const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Change to your frontend URL in production!
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

// --- Middleware ---

// Session middleware
app.use(session({
    secret: 'wanzofc', //  Change this to a strong, random secret!
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS, *very important* for production.
}));

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- User and Room Data (In-memory for simplicity) ---
// IN A REAL APP, USE A DATABASE (PostgreSQL, MongoDB, etc.)
let users = {}; // { userId: { username, hashedPassword, ... }, ... }
let rooms = {};



function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

async function fetchQuestions(amount = 10, category = null, difficulty = null, type = null) {
    let url = `https://opentdb.com/api.php?amount=${amount}`;
    if (category) url += `&category=${category}`;
    if (difficulty) url += `&difficulty=${difficulty}`;
    if (type) url += `&type=${type}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.response_code === 0) {
            return data.results.map(item => {
                const answers = [...item.incorrect_answers, item.correct_answer];
                answers.sort(() => Math.random() - 0.5);
                const correctIndex = answers.indexOf(item.correct_answer);

                return {
                    question: item.question,
                    answers: answers,
                    correct: correctIndex
                };
            });
        } else {
            console.error("Error fetching questions from OTDB:", data.response_code);
            return [];
        }
    } catch (error) {
        console.error("Error fetching questions:", error);
        return [];
    }
}

// --- Serve static files (HTML, CSS, JS client) ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Authentication API Endpoints ---

// Registration
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, message: 'Username and password are required.' });
    }
    if (Object.values(users).find(u => u.username === username)) { // Check for duplicate username
        return res.status(400).json({ success: false, message: 'Username already exists.'});
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10); // Hash the password
        const userId = Date.now().toString(); // Generate a unique user ID (in a real app, use UUIDs)
        users[userId] = { username, hashedPassword };

        // Automatically log the user in after registration
        req.session.userId = userId;
        req.session.username = username;
        return res.json({ success: true, message: 'Registration successful.' });

    } catch (error) {
        console.error("Registration error:", error);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, message: 'Username and password are required.' });
    }

    const user = Object.values(users).find(u => u.username === username);

    if (!user) {
        return res.json({ success: false, message: 'Invalid username or password.' });
    }

    try {
        const match = await bcrypt.compare(password, user.hashedPassword);
        if (match) {
            // Passwords match, create a session
            req.session.userId = Object.keys(users).find(key => users[key] === user); //Store User Id.
            req.session.username = username; // Store the username in the session
            return res.json({ success: true, message: 'Login successful.' });
        } else {
            return res.json({ success: false, message: 'Invalid username or password.' });
        }
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// Logout
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error("Logout error:", err);
            return res.status(500).json({ success: false, message: 'Logout failed.' });
        }
        return res.json({ success: true, message: 'Logged out successfully.' });
    });
});

// Check Authentication Status
app.get('/check-auth', (req, res) => {
    if (req.session.userId) {
        return res.json({ isAuthenticated: true, username: req.session.username });
    } else {
        return res.json({ isAuthenticated: false });
    }
});


// --- Socket.IO Connection ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let session = socket.request.session;

    // --- Socket.IO Event Handlers ---
    socket.on('createRoom', async (username, roomName, callback) => {

        // Check if the user is authenticated
        if (!session.userId) {
          callback({ success: false, message: 'Not authenticated.' });
            return;
        }
        const questions = await fetchQuestions(10, 9, "easy");  // Sesuaikan

        if (questions.length > 0) {
            const roomId = generateRoomId();
            rooms[roomId] = {
                users: { [socket.id]: { username: session.username, score: 0 } },  // Get username from session
                questionIndex: 0,
                questions: questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null,
                timeLeft: 60,
            };
            // No need to store username separately in 'users', it's in the session.
            socket.join(roomId);
            callback({ success: true, roomId });
            updateRoomInfo(roomId);
            startTimer(roomId);
        } else {
            callback({ success: false, message: 'Failed to fetch questions.' });
        }
    });

    socket.on('joinRoom', (roomId, username, callback) => {
         // Check authentication
        if (!session.userId) {
            callback({ success: false, message: 'Not authenticated.' });
            return;
        }

        if (rooms[roomId]) {
            if (Object.keys(rooms[roomId].users).length >= 4) {
                callback({ success: false, message: 'Room is full.' });
                return;
            }
              // Check for duplicate usernames in the room
            const existingUsernames = Object.values(rooms[roomId].users).map(u => u.username);
            if (existingUsernames.includes(session.username)) {  // Check against session username
                return callback({ success: false, message: 'Username already taken in this room.' });
            }

            rooms[roomId].users[socket.id] = { username: session.username, score: 0 }; // Use session username

            socket.join(roomId);
            callback({ success: true, questions: rooms[roomId].questions });
            updateRoomInfo(roomId);
        } else {
            callback({ success: false, message: 'Room not found.' });
        }
    });

    socket.on('answerQuestion', (answerIndex, callback) => {
         // No need to check authentication here, user must be in a room to answer
        const user = rooms[currentRoomId]?.users[socket.id];
        if (!user) {
            // This shouldn't happen if the user is properly managed
            return callback({success: false, message: "Error: User not found in room."});
        }

        const room = rooms[currentRoomId];
        const currentQuestionIndex = room.questionIndex;
        const currentQuestion = room.questions[currentQuestionIndex];

        if (answerIndex === currentQuestion.correct) {
            room.users[socket.id].score += 10;
            callback({ success: true, correct: true, score:  room.users[socket.id].score });
        } else {
            callback({ success: true, correct: false, score:  room.users[socket.id].score });
        }

    });

    socket.on('restartGame', async () => {
        const user = rooms[currentRoomId]?.users[socket.id];
        if (!user) return;
        const room = rooms[currentRoomId];

        const hostSocketId = Object.keys(room.users)[0];
        if (socket.id !== hostSocketId) return;

        const newQuestions = await fetchQuestions(10, 9, "easy"); // Sesuaikan
        if (newQuestions.length === 0) {
          io.to(currentRoomId).emit('error', 'Failed to fetch questions for restart.');
          return;
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 60; // Reset timer

        for (const userId in room.users) {
            room.users[userId].score = 0;
        }

                clearTimeout(room.timer);
        startTimer(currentRoomId);
        updateRoomInfo(currentRoomId);
        io.to(currentRoomId).emit('gameRestarted', room.questions[0]);
    });

    socket.on('leaveRoom', () => {
        handleLeaveRoom(socket);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom(socket);
    });


    // --- Helper Functions ---

    function handleLeaveRoom(socket) {
        let currentRoomId = null;

        // Find the room the user is in.  Iterate through rooms.
        for (const roomId in rooms) {
            if (rooms[roomId].users[socket.id]) {
                currentRoomId = roomId;
                break;
            }
        }

        if (currentRoomId) {
            const room = rooms[currentRoomId];
            delete room.users[socket.id];

            if (Object.keys(room.users).length === 0) {
                // If the room is empty, delete it
                delete rooms[currentRoomId];
            } else {
                // If the user leaving was the host, clear the timer.
                if (Object.keys(room.users)[0] === socket.id) {
                    clearTimeout(room.timer);
                }
                updateRoomInfo(currentRoomId); // Update room info for other users
            }
            socket.leave(currentRoomId);
        }
    }

     function updateRoomInfo(roomId) {
        if (rooms[roomId]) {
            const userList = Object.values(rooms[roomId].users).map(user => ({
                username: user.username,
                score: user.score,
            }));

            io.to(roomId).emit('roomInfo', {
                roomId: roomId,
                roomName: rooms[roomId].roomName,
                users: userList,
                totalUsers: userList.length,
                currentQuestionIndex: rooms[roomId].questionIndex + 1,
                totalQuestions: rooms[roomId].questions.length,
                timeLeft: rooms[roomId].timeLeft,
            });
        }
    }

    function getRoomScores(roomId) {
        if (rooms[roomId]) {
            return Object.values(rooms[roomId].users).map(user => ({
                username: user.username,
                score: user.score
            }));
        }
        return [];
    }

    function startTimer(roomId) {
        if (!rooms[roomId]) return;

        rooms[roomId].timeLeft = 60;
        updateRoomInfo(roomId);

        rooms[roomId].timer = setInterval(() => {
            if (!rooms[roomId]) {
                clearInterval(rooms[roomId].timer); // Clear interval if room is gone.
                return;
            }
            rooms[roomId].timeLeft--;
            updateRoomInfo(roomId);

            if (rooms[roomId].timeLeft <= 0) {
                clearInterval(rooms[roomId].timer);
                moveToNextQuestion(roomId);
            }
        }, 1000);
    }


    function moveToNextQuestion(roomId) {
        if (!rooms[roomId]) return;

        const room = rooms[roomId];
        if (room.questionIndex < room.questions.length - 1) {
            room.questionIndex++;
            io.to(roomId).emit('nextQuestion', room.questions[room.questionIndex]);
            startTimer(roomId); // Restart the timer for the next question

        } else {
            // Game over
            io.to(roomId).emit('gameOver', getRoomScores(roomId));
        }
    }
}); // Closing bracket for io.on('connection', ...)

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
