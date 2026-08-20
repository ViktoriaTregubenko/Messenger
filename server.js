// ================================================================
//                     СЕРВЕР МЕССЕНДЖЕРА VICTORY
// ================================================================
//  Технологии: Node.js + Express + Socket.IO + MS SQL
//  Безопасность: JWT, bcrypt, шифрование (RSA/AES), Helmet, Rate Limiting
// ================================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const sql = require('mssql');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 1. СОЗДАНИЕ ПРИЛОЖЕНИЯ И HTTP-СЕРВЕРА
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// 2. БЕЗОПАСНОСТЬ (Helmet, CORS, лимиты запросов)
// Helmet защищает от распространённых веб-уязвимостей (XSS, кликджекинг и т.д.)
app.use(helmet({
    contentSecurityPolicy: false, // упрощаем для разработки
}));
app.use(cors()); // разрешаем кросс-доменные запросы (на продакшене ограничить)
app.use(express.json({ limit: '10mb' })); // парсим JSON-тело, ограничиваем размер

// Логирование всех запросов (для отладки)
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.url}`);
    next();
});

// Rate Limiting – защита от брутфорса и DDoS
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    message: 'Слишком много запросов, попробуйте позже'
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 минута
    max: 100 // 100 запросов в минуту
});
app.use('/api/', generalLimiter);

// 3. АУТЕНТИФИКАЦИЯ (JWT)
const JWT_SECRET = process.env.JWT_SECRET || 'Admin123';
const JWT_EXPIRES_IN = '7d'; // токен живёт 7 дней

// Хранилище онлайн-пользователей (userId -> socketId)
const onlineUsers = new Map();

// 4. ШИФРОВАНИЕ СООБЩЕНИЙ В КОМНАТАХ (серверное AES-256-GCM)
// Для групповых чатов используется симметричное шифрование на сервере,
// т.к. все участники должны иметь доступ к расшифрованному тексту.
// Ключ хранится в переменной окружения.
const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    console.error('❌ ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    process.exit(1);
}
const KEY = Buffer.from(ENCRYPTION_KEY, 'hex');

// Функция шифрования: возвращает iv:authTag:ciphertext (в hex)
function serverEncrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

// Функция расшифровки
function serverDecrypt(ciphertext) {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// 5. MIDDLEWARE АУТЕНТИФИКАЦИИ (проверка JWT)
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Неверный токен' });
        req.user = user; // добавляем пользователя в запрос
        next();
    });
};

// 6. МАРШРУТЫ API

// 6.1. Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, full_name } = req.body;
        // Проверяем, не заняты ли username/email
        const existing = await db.getMany(
            'SELECT id FROM users WHERE username = @username OR email = @email',
            { username, email }
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        // Хешируем пароль bcrypt (соль + 10 раундов)
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = await db.insertAndGetId(
            `INSERT INTO users (username, email, password_hash, full_name, status) 
             VALUES (@username, @email, @password, @full_name, 'online')`,
            { username, email, password: hashedPassword, full_name }
        );
        // Получаем созданного пользователя
        const newUser = await db.getOne(
            `SELECT id, username, email, full_name, bio, avatar, status, created_at 
             FROM users WHERE id = @id`,
            { id: userId }
        );
        // Генерируем JWT
        const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ 
            token, 
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                full_name: newUser.full_name || '',
                bio: newUser.bio || '',
                avatar: newUser.avatar || '',
                status: newUser.status || 'online'
            } 
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6.2. Логин
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // Ищем пользователя по username или email
        const user = await db.getOne(
            'SELECT * FROM users WHERE username = @username OR email = @username',
            { username }
        );
        if (!user) {
            return res.status(401).json({ error: 'Неверные учётные данные' });
        }
        // Сравниваем хеш пароля
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверные учётные данные' });
        }
        // Обновляем статус на "онлайн"
        await db.execute(
            'UPDATE users SET status = @status WHERE id = @id',
            { status: 'online', id: user.id }
        );
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                bio: user.bio,
                avatar: user.avatar,
                birth_date: user.birth_date,
                city: user.city,
                status: 'online'
            }
        });
    } catch (error) {
        console.error('Ошибка логина:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6.3. Профиль пользователя
// GET – получение данных профиля
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = await db.getOne(
            'SELECT id, username, email, full_name, bio, avatar, status, birth_date, city, created_at FROM users WHERE id = @id',
            { id: req.user.id }
        );
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT – обновление профиля (поля: full_name, bio, avatar, email, status, birth_date, city, password)
app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const { full_name, bio, avatar, email, status, birth_date, city, password } = req.body;
        let updates = [];
        let params = { id: req.user.id };
        if (full_name !== undefined) { updates.push('full_name = @full_name'); params.full_name = full_name || null; }
        if (bio !== undefined) { updates.push('bio = @bio'); params.bio = bio || null; }
        if (avatar !== undefined) { updates.push('avatar = @avatar'); params.avatar = avatar || null; }
        if (email !== undefined) {
            if (email && email.trim() === '') return res.status(400).json({ error: 'Email не может быть пустым' });
            updates.push('email = @email'); params.email = email;
        }
        if (status !== undefined) { updates.push('status = @status'); params.status = status || 'online'; }
        if (birth_date !== undefined) { updates.push('birth_date = @birth_date'); params.birth_date = birth_date || null; }
        if (city !== undefined) { updates.push('city = @city'); params.city = city || null; }
        // Если передан новый пароль – хешируем и обновляем
        if (password && password.length > 0) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updates.push('password_hash = @password');
            params.password = hashedPassword;
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'Нет полей для обновления' });
        }
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = @id`;
        await db.execute(query, params);
        res.json({ message: 'Профиль обновлён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE – удаление аккаунта (каскадное удаление связанных данных)
app.delete('/api/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const pool = await db.getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // Удаляем реакции на сообщения пользователя
            await transaction.request().query(`
                DELETE FROM message_reactions
                WHERE message_id IN (
                    SELECT id FROM messages WHERE from_user_id = ${userId} OR to_user_id = ${userId}
                )
            `);
            // Удаляем все сообщения пользователя
            await transaction.request().query(`
                DELETE FROM messages
                WHERE from_user_id = ${userId} OR to_user_id = ${userId}
            `);
            // Удаляем из комнат
            await transaction.request().query(`
                DELETE FROM room_members WHERE user_id = ${userId}
            `);
            // Удаляем дружеские связи
            await transaction.request().query(`
                DELETE FROM friends WHERE user_id = ${userId} OR friend_id = ${userId}
            `);
            // Удаляем ключи шифрования
            await transaction.request().query(`
                DELETE FROM user_keys WHERE user_id = ${userId}
            `);
            // Удаляем самого пользователя
            const result = await transaction.request().query(`
                DELETE FROM users WHERE id = ${userId}
            `);

            await transaction.commit();

            if (result.rowsAffected[0] === 0) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            res.json({ message: 'Аккаунт успешно удалён' });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (error) {
        console.error('Ошибка удаления аккаунта:', error);
        res.status(500).json({ error: error.message || 'Внутренняя ошибка сервера' });
    }
});

// 6.4. Друзья
// GET – список друзей (только принятые)
app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const friends = await db.getMany(`
            SELECT u.id, u.username, u.full_name, u.email, u.status, u.avatar, u.bio,
                   f.status as friendship_status
            FROM friends f
            JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
            WHERE (f.user_id = @user_id OR f.friend_id = @user_id) 
              AND u.id != @user_id
              AND f.status = 'accepted'
        `, { user_id: req.user.id });
        res.json(friends);
    } catch (error) {
        console.error('Ошибка загрузки друзей:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST – отправить заявку в друзья (с уведомлением через WebSocket)
app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const { friend_username } = req.body;
        const friend = await db.getOne('SELECT id FROM users WHERE username = @username', { username: friend_username });
        if (!friend) return res.status(404).json({ error: 'Пользователь не найден' });
        if (friend.id === req.user.id) return res.status(400).json({ error: 'Нельзя добавить себя в друзья' });
        const existing = await db.getOne(
            `SELECT * FROM friends WHERE (user_id = @user1 AND friend_id = @user2) 
             OR (user_id = @user2 AND friend_id = @user1)`,
            { user1: req.user.id, user2: friend.id }
        );
        if (existing) return res.status(400).json({ error: 'Заявка уже существует или вы уже друзья' });
        await db.execute(
            `INSERT INTO friends (user_id, friend_id, status) VALUES (@user_id, @friend_id, 'pending')`,
            { user_id: req.user.id, friend_id: friend.id }
        );
        // Отправляем уведомление получателю, если он онлайн
        const targetSocketId = onlineUsers.get(friend.id);
        if (targetSocketId) {
            io.to(targetSocketId).emit('friend_request_received', {
                from_user_id: req.user.id,
                username: req.user.username
            });
        }
        res.json({ message: 'Заявка отправлена' });
    } catch (error) {
        console.error('Ошибка отправки заявки:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST – принять заявку
app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    try {
        const { friend_id } = req.body;
        await db.execute(
            `UPDATE friends SET status = 'accepted' 
             WHERE user_id = @friend_id AND friend_id = @user_id AND status = 'pending'`,
            { friend_id, user_id: req.user.id }
        );
        res.json({ message: 'Заявка принята' });
    } catch (error) {
        console.error('Ошибка принятия заявки:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST – отклонить заявку
app.post('/api/friends/reject', authenticateToken, async (req, res) => {
    try {
        const { friend_id } = req.body;
        await db.execute(
            `DELETE FROM friends WHERE user_id = @friend_id AND friend_id = @user_id AND status = 'pending'`,
            { friend_id, user_id: req.user.id }
        );
        res.json({ message: 'Заявка отклонена' });
    } catch (error) {
        console.error('Ошибка отклонения заявки:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET – список входящих заявок
app.get('/api/friends/pending', authenticateToken, async (req, res) => {
    try {
        const requests = await db.getMany(`
            SELECT u.id, u.username, u.full_name, u.email, u.avatar
            FROM friends f
            JOIN users u ON f.user_id = u.id
            WHERE f.friend_id = @user_id AND f.status = 'pending'
        `, { user_id: req.user.id });
        res.json(requests);
    } catch (error) {
        console.error('Ошибка загрузки заявок:', error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE – удалить друга
app.delete('/api/friends/:friendId', authenticateToken, async (req, res) => {
    try {
        await db.execute(
            `DELETE FROM friends WHERE (user_id = @user_id AND friend_id = @friend_id) 
             OR (user_id = @friend_id AND friend_id = @user_id)`,
            { user_id: req.user.id, friend_id: req.params.friendId }
        );
        res.json({ message: 'Друг удалён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.5. Поиск (пользователей, комнат)
// Поиск пользователей (с исключением уже состоящих в комнате, если передан room_id)
app.get('/api/users/search', authenticateToken, async (req, res) => {
    try {
        const { q, room_id } = req.query;
        if (!q || q.length < 2) return res.json([]);
        let sqlQuery = `
            SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.status
            FROM users u
            WHERE u.id != @user_id 
              AND (u.username LIKE @q OR u.full_name LIKE @q OR u.email LIKE @q)
        `;
        let params = { user_id: req.user.id, q: `%${q}%` };
        if (room_id) {
            sqlQuery += ` AND u.id NOT IN (SELECT user_id FROM room_members WHERE room_id = @room_id)`;
            params.room_id = room_id;
        }
        sqlQuery += ` ORDER BY u.username OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY`;
        const users = await db.getMany(sqlQuery, params);
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Поиск комнат
app.get('/api/rooms/search', authenticateToken, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);
        const rooms = await db.getMany(`
            SELECT r.*, 
                   (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as members_count
            FROM rooms r
            WHERE r.name LIKE @q OR r.description LIKE @q
            ORDER BY r.name
            OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY
        `, { q: `%${q}%` });
        res.json(rooms);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.6. Профиль другого пользователя
app.get('/api/users/:userId', authenticateToken, async (req, res) => {
    try {
        const user = await db.getOne(
            'SELECT id, username, email, full_name, bio, avatar, status, birth_date, city, created_at FROM users WHERE id = @id',
            { id: req.params.userId }
        );
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6.7. Комнаты (групповые чаты)
// Создание комнаты
app.post('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const { name, description } = req.body;
        const roomId = await db.insertAndGetId(
            'INSERT INTO rooms (name, description, created_by) VALUES (@name, @description, @created_by)',
            { name, description, created_by: req.user.id }
        );
        // Создатель автоматически становится участником
        await db.execute(
            'INSERT INTO room_members (room_id, user_id) VALUES (@room_id, @user_id)',
            { room_id: roomId, user_id: req.user.id }
        );
        res.json({ id: roomId, name, description });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Получение списка комнат пользователя
app.get('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const rooms = await db.getMany(`
            SELECT r.*, 
                    (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as members_count
             FROM rooms r
             JOIN room_members rm ON r.id = rm.room_id
             WHERE rm.user_id = @user_id
        `, { user_id: req.user.id });
        res.json(rooms);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Получение информации о комнате
app.get('/api/rooms/:roomId', authenticateToken, async (req, res) => {
    try {
        const room = await db.getOne('SELECT * FROM rooms WHERE id = @id', { id: req.params.roomId });
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        res.json(room);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.8. Управление участниками комнаты
// Добавление участника (только для существующих членов)
app.post('/api/rooms/:roomId/members', authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { username_or_email } = req.body;
        // Проверяем, что текущий пользователь состоит в комнате
        const myMembership = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = @room_id AND user_id = @user_id',
            { room_id: roomId, user_id: req.user.id }
        );
        if (!myMembership) return res.status(403).json({ error: 'Вы не состоите в этой комнате' });
        const user = await db.getOne(
            'SELECT id, username, full_name, email FROM users WHERE username = @username OR email = @email',
            { username: username_or_email, email: username_or_email }
        );
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        const existing = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = @room_id AND user_id = @user_id',
            { room_id: roomId, user_id: user.id }
        );
        if (existing) return res.status(400).json({ error: 'Пользователь уже в комнате' });
        await db.execute(
            'INSERT INTO room_members (room_id, user_id) VALUES (@room_id, @user_id)',
            { room_id: roomId, user_id: user.id }
        );
        // Уведомление через WebSocket
        io.to(`room_${roomId}`).emit('member_added', {
            room_id: parseInt(roomId),
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name
            }
        });
        res.json({ message: 'Участник добавлен', user: { id: user.id, username: user.username } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Удаление участника (только создатель или сам пользователь)
app.delete('/api/rooms/:roomId/members/:userId', authenticateToken, async (req, res) => {
    try {
        const { roomId, userId } = req.params;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = @id', { id: roomId });
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        const isRoomCreator = room.created_by === req.user.id;
        const isSelf = parseInt(req.user.id) === parseInt(userId);
        if (!isRoomCreator && !isSelf) {
            return res.status(403).json({ error: 'Нет прав: только создатель может удалять участников, либо пользователь может выйти сам' });
        }
        if (isSelf && isRoomCreator) {
            return res.status(400).json({ error: 'Создатель не может удалить себя из комнаты' });
        }
        await db.execute(
            'DELETE FROM room_members WHERE room_id = @room_id AND user_id = @user_id',
            { room_id: roomId, user_id: userId }
        );
        io.to(`room_${roomId}`).emit('member_removed', {
            room_id: parseInt(roomId),
            user_id: parseInt(userId)
        });
        res.json({ message: 'Участник удалён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.9. Сообщения
// Получение сообщений комнаты (с расшифровкой)
app.get('/api/messages/room/:roomId', authenticateToken, async (req, res) => {
    try {
        const messages = await db.getMany(`
            SELECT TOP 100 m.*, u.username, u.full_name, u.avatar
             FROM messages m
             JOIN users u ON m.from_user_id = u.id
             WHERE m.to_room_id = @room_id AND m.deleted_at IS NULL
             ORDER BY m.created_at ASC
        `, { room_id: req.params.roomId });
        // Расшифровываем сообщения комнаты (is_encrypted = 2)
        const decrypted = messages.map(msg => {
            const looksEncrypted = msg.is_encrypted === 2 ||
                (msg.message && /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/.test(msg.message));
            if (looksEncrypted && msg.message) {
                try {
                    msg.message = serverDecrypt(msg.message);
                } catch (e) {
                    console.error('Ошибка расшифровки сообщения комнаты:', e);
                }
            }
            return msg;
        });
        res.json(decrypted);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Получение личных сообщений (без расшифровки — она на клиенте)
app.get('/api/messages/user/:userId', authenticateToken, async (req, res) => {
    try {
        const messages = await db.getMany(`
            SELECT TOP 100 m.*, u.username, u.full_name, u.avatar
             FROM messages m
             JOIN users u ON m.from_user_id = u.id
             WHERE ((m.to_user_id = @user1 AND m.from_user_id = @user2)
                OR (m.to_user_id = @user2 AND m.from_user_id = @user1))
                AND m.deleted_at IS NULL
             ORDER BY m.created_at ASC
        `, { user1: req.user.id, user2: req.params.userId });
        res.json(messages);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Пометить личные сообщения от собеседника как прочитанные
app.put('/api/messages/user/:userId/read', authenticateToken, async (req, res) => {
    try {
        await db.execute(
            `UPDATE messages SET is_read = 1
             WHERE from_user_id = @friend_id AND to_user_id = @user_id
               AND is_read = 0 AND deleted_at IS NULL`,
            { friend_id: req.params.userId, user_id: req.user.id }
        );
        // Уведомляем отправителя, что сообщения прочитаны
        const senderSocketId = onlineUsers.get(parseInt(req.params.userId));
        if (senderSocketId) {
            io.to(senderSocketId).emit('messages_read', {
                by_user_id: req.user.id,
                from_user_id: parseInt(req.params.userId)
            });
        }
        res.json({ message: 'Сообщения отмечены как прочитанные' });
    } catch (error) {
        console.error('Ошибка отметки сообщений:', error);
        res.status(500).json({ error: error.message });
    }
});

// Получить количество непрочитанных по каждому собеседнику
app.get('/api/messages/unread', authenticateToken, async (req, res) => {
    try {
        const rows = await db.getMany(`
            SELECT from_user_id AS user_id, COUNT(*) AS unread_count
            FROM messages
            WHERE to_user_id = @user_id AND is_read = 0 AND deleted_at IS NULL
            GROUP BY from_user_id
        `, { user_id: req.user.id });
        const result = {};
        rows.forEach(r => { result[r.user_id] = r.unread_count; });
        res.json(result);
    } catch (error) {
        console.error('Ошибка подсчёта непрочитанных:', error);
        res.status(500).json({ error: error.message });
    }
});

// Редактирование сообщения (только автор)
app.put('/api/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        let { message } = req.body;
        if (!message || message.trim() === '') {
            return res.status(400).json({ error: 'Сообщение не может быть пустым' });
        }
        const msg = await db.getOne('SELECT * FROM messages WHERE id = @id', { id: messageId });
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
        if (msg.from_user_id !== req.user.id) {
            return res.status(403).json({ error: 'Вы не можете редактировать это сообщение' });
        }
        if (msg.deleted_at) return res.status(400).json({ error: 'Сообщение удалено' });

        // Если это сообщение в комнате – шифруем заново
        if (msg.to_room_id) {
            message = serverEncrypt(message);
        }

        await db.execute(
            'UPDATE messages SET message = @message, edited_at = GETDATE() WHERE id = @id',
            { message, id: messageId }
        );

        const updated = await db.getOne('SELECT * FROM messages WHERE id = @id', { id: messageId });
        const sender = await db.getOne('SELECT username, full_name, avatar FROM users WHERE id = @id', { id: updated.from_user_id });

        const response = {
            id: updated.id,
            from_user_id: updated.from_user_id,
            username: sender.username,
            full_name: sender.full_name,
            avatar: sender.avatar,
            message: updated.message,
            created_at: updated.created_at,
            edited_at: updated.edited_at,
            to_room_id: updated.to_room_id,
            to_user_id: updated.to_user_id,
            is_encrypted: updated.is_encrypted
        };

        // Расшифровываем для отправки через сокет
        if (updated.to_room_id && updated.message) {
            try {
                response.message = serverDecrypt(updated.message);
            } catch (e) {}
        }

        // Оповещаем через WebSocket
        if (updated.to_room_id) {
            io.to(`room_${updated.to_room_id}`).emit('message_edited', response);
        } else if (updated.to_user_id) {
            const senderId = updated.from_user_id;
            const receiverId = updated.to_user_id;
            const senderSocket = onlineUsers.get(senderId);
            const receiverSocket = onlineUsers.get(receiverId);
            if (senderSocket) io.to(senderSocket).emit('message_edited', response);
            if (receiverSocket) io.to(receiverSocket).emit('message_edited', response);
        }

        res.json(response);
    } catch (error) {
        console.error('Ошибка редактирования сообщения:', error);
        res.status(500).json({ error: error.message });
    }
});

// Удаление сообщения (автор или администратор комнаты)
app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;
        const msg = await db.getOne('SELECT * FROM messages WHERE id = @id', { id: messageId });
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
        if (msg.deleted_at) return res.status(400).json({ error: 'Сообщение уже удалено' });

        let canDelete = false;
        if (msg.from_user_id === userId) canDelete = true;
        else if (msg.to_room_id) {
            const room = await db.getOne('SELECT created_by FROM rooms WHERE id = @id', { id: msg.to_room_id });
            if (room) {
                const member = await db.getOne(
                    'SELECT role FROM room_members WHERE room_id = @room_id AND user_id = @user_id',
                    { room_id: msg.to_room_id, user_id: userId }
                );
                if (member && (member.role === 'admin' || room.created_by === userId)) canDelete = true;
            }
        }
        if (!canDelete) return res.status(403).json({ error: 'Недостаточно прав для удаления сообщения' });

        await db.execute('UPDATE messages SET deleted_at = GETDATE() WHERE id = @id', { id: messageId });

        const deleteEvent = { id: messageId };
        if (msg.to_room_id) {
            io.to(`room_${msg.to_room_id}`).emit('message_deleted', deleteEvent);
        } else if (msg.to_user_id) {
            const senderId = msg.from_user_id;
            const receiverId = msg.to_user_id;
            const senderSocket = onlineUsers.get(senderId);
            const receiverSocket = onlineUsers.get(receiverId);
            if (senderSocket) io.to(senderSocket).emit('message_deleted', deleteEvent);
            if (receiverSocket) io.to(receiverSocket).emit('message_deleted', deleteEvent);
        }
        res.json({ message: 'Сообщение удалено' });
    } catch (error) {
        console.error('Ошибка удаления сообщения:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6.10. Реакции на сообщения (эмодзи)
// Получить реакции для сообщения
app.get('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
    try {
        const reactions = await db.getMany(
            'SELECT user_id, reaction FROM message_reactions WHERE message_id = @message_id',
            { message_id: req.params.messageId }
        );
        res.json(reactions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Добавить/изменить реакцию (если реакция уже есть – удаляем, либо обновляем)
app.post('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { reaction } = req.body;
        if (!reaction || reaction.length === 0) {
            return res.status(400).json({ error: 'Реакция не может быть пустой' });
        }
        const userId = req.user.id;

        const msg = await db.getOne('SELECT * FROM messages WHERE id = @id', { id: messageId });
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });

        const existing = await db.getOne(
            'SELECT * FROM message_reactions WHERE message_id = @message_id AND user_id = @user_id',
            { message_id: messageId, user_id: userId }
        );

        if (existing) {
            if (existing.reaction === reaction) {
                await db.execute(
                    'DELETE FROM message_reactions WHERE id = @id',
                    { id: existing.id }
                );
            } else {
                // Иначе обновляем
                await db.execute(
                    'UPDATE message_reactions SET reaction = @reaction, created_at = GETDATE() WHERE id = @id',
                    { reaction, id: existing.id }
                );
            }
        } else {
            // Новая реакция
            await db.execute(
                'INSERT INTO message_reactions (message_id, user_id, reaction) VALUES (@message_id, @user_id, @reaction)',
                { message_id: messageId, user_id: userId, reaction }
            );
        }

        // Обновлённый список реакций
        const updatedReactions = await db.getMany(
            'SELECT user_id, reaction FROM message_reactions WHERE message_id = @message_id',
            { message_id: messageId }
        );

        const reactionEvent = {
            messageId: parseInt(messageId),
            reactions: updatedReactions,
            userId: userId
        };

        // Оповещаем через WebSocket
        if (msg.to_room_id) {
            io.to(`room_${msg.to_room_id}`).emit('reaction_updated', reactionEvent);
        } else if (msg.to_user_id) {
            const senderId = msg.from_user_id;
            const receiverId = msg.to_user_id;
            [senderId, receiverId].forEach(id => {
                const socketId = onlineUsers.get(id);
                if (socketId) io.to(socketId).emit('reaction_updated', reactionEvent);
            });
        }

        res.json({ message: 'Реакция обновлена', reactions: updatedReactions });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Удалить свою реакцию
app.delete('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        const msg = await db.getOne('SELECT * FROM messages WHERE id = @id', { id: messageId });
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });

        await db.execute(
            'DELETE FROM message_reactions WHERE message_id = @message_id AND user_id = @user_id',
            { message_id: messageId, user_id: userId }
        );

        const updatedReactions = await db.getMany(
            'SELECT user_id, reaction FROM message_reactions WHERE message_id = @message_id',
            { message_id: messageId }
        );

        const reactionEvent = {
            messageId: parseInt(messageId),
            reactions: updatedReactions,
            userId: userId
        };

        if (msg.to_room_id) {
            io.to(`room_${msg.to_room_id}`).emit('reaction_updated', reactionEvent);
        } else if (msg.to_user_id) {
            const senderId = msg.from_user_id;
            const receiverId = msg.to_user_id;
            [senderId, receiverId].forEach(id => {
                const socketId = onlineUsers.get(id);
                if (socketId) io.to(socketId).emit('reaction_updated', reactionEvent);
            });
        }

        res.json({ message: 'Реакция удалена', reactions: updatedReactions });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Пакетное получение реакций для нескольких сообщений (оптимизация)
app.post('/api/reactions/batch', authenticateToken, async (req, res) => {
    try {
        const { messageIds } = req.body;
        if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.json({});
        }
        const placeholders = messageIds.map(() => '?').join(',');
        const reactions = await db.getMany(
            `SELECT message_id, user_id, reaction FROM message_reactions WHERE message_id IN (${placeholders})`,
            messageIds
        );
        const result = {};
        reactions.forEach(r => {
            if (!result[r.message_id]) result[r.message_id] = [];
            result[r.message_id].push({ user_id: r.user_id, reaction: r.reaction });
        });
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.11. Ключи шифрования (для личных сообщений RSA)
// Сохранение публичного ключа пользователя
app.post('/api/keys/public', authenticateToken, async (req, res) => {
    try {
        const { public_key } = req.body;
        await db.execute(
            `MERGE INTO user_keys AS target
             USING (SELECT @user_id AS user_id) AS source
             ON target.user_id = source.user_id
             WHEN MATCHED THEN UPDATE SET public_key = @public_key, key_created_at = GETDATE()
             WHEN NOT MATCHED THEN INSERT (user_id, public_key) VALUES (@user_id, @public_key);`,
            { user_id: req.user.id, public_key }
        );
        res.json({ message: 'Публичный ключ сохранён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Получение публичного ключа другого пользователя
app.get('/api/keys/public/:userId', authenticateToken, async (req, res) => {
    try {
        const key = await db.getOne(
            'SELECT public_key FROM user_keys WHERE user_id = @user_id',
            { user_id: req.params.userId }
        );
        if (!key) return res.status(404).json({ error: 'Публичный ключ не найден' });
        res.json({ public_key: key.public_key });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.12. Статус пользователя
app.put('/api/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        if (!status || !['online', 'offline', 'away'].includes(status)) {
            return res.status(400).json({ error: 'Недопустимый статус' });
        }
        await db.execute('UPDATE users SET status = @status WHERE id = @id', { status, id: req.user.id });
        res.json({ message: 'Статус обновлён' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6.13. Обновление аватара комнаты
app.put('/api/rooms/:roomId/avatar', authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { avatar } = req.body;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = @id', { id: roomId });
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        if (room.created_by !== req.user.id) return res.status(403).json({ error: 'Только создатель комнаты может менять аватар' });
        await db.execute('UPDATE rooms SET avatar = @avatar WHERE id = @id', { avatar: avatar || null, id: roomId });
        res.json({ message: 'Аватар комнаты обновлён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.14. Управление ролями в комнате
// Получить список участников с ролями
app.get('/api/rooms/:roomId/members', authenticateToken, async (req, res) => {
    try {
        const members = await db.getMany(`
            SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.status, rm.joined_at, rm.role
             FROM room_members rm
             JOIN users u ON rm.user_id = u.id
             WHERE rm.room_id = @room_id
             ORDER BY rm.role DESC, rm.joined_at ASC
        `, { room_id: req.params.roomId });
        res.json(members);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Назначить администратора (только создатель)
app.post('/api/rooms/:roomId/members/:userId/admin', authenticateToken, async (req, res) => {
    try {
        const { roomId, userId } = req.params;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = @id', { id: roomId });
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        if (room.created_by !== req.user.id) return res.status(403).json({ error: 'Только создатель комнаты может назначать администраторов' });
        const member = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = @room_id AND user_id = @user_id',
            { room_id: roomId, user_id: userId }
        );
        if (!member) return res.status(404).json({ error: 'Пользователь не состоит в комнате' });
        await db.execute(
            'UPDATE room_members SET role = @role WHERE room_id = @room_id AND user_id = @user_id',
            { role: 'admin', room_id: roomId, user_id: userId }
        );
        io.to(`room_${roomId}`).emit('member_role_changed', {
            room_id: parseInt(roomId),
            user_id: parseInt(userId),
            role: 'admin'
        });
        res.json({ message: 'Администратор назначен' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Понизить администратора (только создатель)
app.delete('/api/rooms/:roomId/members/:userId/admin', authenticateToken, async (req, res) => {
    try {
        const { roomId, userId } = req.params;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = @id', { id: roomId });
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        if (room.created_by !== req.user.id) return res.status(403).json({ error: 'Только создатель комнаты может управлять администраторами' });
        if (parseInt(userId) === room.created_by) return res.status(400).json({ error: 'Нельзя изменить роль создателя комнаты' });
        const member = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = @room_id AND user_id = @user_id',
            { room_id: roomId, user_id: userId }
        );
        if (!member) return res.status(404).json({ error: 'Пользователь не состоит в комнате' });
        await db.execute(
            'UPDATE room_members SET role = @role WHERE room_id = @room_id AND user_id = @user_id',
            { role: 'member', room_id: roomId, user_id: userId }
        );
        io.to(`room_${roomId}`).emit('member_role_changed', {
            room_id: parseInt(roomId),
            user_id: parseInt(userId),
            role: 'member'
        });
        res.json({ message: 'Администратор понижен до участника' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 6.15. Загрузка файлов (multer)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 МБ
    fileFilter: function (req, file, cb) {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'video/mp4', 'video/webm', 'video/ogg', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
        if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Неподдерживаемый тип файла'), false);
        }
    }
});

app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        const fileUrl = `/uploads/${req.file.filename}`;
        const fileType = req.file.mimetype.split('/')[0];
        const fileName = req.file.originalname;
        res.json({ fileUrl, fileType, fileName });
    } catch (error) {
        console.error('Ошибка загрузки файла:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. WEBSOCKET (реальное время)
// Аутентификация через JWT при подключении
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return next(new Error('Authentication error'));
        socket.user = user;
        next();
    });
});

io.on('connection', (socket) => {
    const userId = socket.user.id;
    onlineUsers.set(userId, socket.id); // запоминаем сокет пользователя

    // Обновляем статус в БД и оповещаем всех
    db.execute('UPDATE users SET status = @status WHERE id = @id', { status: 'online', id: userId })
        .catch(err => console.error('Ошибка обновления статуса:', err));
    socket.broadcast.emit('user_status', { userId, status: 'online' });

    // Подписываем пользователя на все комнаты, в которых он состоит
    db.getMany('SELECT room_id FROM room_members WHERE user_id = @user_id', { user_id: userId })
        .then(rooms => rooms.forEach(room => socket.join(`room_${room.room_id}`)))
        .catch(err => console.error('Ошибка загрузки комнат:', err));

    // Обработчик входа в комнату (клиент может явно присоединиться)
    socket.on('join_room', (data) => {
        socket.join(`room_${data.room_id}`);
    });

    // 7.1. Отправка сообщения в комнату
    socket.on('send_message', async (data) => {
    try {
        const { to_room_id, to_user_id, message, file_url, file_type, file_name, localId } = data;
        if (!message && !file_url) return;

        let finalMessage = message || '';
        let isEncrypted = 0;

        if (to_room_id) {
            // Для комнат шифруем на сервере
            if (finalMessage.trim() !== '') {
                finalMessage = serverEncrypt(finalMessage);
                isEncrypted = 2;
            } else {
                finalMessage = '';
                isEncrypted = 0;
            }
        } else if (to_user_id) {
            isEncrypted = 1;
        }

        const result = await db.query(
            `INSERT INTO messages (from_user_id, to_room_id, to_user_id, message, is_encrypted, file_url, file_type, file_name)
             VALUES (@from_user_id, @to_room_id, @to_user_id, @message, @is_encrypted, @file_url, @file_type, @file_name);
             SELECT SCOPE_IDENTITY() AS id;`,
            {
                from_user_id: userId,
                to_room_id: to_room_id || null,
                to_user_id: to_user_id || null,
                message: finalMessage,
                is_encrypted: isEncrypted,
                file_url: file_url || null,
                file_type: file_type || null,
                file_name: file_name || null
            }
        );
        const realId = result.recordset[0].id;

        // Подтверждение отправителю
        if (localId) {
            socket.emit('message_confirmed', { localId, realId });
        }

        const sender = await db.getOne('SELECT username, full_name, avatar FROM users WHERE id = @id', { id: userId });

        let messageData = {
            id: realId,
            from_user_id: userId,
            username: sender?.username || socket.user.username,
            full_name: sender?.full_name || '',
            avatar: sender?.avatar || null,
            message: message || '', // оригинальное (незашифрованное) для отправки клиентам
            created_at: new Date().toISOString(),
            is_encrypted: isEncrypted,
            file_url: file_url || null,
            file_type: file_type || null,
            file_name: file_name || null,
            edited_at: null,
            deleted_at: null
        };

        if (to_room_id) {
            // Расшифровываем для отправки всем участникам
            if (isEncrypted === 2) {
                try {
                    messageData.message = serverDecrypt(finalMessage);
                } catch (e) {
                    messageData.message = '[Ошибка расшифровки]';
                }
            }
            messageData.to_room_id = parseInt(to_room_id);
            io.to(`room_${to_room_id}`).emit('new_message', messageData);
        } else if (to_user_id) {
            // Личные сообщения – отправляем всем сокетам получателя
            const targetSocketIds = [...onlineUsers.entries()]
                .filter(([userId]) => userId === to_user_id)
                .map(([, socketId]) => socketId);

            targetSocketIds.forEach(socketId => {
                io.to(socketId).emit('private_message_encrypted', messageData);
            });
        }
    } catch (error) {
        console.error('Ошибка отправки сообщения:', error);
    }
});
    // 7.2. Отправка зашифрованного личного сообщения (клиент уже зашифровал)
    socket.on('send_encrypted_message', async (data) => {
    try {
        const { to_user_id, encrypted_message, file_url, file_type, file_name, localId } = data;
        if (!to_user_id) return;

        const result = await db.query(
            `INSERT INTO messages (from_user_id, to_user_id, message, is_encrypted, file_url, file_type, file_name)
             VALUES (@from_user_id, @to_user_id, @message, 1, @file_url, @file_type, @file_name);
             SELECT SCOPE_IDENTITY() AS id;`,
            {
                from_user_id: userId,
                to_user_id: to_user_id,
                message: encrypted_message || '',
                file_url: file_url || null,
                file_type: file_type || null,
                file_name: file_name || null
            }
        );
        const realId = result.recordset[0].id;

        // Подтверждение отправителю (чтобы обновить локальный ID)
        if (localId) {
            socket.emit('message_confirmed', { localId, realId });
        }

        const sender = await db.getOne('SELECT username, full_name, avatar FROM users WHERE id = @id', { id: userId });

        const messageData = {
            id: realId,
            from_user_id: userId,
            username: sender?.username || socket.user.username,
            full_name: sender?.full_name || '',
            avatar: sender?.avatar || null,
            message: encrypted_message || '',
            is_encrypted: 1,
            created_at: new Date().toISOString(),
            file_url: file_url || null,
            file_type: file_type || null,
            file_name: file_name || null,
            edited_at: null,
            deleted_at: null,
            to_user_id: to_user_id
        };

        // Отправляем всем сокетам получателя (все вкладки)
        const targetSocketIds = [...onlineUsers.entries()]
            .filter(([userId]) => userId === to_user_id)
            .map(([, socketId]) => socketId);

        targetSocketIds.forEach(socketId => {
            io.to(socketId).emit('private_message_encrypted', messageData);
        });

    } catch (error) {
        console.error('Ошибка отправки зашифрованного сообщения:', error);
    }
});

    // 7.3. Печатает (typing indicator)
    socket.on('typing', (data) => {
        const { to_room_id, to_user_id, is_typing } = data;
        if (to_room_id) {
            socket.to(`room_${to_room_id}`).emit('user_typing', {
                user_id: userId,
                username: socket.user.username,
                is_typing
            });
        } else if (to_user_id) {
            const targetSocketId = onlineUsers.get(to_user_id);
            if (targetSocketId) {
                io.to(targetSocketId).emit('user_typing', {
                    user_id: userId,
                    username: socket.user.username,
                    is_typing
                });
            }
        }
    });

    // 7.4. Отключение
    socket.on('disconnect', async () => {
        onlineUsers.delete(userId);
        await db.execute('UPDATE users SET status = @status WHERE id = @id', { status: 'offline', id: userId });
        socket.broadcast.emit('user_status', { userId, status: 'offline' });
    });
});

// 8. СТАТИЧЕСКИЕ ФАЙЛЫ И ЗАПУСК

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Вспомогательная функция для освобождения порта (Windows)
function killPort(port) {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
            if (stdout) {
                const lines = stdout.split('\n');
                const pids = new Set();
                lines.forEach(line => {
                    const match = line.match(/(\d+)$/);
                    if (match && line.includes('LISTENING')) pids.add(match[1]);
                });
                pids.forEach(pid => {
                    try { exec(`taskkill /F /PID ${pid}`); } catch(e) {}
                });
            }
            setTimeout(resolve, 1000);
        });
    });
}

async function startServer() {
    try {
        await killPort(PORT);
        server.listen(PORT, () => {
            console.log(` Сервер запущен на http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Ошибка при запуске сервера:', error);
        process.exit(1);
    }
}

startServer();