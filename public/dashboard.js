const token = localStorage.getItem('token') || sessionStorage.getItem('token');
let currentUser = null;
let socket = null;

if (!token) {
    window.location.href = 'login.html';
}

async function loadDashboard() {
    try {
        const res = await fetch('/api/profile', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('Ошибка авторизации');
        currentUser = await res.json();
        window.currentUser = currentUser;
        localStorage.setItem('userData', JSON.stringify({
            id: currentUser.id,
            username: currentUser.username,
            full_name: currentUser.full_name
        }));

        const fullNameEl = document.getElementById('fullName');
        const usernameEl = document.getElementById('username');
        const welcomeNameEl = document.getElementById('welcomeName');
        const avatarEl = document.getElementById('avatar');

        if (fullNameEl) fullNameEl.textContent = currentUser.full_name || currentUser.username;
        if (usernameEl) usernameEl.textContent = `@${currentUser.username}`;
        if (welcomeNameEl) welcomeNameEl.textContent = currentUser.full_name || currentUser.username;
        if (avatarEl) avatarEl.src = currentUser.avatar || 'https://via.placeholder.com/80';

        const friendsRes = await fetch('/api/friends', { headers: { 'Authorization': `Bearer ${token}` } });
        const friends = await friendsRes.json();
        document.getElementById('friendsCount').textContent = friends.length;

        const roomsRes = await fetch('/api/rooms', { headers: { 'Authorization': `Bearer ${token}` } });
        const rooms = await roomsRes.json();
        document.getElementById('roomsCount').textContent = rooms.length;

        const onlineFriends = friends.filter(f => f.status === 'online');
        document.getElementById('onlineCount').textContent = onlineFriends.length;

        document.getElementById('globalSearch')?.addEventListener('input', async function(e) {
            const query = this.value.trim();
            const resultsContainer = document.getElementById('searchResults');
            if (query.length < 2) {
                resultsContainer.style.display = 'none';
                return;
            }
            try {
                const usersRes = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const users = await usersRes.json();
                const roomsRes = await fetch(`/api/rooms/search?q=${encodeURIComponent(query)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const rooms = await roomsRes.json();
                if (users.length === 0 && rooms.length === 0) {
                    resultsContainer.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-light);">Ничего не найдено</div>';
                    resultsContainer.style.display = 'block';
                    return;
                }
                let html = '';
                if (users.length > 0) {
                    html += `<div style="margin-bottom: 1rem;"><strong>Пользователи</strong></div>`;
                    html += users.map(user => `
                        <div class="search-item" onclick="window.location.href='profile.html?userId=${user.id}'" style="display:flex; align-items:center; gap:1rem; padding:0.5rem; border-bottom:1px solid var(--border); cursor:pointer;">
                            <img src="${user.avatar || 'https://via.placeholder.com/40'}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">
                            <div>
                                <div><strong>${user.full_name || user.username}</strong></div>
                                <div style="font-size:0.85rem; color:var(--text-light);">@${user.username}</div>
                            </div>
                        </div>
                    `).join('');
                }
                if (rooms.length > 0) {
                    if (users.length > 0) html += `<hr style="margin:1rem 0;">`;
                    html += `<div style="margin-bottom: 1rem;"><strong>Комнаты</strong></div>`;
                    html += rooms.map(room => `
                        <div class="search-item" onclick="window.location.href='room.html?id=${room.id}'" style="display:flex; align-items:center; gap:1rem; padding:0.5rem; border-bottom:1px solid var(--border); cursor:pointer;">
                            <div style="font-size:2rem;"></div>
                            <div>
                                <div><strong>${room.name}</strong></div>
                                <div style="font-size:0.85rem; color:var(--text-light);">${room.members_count || 0} участников</div>
                            </div>
                        </div>
                    `).join('');
                }
                resultsContainer.innerHTML = html;
                resultsContainer.style.display = 'block';
            } catch {
                resultsContainer.innerHTML = '<div style="padding:1rem;color:var(--danger);">Ошибка поиска</div>';
                resultsContainer.style.display = 'block';
            }
        });

        socket = io({ auth: { token } });

    } catch {
        const container = document.querySelector('.dashboard-container');
        if (container) {
            container.innerHTML = `<div style="padding:2rem; color:var(--danger);">❌ Ошибка загрузки данных. Проверьте подключение.</div>`;
        }
    }
}

//УВЕДОМЛЕНИЯ

function showNotification(message, type = 'info') {
    const n = document.createElement('div');
    n.textContent = message;
    n.style.cssText = `position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:12px;background:${
        type === 'success' ? '#2ecc71' : type === 'error' ? '#e74c3c' : '#3498db'
    };color:white;z-index:9999;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,0.2);`;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3000);
}

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    if (socket) socket.disconnect();
    window.location.href = 'login.html';
});


loadDashboard();