// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // GANTI dengan URL frontend saat production!
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;

let rooms = {};
let users = {};
let sessions = {};
let triviaApiTokens = {}; // Menyimpan token untuk Open Trivia DB

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
            console.error("Error requesting token:", data);
            return null;
        }
    } catch (error) {
        console.error("Error requesting token:", error);
        return null;
    }
}



// --- Fungsi untuk mengambil pertanyaan dari Open Trivia DB ---
async function fetchSingleQuestion(token) {
    const url = `https://opentdb.com/api.php?amount=1&type=multiple&token=${token}`; // Gunakan token
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
           return null;

        } else {
            console.error("Error fetching question from Open Trivia DB:", data);
            return null; // Kembalikan null jika error
        }
    } catch (error) {
        console.error("Error fetching question:", error);
        return null; // Kembalikan null jika error
    }
}


// --- Fungsi untuk mengambil sejumlah pertanyaan, dengan retry ---
async function fetchQuestions(amount = 10, roomId) {
    let token = triviaApiTokens[roomId];  // Ambil token untuk room ini
    if (!token) {
        token = await getTriviaApiToken();
        if (!token) {
             console.log("Failed get API Token");
            return []; // Gagal mendapatkan token
        }
        triviaApiTokens[roomId] = token; // Simpan token
    }


    const questions = [];
    let retries = 3; // Coba 3 kali

    for (let i = 0; i < amount; i++) {
        let question = null;
        for (let attempt = 0; attempt < retries; attempt++) {
            question = await fetchSingleQuestion(token);
            if (question) {
                break;  //Berhasil ambil soal
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

             await new Promise(resolve => setTimeout(resolve, 500)); //Tunggu 500ms
        }

        if (question) {
            questions.push(question);
        } else {
            // Handle error jika setelah retry tetap gagal
            console.error("Failed to fetch question after multiple retries.");
            return [];  //Kembalikan array kosong
        }
    }
    return questions;
}



app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('login', async (username, password, callback) => {
        if (users[username] && users[username].password === password) {
            sessions[socket.id] = username;
            callback({ success: true, username: username });
            emitRoomList();
        } else {
            callback({ success: false, message: 'Invalid username or password.' });
        }
    });

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

    socket.on('logout', () => {
        delete sessions[socket.id];
    });

    socket.on('checkSession', (callback) => {
        const username = sessions[socket.id];
        if (username) {
            callback({ loggedIn: true, username: username });
            emitRoomList();
        } else {
            callback({ loggedIn: false });
        }
    });

    socket.on('createRoom', async (username, roomName, callback) => {
        const roomId = generateRoomId();
        const questions = await fetchQuestions(10, roomId); // Ambil 10 pertanyaan, roomId

        if (questions.length > 0) {
            rooms[roomId] = {
                users: { [socket.id]: { username, score: 0 } },
                questionIndex: 0,
                questions: questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null,
                timeLeft: 60,
            };
            users[socket.id] = { username, score: 0, roomId }; // Simpan roomId di user
            socket.join(roomId);
            callback({ success: true, roomId });
            updateRoomInfo(roomId);
            startTimer(roomId);
            emitRoomList();
        } else {
            callback({ success: false, message: 'Failed to fetch questions.' });
        }
    });

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
            users[socket.id] = { username, score: 0, roomId }; // Simpan roomId di user
            socket.join(roomId);
            callback({ success: true, questions: rooms[roomId].questions });
            updateRoomInfo(roomId);
            io.to(roomId).emit('userJoined', username);
        } else {
            callback({ success: false, message: 'Room not found.' });
        }
    });



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
            rooms[user.roomId].users[socket.id].score += 10;
            users[socket.id].score += 10;
            callback({ success: true, correct: true, score: users[socket.id].score });
        } else {
             callback({ success: true, correct: false, score: users[socket.id].score });
        }
    });

    socket.on('restartGame', async () => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;

        const room = rooms[user.roomId];
        const hostSocketId = Object.keys(room.users)[0];
        if (socket.id !== hostSocketId) return;  //Cek hanya host yang bisa restart.

        const newQuestions = await fetchQuestions(10, user.roomId); // Pass roomId
        if (newQuestions.length === 0) {
          io.to(user.roomId).emit('error', 'Failed to fetch questions for restart.');
          return;
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 60;

        // Reset skor
        for (const userId in room.users) {
            room.users[userId].score = 0;
             users[userId].score = 0;
        }

        clearTimeout(room.timer); // Hentikan timer sebelumnya
        startTimer(user.roomId);
        updateRoomInfo(user.roomId);
        io.to(user.roomId).emit('gameRestarted', room.questions[0]);
    });


     socket.on('logout', () => {
        const username = sessions[socket.id];  //Dapatkan username
        delete sessions[socket.id];
        emitRoomList(); //Perbarui room list
        if(username){ //Emit userLoggedOut (jika user sudah login)
            io.emit("userLoggedOut", username); //Beri tahu semua client ada user yang logout
        }

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

                // Jika room kosong, hapus room
                if (Object.keys(rooms[roomId].users).length === 0) {
                    delete rooms[roomId];
                     delete triviaApiTokens[roomId]; // Hapus token API
                } else {
                    //JIka host disconnect
                     if (Object.keys(rooms[roomId].users)[0] === socket.id) {
                         clearTimeout(rooms[roomId].timer);
                     }
                    updateRoomInfo(roomId);
                }
                emitRoomList(); // Update daftar room (penting)
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
                totalUsers: userList.length, // Jumlah user
                currentQuestionIndex: rooms[roomId].questionIndex + 1, // Index pertanyaan saat ini
                totalQuestions: rooms[roomId].questions.length, // Total pertanyaan
                timeLeft: rooms[roomId].timeLeft,  //Sisa waktu.
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

        rooms[roomId].timeLeft = 60; // Reset timer
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
            // Pindah ke pertanyaan berikutnya
            rooms[roomId].questionIndex++;
            io.to(roomId).emit('nextQuestion', rooms[roomId].questions[rooms[roomId].questionIndex]);
            startTimer(roomId); // Mulai timer lagi
        } else {
            // Game selesai
            io.to(roomId).emit('gameOver', getRoomScores(roomId));
        }
    }

    // --- Fungsi untuk mengirim daftar room ke semua klien ---
    function emitRoomList() {
        const roomList = Object.keys(rooms).map(roomId => ({
            id: roomId,
            name: rooms[roomId].roomName,
            host: Object.values(rooms[roomId].users)[0].username, // Ambil username host
            numPlayers: Object.keys(rooms[roomId].users).length,
        }));
        io.emit('roomList', roomList); // Kirim ke *semua* klien
    }

});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
