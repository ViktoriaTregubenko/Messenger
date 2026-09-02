const token = localStorage.getItem('token') || sessionStorage.getItem('token');
const urlParams = new URLSearchParams(window.location.search);
const userId = urlParams.get('userId');
let socket = null;
let currentUser = null;
let typingTimeout = null;
let currentFile = null;

let keyPair = null;
let peerPublicKey = null;

async function generateKeyPair() {
    try {
        keyPair = await window.crypto.subtle.generateKey(
            {
                name: 'RSA-OAEP',
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: 'SHA-256'
            },
            true,
            ['encrypt', 'decrypt']
        );
        const privateKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
        localStorage.setItem('privateKey_' + currentUser.id, JSON.stringify(privateKeyJwk));
        const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
        const publicKeyStr = JSON.stringify(publicKeyJwk);
        localStorage.setItem('publicKey_' + currentUser.id, publicKeyStr);
        return publicKeyStr;
    } catch (err) {
        throw err;
    }
}

async function getOrCreateKeys() {
    const storedPrivate = localStorage.getItem('privateKey_' + currentUser.id);
    if (storedPrivate) {
        try {
            const privateJwk = JSON.parse(storedPrivate);
            const privateKey = await window.crypto.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
            const publicJwk = JSON.parse(localStorage.getItem('publicKey_' + currentUser.id));
            const publicKey = await window.crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
            keyPair = { privateKey, publicKey };
            return localStorage.getItem('publicKey_' + currentUser.id);
        } catch {
            localStorage.removeItem('privateKey_' + currentUser.id);
            localStorage.removeItem('publicKey_' + currentUser.id);
            return await generateKeyPair();
        }
    } else {
        return await generateKeyPair();
    }
}

async function uploadPublicKey(publicKeyStr) {
    try {
        const res = await fetch('/api/keys/public', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ public_key: publicKeyStr })
        });
        if (!res.ok) throw new Error('Не удалось сохранить публичный ключ');
    } catch (err) {
        // Ошибка сохранения ключа – игнорируем, но пользователь может не зашифровать сообщения
    }
}

async function fetchPeerPublicKey(peerId) {
    try {
        const res = await fetch(`/api/keys/public/${peerId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Публичный ключ собеседника не найден');
        const data = await res.json();
        const publicJwk = JSON.parse(data.public_key);
        peerPublicKey = await window.crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
        return true;
    } catch {
        return false;
    }
}

async function encryptMessage(text, publicKey) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const encrypted = await window.crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        data
    );
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

function looksEncrypted(msg) {
    if (!msg || !msg.message) return false;
    if (msg.is_encrypted === 1 || msg.is_encrypted === '1' || msg.is_encrypted === true) return true;
    const m = msg.message;
    if (m.startsWith('{') && m.includes('"p"') && m.includes('"s"')) return true;
    return m.length > 100 && /^[A-Za-z0-9+/=]+$/.test(m);
}

async function decryptMessage(encryptedBase64, privateKey) {
    const binary = atob(encryptedBase64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        data[i] = binary.charCodeAt(i);
    }
    const decrypted = await window.crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        data
    );
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

async function encryptForBoth(text) {
    const peerCipher = peerPublicKey
        ? await encryptMessage(text, peerPublicKey)
        : '';
    const selfCipher = (keyPair && keyPair.publicKey)
        ? await encryptMessage(text, keyPair.publicKey)
        : '';
    return JSON.stringify({ p: peerCipher, s: selfCipher });
}

async function decryptPrivateMessage(raw, privateKey, isOwnMessage) {
    if (!raw) return '';
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && (obj.p || obj.s)) {
            const cipher = isOwnMessage ? (obj.s || obj.p) : (obj.p || obj.s);
            if (cipher) {
                return await decryptMessage(cipher, privateKey);
            }
            return '';
        }
    } catch (e) {}
    try {
        return await decryptMessage(raw, privateKey);
    } catch (e) {
        return '[Зашифрованное сообщение]';
    }
}

function formatMessageTime(dateString) {
    const date = new Date(dateString);
    if (isNaN(date)) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

if (!token || !userId) {
    window.location.href = 'login.html';
}

// ЗАГРУЗКА
async function loadChat() {
    try {
        const profileRes = await fetch('/api/profile', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        currentUser = await profileRes.json();

        const userRes = await fetch(`/api/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const otherUser = await userRes.json();
        document.getElementById('userName').textContent = otherUser.full_name || otherUser.username;
        document.getElementById('userStatus').innerHTML = otherUser.status === 'online' ? '🟢 В сети' : '⚫ Не в сети';

        const publicKeyStr = await getOrCreateKeys();
        await uploadPublicKey(publicKeyStr);
        await fetchPeerPublicKey(userId);

        await loadMessages();
        await markMessagesAsRead();
        initSocket();
        setupEventListeners();
        setupEditMessage();
        setupDeleteMessage();
        setupFileUpload();
    } catch {
        document.getElementById('messages').innerHTML = `
            <div style="text-align:center; padding:2rem; color:var(--danger);">
                 Ошибка загрузки чата<br>
                <button onclick="location.reload()" class="btn btn-primary">Обновить</button>
            </div>
        `;
    }
}

async function loadMessages() {
    try {
        const messagesRes = await fetch(`/api/messages/user/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const messages = await messagesRes.json();
        const container = document.getElementById('messages');

        for (let msg of messages) {
            const isOwnMessage = msg.from_user_id === currentUser.id;
            if (looksEncrypted(msg) && msg.message) {
                try {
                    msg.message = await decryptPrivateMessage(
                        msg.message,
                        keyPair.privateKey,
                        isOwnMessage
                    );
                } catch {
                    msg.message = '[Зашифрованное сообщение]';
                }
            }
            try {
                const reactionsRes = await fetch(`/api/messages/${msg.id}/reactions`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (reactionsRes.ok) {
                    msg.reactions = await reactionsRes.json();
                } else {
                    msg.reactions = [];
                }
            } catch {
                msg.reactions = [];
            }
        }

        if (messages.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-light);">Нет сообщений. Напишите первым!</div>';
        } else {
            container.innerHTML = messages.map(msg => renderMessage(msg)).join('');
        }
        container.scrollTop = container.scrollHeight;
    } catch {
        document.getElementById('messages').innerHTML = `
            <div style="text-align:center;padding:2rem;color:var(--danger);">
                 Ошибка загрузки сообщений
            </div>
        `;
    }
}

async function markMessagesAsRead() {
    try {
        await fetch(`/api/messages/user/${userId}/read`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
    } catch {}
}

function renderMessage(msg) {
    const isOwn = msg.from_user_id === currentUser.id;
    const isEdited = msg.edited_at != null;
    let content = '';
    let fileHtml = '';

    if (msg.message && msg.message.startsWith('[IMAGE]')) {
        const imageUrl = msg.message.replace('[IMAGE]', '');
        content = `<img src="${imageUrl}" style="max-width:300px;max-height:300px;border-radius:12px;cursor:pointer;" onclick="window.open('${imageUrl}','_blank')">`;
    } else {
        content = escapeHtml(msg.message || '');
    }

    if (msg.file_url) {
        const fileUrl = msg.file_url;
        const fileName = msg.file_name || 'Файл';
        const fileType = msg.file_type || 'file';
        if (fileType === 'image') {
            fileHtml = `<a href="${fileUrl}" target="_blank"><img src="${fileUrl}" style="max-width:200px; max-height:200px; border-radius:8px; margin-top:5px; cursor:pointer;"></a>`;
        } else if (fileType === 'audio') {
            fileHtml = `<audio controls src="${fileUrl}" style="width:100%; margin-top:5px; border-radius:8px;"></audio>`;
        } else if (fileType === 'video') {
            fileHtml = `<video controls src="${fileUrl}" style="max-width:100%; max-height:400px; border-radius:8px; margin-top:5px;"></video>`;
        } else {
            fileHtml = `<a href="${fileUrl}" target="_blank" style="display:inline-block; margin-top:5px; padding:5px 10px; background:var(--pink); color:white; border-radius:8px; text-decoration:none;">📎 ${escapeHtml(fileName)}</a>`;
        }
    }

    const time = formatMessageTime(msg.created_at);
    const fullTime = new Date(msg.created_at).toLocaleString('ru-RU');
    const editMark = isEdited ? ' (ред.)' : '';

    let canEdit = false;
    let canDelete = false;
    if (isOwn) {
        canEdit = true;
        canDelete = true;
    }

    const reactions = msg.reactions || [];
    const grouped = {};
    reactions.forEach(r => {
        grouped[r.reaction] = (grouped[r.reaction] || 0) + 1;
    });
    const currentUserReaction = reactions.find(r => r.user_id === currentUser.id)?.reaction || null;

    let reactionsHtml = '';
    const emojiList = Object.keys(grouped);
    if (emojiList.length > 0) {
        reactionsHtml = `<div class="message-reactions">`;
        emojiList.forEach(emoji => {
            const count = grouped[emoji];
            const isActive = (currentUserReaction === emoji);
            reactionsHtml += `
                <span class="reaction-badge ${isActive ? 'active' : ''}" data-emoji="${emoji}" data-message-id="${msg.id}">
                    ${emoji} ${count}
                </span>
            `;
        });
        reactionsHtml += `<span class="reaction-add" data-message-id="${msg.id}">❤️</span>`;
        reactionsHtml += `</div>`;
    } else {
        reactionsHtml = `<div class="message-reactions">
            <span class="reaction-add" data-message-id="${msg.id}">❤️</span>
        </div>`;
    }

    return `
        <div class="message ${isOwn ? 'message-own' : ''}" data-message-id="${msg.id}">
           <img src="${msg.avatar || 'https://via.placeholder.com/35'}" class="message-avatar" alt="avatar" onerror="this.src='https://via.placeholder.com/35'" style="cursor:pointer;" onclick="showUserProfile(${msg.from_user_id})">
            <div class="message-content">
                <div class="message-sender">${escapeHtml(msg.username || 'Пользователь')}</div>
                <div class="message-text">${content}</div>
                ${fileHtml}
                <div class="message-time" title="${fullTime}">${time}${editMark}</div>
                ${reactionsHtml}
                <div class="message-actions">
                    ${canEdit ? `<button class="edit-msg-btn" data-id="${msg.id}">✏️</button>` : ''}
                    ${canDelete ? `<button class="delete-msg-btn" data-id="${msg.id}">🗑️</button>` : ''}
                </div>
            </div>
        </div>
    `;
}

// WEBSOCKET
function initSocket() {
    socket = io({ auth: { token } });

    socket.on('private_message_encrypted', async (message) => {
        if (message.from_user_id === parseInt(userId) || message.to_user_id === parseInt(userId)) {
            let decryptedText = message.message;
            if (looksEncrypted(message) && message.message) {
                if (!keyPair || !keyPair.privateKey) {
                    decryptedText = '[Нет ключа]';
                } else {
                    try {
                        const isOwnMessage = message.from_user_id === currentUser.id;
                        decryptedText = await decryptPrivateMessage(
                            message.message,
                            keyPair.privateKey,
                            isOwnMessage
                        );
                    } catch {
                        decryptedText = '[Ошибка расшифровки]';
                    }
                }
            }
            message.message = decryptedText;

            const container = document.getElementById('messages');
            if (container.children.length === 1 && container.children[0].innerText.includes('Нет сообщений')) {
                container.innerHTML = '';
            }
            container.innerHTML += renderMessage(message);
            container.scrollTop = container.scrollHeight;
            if (message.from_user_id !== currentUser.id) {
                playNotificationSound();
                markMessagesAsRead();
            }
        }
    });

    socket.on('user_status', ({ userId: id, status }) => {
        if (id === parseInt(userId)) {
            document.getElementById('userStatus').innerHTML = status === 'online' ? '🟢 В сети' : '⚫ Не в сети';
        }
    });

    socket.on('user_typing', ({ user_id, is_typing }) => {
        if (user_id === parseInt(userId)) {
            const indicator = document.getElementById('typingIndicator');
            indicator.textContent = is_typing ? 'Печатает...' : '';
        }
    });

    socket.on('message_edited', async (data) => {
        const msgDiv = document.querySelector(`.message[data-message-id="${data.id}"]`);
        if (msgDiv) {
            const textDiv = msgDiv.querySelector('.message-text');
            if (textDiv) {
                let newText = data.message;
                if (looksEncrypted(data) && data.message) {
                    try {
                        const isOwnMessage = data.from_user_id === currentUser.id;
                        newText = await decryptPrivateMessage(
                            data.message,
                            keyPair.privateKey,
                            isOwnMessage
                        );
                    } catch {
                        newText = '[Ошибка расшифровки]';
                    }
                }
                textDiv.innerHTML = escapeHtml(newText);
            }
            const timeDiv = msgDiv.querySelector('.message-time');
            if (timeDiv) timeDiv.textContent = formatMessageTime(data.edited_at) + ' (ред.)';
        }
    });

    socket.on('message_deleted', (data) => {
        const msgDiv = document.querySelector(`.message[data-message-id="${data.id}"]`);
        if (msgDiv) msgDiv.remove();
    });

    socket.on('reaction_updated', () => {
        loadMessages();
    });
}

// ОТПРАВКА СООБЩЕНИЯ

async function sendMessage() {
    const input = document.getElementById('messageInput');
    if (!input) return;
    const message = input.value.trim();
    if (!message && !currentFile) {
        showNotification('Введите сообщение или выберите файл', 'warning');
        return;
    }
    if (!socket || !socket.connected) {
        showNotification('Нет соединения с сервером', 'error');
        return;
    }

    // Если нет ключа собеседника – пробуем получить его ещё раз
    if (!peerPublicKey) {
        const fetched = await fetchPeerPublicKey(userId);
        if (!fetched) {
            showNotification('Собеседник ещё не настроил шифрование. Попросите его открыть личный чат.', 'warning');
            return;
        }
    }

    // Если нет своих ключей – генерируем
    if (!keyPair || !keyPair.publicKey) {
        const publicKeyStr = await getOrCreateKeys();
        if (!publicKeyStr) {
            showNotification('Ошибка генерации ключей', 'error');
            return;
        }
        await uploadPublicKey(publicKeyStr);
    }

    const localId = 'local_' + Date.now();

    let finalMessage = message || '';
    let isEncrypted = 0;
    if (message) {
        if (!peerPublicKey || !keyPair || !keyPair.publicKey) {
            showNotification('Нет ключей для шифрования', 'error');
            return;
        }
        try {
            finalMessage = await encryptForBoth(message);
            isEncrypted = 1;
        } catch (e) {
            showNotification('Ошибка шифрования сообщения', 'error');
            return;
        }
    }

    socket.emit('send_encrypted_message', {
        localId: localId,
        to_user_id: parseInt(userId),
        encrypted_message: finalMessage,
        is_encrypted: isEncrypted,
        file_url: currentFile?.url || null,
        file_type: currentFile?.type || null,
        file_name: currentFile?.name || null
    });

    const localMessage = {
        id: localId,
        from_user_id: currentUser.id,
        username: currentUser.username,
        full_name: currentUser.full_name,
        avatar: currentUser.avatar,
        message: message,
        created_at: new Date().toISOString(),
        is_encrypted: 0,
        file_url: currentFile?.url || null,
        file_type: currentFile?.type || null,
        file_name: currentFile?.name || null,
        edited_at: null,
        deleted_at: null,
        to_user_id: parseInt(userId),
        reactions: []
    };

    const container = document.getElementById('messages');
    if (container.children.length === 1 && container.children[0].innerText.includes('Нет сообщений')) {
        container.innerHTML = '';
    }
    container.innerHTML += renderMessage(localMessage);
    container.scrollTop = container.scrollHeight;
    input.value = '';
    currentFile = null;
    input.style.height = 'auto';
}
// ФУНКЦИИ ДЛЯ РЕАКЦИЙ
async function toggleReaction(messageId, emoji) {
    try {
        const res = await fetch(`/api/messages/${messageId}/reactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ reaction: emoji })
        });
        if (!res.ok) throw new Error('Ошибка обновления реакции');
        loadMessages();
    } catch {
        showNotification('Не удалось поставить реакцию', 'error');
    }
}

function showReactionPicker(messageId) {
    const emojis = ['❤️', '👍', '👎', '😂', '😮', '😢', '😡', '👏','🤘' ,'🔥','👀','🙏'];
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:white;border-radius:50px;padding:10px 15px;box-shadow:0 4px 20px rgba(0,0,0,0.2);z-index:9999;display:flex;gap:8px;';
    emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.textContent = emoji;
        span.style.cssText = 'font-size:28px;cursor:pointer;padding:4px 6px;transition:transform 0.1s;';
        span.onmouseover = () => span.style.transform = 'scale(1.3)';
        span.onmouseout = () => span.style.transform = 'scale(1)';
        span.onclick = () => {
            toggleReaction(messageId, emoji);
            picker.remove();
        };
        picker.appendChild(span);
    });
    document.body.appendChild(picker);
    setTimeout(() => {
        document.addEventListener('click', function closePicker(e) {
            if (!picker.contains(e.target)) {
                picker.remove();
                document.removeEventListener('click', closePicker);
            }
        });
    }, 10);
}

// ЗАГРУЗКА ФАЙЛОВ
function setupFileUpload() {
    const fileBtn = document.getElementById('fileBtn');
    const fileInput = document.getElementById('fileInput');
    if (!fileBtn || !fileInput) return;

    fileBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async function(e) {
        const file = this.files[0];
        if (!file) return;
        this.value = '';

        if (file.size > 50 * 1024 * 1024) {
            showNotification('Файл слишком большой. Максимум 50MB', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);
        try {
            showNotification('⏳ Загрузка файла...', 'info');
            const res = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.error || 'Ошибка загрузки');
            }
            const data = await res.json();
            currentFile = {
                url: data.fileUrl,
                type: data.fileType,
                name: data.fileName
            };
            sendMessage();
            showNotification(' Файл отправлен', 'success');
        } catch (error) {
            showNotification(' ' + error.message, 'error');
        }
    });
}

// РЕДАКТИРОВАНИЕ/УДАЛЕНИЕ 
function setupEditMessage() {
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('.edit-msg-btn');
        if (!btn) return;
        const messageId = btn.dataset.id;
        const messageDiv = btn.closest('.message');
        const textDiv = messageDiv.querySelector('.message-text');
        if (!textDiv) return;
        const currentText = textDiv.innerText;
        openEditModal(messageId, currentText);
    });
}

async function editMessage(messageId, newText) {
    try {
        let finalText = newText;
        if (peerPublicKey && keyPair && keyPair.publicKey) {
            try {
                finalText = await encryptForBoth(newText);
            } catch {
                showNotification('Ошибка шифрования', 'error');
                return;
            }
        }
        const res = await fetch(`/api/messages/${messageId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ message: finalText })
        });
        if (res.ok) {
            const data = await res.json();
            const msgDiv = document.querySelector(`.message[data-message-id="${messageId}"]`);
            if (msgDiv) {
                const textDiv = msgDiv.querySelector('.message-text');
                if (textDiv) {
                    textDiv.innerHTML = escapeHtml(newText);
                }
                const timeDiv = msgDiv.querySelector('.message-time');
                if (timeDiv) timeDiv.textContent = formatMessageTime(data.edited_at) + ' (ред.)';
            }
        } else {
            const error = await res.json();
            alert(error.error || 'Ошибка редактирования');
        }
    } catch {
        alert('Ошибка редактирования');
    }
}

function setupDeleteMessage() {
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('.delete-msg-btn');
        if (!btn) return;
        const messageId = btn.dataset.id;
        openConfirmModal('Вы уверены, что хотите удалить это сообщение?', function() {
            deleteMessage(messageId);
        });
    });
}

async function deleteMessage(messageId) {
    try {
        const res = await fetch(`/api/messages/${messageId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const msgDiv = document.querySelector(`.message[data-message-id="${messageId}"]`);
            if (msgDiv) msgDiv.remove();
        } else {
            const error = await res.json();
            alert(error.error || 'Ошибка удаления');
        }
    } catch {
        alert('Ошибка удаления');
    }
}

// ОБРАБОТЧИКИ СОБЫТИЙ
function setupEventListeners() {
    const sendBtn = document.getElementById('sendBtn');
    const messageInput = document.getElementById('messageInput');

    if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
    }

    if (messageInput) {
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        messageInput.addEventListener('input', () => {
            if (socket && socket.connected) {
                socket.emit('typing', {
                    to_user_id: parseInt(userId),
                    is_typing: true
                });
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    if (socket && socket.connected) {
                        socket.emit('typing', {
                            to_user_id: parseInt(userId),
                            is_typing: false
                        });
                    }
                }, 1000);
            }
        });
    }

    document.addEventListener('click', async function(e) {
        const badge = e.target.closest('.reaction-badge');
        if (badge) {
            const messageId = badge.dataset.messageId;
            const emoji = badge.dataset.emoji;
            await toggleReaction(messageId, emoji);
            return;
        }
        const addBtn = e.target.closest('.reaction-add');
        if (addBtn) {
            const messageId = addBtn.dataset.messageId;
            showReactionPicker(messageId);
            return;
        }
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('token');
            sessionStorage.removeItem('token');
            if (socket) socket.disconnect();
            window.location.href = 'login.html';
        });
    }
}

// ВСПОМОГАТЕЛЬНЫЕ
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${type === 'error' ? '#e74c3c' : type === 'success' ? '#2ecc71' : '#3498db'};
        color: white;
        padding: 12px 24px;
        border-radius: 50px;
        z-index: 9999;
        animation: slideUp 0.3s ease;
        font-weight: 500;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    `;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.animation = 'slideDown 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function playNotificationSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.value = 0.1;
        oscillator.start();
        setTimeout(() => oscillator.stop(), 100);
    } catch {}
}

// МОДАЛЬНЫЕ ОКНА
let pendingEditMessageId = null;
let pendingConfirmCallback = null;

function openEditModal(messageId, currentText) {
    pendingEditMessageId = messageId;
    document.getElementById('editMessageInput').value = currentText;
    document.getElementById('editMessageModal').style.display = 'flex';
    document.getElementById('editMessageInput').focus();
}

function closeEditModal() {
    document.getElementById('editMessageModal').style.display = 'none';
    pendingEditMessageId = null;
}

function openConfirmModal(message, onConfirm) {
    document.getElementById('confirmMessage').textContent = message;
    pendingConfirmCallback = onConfirm;
    document.getElementById('confirmModal').style.display = 'flex';
}

function closeConfirmModal() {
    document.getElementById('confirmModal').style.display = 'none';
    pendingConfirmCallback = null;
}

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('closeEditModal')?.addEventListener('click', closeEditModal);
    document.getElementById('closeConfirmModal')?.addEventListener('click', closeConfirmModal);

    document.getElementById('editMessageModal')?.addEventListener('click', function(e) {
        if (e.target === this) closeEditModal();
    });
    document.getElementById('confirmModal')?.addEventListener('click', function(e) {
        if (e.target === this) closeConfirmModal();
    });

    document.getElementById('saveEditBtn')?.addEventListener('click', function() {
        const newText = document.getElementById('editMessageInput').value.trim();
        if (!newText) {
            alert('Сообщение не может быть пустым');
            return;
        }
        if (pendingEditMessageId) {
            editMessage(pendingEditMessageId, newText);
            closeEditModal();
        }
    });

    document.getElementById('cancelEditBtn')?.addEventListener('click', closeEditModal);

    document.getElementById('confirmYesBtn')?.addEventListener('click', function() {
        if (pendingConfirmCallback) {
            pendingConfirmCallback();
            closeConfirmModal();
        }
    });

    document.getElementById('confirmNoBtn')?.addEventListener('click', closeConfirmModal);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (document.getElementById('editMessageModal').style.display === 'flex') closeEditModal();
            if (document.getElementById('confirmModal').style.display === 'flex') closeConfirmModal();
        }
    });
});

if (!token) {
    window.location.href = 'login.html';
}
if (!userId) {
    alert('ID пользователя не указан');
    window.location.href = 'friends.html';
}

document.addEventListener('DOMContentLoaded', loadChat);