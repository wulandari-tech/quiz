const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');
const fs = require('fs');
const { Translate } = require('@google-cloud/translate').v2; // Import library

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

// Konfigurasi Google Cloud Translation (GANTI DENGAN KREDENSIAL ANDA)
const projectId = 'symbolic-math-454622-q7'; // Ganti dengan project ID Anda
const translate = new Translate({ projectId });


// Fungsi bantu untuk membaca dan menulis file
function loadData(filename) {
    try {
        if (fs.existsSync(filename)) {
            const data = fs.readFileSync(filename, 'utf8');
            return JSON.parse(data);
        } else {
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

let users = loadData(USERS_FILE);
let rooms = loadData(ROOMS_FILE);

function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Fungsi untuk fetch dan menerjemahkan pertanyaan
async function fetchQuestions(amount = 10, category = null, difficulty = null, type = null) {
    let url = `https://opentdb.com/api.php?amount=${amount}`;
    if (category) url += `&category=${category}`;
    if (difficulty) url += `&difficulty=${difficulty}`;
    if (type) url += `&type=${type}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.response_code === 0) {
            // Terjemahkan pertanyaan dan jawaban di server
            const translatedResults = await Promise.all(data.results.map(async item => {
                const [translatedQuestion] = await translate.translate(item.question, 'id');
                const [translatedCorrectAnswer] = await translate.translate(item.correct_answer, 'id');
                const translatedIncorrectAnswers = await Promise.all(
                    item.incorrect_answers.map(async ans => {
                        const [translatedAns] = await translate.translate(ans, 'id');
                        return translatedAns;
                    })
                );

                return {
                    question: translatedQuestion,
                    correct_answer: translatedCorrectAnswer,
                    incorrect_answers: translatedIncorrectAnswers
                };
            }));

            return translatedResults.map(item => {
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
        console.error("Error fetching/translating questions:", error);
        return [];
    }
}

// ... (sisa kode server.js, sama seperti sebelumnya, kecuali fetchQuestions)

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

function getLeaderboard() {
    return Object.values(users)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(user => ({
            username: user.username,
            score: user.score,
            profilePic: user.profilePic || 'default-avatar.png'
        }));
}

function sendLeaderboard() {
    io.emit('leaderboardUpdate', getLeaderboard());
}

function updateRoomInfo(roomId) {
    if (rooms[roomId]) {
        const userList = Object.values(rooms[roomId].users).map(user => ({
            username: user.username,
            score: user.score,
            profilePic: user.profilePic || 'default-avatar.png'
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

function startTimer(roomId) {
    if (!rooms[roomId]) return;

    rooms[roomId].timeLeft = 30;
    updateRoomInfo(roomId);

    if (rooms[roomId].timer) {
        clearInterval(rooms[roomId].timer);
    }

    rooms[roomId].timer = setInterval(() => {
        if (!rooms[roomId]) {
          clearInterval(rooms[roomId].timer);
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
        startTimer(roomId);
    } else {
      const scores = Object.values(room.users).map(user => ({
            username: user.username,
            score: user.score
        }));
        io.to(roomId).emit('gameOver', scores);
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    sendLeaderboard();

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
            users[socket.id].score += 10;
             callback({ success: true, correct: true, score: users[socket.id].score });
        } else {
            callback({ success: true, correct: false, score: users[socket.id].score });
        }
          saveData(USERS_FILE, users);
          saveData(ROOMS_FILE, rooms);
         sendLeaderboard();
    });

    socket.on('restartGame', async () => {
        const user = users[socket.id];
        if (!user || !rooms[user.roomId]) return;
        const room = rooms[user.roomId];

        const newQuestions = await fetchQuestions(10, 9, "easy");
        if (newQuestions.length === 0) {
            io.to(user.roomId).emit('error', 'Failed to fetch questions for restart.');
            return;
        }

        room.questionIndex = 0;
        room.questions = newQuestions;
        room.timeLeft = 30;

        for (let userId in room.users) {
            room.users[userId].score = 0;
        }

        saveData(ROOMS_FILE, rooms);


        clearTimeout(room.timer);
        startTimer(user.roomId);
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

    socket.on('leaveRoom', () => {
        handleLeaveRoom(socket);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handleLeaveRoom(socket);
    });

    function handleLeaveRoom(socket) {
        const user = users[socket.id];
        if (user) {
            const roomId = user.roomId;
            if (rooms[roomId]) {
                delete rooms[roomId].users[socket.id];

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
