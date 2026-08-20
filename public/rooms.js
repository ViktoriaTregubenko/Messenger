const token = localStorage.getItem('token') || sessionStorage.getItem('token');
if (!token) window.location.href = 'login.html';

let socket = null;
let roomsCache = [];
let searchRegex = null;
let searchText = '';

// ЗАГРУЗКА КОМНАТ
async function loadRooms() {
    try {
        const res = await fetch('/api/rooms', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const rooms = await res.json();

        roomsCache = rooms;
        document.getElementById('roomsCount').textContent = rooms.length;
        renderRooms();

        if (!socket) {
            socket = io({ auth: { token } });
        }
    } catch {
        document.getElementById('roomsList').innerHTML =
            '<div style="text-align:center;padding:2rem;color:var(--danger);">Ошибка загрузки</div>';
    }
}

// ПОСТРОЕНИЕ РЕГУЛЯРНОГО ВЫРАЖЕНИЯ
function buildRegex(query) {
    if (!query) return null;
    try {
        if (/[\[\]\(\)\{\}\.\*\+\?\^\\\$\|]/.test(query)) {
            return new RegExp(query, 'i');
        }
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped, 'i');
    } catch {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try { return new RegExp(escaped, 'i'); } catch { return null; }
    }
}

// ПОДСВТКА СОВПАДЕНИЯ
function highlightMatch(text, regex) {
    const safe = escapeHtml(text || '');
    if (!regex) return safe;
    try {
        const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
        const globalRegex = new RegExp(regex.source, flags);
        return safe.replace(globalRegex, match =>
            `<mark style="background:var(--pink);color:#fff;padding:0 2px;border-radius:3px;">${match}</mark>`
        );
    } catch {
        return safe;
    }
}

// РЕНДЕР СПИСКА КОМНАТ С ФИЛЬТРАЦИЕЙ
function renderRooms() {
    const container = document.getElementById('roomsList');

    let visible = roomsCache;
    if (searchRegex) {
        visible = roomsCache.filter(room => {
            return searchRegex.test(room.name || '') || searchRegex.test(room.description || '');
        });
    }

    if (visible.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--facebook-gray);">
            <p style="font-size:2.5rem;">${searchText ? '🔍' : ''}</p>
            <p>${searchText ? 'Ничего не найдено по запросу: «' + escapeHtml(searchText) + '»' : 'У вас нет комнат'}</p>
            ${!searchText ? '<p style="font-size:0.85rem;">Создайте комнату, чтобы общаться с друзьями</p>' : ''}
        </div>`;
        return;
    }

    container.innerHTML = visible.map(room => {
        const nameHtml = highlightMatch(room.name, searchRegex);
        const descHtml = highlightMatch(room.description || 'Нет описания', searchRegex);
        return `
            <div class="list-item" onclick="window.location.href='room.html?id=${room.id}'">
                <img src="${room.avatar || 'https://via.placeholder.com/50'}"
                     onerror="this.src='https://via.placeholder.com/50'">
                <div class="list-info">
                    <div class="list-name">${nameHtml}</div>
                    <div class="list-sub">${descHtml} · 👥 ${room.members_count || 0}</div>
                </div>
                <span style="color:var(--facebook-gray);">➜</span>
            </div>
        `;
    }).join('');
}

// ОБРАБОТЧИК ПОИСКА
document.getElementById('roomsSearchInput')?.addEventListener('input', function () {
    searchText = this.value.trim();
    searchRegex = searchText ? buildRegex(searchText) : null;
    const hint = document.getElementById('roomsSearchHint');
    if (searchRegex) {
        const count = roomsCache.filter(r =>
            searchRegex.test(r.name || '') || searchRegex.test(r.description || '')
        ).length;
        hint.textContent = `Найдено: ${count}. Запрос: «${searchText}»`;
    } else {
        hint.textContent = 'Поиск по названию и описанию комнат';
    }
    renderRooms();
});

// СОЗДАНИЕ КОМНАТЫ
document.getElementById('createRoomBtn').addEventListener('click', () => {
    document.getElementById('createRoomModal').classList.add('show');
});

document.getElementById('closeCreateRoom').addEventListener('click', () => {
    document.getElementById('createRoomModal').classList.remove('show');
});

document.getElementById('confirmCreateRoom').addEventListener('click', async () => {
    const name = document.getElementById('roomName').value.trim();
    const description = document.getElementById('roomDescription').value.trim();

    if (!name) {
        alert('Введите название комнаты');
        return;
    }

    const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name, description })
    });

    if (res.ok) {
        document.getElementById('createRoomModal').classList.remove('show');
        document.getElementById('roomName').value = '';
        document.getElementById('roomDescription').value = '';
        loadRooms();
    } else {
        const error = await res.json();
        alert(error.error || 'Ошибка создания');
    }
});

// ВСПОМОГАТЕЛЬНЫЕ
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    if (socket) socket.disconnect();
    window.location.href = 'login.html';
});

loadRooms();