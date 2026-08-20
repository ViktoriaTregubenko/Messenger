let notificationSocket = null;

function initNotificationSocket() {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    if (!token) return;

    if (notificationSocket && notificationSocket.connected) return;

    notificationSocket = io({ auth: { token } });

    notificationSocket.on('private_message_encrypted', async (message) => {
        showMessageNotification(message);
    });

    notificationSocket.on('connect', () => {
        console.log(' Уведомления подключены');
    });

    notificationSocket.on('connect_error', (err) => {
        console.error(' Ошибка подключения уведомлений:', err.message);
    });

    notificationSocket.on('disconnect', () => {
        console.log(' Уведомления отключены');
    });
}

function showMessageNotification(message) {
    // Проверяем, что это личное сообщение
    if (!message.to_user_id) return;
    const currentUserId = getCurrentUserId();
    if (message.from_user_id === currentUserId) return;
    if (isChatWithUserOpen(message.from_user_id)) return;

    const senderName = message.full_name || message.username || 'Пользователь';

    // Показываем уведомление
    showToastNotification(
        `Новое сообщение от ${senderName}`,
        'Нажмите, чтобы открыть чат',
        'info',
        () => {
            window.location.href = `private-chat.html?userId=${message.from_user_id}`;
        }
    );
}

//ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ 

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
        // Пробуем извлечь из токена
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

function isChatWithUserOpen(userId) {
    const urlParams = new URLSearchParams(window.location.search);
    const chatUserId = urlParams.get('userId');
    return chatUserId && parseInt(chatUserId) === parseInt(userId);
}

//ТОСТ-УВЕДОМЛЕНИЕ

function showToastNotification(title, message, type = 'info', onClick = null) {
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

// СТИЛИ АНИМАЦИИ 
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

//ЗАПУСК 
document.addEventListener('DOMContentLoaded', () => {
    initNotificationSocket();
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initNotificationSocket();
}