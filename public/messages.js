const token = localStorage.getItem('token') || sessionStorage.getItem('token');
if (!token) window.location.href = 'login.html';

let socket = null;
let currentUser = null;
let chatsCache = [];
let searchRegex = null;
let searchText = '';

// КРИПТОГРАФИЯ
async function decryptMessage(encryptedBase64, privateKey) {
    const binary = atob(encryptedBase64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    const decrypted = await window.crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, data);
    return new TextDecoder().decode(decrypted);
}

async function decryptLastMessage(raw, privateKey, isOwnMessage) {
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

function isEncrypted(msg) {
    return msg && (msg.is_encrypted === true || msg.is_encrypted === 1 || msg.is_encrypted === '1' || msg.is_encrypted === 'true');
}

async function getPrivateKey() {
    try {
        const jwk = JSON.parse(localStorage.getItem('privateKey_' + currentUser.id));
        if (!jwk) return null;
        return await window.crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
    } catch { return null; }
}

async function generateKeyPair() {
    try {
        const pair = await window.crypto.subtle.generateKey(
            { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' },
            true, ['encrypt', 'decrypt']
        );
        const priv = await window.crypto.subtle.exportKey('jwk', pair.privateKey);
        localStorage.setItem('privateKey_' + currentUser.id, JSON.stringify(priv));
        const pub = await window.crypto.subtle.exportKey('jwk', pair.publicKey);
        const pubStr = JSON.stringify(pub);
        localStorage.setItem('publicKey_' + currentUser.id, pubStr);
        await fetch('/api/keys/public', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ public_key: pubStr })
        });
        return pair.privateKey;
    } catch { return null; }
}

// ЗАГРУЗКА СПИСКА ЧАТОВ
async function loadMessages() {
    try {
        const profileRes = await fetch('/api/profile', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!profileRes.ok) throw new Error('Профиль не загружен');
        currentUser = await profileRes.json();
        window.currentUser = currentUser;
        localStorage.setItem('userData', JSON.stringify({
            id: currentUser.id,
            username: currentUser.username,
            full_name: currentUser.full_name
        }));

        let privateKey = await getPrivateKey();
        if (!privateKey) privateKey = await generateKeyPair();

        const friendsRes = await fetch('/api/friends', { headers: { 'Authorization': `Bearer ${token}` } });
        const friends = await friendsRes.json();
        const container = document.getElementById('chatsList');

        if (friends.length === 0) {
            chatsCache = [];
            container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--facebook-gray);">
                <p style="font-size:3rem;"></p><p>У вас нет чатов</p>
                <a href="friends.html" class="btn btn-primary" style="margin-top:1rem;">Найти друзей</a>
            </div>`;
            updateUnreadBadge();
            return;
        }

        container.innerHTML = '<div style="text-align:center;padding:1rem;">Загрузка...</div>';

        const chats = await Promise.all(friends.map(async (friend) => {
            try {
                const msgsRes = await fetch(`/api/messages/user/${friend.id}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const messages = await msgsRes.json();
                const last = messages.length ? messages[messages.length - 1] : null;
                let lastMsg = last ? (last.message || '') : '';
                let lastTime = last?.created_at || null;
                let unread = messages.filter(m => !m.is_read && m.from_user_id === friend.id).length;

                if (last && isEncrypted(last) && last.message) {
                    const isOwnMessage = last.from_user_id === currentUser.id;
                    if (privateKey) {
                        lastMsg = await decryptLastMessage(last.message, privateKey, isOwnMessage);
                    } else {
                        lastMsg = '[Зашифрованное сообщение]';
                    }
                }
                if (!lastMsg) lastMsg = 'Нет сообщений';

                let readStatus = '';
                if (last) {
                    if (last.from_user_id === currentUser.id) {
                        readStatus = last.is_read ? 'read' : 'sent';
                    } else {
                        readStatus = last.is_read ? 'read' : 'unread-incoming';
                    }
                }

                return {
                    ...friend,
                    lastMessage: lastMsg,
                    lastMessageTime: lastTime,
                    unreadCount: unread,
                    readStatus: readStatus,
                    messages: messages
                };
            } catch {
                return { ...friend, lastMessage: 'Ошибка', lastMessageTime: null, unreadCount: 0, readStatus: '', messages: [] };
            }
        }));

        chats.sort((a,b) => (b.lastMessageTime || '').localeCompare(a.lastMessageTime || ''));
        chatsCache = chats;

        renderChats();
        updateUnreadBadge();

        if (!socket) {
            socket = io({ auth: { token } });
            socket.on('private_message_encrypted', () => {
                loadMessages();
                updateUnreadBadge();
            });
            socket.on('messages_read', () => {
                loadMessages();
                updateUnreadBadge();
            });
        }

    } catch {
        document.getElementById('chatsList').innerHTML = `
            <div style="text-align:center;padding:2rem;color:var(--danger);">
                Ошибка загрузки<br>
                <button onclick="location.reload()" class="btn btn-primary">Обновить</button>
            </div>
        `;
    }
}

async function updateUnreadBadge() {
    const badge = document.getElementById('unreadCount');
    if (!badge) return;
    try {
        const res = await fetch('/api/messages/unread', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return;
        const map = await res.json();
        let total = 0;
        Object.values(map).forEach(c => { total += parseInt(c) || 0; });
        badge.textContent = total;
    } catch {
        let total = 0;
        chatsCache.forEach(c => { total += c.unreadCount || 0; });
        badge.textContent = total;
    }
}

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

function renderChats() {
    const container = document.getElementById('chatsList');

    let visible = chatsCache;
    if (searchRegex) {
        visible = chatsCache.filter(chat => {
            if (searchRegex.test(chat.full_name || '') || searchRegex.test(chat.username || '')) return true;
            if (searchRegex.test(chat.lastMessage || '')) return true;
            if (chat.messages && chat.messages.some(m => searchRegex.test(m.message || ''))) return true;
            return false;
        });
    }

    if (visible.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--facebook-gray);">
            <p style="font-size:2.5rem;">🔍</p>
            <p>Ничего не найдено${searchText ? ' по запросу: «' + escapeHtml(searchText) + '»' : ''}</p>
        </div>`;
        return;
    }

    container.innerHTML = visible.map(chat => {
        const isUnread = chat.unreadCount > 0;
        const nameHtml = highlightMatch(chat.full_name || chat.username, searchRegex);
        const msgHtml = highlightMatch(chat.lastMessage.substring(0, 60), searchRegex);
        const ellipsis = chat.lastMessage.length > 60 ? '...' : '';

        let readIndicator = '';
        if (chat.readStatus === 'sent') {
            readIndicator = '<span class="read-indicator sent" title="Отправлено, не прочитано">✓</span>';
        } else if (chat.readStatus === 'read') {
            readIndicator = '<span class="read-indicator read" title="Прочитано">✓✓</span>';
        }

        return `
            <div class="chat-item ${isUnread ? 'has-unread' : ''}" onclick="window.location.href='private-chat.html?userId=${chat.id}'">
                <img src="${chat.avatar || 'https://via.placeholder.com/50'}" class="chat-avatar" onerror="this.src='https://via.placeholder.com/50'">
                <div class="chat-details">
                    <div class="chat-name">${nameHtml}</div>
                    <div class="chat-last-message ${isUnread ? 'unread' : ''}">
                        ${readIndicator}${msgHtml}${ellipsis}
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.3rem;">
                    <div style="font-size:11px;color:var(--facebook-gray);">
                        ${chat.lastMessageTime ? new Date(chat.lastMessageTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}
                    </div>
                    ${isUnread ? `<span class="unread-badge" title="Непрочитанных сообщений: ${chat.unreadCount}">${chat.unreadCount}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function highlightMatch(text, regex) {
    const safe = escapeHtml(text || '');
    if (!regex) return safe;
    try {
        const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
        const globalRegex = new RegExp(regex.source, flags);
        return safe.replace(globalRegex, match => `<mark style="background:var(--pink);color:#fff;padding:0 2px;border-radius:3px;">${match}</mark>`);
    } catch {
        return safe;
    }
}

document.getElementById('messagesSearchInput')?.addEventListener('input', function(e) {
    searchText = this.value.trim();
    searchRegex = searchText ? buildRegex(searchText) : null;
    const hint = document.getElementById('searchHint');
    if (searchRegex) {
        const totalMatches = countTotalMatches(searchRegex);
        hint.textContent = `Найдено чатов/совпадений: ${totalMatches}. Запрос: «${searchText}»`;
    } else {
        hint.textContent = 'Введите текст. Поиск ведётся по содержимому сообщений и именам собеседников.';
    }
    renderChats();
});

function countTotalMatches(regex) {
    let n = 0;
    chatsCache.forEach(chat => {
        if (regex.test(chat.full_name || '') || regex.test(chat.username || '')) n++;
        else if (regex.test(chat.lastMessage || '')) n++;
        else if (chat.messages && chat.messages.some(m => regex.test(m.message || ''))) n++;
    });
    return n;
}

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

document.getElementById('unreadBtn')?.addEventListener('click', () => {
    const firstUnread = chatsCache.find(c => c.unreadCount > 0);
    if (firstUnread) {
        window.location.href = `private-chat.html?userId=${firstUnread.id}`;
    } else {
        const badge = document.getElementById('unreadCount');
        if (badge) {
            const orig = badge.textContent;
            badge.textContent = '0';
            setTimeout(() => { badge.textContent = orig; }, 100);
        }
    }
});

loadMessages();