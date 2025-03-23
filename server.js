const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const fs = require('fs'); // Untuk operasi file

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

// Fungsi bantu untuk membaca dan menulis file JSON
function loadData(filename) {
    try {
        if (fs.existsSync(filename)) {
            const data = fs.readFileSync(filename, 'utf8');
            return JSON.parse(data);
        } else {
            // Buat file baru jika belum ada
            fs.writeFileSync(filename, '{}', 'utf8');
            return {};
        }
    } catch (err) {
        console.error(`Error loading data from ${filename}:`, err);
        return {};
    }
}

function saveData(filename, data) {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`Error saving data to ${filename}:`, err);
    }
}

// Load data dari file saat server start
let users = loadData(USERS_FILE);
let rooms = loadData(ROOMS_FILE);

// Fungsi untuk generate room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Fungsi untuk fetch pertanyaan (kembali ke versi asli, tanpa terjemahan)
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



// Serve static files
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Fungsi untuk mendapatkan leaderboard, dengan foto profil
function getLeaderboard() {
    return Object.values(users)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(user => ({ // Tambahkan profilePic ke sini
            username: user.username,
            score: user.score,
            profilePic: user.profilePic || 'default-avatar.png' // Gambar default
        }));
}

// Fungsi untuk mengirim leaderboard
function sendLeaderboard() {
    io.emit('leaderboardUpdate', getLeaderboard());
}

// Fungsi untuk mengirim informasi room
// Fungsi untuk mengirim informasi room, dengan foto profil
function updateRoomInfo(roomId) {
    if (rooms[roomId]) {
        const userList = Object.values(rooms[roomId].users).map(user => ({
            username: user.username,
            score: user.score,
            profilePic: user.profilePic || 'default-avatar.png' // Sertakan profilePic
        }));

        io.to(roomId).emit('roomInfo', {
            roomId: roomId,
            roomName: rooms[roomId].roomName,
            users: userList,
            totalUsers: userList.length,
            currentQuestionIndex: rooms[roomId].questionIndex + 1,
            totalQuestions: rooms[roomId].questions.length,
            timeLeft: rooms[roomId].timeLeft,
            questions: rooms[roomId].questions
        });
    }
}

// Fungsi untuk memulai timer
function startTimer(roomId) {
    if (!rooms[roomId]) return;

    rooms[roomId].timeLeft = 30;
    updateRoomInfo(roomId);

    // Hentikan timer sebelumnya jika ada
    if (rooms[roomId].timer) {
        clearInterval(rooms[roomId].timer);
    }

    rooms[roomId].timer = setInterval(() => {
        if (!rooms[roomId]) {
          clearInterval(rooms[roomId].timer); // Tambahan: Hentikan timer jika room tidak ada
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

// Fungsi untuk pindah ke pertanyaan berikutnya
function moveToNextQuestion(roomId) {
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    if (room.questionIndex < room.questions.length - 1) {
        room.questionIndex++;
        io.to(roomId).emit('nextQuestion', room.questions[room.questionIndex]);
        startTimer(roomId);
    } else {
      const scores = Object.values(room.users).map(user => ({
            username: user.username,
            score: user.score
        }));
        io.to(roomId).emit('gameOver', scores);
    }
}

// Socket.IO event handlers
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Kirim leaderboard saat user pertama kali connect
    sendLeaderboard();

    // Create Room
    socket.on('createRoom', async (username, roomName, callback) => {
        username = username.trim();
        if (!username) {
             return callback({ success: false, message: 'Invalid username.' });
        }


        const roomId = generateRoomId();
        const questions = await fetchQuestions(10, 9, "easy");

        if (questions.length > 0) {
            rooms[roomId] = {
                users: { [socket.id]: { username, score: 0, profilePic: null} },
                questionIndex: 0,
                questions: questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null,
                timeLeft: 30,
            };
            // Update data user (tambahkan roomId)
            if(!users[socket.id]){
                users[socket.id] = { username, score: 0, profilePic: null, roomId };
            } else {
                users[socket.id].roomId = roomId;
            }

            saveData(USERS_FILE, users);
            saveData(ROOMS_FILE, rooms);

            socket.join(roomId);
            callback({ success: true, roomId });
            updateRoomInfo(roomId);
            startTimer(roomId);

        } else {
             callback({ success: false, message: 'Failed to fetch questions.' });
        }
    });

    // Join Room
    socket.on('joinRoom', (roomId, username, callback) => {
        username = username.trim();

        if (!username) {
            return callback({ success: false, message: 'Invalid username.' });
        }

        roomId = roomId.toUpperCase();
        if (rooms[roomId]) {
            if (Object.keys(rooms[roomId].users).length >= 4) {
                 return callback({ success: false, message: 'Room is full.' });
            }
             for (const userId in rooms[roomId].users) {
                if (rooms[roomId].users[userId].username === username) {
                    return callback({ success: false, message: 'Username already taken in this room.' });

                }
            }
              rooms[roomId].users[socket.id] = { username, score: 0,  profilePic: null};

            // Update user data
            if(!users[socket.id]){
                users[socket.id] = { username, score: 0,  profilePic: null, roomId};
            }else {
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

    // Answer Question
    socket.on('answerQuestion', (answerIndex, callback) => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) {
            return callback({success: false, message: "Error answer"})
        }
        const room = rooms[user.roomId];

        const currentQuestionIndex = room.questionIndex;
        const currentQuestion = room.questions[currentQuestionIndex];


        if (answerIndex === currentQuestion.correct) {
            rooms[user.roomId].users[socket.id].score += 10;
            users[socket.id].score += 10; // Update juga di users.
             callback({ success: true, correct: true, score: users[socket.id].score });
        } else {
            callback({ success: true, correct: false, score: users[socket.id].score });
        }
          saveData(USERS_FILE, users);
          saveData(ROOMS_FILE, rooms);
         sendLeaderboard(); // Update leaderboard setelah menjawab
    });

    // Restart Game (semua pemain bisa restart) -> Next
    socket.on('restartGame', async () => { // Ganti nama event
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;
        const room = rooms[user.roomId];

        const newQuestions = await fetchQuestions(10, 9, "easy");
        if (newQuestions.length === 0) {
            io.to(user.roomId).emit('error', 'Failed to fetch questions for restart.');
            return;
        }

        room.questionIndex = 0; // Reset index
        room.questions = newQuestions; // Ganti pertanyaan
        room.timeLeft = 30;

        for (let userId in room.users) {
            room.users[userId].score = 0; // Reset score di ROOM
        }

        saveData(ROOMS_FILE, rooms);


        clearTimeout(room.timer);
        startTimer(user.roomId);
        updateRoomInfo(user.roomId);
        io.to(user.roomId).emit('gameRestarted', room.questions[0]);
    });

      // Update Profile (Foto)
    socket.on('updateProfile', (data) => {
        const user = users[socket.id];
        if (user) {
            user.profilePic = data.profilePic;
            saveData(USERS_FILE, users);

            // Broadcast ke semua klien di room
            if (user.roomId) {
                io.to(user.roomId).emit('profileUpdated', { userId: socket.id, profilePic: data.profilePic });
            }
            sendLeaderboard(); // Update leaderboard
        }
    });


    // Leave Room
    socket.on('leaveRoom', () => {
        handleLeaveRoom(socket);
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom(socket);
    });

     // Handle Leave Room (disederhanakan)
    function handleLeaveRoom(socket) {
        const user = users[socket.id];
        if (user) {
            const roomId = user.roomId;
            if (rooms[roomId]) {
                delete rooms[roomId].users[socket.id]; // Hapus user dari room

                // Jika room kosong, hapus room (opsional)
                if (Object.keys(rooms[roomId].users).length === 0) {
                    delete rooms[roomId];
                } else {
                    updateRoomInfo(roomId);
                }

                saveData(ROOMS_FILE, rooms);
            }

            socket.leave(roomId);
        }
    }

    // Chat Message
    socket.on('chatMessage', (message) => {
        const user = users[socket.id];
        if (user && rooms[user.roomId]) {
            message = message.trim();
            if (message.length > 0 && message.length <= 200) {
                 io.to(user.roomId).emit('chatMessage', {
                    username: user.username,
                    message: message,
                    timestamp: new Date()
                });
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
