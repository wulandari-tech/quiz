const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const cheerio = require('cheerio'); // Tambahkan cheerio

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


// GANTI FUNGSI fetchQuestions dengan ini:
async function fetchQuestionsFromIDNTimes(url) { // URL kuis IDN Times HARUS diberikan
    try {
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);

        const questions = [];

        // CONTOH untuk SATU JENIS KUIS di IDN Times.
        // Ini HARUS disesuaikan tergantung struktur HTML kuis yang Anda pilih.
        $('.quiz-item').each((index, element) => { //Mungkin class ini tidak ada.
            const questionText = $(element).find('.quiz-question-text').text().trim(); // Sesuaikan selector
            const answers = [];
            $(element).find('.quiz-answer').each((i, el) => {  // Sesuaikan selector
                answers.push($(el).text().trim());
            });


            if (questionText && answers.length > 0) {
                questions.push({
                    question: questionText,
                    answers: answers,
                    correct: null, // Kita TIDAK TAHU jawaban benarnya!
                });
            }
        });
        return questions;
    } catch (error) {
        console.error("Error scraping IDN Times:", error);
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
        // GANTI pemanggilan fetchQuestions:
        const idnTimesQuizUrl = 'https://www.idntimes.com/quiz/trivia/kuis-tebak-gambar-bendera-negara-asean-c2t1'; // GANTI dengan URL kuis IDN Times yang *spesifik*
        const questions = await fetchQuestionsFromIDNTimes(idnTimesQuizUrl);

        if (questions.length > 0) {
            rooms[roomId] = {
                users: { [socket.id]: { username, score: 0 } },
                questionIndex: 0,
                questions: questions,
                roomName: roomName || `Room ${roomId}`,
                timer: null,
                timeLeft: 60,
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
         // ... (kode joinRoom tidak berubah)
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
        //Karena kita tidak tahu jawaban yang benar, kita beri nilai 0 saja.
        callback({ success: true, correct: false, score: users[socket.id].score });
        // Jangan pindah ke pertanyaan berikutnya di sini; biarkan timer yang menangani
    });
    socket.on('restartGame', async () => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;
        const room = rooms[user.roomId];

        const hostSocketId = Object.keys(room.users)[0];
        if (socket.id !== hostSocketId) return;
        const idnTimesQuizUrl = 'https://www.idntimes.com/quiz/trivia/kuis-tebak-gambar-bendera-negara-asean-c2t1'; //GANTI URL

        const newQuestions = await fetchQuestionsFromIDNTimes(idnTimesQuizUrl); // Sesuaikan
        if (newQuestions.length === 0) {
          io.to(user.roomId).emit('error', 'Failed to fetch questions for restart.');
          return;
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 60; // Reset timer

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

        rooms[roomId].timeLeft = 60;
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
