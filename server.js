const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "https://styles-production.up.railway.app", // GANTI SEBELUM DEPLOY!
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;
const USERS_FILE = 'users.json';
const ROOMS_FILE = 'rooms.json';

function loadData(filename) {
    try {
        if (fs.existsSync(filename)) {
            return JSON.parse(fs.readFileSync(filename, 'utf8'));
        }
        fs.writeFileSync(filename, '{}', 'utf8');
        return {};
    } catch (err) {
        console.error(`Error loading ${filename}:`, err);
        return {};
    }
}

function saveData(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`Error saving ${filename}:`, err);
    }
}

let users = loadData(USERS_FILE);
let rooms = loadData(ROOMS_FILE);

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
            return data.results.map(item => ({
                question: item.question,
                answers: [...item.incorrect_answers, item.correct_answer].sort(() => Math.random() - 0.5),
                correct: [...item.incorrect_answers, item.correct_answer].sort(() => Math.random() - 0.5).indexOf(item.correct_answer)
            }));
        }
        console.error("Error fetching questions:", data.response_code);
        return [];
    } catch (error) {
        console.error("Error fetching questions:", error);
        return [];
    }
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function getLeaderboard() {
    return Object.values(users)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(user => ({ username: user.username, score: user.score, profilePic: user.profilePic || 'default-avatar.png' }));
}
function sendLeaderboard() { io.emit('leaderboardUpdate', getLeaderboard()); }

function updateRoomInfo(roomId) {
    if (!rooms[roomId]) return;
    const userList = Object.values(rooms[roomId].users).map(user => ({
        username: user.username, score: user.score, profilePic: user.profilePic || 'default-avatar.png'
    }));
    io.to(roomId).emit('roomInfo', {
        roomId,
        roomName: rooms[roomId].roomName,
        users: userList,
        totalUsers: userList.length,
        currentQuestionIndex: rooms[roomId].questionIndex + 1,
        totalQuestions: rooms[roomId].questions.length,
        timeLeft: rooms[roomId].timeLeft,  //timeLeft tetap dikirim
        questions: rooms[roomId].questions
    });
}

//Modifikasi startTimer
function startTimer(roomId) {
    if (!rooms[roomId]) return;

    rooms[roomId].timeLeft = 30; // Waktu awal
    updateRoomInfo(roomId);

    if (rooms[roomId].timer) {
        clearInterval(rooms[roomId].timer);
    }

    rooms[roomId].timer = setInterval(() => {
        if (!rooms[roomId]) {
            clearInterval(rooms[roomId].timer);
            return;
        }
        rooms[roomId].timeLeft--; // Kurangi waktu
        updateRoomInfo(roomId); // Kirim timeLeft yang diperbarui

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
        startTimer(roomId);
    } else {
        io.to(roomId).emit('gameOver', Object.values(room.users).map(u => ({ username: u.username, score: u.score })));
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    sendLeaderboard();

    socket.on('createRoom', async (username, roomName, callback) => {
        username = username.trim();
        if (!username) return callback({ success: false, message: 'Invalid username.' });

        const roomId = generateRoomId();
        const questions = await fetchQuestions(10, 9, "easy");

        if (questions.length > 0) {
            rooms[roomId] = {
                users: { [socket.id]: { username, score: 0, profilePic: null } },
                questionIndex: 0,
                questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null,
                timeLeft: 30, // Waktu awal
            };
            if (!users[socket.id]) {
                users[socket.id] = { username, score: 0, profilePic: null, roomId };
            } else {
                users[socket.id].roomId = roomId;
            }
            saveData(USERS_FILE, users);
            saveData(ROOMS_FILE, rooms);
            socket.join(roomId);
            callback({ success: true, roomId });
            updateRoomInfo(roomId);
            startTimer(roomId); // Mulai timer
        } else {
            callback({ success: false, message: 'Failed to fetch questions' });
        }
    });

    socket.on('joinRoom', (roomId, username, callback) => {
        username = username.trim();
        if (!username) return callback({ success: false, message: 'Invalid username.' });

        roomId = roomId.toUpperCase();
        if (rooms[roomId]) {
            if (Object.keys(rooms[roomId].users).length >= 4)
                return callback({ success: false, message: 'Room is full.' });
            if (Object.values(rooms[roomId].users).some(u => u.username === username))
                return callback({ success: false, message: 'Username taken in this room.' });

            rooms[roomId].users[socket.id] = { username, score: 0, profilePic: null };
            if (!users[socket.id]) {
                users[socket.id] = { username, score: 0, profilePic: null, roomId };
            } else {
                users[socket.id].roomId = roomId;
            }
            saveData(USERS_FILE, users);
            saveData(ROOMS_FILE, rooms);
            socket.join(roomId);
            callback({ success: true, questions: rooms[roomId].questions });
            updateRoomInfo(roomId);
        } else {
            callback({ success: false, message: 'Room not found.' });
        }
    });

    socket.on('answerQuestion', (answerIndex, callback) => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;
        const room = rooms[user.roomId];
        const currentQuestion = room.questions[room.questionIndex];

        if (answerIndex === currentQuestion.correct) {
            rooms[user.roomId].users[socket.id].score += 10;
            users[socket.id].score += 10;
            callback({ success: true, correct: true, score: users[socket.id].score });
        } else {
            callback({ success: true, correct: false, score: users[socket.id].score });
        }
        saveData(USERS_FILE, users); saveData(ROOMS_FILE, rooms);
        sendLeaderboard();
    });

    socket.on('restartGame', async () => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;
        const room = rooms[user.roomId];

        const newQuestions = await fetchQuestions(10, 9, "easy");
        if (newQuestions.length === 0) {
            return io.to(user.roomId).emit('error', 'Failed to fetch questions.');
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 30;     // Reset waktu

        for (let userId in room.users) room.users[userId].score = 0;
        saveData(ROOMS_FILE, rooms);

        clearTimeout(room.timer); //Hentikan Timer
        startTimer(user.roomId); // Mulai timer baru
        updateRoomInfo(user.roomId);
        io.to(user.roomId).emit('gameRestarted', room.questions[0]);
    });

    socket.on('updateProfile', (data) => {
        const user = users[socket.id];
        if (user) {
            user.profilePic = data.profilePic;
            saveData(USERS_FILE, users);
            if (user.roomId) {
                io.to(user.roomId).emit('profileUpdated', { userId: socket.id, profilePic: data.profilePic });
            }
            sendLeaderboard();
        }
    });

    socket.on('leaveRoom', () => { handleLeaveRoom(socket); });
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom(socket);
    });

    function handleLeaveRoom(socket) {
        const user = users[socket.id];
        if (!user) return;

        const roomId = user.roomId;
        if (!rooms[roomId]) return;

        delete rooms[roomId].users[socket.id];
        if (Object.keys(rooms[roomId].users).length === 0) {
            delete rooms[roomId];
        } else {
            updateRoomInfo(roomId);
        }
        saveData(ROOMS_FILE, rooms);
        socket.leave(roomId);
    }

    socket.on('chatMessage', (message) => {
        const user = users[socket.id];
        if (user && rooms[user.roomId]) {
            message = message.trim();
            if (message.length > 0 && message.length <= 200) {
                io.to(user.roomId).emit('chatMessage', { username: user.username, message, timestamp: new Date() });
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
