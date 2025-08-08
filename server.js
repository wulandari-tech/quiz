// --- IMPORTS ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// --- INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3001;

// --- DATABASE CONNECTION ---
// Ganti dengan string koneksi MongoDB Anda. Sebaiknya gunakan variabel lingkungan.
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://zanssxploit:pISqUYgJJDfnLW9b@cluster0.fgram.mongodb.net/scmarketdb?retryWrites=true&w=majority';
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- MONGOOSE SCHEMAS ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    totalScore: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
    profilePic: { type: String, default: 'default-avatar.png' }
});
const User = mongoose.model('User', userSchema);

// --- MIDDLEWARE SETUP ---
app.use(bodyParser.urlencoded({ extended: true }));
// Menyajikan file statis (HTML, CSS, JS) dari direktori root.
// Ini memungkinkan /login.html, /register.html, dll. untuk diakses.
app.use(express.static(__dirname));

const sessionMiddleware = session({
    secret: 'a-secret-key-for-wanzofc-quiz-super-long-and-random', // Ganti dengan string acak yang panjang untuk produksi
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // Sesi 1 hari
});
app.use(sessionMiddleware);
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// --- AUTHENTICATION MIDDLEWARE ---
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

// --- HTTP ROUTES ---
app.get('/', (req, res) => {
    if (req.session.userId) {
        res.redirect('/game'); // Jika sudah login, langsung ke game
    } else {
        res.sendFile(__dirname + '/landing.html'); // Jika tidak, ke halaman landing
    }
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('Username and password are required. <a href="/register.html">Try again</a>');
    }
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).send('User already exists. <a href="/register.html">Try again</a>');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.redirect('/login.html');
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).send('Server error. <a href="/register.html">Try again</a>');
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).send('Invalid credentials. <a href="/login.html">Try again</a>');
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).send('Invalid credentials. <a href="/login.html">Try again</a>');
        }
        req.session.userId = user._id;
        req.session.username = user.username;
        res.redirect('/game');
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).send('Server error. <a href="/login.html">Try again</a>');
    }
});

app.get('/game', isAuthenticated, (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/game');
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

app.get('/profile', isAuthenticated, (req, res) => {
    res.sendFile(__dirname + '/profile.html');
});

app.get('/api/profile', isAuthenticated, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).select('-password'); // Exclude password
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (error) {
        console.error('API profile error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});


// --- GAME LOGIC & STATE ---
let rooms = {}; // Ruangan disimpan di memori, karena bersifat sementara

function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

async function fetchQuestions(options = {}) {
    const { amount = 10, category = '', difficulty = '' } = options;
    let url = `https://opentdb.com/api.php?amount=${amount}&type=multiple`;
    if (category) {
        url += `&category=${category}`;
    }
    if (difficulty) {
        url += `&difficulty=${difficulty}`;
    }

    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.response_code === 0) {
            return data.results.map(item => {
                const answers = [...item.incorrect_answers, item.correct_answer];
                // Acak jawaban
                for (let i = answers.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [answers[i], answers[j]] = [answers[j], answers[i]];
                }
                return {
                    question: item.question,
                    answers: answers,
                    correct: answers.indexOf(item.correct_answer)
                };
            });
        }
        return [];
    } catch (error) {
        console.error("Error fetching questions:", error);
        return [];
    }
}

async function getLeaderboard() {
    try {
        return await User.find({}, 'username totalScore profilePic')
            .sort({ totalScore: -1 })
            .limit(10)
            .lean();
    } catch (error) {
        console.error("Leaderboard error:", error);
        return [];
    }
}

function updateRoomInfo(roomId) {
    if (!rooms[roomId]) return;
    const room = rooms[roomId];
    const userList = Object.values(room.users).map(u => ({
        username: u.username,
        score: u.score,
        profilePic: u.profilePic
    }));
    io.to(roomId).emit('roomInfo', {
        roomId,
        roomName: room.roomName,
        users: userList,
        // info lain seperti questionIndex dapat ditambahkan jika diperlukan
    });
}

const MAX_PLAYERS_PER_ROOM = 10;

function broadcastPublicRooms() {
    const publicRooms = Object.entries(rooms).map(([id, room]) => ({
        id,
        name: room.roomName,
        playerCount: Object.keys(room.users).length,
        maxPlayers: MAX_PLAYERS_PER_ROOM
    }));
    io.emit('publicRoomsUpdate', publicRooms);
}

// --- SOCKET.IO LOGIC ---
io.on('connection', async (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) {
        console.log('Unauthenticated socket connection attempt, disconnecting.');
        return socket.disconnect();
    }

    try {
        const user = await User.findById(session.userId).lean();
        if (!user) {
            console.log(`User with ID ${session.userId} not found, disconnecting.`);
            return socket.disconnect();
        }

        socket.data.userId = user._id.toString();
        socket.data.username = user.username;
        socket.data.profilePic = user.profilePic;
        socket.data.currentRoomId = null;

        console.log(`User '${user.username}' connected.`);
        socket.emit('connectionSuccess', { username: user.username, profilePic: user.profilePic });

        socket.on('getPublicRooms', () => {
            const publicRooms = Object.entries(rooms).map(([id, room]) => ({
                id,
                name: room.roomName,
                playerCount: Object.keys(room.users).length,
                maxPlayers: MAX_PLAYERS_PER_ROOM
            }));
            socket.emit('publicRoomsUpdate', publicRooms);
        });

        socket.on('getLeaderboard', async () => {
            socket.emit('leaderboardUpdate', await getLeaderboard());
        });

        socket.on('createRoom', async (options, callback) => {
            const { roomName, category, difficulty } = options;
            const roomId = generateRoomId();
            const questions = await fetchQuestions({ category, difficulty });

            if (questions.length === 0) {
                return callback({ success: false, message: 'Failed to fetch questions for the selected criteria.' });
            }

            rooms[roomId] = {
                users: {},
                questionIndex: -1,
                questions: questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null
            };

            socket.join(roomId);
            rooms[roomId].users[socket.id] = { username: socket.data.username, score: 0, profilePic: socket.data.profilePic };
            socket.data.currentRoomId = roomId;

            callback({ success: true, roomId });
            updateRoomInfo(roomId);
            broadcastPublicRooms();
        });

        socket.on('joinRoom', (roomId, callback) => {
            roomId = roomId.toUpperCase();
            const room = rooms[roomId];
            if (!room) {
                return callback({ success: false, message: 'Room not found.' });
            }
            if (Object.keys(room.users).length >= MAX_PLAYERS_PER_ROOM) {
                return callback({ success: false, message: 'Room is full.' });
            }

            socket.join(roomId);
            room.users[socket.id] = { username: socket.data.username, score: 0, profilePic: socket.data.profilePic };
            socket.data.currentRoomId = roomId;

            callback({ success: true });
            updateRoomInfo(roomId);
            broadcastPublicRooms();
        });

        const handleLeaveRoom = () => {
            const roomId = socket.data.currentRoomId;
            if (!roomId || !rooms[roomId]) return;

            delete rooms[roomId].users[socket.id];
            socket.leave(roomId);
            socket.data.currentRoomId = null;

            if (Object.keys(rooms[roomId].users).length === 0) {
                delete rooms[roomId];
            } else {
                updateRoomInfo(roomId);
            }
            broadcastPublicRooms();
        };

        socket.on('leaveRoom', handleLeaveRoom);
        socket.on('disconnect', () => {
            handleLeaveRoom();
            console.log(`User '${socket.data.username}' disconnected.`);
        });

    } catch (error) {
        console.error("Error during socket connection setup:", error);
        socket.disconnect();
    }
});

// --- SERVER START ---
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
