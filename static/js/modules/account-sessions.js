/**
 * Cloud TTS Reader - Multi-account Firebase sessions
 *
 * Each Google account lives in its own named Firebase app, so Firebase keeps
 * one persisted session per account in IndexedDB. Only the active app is ever
 * initialized; the other accounts are a small profile list in localStorage
 * until the user switches to them. No tokens are stored by this module.
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
    constructor(config, { onSession, beforeLeave }) {
        this._config = config;
        this._onSession = onSession;
        this._beforeLeave = beforeLeave;
        this._store = readStore();
        this._waiters = [];
        this._busy = false;
        this.app = null;
        this.auth = null;
        this.user = null;
    }

    get accounts() {
        return this._store.list.map(entry => ({ ...entry }));
    }

    get activeUid() {
        return this.user?.uid || null;
    }

    get busy() {
        return this._busy;
    }

    start() {
        const { active, list } = this._store;
        const entry = list.find(a => a.uid === active) || list[0];
        const ready = this._waitSettled();
        this._open(entry ? entry.appName : DEFAULT_APP_NAME);
        return ready;
    }

    async switchTo(uid) {
        if (uid === this.activeUid) return;
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
        if (this._busy) return;
        if (this._store.list.length >= MAX_ACCOUNTS) {
            throw new Error(`Chỉ lưu tối đa ${MAX_ACCOUNTS} tài khoản trên một máy.`);
        }
        const app = initializeApp(this._config, randomAppName());
        const auth = getAuth(app);
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        let user;
        try {
            user = (await signInWithPopup(auth, provider)).user;
        } catch (err) {
            await deleteApp(app).catch(() => { });
            throw err;
        }

        if (this._store.list.some(a => a.uid === user.uid)) {
            // Already on this device: drop the duplicate session, keep the stored one.
            await signOut(auth).catch(() => { });
            await deleteApp(app).catch(() => { });
            await this.switchTo(user.uid);
            return;
        }

        await this._exclusive(async () => {
            await this._beforeLeave();
            await this._close();
            const ready = this._waitSettled();
            this._attach(app, auth);
            await ready;
        });
    }

    async signOutActive() {
        const uid = this.activeUid;
        if (!uid) return;
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
            await this._close();
            const next = this._store.list[0];
            const ready = this._waitSettled();
            this._open(next ? next.appName : DEFAULT_APP_NAME);
            await ready;
        });
    }

    async _exclusive(task) {
        if (this._busy) return;
        this._busy = true;
        try {
            await task();
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

    async _close() {
        this._detach();
        const app = this.app;
        this.app = null;
        this.auth = null;
        this.user = null;
        // deleteApp frees Auth/Firestore instances; the persisted session survives.
        if (app) await deleteApp(app).catch(err => console.warn('[Accounts] deleteApp failed:', err));
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
        const lost = this._store.list.find(a => a.appName === app.name);
        if (lost) this._forget(lost.uid);
        const next = this._store.list[0];
        if (next) {
            if (hadUser) await this._beforeLeave();
            await this._close();
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
        const profile = {
            uid: user.uid,
            appName,
            name: user.displayName || user.email || 'Tài khoản Google',
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
