const token = localStorage.getItem('token') || sessionStorage.getItem('token');
let currentUser = null;
let socket = null;
let currentChatUserId = null;
let currentFieldToEdit = null;
let keyPair = null;

if (!token) {
    window.location.href = 'login.html';
}

// КРИПТОГРАФИЯ

async function generateKeyPair() {
    return new Promise((resolve, reject) => {
        forge.rsa.generateKeyPair({ bits: 2048, workers: 2 }, (err, keys) => {
            if (err) reject(err);
            else resolve(keys);
        });
    });
}

async function initUserKeys() {
    try {
        let privateKey = localStorage.getItem('private_key');
        let publicKey = localStorage.getItem('public_key');
        
        if (!privateKey || !publicKey) {
            keyPair = await generateKeyPair();
            privateKey = forge.pki.privateKeyToPem(keyPair.privateKey);
            publicKey = forge.pki.publicKeyToPem(keyPair.publicKey);
            localStorage.setItem('private_key', privateKey);
            localStorage.setItem('public_key', publicKey);
            await fetch('/api/keys/public', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ public_key: publicKey })
            });
        } else {
            const privateKeyPem = forge.pki.privateKeyFromPem(privateKey);
            const publicKeyPem = forge.pki.publicKeyFromPem(publicKey);
            keyPair = { privateKey: privateKeyPem, publicKey: publicKeyPem };
        }
    } catch (error) {
        // Ошибка инициализации ключей — пользователь не сможет шифровать
    }
}

async function encryptMessage(message, recipientUserId) {
    try {
        const res = await fetch(`/api/keys/public/${recipientUserId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            throw new Error('Не удалось получить публичный ключ получателя');
        }
        const { public_key } = await res.json();
        const recipientPublicKey = forge.pki.publicKeyFromPem(public_key);
        const sessionKey = forge.random.getBytesSync(32);
        const iv = forge.random.getBytesSync(16);
        const cipher = forge.cipher.createCipher('AES-GCM', sessionKey);
        cipher.start({ iv });
        cipher.update(forge.util.createBuffer(message));
        cipher.finish();
        const encryptedMessage = cipher.output.getBytes();
        const authTag = cipher.mode.tag.getBytes();
        const encryptedSessionKey = recipientPublicKey.encrypt(sessionKey, 'RSA-OAEP');
        const encryptedPackage = {
            encrypted_message: forge.util.encode64(encryptedMessage),
            encrypted_session_key: forge.util.encode64(encryptedSessionKey),
            iv: forge.util.encode64(iv),
            auth_tag: forge.util.encode64(authTag)
        };
        return JSON.stringify(encryptedPackage);
    } catch (error) {
        return null;
    }
}

async function decryptMessage(encryptedPackageJson) {
    try {
        const encryptedPackage = JSON.parse(encryptedPackageJson);
        const encryptedMessage = forge.util.decode64(encryptedPackage.encrypted_message);
        const encryptedSessionKey = forge.util.decode64(encryptedPackage.encrypted_session_key);
        const iv = forge.util.decode64(encryptedPackage.iv);
        const authTag = forge.util.decode64(encryptedPackage.auth_tag);
        const sessionKey = keyPair.privateKey.decrypt(encryptedSessionKey, 'RSA-OAEP');
        const decipher = forge.cipher.createDecipher('AES-GCM', sessionKey);
        decipher.start({ iv, tag: authTag });
        decipher.update(forge.util.createBuffer(encryptedMessage));
        const result = decipher.finish();
        if (result) {
            return decipher.output.getBytes();
        } else {
            throw new Error('Ошибка расшифровки');
        }
    } catch (error) {
        return '[Зашифрованное сообщение]';
    }
}

// ИНИЦИАЛИЗАЦИЯ
async function init() {
    try {
        await initUserKeys();
        await loadUserProfile();
        await loadFriends();
        await loadRooms();
        await loadChats();
        initSocket();
        setupEventListeners();
        loadTheme();
    } catch (error) {
    }
}

function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
    }
}

// ЗАГРУЗКА ПРОФИЛЯ
async function loadUserProfile() {
    try {
        const res = await fetch('/api/profile', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Ошибка загрузки профиля');
        currentUser = await res.json();
        window.currentUser = currentUser;
        localStorage.setItem('userData', JSON.stringify({ 
            id: currentUser.id,
            username: currentUser.username,
            full_name: currentUser.full_name
        }));
        
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
        };
        
        setText('profileFullName', currentUser.full_name || currentUser.username || 'Пользователь');
        setText('profileUsername', currentUser.username || 'username');
        setText('profileEmail', currentUser.email || 'email@example.com');
        
        const avatarEl = document.getElementById('profileAvatar');
        if (avatarEl) {
            if (currentUser.avatar && currentUser.avatar.startsWith('data:image')) {
                avatarEl.src = currentUser.avatar;
            } else {
                const initials = (currentUser.full_name || currentUser.username || 'U')
                    .split(' ')
                    .map(n => n[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2);
                const canvas = document.createElement('canvas');
                canvas.width = 120;
                canvas.height = 120;
                const ctx = canvas.getContext('2d');
                const colors = ['#FF6B9D', '#FFD700', '#6BCB77', '#4D96FF', '#FF6B6B', '#9B59B6', '#1ABC9C'];
                const colorIndex = (currentUser.id || 0) % colors.length;
                ctx.fillStyle = colors[colorIndex];
                ctx.fillRect(0, 0, 120, 120);
                ctx.fillStyle = 'white';
                ctx.font = 'bold 48px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initials, 60, 60);
                avatarEl.src = canvas.toDataURL();
            }
        }
        
        setText('joinDate', currentUser.created_at ? new Date(currentUser.created_at).toLocaleDateString('ru-RU') : '--');
        setText('displayFullName', currentUser.full_name || 'Не указано');
        setText('displayBirthDate', currentUser.birth_date ? new Date(currentUser.birth_date).toLocaleDateString('ru-RU') : 'Не указана');
        setText('displayCity', currentUser.city || 'Не указан');
        setText('displayBio', currentUser.bio || 'Расскажите о себе...');
        
        setVal('settingsFullName', currentUser.full_name);
        setVal('settingsBirthDate', currentUser.birth_date);
        setVal('settingsCity', currentUser.city);
        setVal('settingsBio', currentUser.bio);
        setVal('settingsEmail', currentUser.email);
        setVal('settingsStatus', currentUser.status || 'online');
        
        updateStatusDisplay(currentUser.status || 'online');
        
    } catch (error) {
        showNotification('Не удалось загрузить профиль', 'error');
    }
}

function updateStatusDisplay(status) {
    const statusText = document.querySelector('#profileStatus');
    if (!statusText) return;
    const statusMap = {
        'online': { class: 'online', text: 'Онлайн' },
        'away': { class: 'away', text: 'Отошёл' },
        'offline': { class: 'offline', text: 'Офлайн' }
    };
    const statusInfo = statusMap[status] || statusMap['offline'];
    statusText.innerHTML = `<span class="status-dot ${statusInfo.class}"></span> ${statusInfo.text}`;
}

async function optimizeImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const MAX_SIZE = 300;
                if (width > height) {
                    if (width > MAX_SIZE) {
                        height = height * MAX_SIZE / width;
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width = width * MAX_SIZE / height;
                        height = MAX_SIZE;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ПОДТВЕРЖДЕНИЕ (МОДАЛЬНОЕ ОКНО)
let pendingConfirmCallback = null;

function openConfirmModal(message, onConfirm) {
    document.getElementById('confirmMessage').textContent = message;
    pendingConfirmCallback = onConfirm;
    document.getElementById('confirmModal').style.display = 'flex';
}

function closeConfirmModal() {
    document.getElementById('confirmModal').style.display = 'none';
    pendingConfirmCallback = null;
}

document.getElementById('closeConfirmModal')?.addEventListener('click', closeConfirmModal);
document.getElementById('confirmModal')?.addEventListener('click', function(e) {
    if (e.target === this) closeConfirmModal();
});
document.getElementById('confirmYesBtn')?.addEventListener('click', function() {
    if (pendingConfirmCallback) {
        pendingConfirmCallback();
        closeConfirmModal();
    }
});
document.getElementById('confirmNoBtn')?.addEventListener('click', closeConfirmModal);
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && document.getElementById('confirmModal')?.style.display === 'flex') {
        closeConfirmModal();
    }
});

// УДАЛЕНИЕ АККАУНТА
document.getElementById('deleteAccountBtn')?.addEventListener('click', function() {
    openConfirmModal(
        '⚠️ Вы действительно хотите удалить свой аккаунт? Это действие необратимо!',
        async function() {
            try {
                const res = await fetch('/api/profile', {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (res.ok) {
                    showNotification(' Аккаунт удалён', 'success');
                    localStorage.removeItem('token');
                    sessionStorage.removeItem('token');
                    if (socket) socket.disconnect();
                    setTimeout(() => window.location.href = 'index.html', 1500);
                } else {
                    const error = await res.json();
                    showNotification(error.error || 'Ошибка удаления', 'error');
                }
            } catch (error) {
                showNotification('Ошибка сервера', 'error');
            }
        }
    );
});

// ЗАГРУЗКА АВАТАРА
document.addEventListener('DOMContentLoaded', function() {
    const uploadBtn = document.getElementById('uploadAvatarBtn');
    if (uploadBtn) {
        uploadBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const input = document.getElementById('avatarInput');
            if (input) input.click();
        });
    }
    const changeBtn = document.getElementById('changeAvatarBtn');
    if (changeBtn) {
        changeBtn.addEventListener('click', function() {
            document.getElementById('avatarInput').click();
        });
    }
    const avatarInput = document.getElementById('avatarInput');
    if (avatarInput) {
        avatarInput.addEventListener('change', handleAvatarUpload);
    }
});

async function handleAvatarUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showNotification('Пожалуйста, выберите изображение', 'warning');
        e.target.value = '';
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        showNotification('Изображение слишком большое. Максимум 2MB', 'warning');
        e.target.value = '';
        return;
    }
    try {
        const optimizedImage = await optimizeImage(file);
        const res = await fetch('/api/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ avatar: optimizedImage })
        });
        if (res.ok) {
            showNotification('Аватар обновлён!', 'success');
            document.getElementById('profileAvatar').src = optimizedImage;
            localStorage.setItem('user_avatar', optimizedImage);
            currentUser.avatar = optimizedImage;
            await loadUserProfile();
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка загрузки', 'error');
        }
    } catch (error) {
        showNotification('Ошибка при загрузке изображения', 'error');
    }
    e.target.value = '';
}

// ЗАГРУЗКА ДРУЗЕЙ
async function loadFriends() {
    try {
        const res = await fetch('/api/friends', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const friends = await res.json();
        document.getElementById('friendsCount').textContent = friends.length;
        document.getElementById('friendsBadge').textContent = friends.length;
        const container = document.getElementById('friendsListProfile');
        if (friends.length === 0) {
            container.innerHTML = '<div class="empty-state">У вас пока нет друзей. Добавьте первого друга!</div>';
            return;
        }
        container.innerHTML = friends.map(friend => `
            <div class="friend-card" data-user-id="${friend.id}">
                <img src="${friend.avatar || 'https://via.placeholder.com/60'}" class="friend-avatar" onerror="this.src='https://via.placeholder.com/60'">
                <div class="friend-info">
                    <div class="friend-name">${escapeHtml(friend.full_name || friend.username)}</div>
                    <div class="friend-username">@${escapeHtml(friend.username)}</div>
                    <div class="friend-status ${friend.status === 'online' ? 'online' : 'offline'}">
                        ${friend.status === 'online' ? '● Онлайн' : '○ Офлайн'}
                    </div>
                </div>
                <div class="friend-actions">
                    <button onclick="viewUserProfile(${friend.id})" class="view-profile-btn" title="Просмотр профиля">👁️</button>
                    <button onclick="openChatWithUser(${friend.id}, '${escapeHtml(friend.username)}')" class="message-btn" title="Написать сообщение">💬</button>
                    <button onclick="removeFriend(${friend.id})" class="remove-friend-btn" title="Удалить из друзей">🗑️</button>
                </div>
            </div>
        `).join('');
        setupFriendSearch();
    } catch (error) {
        document.getElementById('friendsListProfile').innerHTML = '<div class="empty-state">Ошибка загрузки друзей</div>';
    }
}

function setupFriendSearch() {
    const searchInput = document.getElementById('friendsSearchInput');
    if (!searchInput) return;
    const newSearchInput = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearchInput, searchInput);
    newSearchInput.addEventListener('input', function(e) {
        const query = this.value.toLowerCase().trim();
        const cards = document.querySelectorAll('.friend-card');
        cards.forEach(card => {
            const name = card.querySelector('.friend-name')?.textContent?.toLowerCase() || '';
            const username = card.querySelector('.friend-username')?.textContent?.toLowerCase() || '';
            const shouldShow = !query || name.includes(query) || username.includes(query);
            card.style.display = shouldShow ? 'flex' : 'none';
        });
    });
}

// ЗАГРУЗКА КОМНАТ
async function loadRooms() {
    try {
        const res = await fetch('/api/rooms', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const rooms = await res.json();
        document.getElementById('roomsBadge').textContent = rooms.length;
        document.getElementById('userRoomsCount').textContent = rooms.length;
        const container = document.getElementById('roomsListProfile');
        if (rooms.length === 0) {
            container.innerHTML = '<div class="empty-state">Вы не состоите ни в одной комнате. Создайте первую!</div>';
            return;
        }
        container.innerHTML = rooms.map(room => `
            <div class="room-card">
                <div class="room-icon"></div>
                <div class="room-info">
                    <div class="room-name">${escapeHtml(room.name)}</div>
                    <div class="room-description">${escapeHtml(room.description || 'Нет описания')}</div>
                    <div class="room-meta">👥 ${room.members_count || 0} участников</div>
                </div>
                <div class="room-actions">
                    <button onclick="goToRoom(${room.id})" class="join-room-btn">Войти</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        document.getElementById('roomsListProfile').innerHTML = '<div class="empty-state">Ошибка загрузки комнат</div>';
    }
}

// ЗАГРУЗКА ЧАТОВ
async function loadChats() {
    try {
        const res = await fetch('/api/friends', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const friends = await res.json();
        const container = document.getElementById('chatsList');
        if (friends.length === 0) {
            container.innerHTML = '<div class="empty-state">Нет активных чатов</div>';
            return;
        }
        container.innerHTML = '<div class="loading">Загрузка...</div>';
        const chats = await Promise.all(friends.map(async (friend) => {
            try {
                const messagesRes = await fetch(`/api/messages/user/${friend.id}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const messages = await messagesRes.json();
                const lastMessage = messages[messages.length - 1];
                return {
                    ...friend,
                    lastMessage: lastMessage?.message || 'Нет сообщений',
                    lastMessageTime: lastMessage?.created_at || null
                };
            } catch (e) {
                return {
                    ...friend,
                    lastMessage: 'Ошибка загрузки',
                    lastMessageTime: null
                };
            }
        }));
        container.innerHTML = chats.map(chat => `
            <div class="chat-card" onclick="openChatWithUser(${chat.id}, '${escapeHtml(chat.username)}')">
                <img src="${chat.avatar || 'https://via.placeholder.com/50'}" class="chat-avatar">
                <div class="chat-details">
                    <div class="chat-name">${escapeHtml(chat.full_name || chat.username)}</div>
                    <div class="chat-last-message">${escapeHtml(chat.lastMessage.substring(0, 50))}</div>
                </div>
                <div class="chat-time">
                    ${chat.lastMessageTime ? new Date(chat.lastMessageTime).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''}
                </div>
            </div>
        `).join('');
    } catch (error) {
        document.getElementById('chatsList').innerHTML = '<div class="empty-state">Ошибка загрузки</div>';
    }
}

// ПРОСМОТР ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ
window.viewUserProfile = async function(userId) {
    try {
        const res = await fetch(`/api/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Ошибка загрузки');
        const user = await res.json();
        document.getElementById('viewUserAvatar').src = user.avatar || 'https://via.placeholder.com/80';
        document.getElementById('viewUserFullName').textContent = user.full_name || user.username;
        document.getElementById('viewUserUsername').textContent = user.username;
        document.getElementById('viewUserEmail').textContent = user.email || 'Не указан';
        document.getElementById('viewUserBirthDate').textContent = user.birth_date 
            ? new Date(user.birth_date).toLocaleDateString('ru-RU') 
            : 'Не указана';
        document.getElementById('viewUserCity').textContent = user.city || 'Не указан';
        document.getElementById('viewUserBio').textContent = user.bio || 'Не указано';
        document.getElementById('viewUserJoinDate').textContent = user.created_at 
            ? new Date(user.created_at).toLocaleDateString('ru-RU') 
            : '--';
        const statusSpan = document.getElementById('viewUserStatus');
        if (user.status === 'online') {
            statusSpan.innerHTML = '<span class="status-dot online"></span> Онлайн';
        } else if (user.status === 'away') {
            statusSpan.innerHTML = '<span class="status-dot away"></span> Отошёл';
        } else {
            statusSpan.innerHTML = '<span class="status-dot offline"></span> Офлайн';
        }
        document.getElementById('sendMessageToUserBtn').onclick = () => {
            document.getElementById('userProfileModal').style.display = 'none';
            openChatWithUser(user.id, user.username);
        };
        document.getElementById('userProfileModal').style.display = 'flex';
    } catch (error) {
        showNotification('Не удалось загрузить профиль пользователя', 'error');
    }
};

// *** WEBSOCKET ***
function initSocket() {
    socket = io({ auth: { token } });
    socket.on('private_message', (message) => {
        if (currentChatUserId === message.from_user_id) {
            appendChatMessage(message);
        }
        loadChats();
        if (message.from_user_id !== currentUser?.id) {
            showNotification(`Новое сообщение`, 'info');
        }
    });
    
    socket.on('user_status', ({ userId, status }) => {
        updateFriendStatus(userId, status);
    });
}

// ОТКРЫТЬ ЧАТ
window.openChatWithUser = async function(userId, username) {
    currentChatUserId = userId;
    document.getElementById('chatModalTitle').textContent = `Чат с ${escapeHtml(username)}`;
    document.getElementById('chatModal').style.display = 'flex';
    const container = document.getElementById('chatModalMessages');
    container.innerHTML = '<div class="loading">Загрузка сообщений...</div>';
    try {
        const res = await fetch(`/api/messages/user/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const messages = await res.json();
        container.innerHTML = '';
        if (messages.length === 0) {
            container.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первое!</div>';
        } else {
            messages.forEach(msg => appendChatMessage(msg));
        }
        container.scrollTop = container.scrollHeight;
    } catch (error) {
        container.innerHTML = '<div class="empty-state">Ошибка загрузки сообщений</div>';
    }
};

function appendChatMessage(message) {
    const container = document.getElementById('chatModalMessages');
    const isOwn = message.from_user_id === currentUser.id;
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${isOwn ? 'own' : ''}`;
    const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = new Date(message.created_at).toLocaleDateString('ru-RU');
    const fullTime = `${date} ${time}`;
    let displayText = escapeHtml(message.message);
    if (message.is_encrypted) {
        displayText = 'Зашифрованное сообщение';
    }
    messageDiv.innerHTML = `
        <div class="chat-message-bubble">
            <div class="chat-message-text">${displayText}</div>
            <div class="chat-message-time" title="${fullTime}">${time}</div>
        </div>
    `;
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
}

document.getElementById('sendModalMessageBtn')?.addEventListener('click', () => {
    const input = document.getElementById('chatModalInput');
    const message = input.value.trim();
    if (!message || !currentChatUserId) return;
    socket.emit('send_message', {
        to_user_id: currentChatUserId,
        message: message
    });
    const container = document.getElementById('chatModalMessages');
    const emptyMsg = container.querySelector('.empty-state');
    if (emptyMsg) emptyMsg.remove();
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message own';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageDiv.innerHTML = `
        <div class="chat-message-bubble">
            <div class="chat-message-text">${escapeHtml(message)}</div>
            <div class="chat-message-time">${time}</div>
        </div>
    `;
    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;
    input.value = '';
});

document.getElementById('chatModalInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('sendModalMessageBtn').click();
    }
});

// ДОБАВЛЕНИЕ ДРУГА
document.getElementById('addFriendProfileBtn')?.addEventListener('click', () => {
    document.getElementById('addFriendModal').style.display = 'flex';
    document.getElementById('newFriendUsername').focus();
});

document.getElementById('confirmAddFriendBtn')?.addEventListener('click', async () => {
    const username = document.getElementById('newFriendUsername').value.trim();
    if (!username) {
        showNotification('Введите имя пользователя', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/friends/request', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ friend_username: username })
        });
        if (res.ok) {
            showNotification(' Заявка отправлена', 'success');
            document.getElementById('addFriendModal').style.display = 'none';
            document.getElementById('newFriendUsername').value = '';
            await loadFriends();
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка', 'error');
        }
    } catch (error) {
        showNotification('Ошибка при отправке заявки', 'error');
    }
});

// УДАЛЕНИЕ ДРУГА
window.removeFriend = async function(userId) {
    if (!confirm('Удалить этого друга из списка?')) return;
    try {
        const res = await fetch(`/api/friends/${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            showNotification(' Друг удалён', 'success');
            await loadFriends();
            await loadChats();
        } else {
            showNotification('Ошибка удаления', 'error');
        }
    } catch (error) {
        showNotification('Ошибка при удалении', 'error');
    }
};

// СОЗДАНИЕ КОМНАТЫ
document.getElementById('createRoomProfileBtn')?.addEventListener('click', () => {
    document.getElementById('createRoomProfileModal').style.display = 'flex';
    document.getElementById('newRoomName').focus();
});

document.getElementById('confirmCreateRoomProfileBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newRoomName').value.trim();
    const description = document.getElementById('newRoomDescription').value.trim();
    if (!name) {
        showNotification('Введите название комнаты', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/rooms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ name, description })
        });
        if (res.ok) {
            showNotification(' Комната создана', 'success');
            document.getElementById('createRoomProfileModal').style.display = 'none';
            document.getElementById('newRoomName').value = '';
            document.getElementById('newRoomDescription').value = '';
            await loadRooms();
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка', 'error');
        }
    } catch (error) {
        showNotification('Ошибка при создании комнаты', 'error');
    }
});

//  ОБНОВЛЕНИЕ СТАТУСА ДРУГА
function updateFriendStatus(userId, status) {
    const card = document.querySelector(`.friend-card[data-user-id="${userId}"]`);
    if (card) {
        const statusSpan = card.querySelector('.friend-status');
        if (statusSpan) {
            statusSpan.className = `friend-status ${status}`;
            statusSpan.textContent = status === 'online' ? '● Онлайн' : '○ Офлайн';
        }
    }
}

// ОБНОВЛЕНИЕ ПРОФИЛЯ
async function updateProfile(data) {
    try {
        if (data.avatar && data.avatar.startsWith('data:image')) {
            const sizeInBytes = data.avatar.length * 3 / 4;
            if (sizeInBytes > 2 * 1024 * 1024) {
                showNotification('Изображение слишком большое. Максимум 2MB', 'warning');
                return;
            }
        }
        const res = await fetch('/api/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            showNotification(' Профиль обновлён', 'success');
            await loadUserProfile();
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка обновления', 'error');
        }
    } catch (error) {
        showNotification('Ошибка при сохранении', 'error');
    }
}

//СОХРАНЕНИЕ НАСТРОЕК
document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const full_name = document.getElementById('settingsFullName').value.trim();
    const birth_date = document.getElementById('settingsBirthDate').value;
    const city = document.getElementById('settingsCity').value.trim();
    const bio = document.getElementById('settingsBio').value.trim();
    const email = document.getElementById('settingsEmail').value.trim();
    const status = document.getElementById('settingsStatus').value;
    const password = document.getElementById('settingsPassword').value;
    const confirmPassword = document.getElementById('settingsConfirmPassword').value;
    
    if (password && password !== confirmPassword) {
        showNotification('Пароли не совпадают', 'warning');
        return;
    }
    if (password && password.length < 6) {
        showNotification('Пароль должен быть минимум 6 символов', 'warning');
        return;
    }
    const data = { full_name, birth_date, city, bio, email, status };
    if (password) data.password = password;
    await updateProfile(data);
    document.getElementById('settingsPassword').value = '';
    document.getElementById('settingsConfirmPassword').value = '';
});

//ПЕРЕХОДЫ
window.goToRoom = function(roomId) {
    if (!roomId) {
        showNotification('ID комнаты не указан', 'warning');
        return;
    }
    window.location.href = `room.html?id=${roomId}`;
};

//ВЫХОД 
document.getElementById('logoutProfileBtn')?.addEventListener('click', () => {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    if (socket) socket.disconnect();
    window.location.href = 'login.html';
});

//НАВИГАЦИЯ
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabs = document.querySelectorAll('.tab-content');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tabName = item.dataset.tab;
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            tabs.forEach(tab => tab.classList.remove('active'));
            const targetTab = document.getElementById(`${tabName}Tab`);
            if (targetTab) targetTab.classList.add('active');
        });
    });
}

// Открытие модального окна настроек
document.getElementById('showSettingsBtn')?.addEventListener('click', function() {
    document.getElementById('settingsModal').style.display = 'flex';
});
document.getElementById('closeSettingsModal')?.addEventListener('click', function() {
    document.getElementById('settingsModal').style.display = 'none';
});
document.getElementById('settingsModal')?.addEventListener('click', function(e) {
    if (e.target === this) {
        this.style.display = 'none';
    }
});
document.getElementById('showProfileBtn')?.addEventListener('click', function() {
    document.getElementById('showProfileBtn').className = 'btn btn-primary';
    document.getElementById('showSettingsBtn').className = 'btn btn-outline';
});
document.getElementById('showSettingsBtn')?.addEventListener('click', function() {
    document.getElementById('showSettingsBtn').className = 'btn btn-primary';
    document.getElementById('showProfileBtn').className = 'btn btn-outline';
});

// ЗАКРЫТИЕ МОДАЛЬНЫХ ОКОН
function setupModals() {
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.modal').forEach(modal => {
                modal.style.display = 'none';
            });
        });
    });
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            e.target.style.display = 'none';
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(modal => {
                modal.style.display = 'none';
            });
        }
    });
}

//  УВЕДОМЛЕНИЯ
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 12px;
        background: ${type === 'success' ? '#2ecc71' : type === 'error' ? '#e74c3c' : type === 'warning' ? '#f39c12' : '#3498db'};
        color: white;
        z-index: 10000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        font-weight: 500;
        max-width: 400px;
    `;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function setupEventListeners() {
    setupNavigation();
    setupModals();
}

document.addEventListener('DOMContentLoaded', init);