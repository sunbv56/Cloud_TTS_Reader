/**
 * Statistics & Insights Manager
 */
export function createStatsManager(STATE, db, doc, setDoc, getDoc) {
    return {
        _lastActiveTime: 0,
        _syncTimer: null,
        _saveChain: Promise.resolve(),

        init() {
            this._lastActiveTime = Date.now();
            setInterval(() => this.track(), 10000);
        },

        async track() {
            const now = Date.now();
            const deltaMs = now - this._lastActiveTime;
            this._lastActiveTime = now;

            if (!STATE.isPlaying || !STATE.user) return;

            STATE.stats.totalTime += Math.floor(deltaMs / 1000);

            const today = new Date().toDateString();
            if (STATE.stats.lastReadDate !== today) {
                const lastDate = new Date(STATE.stats.lastReadDate);
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);

                if (lastDate.toDateString() === yesterday.toDateString()) {
                    STATE.stats.streak += 1;
                } else if (STATE.stats.lastReadDate === 'never') {
                    STATE.stats.streak = 1;
                } else {
                    STATE.stats.streak = 1;
                }
                STATE.stats.lastReadDate = today;
            }

            this.updateUI();
            this.scheduleSync();
        },

        updateUI() {
            const streakEl = document.getElementById('stat-streak');
            const timeEl = document.getElementById('stat-total-time');
            const streakDot = document.getElementById('streak-dot');

            if (streakEl) streakEl.innerText = STATE.stats.streak;
            if (timeEl) {
                const mins = Math.floor(STATE.stats.totalTime / 60);
                timeEl.innerText = mins > 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
            }
            if (streakDot && STATE.stats.streak > 0) streakDot.classList.remove('hidden');
        },

        scheduleSync() {
            if (this._syncTimer) return;
            this._syncTimer = setTimeout(async () => {
                this._syncTimer = null;
                await this.syncToFirestore();
            }, 30000);
        },

        async syncToFirestore(force = false) {
            if (!STATE.user || (STATE.strictSyncMode && !force) || !db) return;
            const userId = STATE.user.uid;
            const statsSnapshot = { ...STATE.stats };
            const write = async () => {
                try {
                    const statsRef = doc(db, 'users', userId, 'stats', 'reading');
                    await setDoc(statsRef, statsSnapshot, { merge: true });
                    return true;
                } catch (err) {
                    console.warn('[Stats] Sync failed:', err);
                    return false;
                }
            };

            const queuedWrite = this._saveChain.then(write, write);
            this._saveChain = queuedWrite.catch(() => {});
            return queuedWrite;
        },

        async load() {
            if (!STATE.user || !db) return;
            try {
                const statsRef = doc(db, 'users', STATE.user.uid, 'stats', 'reading');
                const snap = await getDoc(statsRef);
                if (snap.exists()) {
                    STATE.stats = { ...STATE.stats, ...snap.data() };
                }
                this.updateUI();
            } catch (err) {
                console.warn('[Stats] Load failed:', err);
            }
        }
    };
}
