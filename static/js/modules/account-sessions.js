/**
 * Cloud TTS Reader - Multi-account Firebase sessions
 *
 * Each Google account lives in its own named Firebase app, so Firebase keeps
 * one persisted session per account in IndexedDB. Only the active account has
 * a listener and a Firestore client; the others are a small profile list in
 * localStorage plus, once used, an idle Auth instance. No tokens are stored by
 * this module.
 */
import { initializeApp, getApps, deleteApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

const STORE_KEY = 'tts.accounts.v1';
const DEFAULT_APP_NAME = '[DEFAULT]';
const APP_NAME_PATTERN = /^(\[DEFAULT\]|acc-[a-f0-9]{8,32})$/;
export const MAX_ACCOUNTS = 5;

function safePhotoURL(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

function readStore() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY));
        const list = Array.isArray(raw?.list) ? raw.list.filter(entry =>
            typeof entry?.uid === 'string' && APP_NAME_PATTERN.test(entry?.appName)
        ).slice(0, MAX_ACCOUNTS) : [];
        return { active: typeof raw?.active === 'string' ? raw.active : null, list };
    } catch {
        return { active: null, list: [] };
    }
}

function randomAppName() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return 'acc-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export class AccountSessions {
    constructor(config, { onSession, beforeLeave, onAccountsChange }) {
        this._config = config;
        this._onSession = onSession;
        this._beforeLeave = beforeLeave;
        this._onAccountsChange = onAccountsChange;
        this._store = readStore();
        this._waiters = [];
        this._busy = false;
        this._adding = false;
        this._candidate = null;
        this.app = null;
        this.auth = null;
        this.user = null;
        window.addEventListener('storage', event => {
            if (event.key !== STORE_KEY) return;
            this._store = readStore();
            this._onAccountsChange?.();
        });
    }

    get accounts() {
        return this._store.list.map(entry => ({ ...entry }));
    }

    get activeUid() {
        return this.user?.uid || null;
    }

    get busy() {
        return this._busy || this._adding;
    }

    start() {
        const { active, list } = this._store;
        const entry = list.find(a => a.uid === active) || list[0];
        const ready = this._waitSettled();
        this._open(entry ? entry.appName : DEFAULT_APP_NAME);
        return ready;
    }

    /**
     * Creates the Auth instance used by the next "Add account" ahead of the
     * click: Safari/iOS block the popup when the SDK still has to warm up a
     * fresh Auth after the user gesture.
     */
    prepareCandidate() {
        if (this._candidate || !this.user) return;
        const app = initializeApp(this._config, randomAppName());
        this._candidate = { app, auth: getAuth(app) };
    }

    async switchTo(uid) {
        if (uid === this.activeUid || this._adding) return;
        this._store = readStore();
        const entry = this._store.list.find(a => a.uid === uid);
        if (!entry) throw new Error('Tài khoản này không còn trên máy.');
        await this._exclusive(async () => {
            await this._beforeLeave();
            await this._close();
            const ready = this._waitSettled();
            this._open(entry.appName);
            await ready;
        });
    }

    /** Must be called straight from a click handler so the popup is allowed. */
    async add() {
        if (this.busy) return;
        this._store = readStore();
        if (this._store.list.length >= MAX_ACCOUNTS) {
            throw new Error(`Chỉ lưu tối đa ${MAX_ACCOUNTS} tài khoản trên một máy.`);
        }
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        if (!this.user && this.auth) {
            // Signed out: sign in on the app that is already open; its auth
            // listener records the account and starts the session.
            await signInWithPopup(this.auth, provider);
            return;
        }

        this.prepareCandidate();
        const { app, auth } = this._candidate;
        this._adding = true;
        let user;
        try {
            user = (await signInWithPopup(auth, provider)).user;
        } finally {
            this._adding = false;
        }

        if (this._store.list.some(a => a.uid === user.uid)) {
            // Already on this device: drop the duplicate session, keep the stored one.
            await signOut(auth).catch(() => { });
            await this.switchTo(user.uid);
            return;
        }

        const attached = await this._exclusive(async () => {
            await this._beforeLeave();
            await this._close();
            this._candidate = null;
            const ready = this._waitSettled();
            this._attach(app, auth);
            await ready;
        });
        if (!attached) {
            await signOut(auth).catch(() => { });
            throw new Error('Đang chuyển tài khoản, hãy thử thêm lại.');
        }
    }

    async signOutActive() {
        const uid = this.activeUid;
        if (!uid || this._adding) return;
        await this._exclusive(async () => {
            await this._beforeLeave();
            this._detach();
            try {
                await signOut(this.auth);
            } catch (err) {
                this._attach(this.app, this.auth);
                throw err;
            }
            this._forget(uid);
            await this._close({ dispose: true });
            const next = this._store.list[0];
            const ready = this._waitSettled();
            this._open(next ? next.appName : DEFAULT_APP_NAME);
            await ready;
        });
    }

    async _exclusive(task) {
        if (this._busy) return false;
        this._busy = true;
        try {
            await task();
            return true;
        } finally {
            this._busy = false;
        }
    }

    _open(appName) {
        const app = getApps().find(a => a.name === appName)
            || (appName === DEFAULT_APP_NAME ? initializeApp(this._config) : initializeApp(this._config, appName));
        this._attach(app, getAuth(app));
    }

    _attach(app, auth) {
        this.app = app;
        this.auth = auth;
        this.user = null;
        this._unsubscribe = onAuthStateChanged(auth, user => {
            this._handleAuth(app, user).catch(err => console.error('[Accounts] Auth state error:', err));
        });
    }

    _detach() {
        this._unsubscribe?.();
        this._unsubscribe = null;
    }

    /**
     * Inactive apps stay registered (at most MAX_ACCOUNTS) so switching back
     * reuses their warm Auth; the caller terminates Firestore. Apps are only
     * deleted once their account is forgotten.
     */
    async _close({ dispose = false } = {}) {
        this._detach();
        const app = this.app;
        this.app = null;
        this.auth = null;
        this.user = null;
        if (app && dispose) await deleteApp(app).catch(err => console.warn('[Accounts] deleteApp failed:', err));
    }

    async _handleAuth(app, user) {
        if (app !== this.app) return;
        if (user) {
            this.user = user;
            this._remember(user, app.name);
            this._settle();
            await this._onSession({ app, auth: this.auth, user });
            return;
        }

        // The session for this app is gone (signed out elsewhere, revoked or
        // never existed). Forget it and fall back to the next stored account.
        const hadUser = !!this.user;
        this.user = null;
        this._store = readStore();
        const lost = this._store.list.find(a => a.appName === app.name);
        if (lost) this._forget(lost.uid);
        const next = this._store.list[0];
        if (next) {
            if (hadUser) await this._beforeLeave();
            await this._close({ dispose: !!lost });
            this._open(next.appName);
            return;
        }
        this._settle();
        await this._onSession(null);
    }

    _waitSettled() {
        return new Promise(resolve => this._waiters.push(resolve));
    }

    _settle() {
        const waiters = this._waiters;
        this._waiters = [];
        waiters.forEach(resolve => resolve());
    }

    _remember(user, appName) {
        this._store = readStore();
        const profile = {
            uid: user.uid,
            appName,
            name: user.displayName || user.email || '',
            email: user.email || '',
            photo: safePhotoURL(user.photoURL)
        };
        const list = this._store.list;
        const index = list.findIndex(a => a.uid === user.uid);
        if (index >= 0) list[index] = profile;
        else list.push(profile);
        this._store.active = user.uid;
        this._save();
    }

    _forget(uid) {
        this._store = readStore();
        this._store.list = this._store.list.filter(a => a.uid !== uid);
        if (this._store.active === uid) this._store.active = null;
        this._save();
    }

    _save() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(this._store));
        } catch (err) {
            console.warn('[Accounts] Cannot persist account list:', err);
        }
    }
}
