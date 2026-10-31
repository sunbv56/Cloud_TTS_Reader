/**
 * Cloud TTS Reader - Header account switcher
 *
 * Profile fields come from Google and are rendered with textContent only.
 */
import { translations } from './i18n.js';
import { MAX_ACCOUNTS } from './account-sessions.js';

const POPUP_DISMISSED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

function t(key) {
    let lang = 'en';
    try {
        lang = localStorage.getItem('ui-lang') || 'en';
    } catch (_) { }
    return translations[lang]?.[key] || translations.en[key] || key;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name) {
    const node = el('i', name.startsWith('fab ') ? name : `fas ${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function i18nText(tag, className, key) {
    const node = el(tag, className, t(key));
    node.dataset.i18n = key;
    return node;
}

function avatar(profile, className = 'acct-avatar') {
    const initial = el('span', `${className} acct-avatar--initial`, (profile.name || profile.email || '?').trim().charAt(0).toUpperCase());
    initial.setAttribute('aria-hidden', 'true');
    if (!profile.photo) return initial;
    const img = el('img', className);
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.src = profile.photo;
    img.addEventListener('error', () => img.replaceWith(initial), { once: true });
    return img;
}

export function createAccountMenu({ sessions, onError, onStatus }) {
    const trigger = document.getElementById('auth-btn');
    const info = document.getElementById('auth-info');
    const menu = document.getElementById('account-menu');
    let isOpen = false;
    let pendingUid = null;

    const activeProfile = () => sessions.accounts.find(a => a.uid === sessions.activeUid);

    function renderTrigger() {
        const profile = sessions.user ? activeProfile() : null;
        trigger.replaceChildren();
        if (!profile) {
            trigger.append(icon('fab fa-google'), i18nText('span', 'hidden sm:inline', 'sign-in'));
            trigger.classList.replace('acct-trigger--signed-in', 'btn-primary');
            trigger.removeAttribute('aria-haspopup');
            trigger.removeAttribute('aria-expanded');
            trigger.setAttribute('aria-label', t('sign-in'));
            info?.replaceChildren(el('span', 'menu-who__guest'), i18nText('span', '', 'guest-mode'));
            return;
        }
        trigger.classList.remove('btn-primary');
        trigger.classList.add('acct-trigger--signed-in');
        trigger.append(avatar(profile, 'acct-avatar acct-avatar--sm'), icon('fa-chevron-down acct-trigger__chevron'));
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-controls', 'account-menu');
        trigger.setAttribute('aria-expanded', String(isOpen));
        trigger.setAttribute('aria-label', `${profile.name} — ${t('account-menu-title')}`);
        info?.replaceChildren(avatar(profile, 'acct-avatar acct-avatar--sm'), el('span', 'acct-info__name', profile.name));
    }

    function renderMenu() {
        const activeUid = sessions.activeUid;
        const accounts = sessions.accounts;
        const busy = sessions.busy || pendingUid !== null;
        const list = el('div', 'acct-menu__list');
        list.setAttribute('role', 'group');

        for (const account of accounts) {
            const isActive = account.uid === activeUid;
            const item = el('button', 'acct-item');
            item.type = 'button';
            item.setAttribute('role', 'menuitemradio');
            item.setAttribute('aria-checked', String(isActive));
            item.dataset.uid = account.uid;
            item.disabled = busy && account.uid !== pendingUid;
            if (account.uid === pendingUid) item.dataset.state = 'loading';

            const text = el('span', 'acct-item__text');
            text.append(el('span', 'acct-item__name', account.name));
            if (account.email) text.append(el('span', 'acct-item__email', account.email));

            const mark = account.uid === pendingUid
                ? icon('fa-circle-notch fa-spin acct-item__mark')
                : isActive ? icon('fa-check acct-item__mark') : el('span', 'acct-item__mark');
            item.append(avatar(account), text, mark);
            list.append(item);
        }

        const full = accounts.length >= MAX_ACCOUNTS;
        const add = el('button', 'acct-action');
        add.type = 'button';
        add.setAttribute('role', 'menuitem');
        add.dataset.action = 'add';
        add.disabled = busy || full;
        add.append(icon('fa-user-plus'), i18nText('span', '', 'account-add'));
        if (full) add.append(i18nText('span', 'acct-action__hint', 'account-limit'));

        const signOutBtn = el('button', 'acct-action acct-action--quiet');
        signOutBtn.type = 'button';
        signOutBtn.setAttribute('role', 'menuitem');
        signOutBtn.dataset.action = 'sign-out';
        signOutBtn.disabled = busy;
        signOutBtn.append(icon('fa-right-from-bracket'), i18nText('span', '', 'account-sign-out'));

        menu.setAttribute('aria-busy', String(busy));
        menu.replaceChildren(i18nText('p', 'acct-menu__label', 'account-menu-title'), list, el('div', 'acct-menu__rule'), add, signOutBtn);
    }

    function focusables() {
        return [...menu.querySelectorAll('button:not(:disabled)')];
    }

    function openMenu() {
        sessions.prepareCandidate();
        isOpen = true;
        renderMenu();
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', onOutside, true);
        (menu.querySelector('[aria-checked="true"]') || focusables()[0])?.focus();
    }

    function closeMenu({ restoreFocus = false } = {}) {
        if (!isOpen) return;
        isOpen = false;
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutside, true);
        if (restoreFocus) trigger.focus();
    }

    function onOutside(event) {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
    }

    function reportAuthError(err, prefix) {
        if (POPUP_DISMISSED.has(err?.code)) return;
        console.error('[Accounts]', err);
        onError(`${prefix}: ${err?.message || err}`);
    }

    async function addAccount() {
        closeMenu();
        try {
            await sessions.add();
        } catch (err) {
            reportAuthError(err, 'Đăng nhập thất bại');
        }
        render();
    }

    async function switchTo(uid) {
        if (uid === sessions.activeUid) {
            closeMenu({ restoreFocus: true });
            return;
        }
        pendingUid = uid;
        renderMenu();
        onStatus?.('Đang chuyển tài khoản...');
        try {
            await sessions.switchTo(uid);
            closeMenu({ restoreFocus: true });
        } catch (err) {
            reportAuthError(err, 'Chuyển tài khoản thất bại');
        } finally {
            pendingUid = null;
            render();
        }
    }

    async function signOutActive() {
        closeMenu({ restoreFocus: true });
        try {
            await sessions.signOutActive();
        } catch (err) {
            reportAuthError(err, 'Đăng xuất thất bại');
        }
        render();
    }

    function render() {
        renderTrigger();
        if (isOpen) {
            if (sessions.user) renderMenu();
            else closeMenu();
        }
    }

    // account-menu.js owns the trigger's label, so it re-renders when the UI language flips.
    window.addEventListener('uilanguagechange', render);

    trigger.addEventListener('click', () => {
        if (!sessions.user) {
            addAccount();
            return;
        }
        if (isOpen) closeMenu();
        else openMenu();
    });

    menu.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.dataset.uid) switchTo(button.dataset.uid);
        else if (button.dataset.action === 'add') addAccount();
        else if (button.dataset.action === 'sign-out') signOutActive();
    });

    menu.addEventListener('keydown', event => {
        const items = focusables();
        const index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu({ restoreFocus: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            items[(index + step + items.length) % items.length]?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
        } else if (event.key === 'Tab') {
            closeMenu();
        }
    });

    render();
    return { render, close: closeMenu };
}
