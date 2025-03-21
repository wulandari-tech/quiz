const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch'); // Pastikan node-fetch terinstall: npm install node-fetch

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // GANTI dengan URL frontend saat production!
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

let rooms = {};          // Menyimpan data room
let users = {};          // Menyimpan data user
let sessions = {};       // Menyimpan session login
let triviaApiTokens = {}; // Menyimpan token Open Trivia DB per room


// Fungsi untuk membuat ID room yang unik
function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// --- Fungsi untuk mendapatkan token sesi dari Open Trivia DB ---
async function getTriviaApiToken() {
    try {
        const response = await fetch('https://opentdb.com/api_token.php?command=request');
        const data = await response.json();
        if (data.response_code === 0) {
            return data.token;
        } else {
            console.error("Error requesting token:", data); // Log error
            return null; // Kembalikan null jika gagal
        }
    } catch (error) {
        console.error("Error requesting token (network error):", error); // Log error
        return null; // Kembalikan null jika gagal (masalah jaringan)
    }
}

// --- Fungsi untuk mengambil satu pertanyaan dari Open Trivia DB ---
async function fetchSingleQuestion(token) {
    const url = `https://opentdb.com/api.php?amount=1&type=multiple&token=${token}`;
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.response_code === 0) {
            const questionData = data.results[0];
            const answers = [...questionData.incorrect_answers, questionData.correct_answer];

            // Acak urutan jawaban
            for (let i = answers.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [answers[i], answers[j]] = [answers[j], answers[i]];
            }

            const correctIndex = answers.indexOf(questionData.correct_answer);

            return {
                question: questionData.question,
                answers: answers,
                correct: correctIndex
            };
        } else if (data.response_code === 1 || data.response_code === 2) {
           //Token habis/tidak ada pertanyaan
           console.log("Token expired/no questions.  Requesting new token."); // Log info
           return null;

        }else {
            console.error("Error fetching question from Open Trivia DB:", data); // Log error
            return null;
        }
    } catch (error) {
        console.error("Error fetching question (network error):", error);  // Log error
        return null;
    }
}

// --- Fungsi untuk mengambil sejumlah pertanyaan dengan retry ---
async function fetchQuestions(amount = 10, roomId) {
    let token = triviaApiTokens[roomId];
    if (!token) {
        console.log("No token for room", roomId, ".  Getting a new one."); // Log info
        token = await getTriviaApiToken();
        if (!token) {
            console.error("Failed to get API token.  Cannot fetch questions."); // Log error
            return []; // Gagal mendapatkan token
        }
        triviaApiTokens[roomId] = token;
    }

    const questions = [];
    let retries = 3; // Coba ambil pertanyaan hingga 3 kali

    for (let i = 0; i < amount; i++) {
        let question = null;
        for (let attempt = 0; attempt < retries; attempt++) {
             console.log(`Fetching question ${i + 1} for room ${roomId}, attempt ${attempt + 1}`);
            question = await fetchSingleQuestion(token);
            if (question) {
                 console.log(`Successfully fetched question ${i + 1} for room ${roomId}`);
                break; // Berhasil ambil pertanyaan, keluar dari loop retry
            }

            //Jika token habis reset.
            if(question === null){
                 token = await getTriviaApiToken();
                if (!token) {
                     console.log("Failed get API Token");
                    return []; // Gagal mendapatkan token
                }
                triviaApiTokens[roomId] = token; // Simpan token
            }

            // Tunggu sebentar sebelum mencoba lagi
            await new Promise(resolve => setTimeout(resolve, 1000)); // Tunggu 1 detik
        }

        if (question) {
            questions.push(question);
        } else {
            console.error("Failed to fetch question after multiple retries."); // Log error
            return []; // Kembalikan array kosong
        }
    }
    return questions;
}


// --- Routing (hanya untuk file statis) ---
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });


// --- Socket.IO Event Handling ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Login ---
    socket.on('login', async (username, password, callback) => {
        if (users[username] && users[username].password === password) {
            sessions[socket.id] = username;
            callback({ success: true, username: username });
            emitRoomList(); // Update room list
        } else {
            callback({ success: false, message: 'Invalid username or password.' });
        }
    });

    // --- Register ---
    socket.on('register', (username, password, callback) => {
        if (users[username]) {
            callback({ success: false, message: 'Username already taken.' });
            return;
        }
        if (!password || password.length < 4) {
            callback({ success: false, message: 'Password must be at least 4 characters.' });
            return;
        }
        users[username] = { password: password };
        callback({ success: true });
    });

    // --- Logout ---
    socket.on('logout', () => {
        delete sessions[socket.id];
         emitRoomList(); // Update room list
    });

    // --- Cek Sesi ---
    socket.on('checkSession', (callback) => {
        const username = sessions[socket.id];
        if (username) {
            callback({ loggedIn: true, username: username });
            emitRoomList(); // Update room list
        } else {
            callback({ loggedIn: false });
        }
    });

    // --- Create Room ---
    socket.on('createRoom', async (username, roomName, callback) => {
        const roomId = generateRoomId();
        const questions = await fetchQuestions(10, roomId); // Ambil 10 pertanyaan

        if (questions.length > 0) {
            rooms[roomId] = {
                users: { [socket.id]: { username, score: 0 } },
                questionIndex: 0,
                questions: questions,
                roomName: roomName || `Room ${roomId}`, // Nama room default
                timer: null,
                timeLeft: 60,
            };
            users[socket.id] = { username, score: 0, roomId }; // Simpan roomId
            socket.join(roomId);
            callback({ success: true, roomId });
            updateRoomInfo(roomId); // Update info room
            startTimer(roomId);     // Mulai timer
            emitRoomList();          // Update room list
        } else {
            callback({ success: false, message: 'Failed to fetch questions.' }); // Kirim pesan error
        }
    });

    // --- Join Room ---
    socket.on('joinRoom', (roomId, callback) => {
        const username = sessions[socket.id];

        if (!username) {
          callback({success: false, message:"User not logged in."});
          return;
        }
        if (rooms[roomId]) {
            if (Object.keys(rooms[roomId].users).length >= 4) {
                callback({ success: false, message: 'Room is full.' });
                return;
            }
            // Cek username duplikat
            for (const userId in rooms[roomId].users) {
                if (rooms[roomId].users[userId].username === username) {
                    callback({ success: false, message: 'Username already taken in this room.' });
                    return;
                }
            }

            rooms[roomId].users[socket.id] = { username, score: 0 };
            users[socket.id] = { username, score: 0, roomId }; // Simpan roomId
            socket.join(roomId);
            callback({ success: true, questions: rooms[roomId].questions });
            updateRoomInfo(roomId); // Update info room
            io.to(roomId).emit('userJoined', username); // Notifikasi
        } else {
            callback({ success: false, message: 'Room not found.' });
        }
    });

    // --- Jawab Pertanyaan ---
    socket.on('answerQuestion', (answerIndex, callback) => {
         const user = users[socket.id];
        if (!user || !rooms[user.roomId]) {
            callback({success: false, message: "Error answer."});
            return;
        }

        const room = rooms[user.roomId];
        const currentQuestionIndex = room.questionIndex;
        const currentQuestion = room.questions[currentQuestionIndex];

        if (answerIndex === currentQuestion.correct) {
            rooms[user.roomId].users[socket.id].score += 10; // Tambah skor di room
             users[socket.id].score += 10; // Tambah skor di user (global)
            callback({ success: true, correct: true, score: users[socket.id].score });
        } else {
             callback({ success: true, correct: false, score: users[socket.id].score });
        }
    });

    // --- Restart Game (hanya host) ---
    socket.on('restartGame', async () => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;

        const room = rooms[user.roomId];
        const hostSocketId = Object.keys(room.users)[0]; // Host adalah user pertama
        if (socket.id !== hostSocketId) return; // Cek apakah user adalah host

        const newQuestions = await fetchQuestions(10, user.roomId);  //Ambil soal baru
        if (newQuestions.length === 0) {
          io.to(user.roomId).emit('error', 'Failed to fetch questions for restart.');
          return;
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 60;

        // Reset skor semua pemain
        for (const userId in room.users) {
            room.users[userId].score = 0;
            users[userId].score = 0; // Reset skor user (global)
        }

        clearTimeout(room.timer); // Hentikan timer
        startTimer(user.roomId);  // Mulai timer baru
        updateRoomInfo(user.roomId); // Update info room
        io.to(user.roomId).emit('gameRestarted', room.questions[0]); // Kirim pertanyaan pertama
    });


    // --- Logout ---
    socket.on('logout', () => {
        const username = sessions[socket.id];
        delete sessions[socket.id];
         emitRoomList(); // Update room list
        if(username){
            io.emit("userLoggedOut", username); // Notifikasi
        }

    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom(socket);
    });

    // --- Fungsi untuk menangani user yang keluar dari room ---
    function handleLeaveRoom(socket){
         const user = users[socket.id];
        if (user) {
            const roomId = user.roomId;
            if (rooms[roomId]) {
                delete rooms[roomId].users[socket.id];

                // Jika room kosong, hapus room dan token
                if (Object.keys(rooms[roomId].users).length === 0) {
                    delete rooms[roomId];
                    delete triviaApiTokens[roomId]; // Hapus token API
                } else {
                     //Jika host yang keluar
                    if (Object.keys(rooms[roomId].users)[0] === socket.id) {
                         clearTimeout(rooms[roomId].timer);
                     }
                    updateRoomInfo(roomId); // Update info room
                }
                emitRoomList(); // Update daftar room
            }
            delete users[socket.id];
            socket.leave(roomId);

        }
    }


    // --- Fungsi untuk update informasi room ke semua client di room tersebut ---
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
                currentQuestionIndex: rooms[roomId].questionIndex + 1, // +1 agar lebih user-friendly
                totalQuestions: rooms[roomId].questions.length,
                timeLeft: rooms[roomId].timeLeft,
            });
        }
    }

    // --- Fungsi untuk mendapatkan skor semua pemain di room ---
    function getRoomScores(roomId) {
        if (rooms[roomId]) {
            return Object.values(rooms[roomId].users).map(user => ({
                username: user.username,
                score: user.score
            }));
        }
        return [];
    }

    // --- Fungsi untuk memulai timer ---
    function startTimer(roomId) {
        if (!rooms[roomId]) return;

        rooms[roomId].timeLeft = 60; // Reset timer
        updateRoomInfo(roomId); // Update info (termasuk timer)

        rooms[roomId].timer = setInterval(() => {
            if (!rooms[roomId]) {

                return; // Room sudah dihapus
            }
            rooms[roomId].timeLeft--;
            updateRoomInfo(roomId); // Update info (termasuk timer)

            if (rooms[roomId].timeLeft <= 0) {
                clearInterval(rooms[roomId].timer); // Hentikan timer
                moveToNextQuestion(roomId);         // Pindah ke pertanyaan berikutnya
            }
        }, 1000);
    }

    // --- Fungsi untuk pindah ke pertanyaan berikutnya ---
    function moveToNextQuestion(roomId) {
        if (!rooms[roomId]) return;

        const room = rooms[roomId];
        if (room.questionIndex < room.questions.length - 1) {
            room.questionIndex++;
            io.to(roomId).emit('nextQuestion', rooms[roomId].questions[room.questionIndex]);
            startTimer(roomId); // Mulai timer lagi
        } else {
            // Game selesai
            io.to(roomId).emit('gameOver', getRoomScores(roomId));
        }
    }

    // --- Fungsi untuk mengirim daftar room ke semua client ---
    function emitRoomList() {
        const roomList = Object.keys(rooms).map(roomId => ({
            id: roomId,
            name: rooms[roomId].roomName,
            host: Object.values(rooms[roomId].users)[0].username,
            numPlayers: Object.keys(rooms[roomId].users).length,
        }));
        io.emit('roomList', roomList);
    }
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
