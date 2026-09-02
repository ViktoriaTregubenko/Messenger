const token = localStorage.getItem('token') || sessionStorage.getItem('token');
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('id');
let socket = null;
let currentUser = null;
let typingTimeout = null;
let currentFile = null;

function formatMessageTime(dateString) {
    const date = new Date(dateString);
    if (isNaN(date)) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

if (!token) {
    window.location.href = 'login.html';
}
if (!roomId) {
    alert('ID комнаты не указан');
    window.location.href = 'rooms.html';
    throw new Error('No room ID');
}

// ЗАГРУЗКА 
async function loadRoom() {
    try {
        const profileRes = await fetch('/api/profile', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!profileRes.ok) throw new Error('Ошибка профиля');
        currentUser = await profileRes.json();

        const roomRes = await fetch(`/api/rooms/${roomId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!roomRes.ok) {
            if (roomRes.status === 404) {
                alert('Комната не найдена');
                window.location.href = 'rooms.html';
                return;
            }
            throw new Error(`Ошибка загрузки комнаты: ${roomRes.status}`);
        }

        const room = await roomRes.json();
        document.getElementById('roomName').textContent = room.name;
        if (room.avatar) {
            document.getElementById('roomAvatar').src = room.avatar;
        }

        const membersRes = await fetch(`/api/rooms/${roomId}/members`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (membersRes.ok) {
            const members = await membersRes.json();
            const currentMember = members.find(m => m.id === currentUser.id);
            window._isRoomAdmin = currentMember?.role === 'admin' || room.created_by === currentUser.id;
        } else {
            window._isRoomAdmin = false;
        }

        const avatarBtn = document.getElementById('changeRoomAvatarBtn');
        if (avatarBtn) {
            avatarBtn.style.display = (room.created_by === currentUser.id) ? 'flex' : 'none';
        }

        await loadRoomMembers(roomId);
        await loadRoomMessages(roomId);
        initSocket();
        setupEventListeners();
        setupRoomAvatarUpload();
        setupMemberManagement();
        setupEditMessage();
        setupDeleteMessage();
        setupFileUpload();
    } catch (error) {
        document.getElementById('messages').innerHTML = `
            <div style="text-align:center; padding:2rem; color:var(--danger);">
                 Ошибка загрузки комнаты<br>
                <small style="color:var(--facebook-gray);">${error.message}</small>
                <br><br>
                <button onclick="location.reload()" class="btn btn-primary">Обновить</button>
            </div>
        `;
    }
}

async function loadRoomMembers(roomId) {
    try {
        const membersRes = await fetch(`/api/rooms/${roomId}/members`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!membersRes.ok) throw new Error(`Ошибка участников: ${membersRes.status}`);
        const members = await membersRes.json();
        document.getElementById('roomMembers').textContent = `👥 ${members.length}`;
        window._roomMembers = members;
    } catch {
        document.getElementById('roomMembers').textContent = '👥 Ошибка';
    }
}

async function loadRoomMessages(roomId) {
    try {
        const messagesRes = await fetch(`/api/messages/room/${roomId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!messagesRes.ok) throw new Error(`Ошибка сообщений: ${messagesRes.status}`);
        const messages = await messagesRes.json();
        const container = document.getElementById('messages');

        for (let msg of messages) {
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
            container.innerHTML = `
                <div style="text-align:center;padding:2rem;color:var(--facebook-gray);">
                    <p style="font-size:3rem;">💬</p>
                    <p>Нет сообщений в этой комнате</p>
                    <p style="font-size:0.85rem;">Напишите первое сообщение!</p>
                </div>
            `;
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

//  ОТРИСОВКА СООБЩЕНИЯ
function renderMessage(msg) {
    const isOwn = msg.from_user_id === currentUser.id;
    const isEdited = msg.edited_at != null;

    let content = '';
    let fileHtml = '';

    if (msg.message && msg.message.startsWith('[IMAGE]')) {
        const imageUrl = msg.message.replace('[IMAGE]', '');
        content = `<img src="${imageUrl}" class="message-image" onclick="window.open('${imageUrl}','_blank')" style="max-width:300px;max-height:300px;border-radius:12px;cursor:pointer;">`;
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
    } else if (window._isRoomAdmin && msg.to_room_id) {
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
            <span class="reaction-add" data-message-id="${msg.id}">❤️+-</span>
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

//  WEBSOCKET 
function initSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => {
        socket.emit('join_room', { room_id: parseInt(roomId) });
    });

    socket.on('new_message', (message) => {
        if (message.to_room_id !== parseInt(roomId)) return;
        const container = document.getElementById('messages');
        if (!container) return;
        if (container.children.length === 1 && container.children[0].innerText.includes('Нет сообщений')) {
            container.innerHTML = '';
        }
        message.reactions = [];
        container.innerHTML += renderMessage(message);
        container.scrollTop = container.scrollHeight;
        if (message.from_user_id !== currentUser.id) {
            playNotificationSound();
        }
    });

    socket.on('user_typing', ({ user_id, username, is_typing }) => {
        const indicator = document.getElementById('typingIndicator');
        if (!indicator) return;
        if (is_typing && user_id !== currentUser.id) {
            indicator.textContent = `${escapeHtml(username)} печатает...`;
            indicator.style.display = 'block';
        } else {
            indicator.textContent = '';
            indicator.style.display = 'none';
        }
    });

    socket.on('member_added', (data) => {
        if (data.room_id === parseInt(roomId)) {
            showNotification(`👋 ${data.user.full_name || data.user.username} присоединился к комнате`);
            loadRoomMembers(roomId);
            if (document.getElementById('manageMembersModal').style.display === 'flex') {
                renderMembersList();
            }
        }
    });

    socket.on('member_removed', (data) => {
        if (data.room_id === parseInt(roomId)) {
            if (data.user_id === currentUser.id) {
                showNotification(' Вас удалили из комнаты');
                setTimeout(() => window.location.href = 'rooms.html', 2000);
            } else {
                showNotification(` Пользователь покинул комнату`);
                loadRoomMembers(roomId);
                if (document.getElementById('manageMembersModal').style.display === 'flex') {
                    renderMembersList();
                }
            }
        }
    });

    socket.on('member_role_changed', (data) => {
        if (data.room_id === parseInt(roomId)) {
            showNotification(` Роль пользователя изменена на ${data.role}`);
            loadRoomMembers(roomId);
            if (document.getElementById('manageMembersModal').style.display === 'flex') {
                renderMembersList();
            }
        }
    });

    socket.on('message_edited', (data) => {
        const msgDiv = document.querySelector(`.message[data-message-id="${data.id}"]`);
        if (msgDiv) {
            const textDiv = msgDiv.querySelector('.message-text');
            if (textDiv) textDiv.innerHTML = escapeHtml(data.message);
            const timeDiv = msgDiv.querySelector('.message-time');
            if (timeDiv) timeDiv.textContent = formatMessageTime(data.edited_at) + ' (ред.)';
        }
    });

    socket.on('message_deleted', (data) => {
        const msgDiv = document.querySelector(`.message[data-message-id="${data.id}"]`);
        if (msgDiv) msgDiv.remove();
    });

    socket.on('reaction_updated', () => {
        loadRoomMessages(roomId);
    });
}

//  ОТПРАВКА СООБЩЕНИЯ С ФАЙЛОМ 
function sendMessage() {
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

    // ГЕНЕРАЦИЯ ЛОКАЛЬНОГО ID
    const localId = 'local_' + Date.now();

    socket.emit('send_message', {
        localId: localId,
        to_room_id: parseInt(roomId),
        message: message || '',
        file_url: currentFile?.url || null,
        file_type: currentFile?.type || null,
        file_name: currentFile?.name || null
    });

    input.value = '';
    currentFile = null;
    input.style.height = 'auto';
}

//  ФУНКЦИИ ДЛЯ РЕАКЦИЙ 
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
        loadRoomMessages(roomId);
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

//  ЗАГРУЗКА ФАЙЛОВ 
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
            showNotification(' Загрузка файла...', 'info');
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
            showNotification('✅ Файл отправлен', 'success');
        } catch (error) {
            showNotification('❌ ' + error.message, 'error');
        }
    });
}

//  РЕДАКТИРОВАНИЕ/УДАЛЕНИЕ 
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
        const res = await fetch(`/api/messages/${messageId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ message: newText })
        });
        if (res.ok) {
            const data = await res.json();
            const msgDiv = document.querySelector(`.message[data-message-id="${messageId}"]`);
            if (msgDiv) {
                const textDiv = msgDiv.querySelector('.message-text');
                if (textDiv) textDiv.innerHTML = escapeHtml(newText);
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

//  УПРАВЛЕНИЕ УЧАСТНИКАМИ 
function setupMemberManagement() {
    const manageBtn = document.getElementById('manageMembersBtn');
    const modal = document.getElementById('manageMembersModal');
    const closeBtn = document.getElementById('closeManageMembers');
    const searchInput = document.getElementById('addMemberSearch');
    const resultsContainer = document.getElementById('addMemberResults');

    if (!manageBtn || !modal) return;

    manageBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        renderMembersList();
    });

    closeBtn?.addEventListener('click', () => {
        modal.style.display = 'none';
        searchInput.value = '';
        resultsContainer.innerHTML = '';
    });

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
            searchInput.value = '';
            resultsContainer.innerHTML = '';
        }
    });

    searchInput?.addEventListener('input', async function() {
        const query = this.value.trim();
        if (query.length < 2) {
            resultsContainer.innerHTML = '';
            return;
        }
        try {
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}&room_id=${roomId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Ошибка поиска');
            const users = await res.json();
            if (users.length === 0) {
                resultsContainer.innerHTML = '<div style="padding:0.5rem; color:var(--text-light);">Ничего не найдено</div>';
                return;
            }
            resultsContainer.innerHTML = users.map(user => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:0.3rem 0.5rem; border-bottom:1px solid var(--border);">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                        <img src="${m.avatar || 'https://via.placeholder.com/40'}" style="width:40px; height:40px; border-radius:50%; object-fit:cover; cursor:pointer;" onclick="showUserProfile(${m.id})">
                        <span>${escapeHtml(user.full_name || user.username)} (@${escapeHtml(user.username)})</span>
                    </div>
                    <button onclick="addMemberToRoom('${user.username}')" class="btn btn-success" style="padding:0.1rem 0.6rem; font-size:0.8rem;">➕</button>
                </div>
            `).join('');
        } catch {
            resultsContainer.innerHTML = '<div style="padding:0.5rem; color:var(--danger);">Ошибка поиска</div>';
        }
    });
}

window.addMemberToRoom = async function(username) {
    try {
        const res = await fetch(`/api/rooms/${roomId}/members`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ username_or_email: username })
        });
        if (res.ok) {
            document.getElementById('addMemberSearch').value = '';
            document.getElementById('addMemberResults').innerHTML = '';
            await loadRoomMembers(roomId);
            renderMembersList();
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка добавления', 'error');
        }
    } catch {
        showNotification('Ошибка при добавлении участника', 'error');
    }
};

async function renderMembersList() {
    const container = document.getElementById('membersList');
    try {
        const membersRes = await fetch(`/api/rooms/${roomId}/members`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!membersRes.ok) throw new Error('Ошибка загрузки');
        const members = await membersRes.json();
        const room = await fetch(`/api/rooms/${roomId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        }).then(r => r.json());

        const isCreator = room.created_by === currentUser.id;
        const currentMember = members.find(m => m.id === currentUser.id);
        const isAdmin = currentMember?.role === 'admin';

        if (members.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:1rem;">Нет участников</div>';
            return;
        }

        container.innerHTML = members.map(m => {
            const isSelf = m.id === currentUser.id;
            const isRoomCreator = m.id === room.created_by;
            const canManage = isCreator || (isAdmin && !isRoomCreator && !isSelf);

            let roleBadge = '';
            if (isRoomCreator) roleBadge = ' 👑 Создатель';
            else if (m.role === 'admin') roleBadge = ' ⭐ Админ';

            let actions = '';
            if (canManage && !isRoomCreator) {
                actions += `
                    <button onclick="removeMemberFromRoom(${m.id})" class="btn btn-danger" style="padding:0.1rem 0.5rem; font-size:0.7rem;">🗑️</button>
                `;
                if (m.role !== 'admin' && isCreator) {
                    actions += `
                        <button onclick="setAdmin(${m.id})" class="btn btn-primary" style="padding:0.1rem 0.5rem; font-size:0.7rem;">⭐</button>
                    `;
                } else if (m.role === 'admin' && isCreator) {
                    actions += `
                        <button onclick="removeAdmin(${m.id})" class="btn btn-outline" style="padding:0.1rem 0.5rem; font-size:0.7rem;">⬇️</button>
                    `;
                }
            } else if (isSelf && !isRoomCreator) {
                actions = `
                    <button onclick="leaveRoom()" class="btn btn-danger" style="padding:0.1rem 0.5rem; font-size:0.7rem;">🚪 Выйти</button>
                `;
            }

            return `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem; border-bottom:1px solid var(--border);">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                        <img src="${m.avatar || 'https://via.placeholder.com/40'}" style="width:40px; height:40px; border-radius:50%; object-fit:cover;">
                        <div>
                            <strong>${escapeHtml(m.full_name || m.username)}</strong>
                            <span style="font-size:0.8rem; color:var(--text-light);">${roleBadge}</span>
                            <div style="font-size:0.7rem; color:var(--text-light);">@${escapeHtml(m.username)}</div>
                        </div>
                    </div>
                    <div style="display:flex; gap:0.3rem;">
                        ${actions}
                    </div>
                </div>
            `;
        }).join('');
    } catch {
        container.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--danger);">Ошибка загрузки участников</div>';
    }
}

window.removeMemberFromRoom = async function(userId) {
    openConfirmModal('Удалить этого участника из комнаты?', async function() {
        try {
            const res = await fetch(`/api/rooms/${roomId}/members/${userId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                await loadRoomMembers(roomId);
                renderMembersList();
            } else {
                const error = await res.json();
                showNotification(error.error || 'Ошибка удаления', 'error');
            }
        } catch {
            showNotification('Ошибка при удалении', 'error');
        }
    });
};

window.setAdmin = async function(userId) {
    try {
        const res = await fetch(`/api/rooms/${roomId}/members/${userId}/admin`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            await loadRoomMembers(roomId);
            renderMembersList();
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка', 'error');
        }
    } catch {
        showNotification('Ошибка при назначении', 'error');
    }
};

window.removeAdmin = async function(userId) {
    openConfirmModal('Понизить администратора до участника?', async function() {
        try {
            const res = await fetch(`/api/rooms/${roomId}/members/${userId}/admin`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                await loadRoomMembers(roomId);
                renderMembersList();
            } else {
                const error = await res.json();
                showNotification(error.error || 'Ошибка', 'error');
            }
        } catch {
            showNotification('Ошибка при понижении', 'error');
        }
    });
};

window.leaveRoom = async function() {
    openConfirmModal('Вы уверены, что хотите покинуть комнату?', async function() {
        try {
            const res = await fetch(`/api/rooms/${roomId}/members/${currentUser.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                showNotification(' Вы покинули комнату', 'success');
                setTimeout(() => window.location.href = 'rooms.html', 1000);
            } else {
                const error = await res.json();
                showNotification(error.error || 'Ошибка', 'error');
            }
        } catch {
            showNotification('Ошибка при выходе', 'error');
        }
    });
};

//  ОБРАБОТЧИКИ СООБЩЕНИЙ 
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
                    to_room_id: parseInt(roomId),
                    is_typing: true
                });
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    if (socket && socket.connected) {
                        socket.emit('typing', {
                            to_room_id: parseInt(roomId),
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

//  АВАТАР КОМНАТЫ 
function setupRoomAvatarUpload() {
    const changeBtn = document.getElementById('changeRoomAvatarBtn');
    const fileInput = document.getElementById('roomAvatarInput');
    if (!changeBtn || !fileInput) return;

    changeBtn.addEventListener('click', () => fileInput.click());

    const textBtn = document.getElementById('changeRoomAvatarTextBtn');
    if (textBtn) {
        textBtn.addEventListener('click', () => fileInput.click());
    }

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showNotification('Пожалуйста, выберите изображение', 'warning');
            fileInput.value = '';
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            showNotification('Изображение слишком большое. Максимум 2MB', 'warning');
            fileInput.value = '';
            return;
        }
        try {
            showNotification(' Загрузка аватара...', 'info');
            const base64 = await fileToBase64(file);
            const res = await fetch(`/api/rooms/${roomId}/avatar`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ avatar: base64 })
            });
            if (res.ok) {
                showNotification(' Аватар комнаты обновлён!', 'success');
                document.getElementById('roomAvatar').src = base64;
            } else {
                const error = await res.json();
                showNotification(error.error || 'Ошибка загрузки', 'error');
            }
        } catch {
            showNotification('Ошибка при загрузке аватара', 'error');
        }
        fileInput.value = '';
    });
}

//  ВСПОМОГАТЕЛЬНЫЕ 
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
    });
}

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

//  МОДАЛЬНЫЕ ОКНА 
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
if (!roomId) {
    alert('ID комнаты не указан');
    window.location.href = 'rooms.html';
    throw new Error('No room ID');
}

document.addEventListener('DOMContentLoaded', loadRoom);