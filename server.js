const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const runMigrations = require('./migrate');

// 1. СОЗДАНИЕ ПРИЛОЖЕНИЯ И HTTP-СЕРВЕРА
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// 2. БЕЗОПАСНОСТЬ
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`📨 ${req.method} ${req.url}`);
        next();
    });
}

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Слишком много запросов, попробуйте позже'
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100
});
app.use('/api/', generalLimiter);

// Health check (для ONREZA)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 3. АУТЕНТИФИКАЦИЯ (JWT)
const JWT_SECRET = process.env.JWT_SECRET || 'Admin123';
const JWT_EXPIRES_IN = '7d';
const onlineUsers = new Map();

// 4. ШИФРОВАНИЕ КОМНАТ (AES-256-GCM)
const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    console.error('❌ ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    process.exit(1);
}
const KEY = Buffer.from(ENCRYPTION_KEY, 'hex');

function serverEncrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

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

// 5. MIDDLEWARE АУТЕНТИФИКАЦИИ
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Неверный токен' });
        req.user = user;
        next();
    });
};



// 6. МАРШРУТЫ API

// ---------- 6.1. Регистрация ----------
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, full_name } = req.body;
        const existing = await db.getMany(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = await db.insertAndGetId(
            `INSERT INTO users (username, email, password_hash, full_name, status) 
             VALUES ($1, $2, $3, $4, 'online') RETURNING id`,
            [username, email, hashedPassword, full_name]
        );
        const newUser = await db.getOne(
            `SELECT id, username, email, full_name, bio, avatar, status, created_at 
             FROM users WHERE id = $1`,
            [userId]
        );
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

// ---------- 6.2. Логин ----------
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await db.getOne(
            'SELECT * FROM users WHERE username = $1 OR email = $1',
            [username]
        );
        if (!user) {
            return res.status(401).json({ error: 'Неверные учётные данные' });
        }
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверные учётные данные' });
        }
        await db.execute(
            'UPDATE users SET status = $1 WHERE id = $2',
            ['online', user.id]
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

// ---------- 6.3. Профиль ----------
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = await db.getOne(
            'SELECT id, username, email, full_name, bio, avatar, status, birth_date, city, created_at FROM users WHERE id = $1',
            [req.user.id]
        );
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const { full_name, bio, avatar, email, status, birth_date, city, password } = req.body;
        let updates = [];
        let params = [req.user.id];
        let idx = 2;
        if (full_name !== undefined) { updates.push(`full_name = $${idx}`); params.push(full_name || null); idx++; }
        if (bio !== undefined) { updates.push(`bio = $${idx}`); params.push(bio || null); idx++; }
        if (avatar !== undefined) { updates.push(`avatar = $${idx}`); params.push(avatar || null); idx++; }
        if (email !== undefined) {
            if (email && email.trim() === '') return res.status(400).json({ error: 'Email не может быть пустым' });
            updates.push(`email = $${idx}`); params.push(email); idx++;
        }
        if (status !== undefined) { updates.push(`status = $${idx}`); params.push(status || 'online'); idx++; }
        if (birth_date !== undefined) { updates.push(`birth_date = $${idx}`); params.push(birth_date || null); idx++; }
        if (city !== undefined) { updates.push(`city = $${idx}`); params.push(city || null); idx++; }
        if (password && password.length > 0) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updates.push(`password_hash = $${idx}`); params.push(hashedPassword); idx++;
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'Нет полей для обновления' });
        }
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $1`;
        await db.execute(query, params);
        res.json({ message: 'Профиль обновлён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const pool = await db.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Реакции
            await client.query(`
                DELETE FROM message_reactions
                WHERE message_id IN (
                    SELECT id FROM messages WHERE from_user_id = $1 OR to_user_id = $1
                )
            `, [userId]);
            // Сообщения
            await client.query(
                'DELETE FROM messages WHERE from_user_id = $1 OR to_user_id = $1',
                [userId]
            );
            // Участники комнат
            await client.query(
                'DELETE FROM room_members WHERE user_id = $1',
                [userId]
            );
            // Друзья
            await client.query(
                'DELETE FROM friends WHERE user_id = $1 OR friend_id = $1',
                [userId]
            );
            // Ключи
            await client.query(
                'DELETE FROM user_keys WHERE user_id = $1',
                [userId]
            );
            // Пользователь
            const result = await client.query(
                'DELETE FROM users WHERE id = $1',
                [userId]
            );
            await client.query('COMMIT');
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            res.json({ message: 'Аккаунт успешно удалён' });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Ошибка удаления аккаунта:', error);
        res.status(500).json({ error: error.message || 'Внутренняя ошибка сервера' });
    }
});

// ---------- 6.4. Друзья ----------
app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const friends = await db.getMany(`
            SELECT u.id, u.username, u.full_name, u.email, u.status, u.avatar, u.bio,
                   f.status as friendship_status
            FROM friends f
            JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
            WHERE (f.user_id = $1 OR f.friend_id = $1) 
              AND u.id != $1
              AND f.status = 'accepted'
        `, [req.user.id]);
        res.json(friends);
    } catch (error) {
        console.error('Ошибка загрузки друзей:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const { friend_username } = req.body;
        const friend = await db.getOne(
            'SELECT id FROM users WHERE username = $1',
            [friend_username]
        );
        if (!friend) return res.status(404).json({ error: 'Пользователь не найден' });
        if (friend.id === req.user.id) return res.status(400).json({ error: 'Нельзя добавить себя в друзья' });
        const existing = await db.getOne(
            `SELECT * FROM friends WHERE (user_id = $1 AND friend_id = $2) 
             OR (user_id = $2 AND friend_id = $1)`,
            [req.user.id, friend.id]
        );
        if (existing) return res.status(400).json({ error: 'Заявка уже существует или вы уже друзья' });
        await db.execute(
            `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'pending')`,
            [req.user.id, friend.id]
        );
        // Отправляем уведомление в комнату пользователя
        io.to(`user_${friend.id}`).emit('friend_request_received', {
            from_user_id: req.user.id,
            username: req.user.username
        });
        res.json({ message: 'Заявка отправлена' });
    } catch (error) {
        console.error('Ошибка отправки заявки:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    try {
        const { friend_id } = req.body;
        await db.execute(
            `UPDATE friends SET status = 'accepted' 
             WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'`,
            [friend_id, req.user.id]
        );
        res.json({ message: 'Заявка принята' });
    } catch (error) {
        console.error('Ошибка принятия заявки:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/reject', authenticateToken, async (req, res) => {
    try {
        const { friend_id } = req.body;
        await db.execute(
            'DELETE FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = $3',
            [friend_id, req.user.id, 'pending']
        );
        res.json({ message: 'Заявка отклонена' });
    } catch (error) {
        console.error('Ошибка отклонения заявки:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/friends/pending', authenticateToken, async (req, res) => {
    try {
        const requests = await db.getMany(`
            SELECT u.id, u.username, u.full_name, u.email, u.avatar
            FROM friends f
            JOIN users u ON f.user_id = u.id
            WHERE f.friend_id = $1 AND f.status = 'pending'
        `, [req.user.id]);
        res.json(requests);
    } catch (error) {
        console.error('Ошибка загрузки заявок:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/friends/:friendId', authenticateToken, async (req, res) => {
    try {
        await db.execute(
            `DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) 
             OR (user_id = $2 AND friend_id = $1)`,
            [req.user.id, req.params.friendId]
        );
        res.json({ message: 'Друг удалён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.5. Поиск ----------
app.get('/api/users/search', authenticateToken, async (req, res) => {
    try {
        const { q, room_id } = req.query;
        if (!q || q.length < 2) return res.json([]);
        let sql = `
            SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.status
            FROM users u
            WHERE u.id != $1 
              AND (u.username ILIKE $2 OR u.full_name ILIKE $2 OR u.email ILIKE $2)
        `;
        let params = [req.user.id, `%${q}%`];
        if (room_id) {
            sql += ` AND u.id NOT IN (SELECT user_id FROM room_members WHERE room_id = $3)`;
            params.push(room_id);
        }
        sql += ` ORDER BY u.username LIMIT 20`;
        const users = await db.getMany(sql, params);
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/rooms/search', authenticateToken, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json([]);
        const rooms = await db.getMany(`
            SELECT r.*, 
                   (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as members_count
            FROM rooms r
            WHERE r.name ILIKE $1 OR r.description ILIKE $1
            ORDER BY r.name
            LIMIT 20
        `, [`%${q}%`]);
        res.json(rooms);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.6. Профиль пользователя ----------
app.get('/api/users/:userId', authenticateToken, async (req, res) => {
    try {
        const user = await db.getOne(
            'SELECT id, username, email, full_name, bio, avatar, status, birth_date, city, created_at FROM users WHERE id = $1',
            [req.params.userId]
        );
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.7. Комнаты ----------
app.post('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const { name, description } = req.body;
        const roomId = await db.insertAndGetId(
            'INSERT INTO rooms (name, description, created_by) VALUES ($1, $2, $3) RETURNING id',
            [name, description, req.user.id]
        );
        await db.execute(
            'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)',
            [roomId, req.user.id]
        );
        res.json({ id: roomId, name, description });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const rooms = await db.getMany(`
            SELECT r.*, 
                    (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as members_count
             FROM rooms r
             JOIN room_members rm ON r.id = rm.room_id
             WHERE rm.user_id = $1
        `, [req.user.id]);
        res.json(rooms);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/rooms/:roomId', authenticateToken, async (req, res) => {
    try {
        const room = await db.getOne('SELECT * FROM rooms WHERE id = $1', [req.params.roomId]);
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        res.json(room);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.8. Участники комнат ----------
app.post('/api/rooms/:roomId/members', authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { username_or_email } = req.body;
        const myMembership = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
            [roomId, req.user.id]
        );
        if (!myMembership) return res.status(403).json({ error: 'Вы не состоите в этой комнате' });
        const user = await db.getOne(
            'SELECT id, username, full_name, email FROM users WHERE username = $1 OR email = $1',
            [username_or_email]
        );
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        const existing = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
            [roomId, user.id]
        );
        if (existing) return res.status(400).json({ error: 'Пользователь уже в комнате' });
        await db.execute(
            'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)',
            [roomId, user.id]
        );
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

app.delete('/api/rooms/:roomId/members/:userId', authenticateToken, async (req, res) => {
    try {
        const { roomId, userId } = req.params;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = $1', [roomId]);
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
            'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
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

// ---------- 6.9. Сообщения ----------
app.get('/api/messages/room/:roomId', authenticateToken, async (req, res) => {
    try {
        const messages = await db.getMany(`
            SELECT m.*, u.username, u.full_name, u.avatar
             FROM messages m
             JOIN users u ON m.from_user_id = u.id
             WHERE m.to_room_id = $1 AND m.deleted_at IS NULL
             ORDER BY m.created_at ASC
             LIMIT 100
        `, [req.params.roomId]);
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

app.get('/api/messages/user/:userId', authenticateToken, async (req, res) => {
    try {
        const messages = await db.getMany(`
            SELECT m.*, u.username, u.full_name, u.avatar
             FROM messages m
             JOIN users u ON m.from_user_id = u.id
             WHERE ((m.to_user_id = $1 AND m.from_user_id = $2)
                OR (m.to_user_id = $2 AND m.from_user_id = $1))
                AND m.deleted_at IS NULL
             ORDER BY m.created_at ASC
             LIMIT 100
        `, [req.user.id, req.params.userId]);
        res.json(messages);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/messages/user/:userId/read', authenticateToken, async (req, res) => {
    try {
        await db.execute(
            `UPDATE messages SET is_read = true
             WHERE from_user_id = $1 AND to_user_id = $2
               AND is_read = false AND deleted_at IS NULL`,
            [req.params.userId, req.user.id]
        );
        io.to(`user_${parseInt(req.params.userId)}`).emit('messages_read', {
            by_user_id: req.user.id,
            from_user_id: parseInt(req.params.userId)
        });
        res.json({ message: 'Сообщения отмечены как прочитанные' });
    } catch (error) {
        console.error('Ошибка отметки сообщений:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/messages/unread', authenticateToken, async (req, res) => {
    try {
        const rows = await db.getMany(`
            SELECT from_user_id AS user_id, COUNT(*) AS unread_count
            FROM messages
            WHERE to_user_id = $1 AND is_read = false AND deleted_at IS NULL
            GROUP BY from_user_id
        `, [req.user.id]);
        const result = {};
        rows.forEach(r => { result[r.user_id] = parseInt(r.unread_count); });
        res.json(result);
    } catch (error) {
        console.error('Ошибка подсчёта непрочитанных:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        let { message } = req.body;
        if (!message || message.trim() === '') {
            return res.status(400).json({ error: 'Сообщение не может быть пустым' });
        }
        const msg = await db.getOne('SELECT * FROM messages WHERE id = $1', [messageId]);
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
        if (msg.from_user_id !== req.user.id) {
            return res.status(403).json({ error: 'Вы не можете редактировать это сообщение' });
        }
        if (msg.deleted_at) return res.status(400).json({ error: 'Сообщение удалено' });

        if (msg.to_room_id) {
            message = serverEncrypt(message);
        }

        await db.execute(
            'UPDATE messages SET message = $1, edited_at = NOW() WHERE id = $2',
            [message, messageId]
        );

        const updated = await db.getOne('SELECT * FROM messages WHERE id = $1', [messageId]);
        const sender = await db.getOne('SELECT username, full_name, avatar FROM users WHERE id = $1', [updated.from_user_id]);

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

        if (updated.to_room_id && updated.message) {
            try {
                response.message = serverDecrypt(updated.message);
            } catch (e) {}
        }

        if (updated.to_room_id) {
            io.to(`room_${updated.to_room_id}`).emit('message_edited', response);
        } else if (updated.to_user_id) {
            const senderId = updated.from_user_id;
            const receiverId = updated.to_user_id;
            io.to(`user_${senderId}`).emit('message_edited', response);
            io.to(`user_${receiverId}`).emit('message_edited', response);
        }

        res.json(response);
    } catch (error) {
        console.error('Ошибка редактирования сообщения:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/messages/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;
        const msg = await db.getOne('SELECT * FROM messages WHERE id = $1', [messageId]);
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
        if (msg.deleted_at) return res.status(400).json({ error: 'Сообщение уже удалено' });

        let canDelete = false;
        if (msg.from_user_id === userId) canDelete = true;
        else if (msg.to_room_id) {
            const room = await db.getOne('SELECT created_by FROM rooms WHERE id = $1', [msg.to_room_id]);
            if (room) {
                const member = await db.getOne(
                    'SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2',
                    [msg.to_room_id, userId]
                );
                if (member && (member.role === 'admin' || room.created_by === userId)) canDelete = true;
            }
        }
        if (!canDelete) return res.status(403).json({ error: 'Недостаточно прав для удаления сообщения' });

        await db.execute('UPDATE messages SET deleted_at = NOW() WHERE id = $1', [messageId]);

        const deleteEvent = { id: parseInt(messageId) };
        if (msg.to_room_id) {
            io.to(`room_${msg.to_room_id}`).emit('message_deleted', deleteEvent);
        } else if (msg.to_user_id) {
            const senderId = msg.from_user_id;
            const receiverId = msg.to_user_id;
            io.to(`user_${senderId}`).emit('message_deleted', deleteEvent);
            io.to(`user_${receiverId}`).emit('message_deleted', deleteEvent);
        }
        res.json({ message: 'Сообщение удалено' });
    } catch (error) {
        console.error('Ошибка удаления сообщения:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.10. Реакции ----------
app.get('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
    try {
        const reactions = await db.getMany(
            'SELECT user_id, reaction FROM message_reactions WHERE message_id = $1',
            [req.params.messageId]
        );
        res.json(reactions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { reaction } = req.body;
        if (!reaction || reaction.length === 0) {
            return res.status(400).json({ error: 'Реакция не может быть пустой' });
        }
        const userId = req.user.id;

        const msg = await db.getOne('SELECT * FROM messages WHERE id = $1', [messageId]);
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });

        const existing = await db.getOne(
            'SELECT * FROM message_reactions WHERE message_id = $1 AND user_id = $2',
            [messageId, userId]
        );

        if (existing) {
            if (existing.reaction === reaction) {
                await db.execute(
                    'DELETE FROM message_reactions WHERE id = $1',
                    [existing.id]
                );
            } else {
                await db.execute(
                    'UPDATE message_reactions SET reaction = $1, created_at = NOW() WHERE id = $2',
                    [reaction, existing.id]
                );
            }
        } else {
            await db.execute(
                'INSERT INTO message_reactions (message_id, user_id, reaction) VALUES ($1, $2, $3)',
                [messageId, userId, reaction]
            );
        }

        const updatedReactions = await db.getMany(
            'SELECT user_id, reaction FROM message_reactions WHERE message_id = $1',
            [messageId]
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
            io.to(`user_${senderId}`).emit('reaction_updated', reactionEvent);
            io.to(`user_${receiverId}`).emit('reaction_updated', reactionEvent);
        }

        res.json({ message: 'Реакция обновлена', reactions: updatedReactions });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;

        const msg = await db.getOne('SELECT * FROM messages WHERE id = $1', [messageId]);
        if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });

        await db.execute(
            'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2',
            [messageId, userId]
        );

        const updatedReactions = await db.getMany(
            'SELECT user_id, reaction FROM message_reactions WHERE message_id = $1',
            [messageId]
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
            io.to(`user_${senderId}`).emit('reaction_updated', reactionEvent);
            io.to(`user_${receiverId}`).emit('reaction_updated', reactionEvent);
        }

        res.json({ message: 'Реакция удалена', reactions: updatedReactions });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/reactions/batch', authenticateToken, async (req, res) => {
    try {
        const { messageIds } = req.body;
        if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.json({});
        }
        const placeholders = messageIds.map((_, i) => `$${i+1}`).join(',');
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

// ---------- 6.11. Ключи шифрования ----------
app.post('/api/keys/public', authenticateToken, async (req, res) => {
    try {
        const { public_key } = req.body;
        // Проверяем, есть ли уже запись для этого пользователя
        const existing = await db.getOne(
            'SELECT id FROM user_keys WHERE user_id = $1',
            [req.user.id]
        );
        if (existing) {
            // Обновляем существующий ключ
            await db.execute(
                'UPDATE user_keys SET public_key = $1, key_created_at = NOW() WHERE user_id = $2',
                [public_key, req.user.id]
            );
        } else {
            // Создаём новую запись
            await db.execute(
                'INSERT INTO user_keys (user_id, public_key) VALUES ($1, $2)',
                [req.user.id, public_key]
            );
        }
        res.json({ message: 'Публичный ключ сохранён' });
    } catch (error) {
        console.error('Ошибка сохранения ключа:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/keys/public/:userId', authenticateToken, async (req, res) => {
    try {
        const key = await db.getOne(
            'SELECT public_key FROM user_keys WHERE user_id = $1',
            [req.params.userId]
        );
        if (!key) return res.status(404).json({ error: 'Публичный ключ не найден' });
        res.json({ public_key: key.public_key });
    } catch (error) {
        console.error('Ошибка получения ключа:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.12. Статус ----------
app.put('/api/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        if (!status || !['online', 'offline', 'away'].includes(status)) {
            return res.status(400).json({ error: 'Недопустимый статус' });
        }
        await db.execute('UPDATE users SET status = $1 WHERE id = $2', [status, req.user.id]);
        res.json({ message: 'Статус обновлён' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.13. Аватар комнаты ----------
app.put('/api/rooms/:roomId/avatar', authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { avatar } = req.body;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = $1', [roomId]);
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        if (room.created_by !== req.user.id) return res.status(403).json({ error: 'Только создатель комнаты может менять аватар' });
        await db.execute('UPDATE rooms SET avatar = $1 WHERE id = $2', [avatar || null, roomId]);
        res.json({ message: 'Аватар комнаты обновлён' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ---------- 6.14. Роли в комнате ----------
app.get('/api/rooms/:roomId/members', authenticateToken, async (req, res) => {
    try {
        const members = await db.getMany(`
            SELECT u.id, u.username, u.full_name, u.email, u.avatar, u.status, rm.joined_at, rm.role
             FROM room_members rm
             JOIN users u ON rm.user_id = u.id
             WHERE rm.room_id = $1
             ORDER BY rm.role DESC, rm.joined_at ASC
        `, [req.params.roomId]);
        res.json(members);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/rooms/:roomId/members/:userId/admin', authenticateToken, async (req, res) => {
    try {
        const { roomId, userId } = req.params;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = $1', [roomId]);
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        if (room.created_by !== req.user.id) return res.status(403).json({ error: 'Только создатель комнаты может назначать администраторов' });
        const member = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
        );
        if (!member) return res.status(404).json({ error: 'Пользователь не состоит в комнате' });
        await db.execute(
            'UPDATE room_members SET role = $1 WHERE room_id = $2 AND user_id = $3',
            ['admin', roomId, userId]
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

app.delete('/api/rooms/:roomId/members/:userId/admin', authenticateToken, async (req, res) => {
    try {
        const { roomId, userId } = req.params;
        const room = await db.getOne('SELECT created_by FROM rooms WHERE id = $1', [roomId]);
        if (!room) return res.status(404).json({ error: 'Комната не найдена' });
        if (room.created_by !== req.user.id) return res.status(403).json({ error: 'Только создатель комнаты может управлять администраторами' });
        if (parseInt(userId) === room.created_by) return res.status(400).json({ error: 'Нельзя изменить роль создателя комнаты' });
        const member = await db.getOne(
            'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
        );
        if (!member) return res.status(404).json({ error: 'Пользователь не состоит в комнате' });
        await db.execute(
            'UPDATE room_members SET role = $1 WHERE room_id = $2 AND user_id = $3',
            ['member', roomId, userId]
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

// ---------- 6.15. Загрузка файлов в Cloudinary ----------
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'messenger_uploads',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'pdf', 'doc', 'docx', 'txt'],
        resource_type: 'auto',
    },
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        const fileUrl = req.file.path || req.file.secure_url;
        const fileType = req.file.mimetype ? req.file.mimetype.split('/')[0] : 'file';
        const fileName = req.file.originalname || 'Файл';
        res.json({ fileUrl, fileType, fileName });
    } catch (error) {
        console.error('Ошибка загрузки файла в Cloudinary:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. WEBSOCKET
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
    onlineUsers.set(userId, socket.id);
    socket.join(`user_${userId}`);

    db.execute('UPDATE users SET status = $1 WHERE id = $2', ['online', userId])
        .catch(err => console.error('Ошибка обновления статуса:', err));
    socket.broadcast.emit('user_status', { userId, status: 'online' });

    db.getMany('SELECT room_id FROM room_members WHERE user_id = $1', [userId])
        .then(rooms => rooms.forEach(room => socket.join(`room_${room.room_id}`)))
        .catch(err => console.error('Ошибка загрузки комнат:', err));

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
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id`,
                [
                    userId,
                    to_room_id || null,
                    to_user_id || null,
                    finalMessage,
                    isEncrypted,
                    file_url || null,
                    file_type || null,
                    file_name || null
                ]
            );
            const realId = result.rows[0].id;

            if (localId) {
                socket.emit('message_confirmed', { localId, realId });
            }

            const sender = await db.getOne('SELECT username, full_name, avatar FROM users WHERE id = $1', [userId]);

            let messageData = {
                id: realId,
                from_user_id: userId,
                username: sender?.username || socket.user.username,
                full_name: sender?.full_name || '',
                avatar: sender?.avatar || null,
                message: message || '',
                created_at: new Date().toISOString(),
                is_encrypted: isEncrypted,
                file_url: file_url || null,
                file_type: file_type || null,
                file_name: file_name || null,
                edited_at: null,
                deleted_at: null
            };

            if (to_room_id) {
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
                io.to(`user_${to_user_id}`).emit('private_message_encrypted', messageData);
            }
        } catch (error) {
            console.error('Ошибка отправки:', error);
        }
    });

    // 7.2. Отправка зашифрованного личного сообщения
    socket.on('send_encrypted_message', async (data) => {
        try {
            const { to_user_id, encrypted_message, file_url, file_type, file_name, localId } = data;
            if (!to_user_id) return;

            const result = await db.query(
                `INSERT INTO messages (from_user_id, to_user_id, message, is_encrypted, file_url, file_type, file_name)
                 VALUES ($1, $2, $3, 1, $4, $5, $6)
                 RETURNING id`,
                [
                    userId,
                    to_user_id,
                    encrypted_message || '',
                    file_url || null,
                    file_type || null,
                    file_name || null
                ]
            );
            const realId = result.rows[0].id;

            if (localId) {
                socket.emit('message_confirmed', { localId, realId });
            }

            const sender = await db.getOne('SELECT username, full_name, avatar FROM users WHERE id = $1', [userId]);

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

            io.to(`user_${to_user_id}`).emit('private_message_encrypted', messageData);
        } catch (error) {
            console.error('Ошибка отправки:', error);
        }
    });

    // 7.3. Печатает
    socket.on('typing', (data) => {
        const { to_room_id, to_user_id, is_typing } = data;
        if (to_room_id) {
            socket.to(`room_${to_room_id}`).emit('user_typing', {
                user_id: userId,
                username: socket.user.username,
                is_typing
            });
        } else if (to_user_id) {
            io.to(`user_${to_user_id}`).emit('user_typing', {
                user_id: userId,
                username: socket.user.username,
                is_typing
            });
        }
    });

    // 7.4. Отключение
    socket.on('disconnect', async () => {
        onlineUsers.delete(userId);
        await db.execute('UPDATE users SET status = $1 WHERE id = $2', ['offline', userId]);
        socket.broadcast.emit('user_status', { userId, status: 'offline' });
    });
});

// 8. СТАТИЧЕСКИЕ ФАЙЛЫ
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));

// 9. ЗАПУСК СЕРВЕРА
const PORT = process.env.PORT || 3000;

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
        // Выполняем миграции перед запуском
        await runMigrations();
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Сервер запущен на порту ${PORT}`);
        });
    } catch (error) {
        console.error('Ошибка при запуске сервера:', error);
        process.exit(1);
    }
}

startServer();