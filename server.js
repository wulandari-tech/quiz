// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "https://styles-production.up.railway.app", // GANTI dengan URL frontend Anda saat production!
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

let rooms = {};
let users = {};

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

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', async (username, roomName, callback) => {
        // Validasi username (contoh sederhana)
        if (!username || username.trim().length === 0) {
            callback({ success: false, message: 'Invalid username.' });
            return;
        }

        const roomId = generateRoomId();
        const questions = await fetchQuestions(10, 9, "easy");  // Sesuaikan

        if (questions.length > 0) {
            rooms[roomId] = {
                users: { [socket.id]: { username, score: 0 } },
                questionIndex: 0,
                questions: questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null,
                timeLeft: 30,
            };
            users[socket.id] = { username, score: 0, roomId };
            socket.join(roomId);
            callback({ success: true, roomId });
            updateRoomInfo(roomId);
            startTimer(roomId);
        } else {
            callback({ success: false, message: 'Failed to fetch questions.' });
        }
    });

    socket.on('joinRoom', (roomId, username, callback) => {
        // Validasi username
        if (!username || username.trim().length === 0) {
            callback({ success: false, message: 'Invalid username.' });
            return;
        }

        if (rooms[roomId]) {
            if (Object.keys(rooms[roomId].users).length >= 4) {
                callback({ success: false, message: 'Room is full.' });
                return;
            }

            // Cek username duplikat di room yang sama
            for (const userId in rooms[roomId].users) {
                if (rooms[roomId].users[userId].username === username) {
                    callback({ success: false, message: 'Username already taken in this room.' });
                    return;
                }
            }

            rooms[roomId].users[socket.id] = { username, score: 0 };
            users[socket.id] = { username, score: 0, roomId };
            socket.join(roomId);
            callback({ success: true, questions: rooms[roomId].questions });
            updateRoomInfo(roomId);
        } else {
            callback({ success: false, message: 'Room not found.' });
        }
    });

    socket.on('answerQuestion', (answerIndex, callback) => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) {
            callback({success: false, message: "Error answer"})
            return;
        }
        const room = rooms[user.roomId];

        const currentQuestionIndex = room.questionIndex;
        const currentQuestion = room.questions[currentQuestionIndex];

        if (answerIndex === currentQuestion.correct) {
            rooms[user.roomId].users[socket.id].score += 10;
            users[socket.id].score += 10; //Update juga di users.
            callback({ success: true, correct: true, score: users[socket.id].score });

        } else {
             callback({ success: true, correct: false, score: users[socket.id].score });

        }
        // Jangan pindah ke pertanyaan berikutnya di sini; biarkan timer yang menangani
    });

    socket.on('restartGame', async () => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;
        const room = rooms[user.roomId];

        const hostSocketId = Object.keys(room.users)[0];
        if (socket.id !== hostSocketId) return;

        const newQuestions = await fetchQuestions(10, 9, "easy"); // Sesuaikan
        if (newQuestions.length === 0) {
          io.to(user.roomId).emit('error', 'Failed to fetch questions for restart.');
          return;
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 30; 

        for (const userId in room.users) {
            room.users[userId].score = 0;
             users[userId].score = 0;
        }

        clearTimeout(room.timer);
        startTimer(user.roomId);
        updateRoomInfo(user.roomId);
        io.to(user.roomId).emit('gameRestarted', room.questions[0]);
    });

    socket.on('leaveRoom', () => {
        handleLeaveRoom(socket);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom(socket);
    });

    function handleLeaveRoom(socket){
         const user = users[socket.id];
        if (user) {
            const roomId = user.roomId;
            if (rooms[roomId]) {
                delete rooms[roomId].users[socket.id];
                if (Object.keys(rooms[roomId].users).length === 0) {
                    delete rooms[roomId];
                } else {
                    if (Object.keys(rooms[roomId].users)[0] === socket.id) {
                         clearTimeout(rooms[roomId].timer);
                    }
                    updateRoomInfo(roomId);
                }
            }
             delete users[socket.id];
             socket.leave(roomId);
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
    function getRoomScores(roomId){
         if(rooms[roomId]){
             return Object.values(rooms[roomId].users).map(user => ({
                username: user.username,
                score: user.score
            }));
         }
         return [];
    }

    function startTimer(roomId) {
        if (!rooms[roomId]) return;

        rooms[roomId].timeLeft = 30;
        updateRoomInfo(roomId);

        rooms[roomId].timer = setInterval(() => {
            if (!rooms[roomId]) {
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
                rooms[roomId].questionIndex++;
                io.to(roomId).emit('nextQuestion', rooms[roomId].questions[rooms[roomId].questionIndex]);
                startTimer(roomId);

           } else {
                io.to(roomId).emit('gameOver', getRoomScores(roomId));
           }
    }
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
