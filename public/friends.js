const token = localStorage.getItem('token') || sessionStorage.getItem('token');
let socket = null;
let currentUser = null;
let friendsList = [];
let pendingConfirmCallback = null;

if (!token) {
    window.location.href = 'login.html';
}

//МОДАЛЬНОЕ ОКНО ПОДТВЕРЖДЕНИЯ
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

// ЗАГРУЗКА ДРУЗЕЙ
async function loadFriends() {
    try {
        const profileRes = await fetch('/api/profile', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        currentUser = await profileRes.json();

        const res = await fetch('/api/friends', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        friendsList = await res.json();

        const container = document.getElementById('friendsList');
        if (friendsList.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-light);">У вас пока нет друзей. Добавьте их через поиск!</div>';
            return;
        }

        container.innerHTML = friendsList.map(friend => `
            <div class="list-item" data-user-id="${friend.id}">
                <div class="item-info" onclick="showUserProfile(${friend.id})" style="cursor:pointer; flex:1;">
                    <img src="${friend.avatar || 'https://via.placeholder.com/50'}" class="item-avatar">
                    <div>
                        <div>
                            <strong>${escapeHtml(friend.full_name || friend.username)}</strong>
                            <span class="item-status status-${friend.status}"></span>
                        </div>
                        <div style="font-size: 12px; color: var(--text-light);">@${friend.username}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button onclick="window.location.href='private-chat.html?userId=${friend.id}'" class="btn btn-primary" style="padding: 0.2rem 0.8rem;">💬</button>
                    <button onclick="removeFriend(${friend.id})" class="btn btn-danger" style="padding: 0.2rem 0.8rem;">🗑️</button>
                </div>
            </div>
        `).join('');

        try {
            const requestsRes = await fetch('/api/friends/pending', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const requests = await requestsRes.json();
            document.getElementById('requestsCount').textContent = requests.length;
        } catch {
            document.getElementById('requestsCount').textContent = '0';
        }

       /* if (!socket) {
            socket = io({ auth: { token } });
            socket.on('friend_request_received', () => {
                const count = parseInt(document.getElementById('requestsCount').textContent) || 0;
                document.getElementById('requestsCount').textContent = count + 1;
            });
        }
            */

    } catch {
        document.getElementById('friendsList').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--danger);">❌ Ошибка загрузки друзей</div>';
    }
}

// ПОИСК
document.getElementById('globalSearchInput')?.addEventListener('input', async function(e) {
    const query = this.value.trim();
    const resultsContainer = document.getElementById('searchResults');
    if (query.length < 2) {
        resultsContainer.innerHTML = '';
        return;
    }

    try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Ошибка поиска');
        const users = await res.json();

        if (users.length === 0) {
            resultsContainer.innerHTML = '<div style="padding: 0.5rem; color: var(--text-light);">Ничего не найдено</div>';
            return;
        }

        resultsContainer.innerHTML = users.map(user => {
            const isFriend = friendsList.some(f => f.id === user.id);
            return `
                <div class="search-result-item" style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem; border-bottom:1px solid var(--border);">
                    <div onclick="showUserProfile(${user.id})" style="flex:1; cursor:pointer; display:flex; align-items:center; gap:0.5rem;">
                        <img src="${user.avatar || 'https://via.placeholder.com/40'}" style="width:40px; height:40px; border-radius:50%; object-fit:cover;">
                        <div>
                            <strong>${user.full_name || user.username}</strong>
                            <div style="font-size:12px; color:var(--text-light);">@${user.username}</div>
                        </div>
                    </div>
                    <div style="display:flex; gap:0.3rem;">
                        ${isFriend ? `
                            <button onclick="removeFriend(${user.id})" class="btn btn-danger" style="padding:0.1rem 0.5rem; font-size:0.8rem;">Удалить</button>
                            <button onclick="window.location.href='private-chat.html?userId=${user.id}'" class="btn btn-primary" style="padding:0.1rem 0.5rem; font-size:0.8rem;">💬</button>
                        ` : `
                            <button onclick="addFriend('${user.username}')" class="btn btn-success" style="padding:0.1rem 0.5rem; font-size:0.8rem;">➕ Добавить</button>
                        `}
                    </div>
                </div>
            `;
        }).join('');
    } catch {
        resultsContainer.innerHTML = '<div style="padding:0.5rem; color:var(--danger);">Ошибка поиска</div>';
    }
});

// ДОБАВЛЕНИЕ ДРУГА
window.addFriend = async function(username) {
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
            document.getElementById('globalSearchInput').dispatchEvent(new Event('input'));
        } else {
            const error = await res.json();
            showNotification(error.error || 'Ошибка отправки заявки', 'error');
        }
    } catch {
        showNotification('Ошибка при отправке заявки', 'error');
    }
};

// УДАЛЕНИЕ ДРУГА
window.removeFriend = async function(userId) {
    openConfirmModal('Удалить этого друга из списка?', async function() {
        try {
            const res = await fetch(`/api/friends/${userId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                showNotification('Друг удалён', 'success');
                await loadFriends();
                document.getElementById('globalSearchInput').dispatchEvent(new Event('input'));
            } else {
                showNotification('Ошибка удаления', 'error');
            }
        } catch {
            showNotification('Ошибка при удалении', 'error');
        }
    });
};

// ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ
window.showUserProfile = async function(userId) {
    try {
        const res = await fetch(`/api/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Ошибка загрузки');
        const user = await res.json();

        document.getElementById('viewUserAvatar').src = user.avatar || 'https://via.placeholder.com/80';
        document.getElementById('viewUserFullName').textContent = user.full_name || user.username;
        document.getElementById('viewUserUsername').textContent = user.username;
        document.getElementById('viewUserBirthDate').textContent = user.birth_date
            ? new Date(user.birth_date).toLocaleDateString('ru-RU')
            : 'Не указана';
        document.getElementById('viewUserCity').textContent = user.city || 'Не указан';
        document.getElementById('viewUserBio').textContent = user.bio || 'Не указано';

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
            window.location.href = `private-chat.html?userId=${user.id}`;
        };

        document.getElementById('userProfileModal').style.display = 'flex';
    } catch {
        showNotification('Не удалось загрузить профиль пользователя', 'error');
    }
};

// ЗАКРЫТИЕ МОДАЛЬНЫХ ОКОН
document.querySelector('#userProfileModal .close-modal')?.addEventListener('click', () => {
    document.getElementById('userProfileModal').style.display = 'none';
});
window.addEventListener('click', (e) => {
    if (e.target.id === 'userProfileModal') {
        document.getElementById('userProfileModal').style.display = 'none';
    }
});

// ЗАЯВКИ
document.getElementById('showRequestsBtn')?.addEventListener('click', async () => {
    try {
        const res = await fetch('/api/friends/pending', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const requests = await res.json();

        const container = document.getElementById('requestsList');
        if (requests.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 1rem;">Нет входящих заявок</div>';
        } else {
            container.innerHTML = requests.map(req => `
                <div style="padding: 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>${escapeHtml(req.full_name || req.username)}</strong>
                        <div style="font-size: 12px;">@${escapeHtml(req.username)}</div>
                    </div>
                    <div style="display: flex; gap: 0.5rem;">
                        <button onclick="acceptRequest(${req.id})" class="btn btn-success" style="padding: 0.2rem 0.8rem;">✅ Принять</button>
                        <button onclick="rejectRequest(${req.id})" class="btn btn-danger" style="padding: 0.2rem 0.8rem;">❌ Отклонить</button>
                    </div>
                </div>
            `).join('');
        }

        document.getElementById('requestsModal').style.display = 'flex';
    } catch {
        showNotification('Ошибка загрузки заявок', 'error');
    }
});

window.acceptRequest = async (friendId) => {
    try {
        const res = await fetch('/api/friends/accept', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ friend_id: friendId })
        });
        if (res.ok) {
            document.getElementById('requestsModal').style.display = 'none';
            await loadFriends();
            showNotification('Заявка принята', 'success');
        } else {
            showNotification('Ошибка принятия заявки', 'error');
        }
    } catch {
        showNotification('Ошибка принятия заявки', 'error');
    }
};

window.rejectRequest = async (friendId) => {
    try {
        const res = await fetch('/api/friends/reject', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ friend_id: friendId })
        });
        if (res.ok) {
            document.getElementById('requestsModal').style.display = 'none';
            await loadFriends();
            showNotification('Заявка отклонена', 'success');
        } else {
            showNotification('Ошибка отклонения заявки', 'error');
        }
    } catch {
        showNotification('Ошибка отклонения заявки', 'error');
    }
};

document.querySelector('#requestsModal .close-modal')?.addEventListener('click', () => {
    document.getElementById('requestsModal').style.display = 'none';
});

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

// ВЫХОД И ЗАПУСК
document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    if (socket) socket.disconnect();
    window.location.href = 'login.html';
});

loadFriends();