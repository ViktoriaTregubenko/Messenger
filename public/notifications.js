let notificationSocket = null;
let roomNameCache = {};

function initNotificationSocket() {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    if (!token) return;

    if (notificationSocket && notificationSocket.connected) return;

    notificationSocket = io({ auth: { token } });

    // ----- ЛИЧНЫЕ СООБЩЕНИЯ -----
    notificationSocket.on('private_message_encrypted', async (message) => {
        showMessageNotification(message);
    });

    // ----- ЗАЯВКИ В ДРУЗЬЯ -----
    notificationSocket.on('friend_request_received', (data) => {
        const senderName = data.username || 'Пользователь';
        showToastNotification(
            `Заявка в друзья`,
            `Пользователь @${senderName} хочет добавить Вас в друзья`,
            'info',
            () => {
                window.location.href = 'friends.html';
            }
        );
    });

    notificationSocket.on('friend_request_received', (data) => {
    const badge = document.getElementById('requestsCount');
    if (badge) {
        let count = parseInt(badge.textContent) || 0;
        badge.textContent = count + 1;
    }
});

    // ----- ДОБАВЛЕНИЕ В КОМНАТУ -----
    notificationSocket.on('member_added', async (data) => {
        if (!data.room_id) return;

        const currentUserId = getCurrentUserId();
        if (data.user.id === currentUserId) return;
        if (isRoomOpen(data.room_id)) return;

        const userName = data.user.full_name || data.user.username || 'Пользователь';
        const roomName = await getRoomName(data.room_id);

        showToastNotification(
            `Добавлен в комнату`,
            `${userName} добавил(а) вас в комнату «${roomName}»`,
            'info',
            () => {
                window.location.href = `room.html?id=${data.room_id}`;
            }
        );
    });

    // ----- НОВЫЕ СООБЩЕНИЯ В КОМНАТАХ -----
    notificationSocket.on('new_message', async (message) => {
        if (!message.to_room_id) return;

        const currentUserId = getCurrentUserId();
        if (message.from_user_id === currentUserId) return;
        if (isRoomOpen(message.to_room_id)) return;

        const senderName = message.full_name || message.username || 'Пользователь';
        const roomName = await getRoomName(message.to_room_id);

        let preview = message.message || 'Новое сообщение';
        if (preview.length > 40) preview = preview.substring(0, 40) + '...';

        showToastNotification(
            `Новое сообщение в «${roomName}»`,
            `${senderName}: ${preview}`,
            'info',
            () => {
                window.location.href = `room.html?id=${message.to_room_id}`;
            }
        );
    });

    // ----- СТАТУСЫ ПОДКЛЮЧЕНИЯ -----
    notificationSocket.on('connect', async () => {
        try {
            const token = localStorage.getItem('token') || sessionStorage.getItem('token');
            const res = await fetch('/api/rooms', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const rooms = await res.json();
                rooms.forEach(room => {
                    notificationSocket.emit('join_room', { room_id: room.id });
                });
            }
        } catch (e) {}
    });

    notificationSocket.on('connect_error', (err) => {});
    notificationSocket.on('disconnect', () => {});
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

async function getRoomName(roomId) {
    if (roomNameCache[roomId]) return roomNameCache[roomId];

    try {
        const token = localStorage.getItem('token') || sessionStorage.getItem('token');
        const res = await fetch(`/api/rooms/${roomId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Ошибка загрузки комнаты');
        const room = await res.json();
        roomNameCache[roomId] = room.name || 'Комната';
        return roomNameCache[roomId];
    } catch (e) {
        return 'Комната';
    }
}

function getCurrentUserId() {
    try {
        if (window.currentUser && window.currentUser.id) {
            return window.currentUser.id;
        }
        const userData = localStorage.getItem('userData');
        if (userData) {
            const user = JSON.parse(userData);
            return user.id;
        }
        const token = localStorage.getItem('token') || sessionStorage.getItem('token');
        if (token) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                return payload.id;
            } catch {}
        }
        return null;
    } catch {
        return null;
    }
}

function isRoomOpen(roomId) {
    const urlParams = new URLSearchParams(window.location.search);
    const roomIdParam = urlParams.get('id');
    return roomIdParam && parseInt(roomIdParam) === parseInt(roomId);
}

function isChatWithUserOpen(userId) {
    const urlParams = new URLSearchParams(window.location.search);
    const chatUserId = urlParams.get('userId');
    return chatUserId && parseInt(chatUserId) === parseInt(userId);
}

// ===== ПОКАЗ УВЕДОМЛЕНИЯ О ЛИЧНОМ СООБЩЕНИИ =====
function showMessageNotification(message) {
    if (!message.to_user_id) return;

    const currentUserId = getCurrentUserId();
    if (message.from_user_id === currentUserId) return;
    if (isChatWithUserOpen(message.from_user_id)) return;

    const senderName = message.full_name || message.username || 'Пользователь';

    showToastNotification(
        `Новое сообщение от ${senderName}`,
        'Нажмите, чтобы открыть чат',
        'info',
        () => {
            window.location.href = `private-chat.html?userId=${message.from_user_id}`;
        }
    );
}

// ===== ЗВУК ДЛЯ УВЕДОМЛЕНИЯ =====
function playBirdSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [
            { freq: 800, time: 0, dur: 0.1 },
            { freq: 1200, time: 0.08, dur: 0.08 },
            { freq: 600, time: 0.15, dur: 0.1 },
            { freq: 1400, time: 0.22, dur: 0.06 },
            { freq: 1000, time: 0.28, dur: 0.08 },
            { freq: 500, time: 0.35, dur: 0.12 }
        ];
        notes.forEach(note => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.connect(gain);
            gain.connect(audioContext.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(note.freq, audioContext.currentTime + note.time);
            gain.gain.setValueAtTime(0.1, audioContext.currentTime + note.time);
            gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + note.time + note.dur);
            osc.start(audioContext.currentTime + note.time);
            osc.stop(audioContext.currentTime + note.time + note.dur);
        });
    } catch (e) {}
}

// ===== ТОСТ-УВЕДОМЛЕНИЕ =====
function showToastNotification(title, message, type = 'info', onClick = null) {
    playBirdSound();

    const existing = document.querySelectorAll('.toast-notification');
    if (existing.length >= 5) {
        existing[0].remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        max-width: 380px;
        min-width: 280px;
        padding: 16px 20px;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(12px);
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        border-left: 4px solid ${type === 'error' ? '#e74c3c' : type === 'success' ? '#2ecc71' : '#FF6B9D'};
        z-index: 99999;
        cursor: pointer;
        animation: slideInRight 0.4s ease;
        transition: transform 0.3s, opacity 0.3s;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    `;

    toast.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 12px;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 700; font-size: 0.95rem; color: #1a1a1a; margin-bottom: 2px;">
                    ${title}
                </div>
                <div style="font-size: 0.85rem; color: #555; word-wrap: break-word;">
                    ${message}
                </div>
                <div style="font-size: 0.7rem; color: #999; margin-top: 4px;">
                    ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
            </div>
            <button class="toast-close" style="
                background: none;
                border: none;
                font-size: 20px;
                cursor: pointer;
                color: #999;
                padding: 0 4px;
                line-height: 1;
                transition: color 0.2s;
                flex-shrink: 0;
            ">&times;</button>
        </div>
    `;

    toast.querySelector('.toast-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeToast(toast);
    });

    toast.addEventListener('click', (e) => {
        if (e.target.closest('.toast-close')) return;
        if (onClick) onClick();
        closeToast(toast);
    });

    document.body.appendChild(toast);

    const timeoutId = setTimeout(() => {
        closeToast(toast);
    }, 5000);

    toast.dataset.timeoutId = timeoutId;

    toast.addEventListener('mouseenter', () => {
        clearTimeout(parseInt(toast.dataset.timeoutId));
    });

    toast.addEventListener('mouseleave', () => {
        const newTimeout = setTimeout(() => {
            closeToast(toast);
        }, 3000);
        toast.dataset.timeoutId = newTimeout;
    });
}

function closeToast(toast) {
    if (!toast || toast._closed) return;
    toast._closed = true;
    clearTimeout(parseInt(toast.dataset.timeoutId));
    toast.style.transform = 'translateX(100px)';
    toast.style.opacity = '0';
    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, 400);
}

// ===== СТИЛИ АНИМАЦИИ =====
const toastStyles = document.createElement('style');
toastStyles.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(100px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }

    body.dark-mode .toast-notification {
        background: rgba(26, 26, 46, 0.95) !important;
        border-color: var(--pink) !important;
    }
    body.dark-mode .toast-notification div {
        color: #e0e0e0 !important;
    }
    body.dark-mode .toast-notification .toast-close {
        color: #888 !important;
    }
`;
document.head.appendChild(toastStyles);

// ===== ЗАПУСК =====
document.addEventListener('DOMContentLoaded', () => {
    initNotificationSocket();
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initNotificationSocket();
}