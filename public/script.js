/**
 * Tiny Tune widget.
 *
 * Keeps the embedded player in sync with Spotify. Two independent clocks do
 * the work:
 *
 *   - A poll loop asks the server what is playing. It is a self-chaining
 *     setTimeout rather than a setInterval, so a slow request can never stack
 *     up behind itself, and it runs in *every* state — including errors and
 *     "nothing playing" — so the widget always recovers on its own.
 *   - A display tick redraws the progress bar from a wall-clock anchor
 *     (when the track started, derived from the reported position). Nothing
 *     accumulates, so background-tab timer throttling cannot make the bar
 *     drift away from real playback.
 */
(() => {
    'use strict';

    const POLL_PLAYING_MS = 5000;    // Cheap: the server caches for ~4s.
    const POLL_IDLE_MS = 10000;      // Nothing playing — just watch for a start.
    const POLL_REAUTH_MS = 60000;    // Needs the user to act; barely worth asking.
    const ERROR_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000, 60000];
    const REQUEST_TIMEOUT_MS = 10000;
    const TICK_MS = 500;             // Redraw rate; cheap because it is derived.
    const STALE_AFTER_FAILURES = 3;  // Admit something is wrong after ~17s.

    const VARIANTS = ['card', 'compact', 'minimal'];
    const STATES = ['loading', 'playing', 'paused', 'idle', 'error', 'reauth', 'unconfigured'];

    const el = {
        widget: document.getElementById('now-playing'),
        link: document.getElementById('spotify-link'),
        cover: document.getElementById('album-cover'),
        title: document.getElementById('track-title'),
        artist: document.getElementById('artist-name'),
        liveText: document.querySelector('.live-text'),
        progressTime: document.getElementById('progress-time'),
        progressBar: document.getElementById('progress-bar'),
        trackDuration: document.getElementById('track-duration'),
        minimalTitle: document.getElementById('minimal-title'),
        minimalArtist: document.getElementById('minimal-artist'),
        minimalSep: document.querySelector('.minimal-sep')
    };

    // --- View state ---------------------------------------------------------
    // One object describes everything on screen; render() is the only writer of
    // the DOM. That is deliberate: the previous version poked individual style
    // properties per branch, so a property set in one state (the hidden
    // progress bar) stayed set forever once another state forgot to undo it.
    const view = {
        state: 'loading',
        item: null,
        playedAt: null,
        stale: false   // Have recent polls been failing?
    };

    // Where playback was, and when we learned that — progress is always
    // recomputed from this rather than incremented.
    let anchor = null;
    let tickTimer = null;
    let pollTimer = null;
    let inFlight = null;
    let failureStreak = 0;

    const userId = (() => {
        const params = new URLSearchParams(window.location.search);
        const value = params.get('user');
        return value && value.trim() ? value.trim() : null;
    })();

    // The widget hides itself whenever nothing is playing, which would leave
    // the config page previewing an empty box. preview=1 keeps it on screen in
    // every state so the appearance can still be chosen. The embed snippet the
    // config page hands out never carries it.
    const previewMode = new URLSearchParams(window.location.search).get('preview') === '1';

    // --- Rendering ----------------------------------------------------------

    function setState(next) {
        view.state = next;
        for (const state of STATES) {
            document.body.classList.toggle(`state-${state}`, state === next);
        }
    }

    function formatClock(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function formatPlayedAt(isoString) {
        const when = new Date(isoString);
        if (Number.isNaN(when.getTime())) return null;
        // Formatted client-side so it lands in the viewer's locale and timezone.
        return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function setCover(url) {
        // Quote the URL: an unquoted url() breaks on parentheses, whitespace or
        // quotes, which Spotify's CDN paths are not guaranteed to avoid.
        el.cover.style.backgroundImage = url
            ? `url("${String(url).replace(/["\\]/g, match => `\\${match}`)}")`
            : '';
    }

    function setMinimalText(title, subtitle) {
        el.minimalTitle.textContent = title;
        el.minimalArtist.textContent = subtitle;
        if (el.minimalSep) el.minimalSep.hidden = !subtitle;
    }

    // What the "Currently listening to" line says in each state.
    function statusLabel() {
        if (view.stale) return 'Reconnecting…';
        switch (view.state) {
            case 'playing': return 'Currently listening to';
            case 'paused': return 'Paused';
            case 'idle': return view.playedAt ? 'Last played' : 'Not playing';
            case 'reauth': return 'Disconnected';
            case 'unconfigured': return 'Setup needed';
            case 'error': return 'Offline';
            default: return 'Loading…';
        }
    }

    // Headline text when there is no track to name.
    function placeholderText() {
        switch (view.state) {
            case 'reauth': return { title: 'Reconnect Spotify', subtitle: '' };
            case 'unconfigured': return { title: 'Widget not configured', subtitle: 'Missing ?user= parameter' };
            case 'error': return { title: 'Can’t reach Spotify', subtitle: 'Retrying…' };
            case 'loading': return { title: 'Loading…', subtitle: '' };
            default: return { title: 'Nothing playing right now', subtitle: '' };
        }
    }

    function elapsedMs() {
        if (!anchor) return 0;
        const drift = anchor.frozen ? 0 : Date.now() - anchor.at;
        return Math.min(anchor.progressMs + drift, anchor.durationMs);
    }

    function renderProgress() {
        const showProgress = Boolean(
            (view.state === 'playing' || view.state === 'paused') && anchor && anchor.durationMs > 0
        );
        // One class decides whether the row is a progress bar or a status line,
        // so CSS owns the hiding and there is no inline style left behind to
        // restore when playback comes back.
        document.body.classList.toggle('no-progress', !showProgress);

        if (showProgress) {
            const elapsed = elapsedMs();
            el.progressTime.textContent = formatClock(elapsed);
            el.trackDuration.textContent = formatClock(anchor.durationMs);
            const percentage = Math.min(100, Math.max(0, (elapsed / anchor.durationMs) * 100));
            el.progressBar.style.width = `${percentage}%`;
            return;
        }

        // No usable progress: the row reads as a single status line instead.
        const playedAt = view.playedAt ? formatPlayedAt(view.playedAt) : null;
        el.progressTime.textContent = playedAt ? `Last played at ${playedAt}` : '';
        el.trackDuration.textContent = '';
        el.progressBar.style.width = '0%';
    }

    // Nothing playing means nothing on screen: the widget should not announce a
    // song that stopped, and an embed with no music is meant to disappear
    // rather than sit there as an empty card.
    function updateVisibility() {
        el.widget.hidden = !(previewMode || view.state === 'playing');
    }

    function render() {
        updateVisibility();

        const item = view.item;
        const placeholder = placeholderText();
        const title = item ? item.title : placeholder.title;
        const subtitle = item ? (item.subtitle || '') : placeholder.subtitle;

        el.title.textContent = title;
        el.artist.textContent = subtitle;
        setMinimalText(title, subtitle);
        setCover(item && item.albumCover);

        const href = item && item.url;
        el.link.href = href || '#';
        if (el.liveText) el.liveText.textContent = statusLabel();

        renderProgress();
    }

    // --- Display tick -------------------------------------------------------

    function startTick() {
        if (tickTimer !== null) return;
        tickTimer = setInterval(() => {
            if (view.state !== 'playing' || !anchor) return;
            renderProgress();

            // The track should be over. Ask the server once — immediately, so a
            // new song appears promptly — then fall back to the normal poll
            // cadence. The flag lives on the anchor, so it resets by itself
            // when the next payload replaces it; incrementing a module-level
            // counter here is what used to let this fire every tick.
            if (!anchor.refreshRequested && elapsedMs() >= anchor.durationMs) {
                anchor.refreshRequested = true;
                schedulePoll(0);
            }
        }, TICK_MS);
    }

    function stopTick() {
        if (tickTimer !== null) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    // --- Poll loop ----------------------------------------------------------

    function schedulePoll(delayMs) {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, delayMs);
    }

    function stopPolling() {
        if (pollTimer !== null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function nextDelay() {
        if (failureStreak > 0) {
            const index = Math.min(failureStreak - 1, ERROR_BACKOFF_MS.length - 1);
            return ERROR_BACKOFF_MS[index];
        }
        if (view.state === 'playing') return POLL_PLAYING_MS;
        if (view.state === 'reauth' || view.state === 'unconfigured') return POLL_REAUTH_MS;
        return POLL_IDLE_MS;
    }

    async function requestNowPlaying() {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, REQUEST_TIMEOUT_MS);
        inFlight = controller;

        try {
            const response = await fetch(`/now-playing?user=${encodeURIComponent(userId)}`, {
                signal: controller.signal,
                cache: 'no-store',
                headers: { Accept: 'application/json' }
            });

            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}`);
                // 401 needs the user to reconnect; 404 means this widget URL
                // points at a user the server has never seen. Neither is worth
                // hammering. Everything else is treated as transient.
                error.code = (response.status === 401 || response.status === 404) ? 'reauth' : 'http';
                error.retryAfterMs = response.status === 429
                    ? (Number(response.headers.get('Retry-After')) || 5) * 1000
                    : null;
                throw error;
            }

            return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                const wrapped = new Error(timedOut ? 'Request timed out' : 'Request cancelled');
                wrapped.code = timedOut ? 'timeout' : 'cancelled';
                throw wrapped;
            }
            throw error;
        } finally {
            clearTimeout(timer);
            if (inFlight === controller) inFlight = null;
        }
    }

    function applyPayload(data) {
        const item = data && data.item ? data.item : null;
        view.item = item;
        view.playedAt = (data && data.playedAt) || null;
        view.stale = false;

        const hasProgress = item
            && typeof item.durationMs === 'number'
            && item.durationMs > 0
            && typeof data.progressMs === 'number';

        if (data && data.state === 'playing' && item) {
            anchor = hasProgress
                ? {
                    at: Date.now(),
                    progressMs: Math.max(0, Math.min(data.progressMs, item.durationMs)),
                    durationMs: item.durationMs,
                    frozen: false
                }
                : null;
            setState('playing');
            startTick();
        } else if (data && data.state === 'paused' && item) {
            // Keep the real position on screen, just stop advancing it.
            anchor = hasProgress
                ? {
                    at: Date.now(),
                    progressMs: Math.max(0, Math.min(data.progressMs, item.durationMs)),
                    durationMs: item.durationMs,
                    frozen: true
                }
                : null;
            setState('paused');
            stopTick();
        } else {
            anchor = null;
            setState('idle');
            stopTick();
        }

        render();
    }

    function handleFailure(error) {
        failureStreak += 1;

        if (error.code === 'reauth') {
            // Not self-healing, and not a reason to keep a stale track up.
            failureStreak = 0;
            view.item = null;
            view.playedAt = null;
            view.stale = false;
            anchor = null;
            stopTick();
            setState('reauth');
            render();
            schedulePoll(POLL_REAUTH_MS);
            return;
        }

        console.warn('Tiny Tune: now-playing request failed —', error.message);

        if (view.item) {
            // Keep the last good render rather than blanking the widget: the
            // music is most likely still playing, so let the progress bar carry
            // on optimistically and only admit a problem once it persists.
            if (failureStreak >= STALE_AFTER_FAILURES && !view.stale) {
                view.stale = true;
                render();
            }
        } else {
            setState('error');
            render();
        }

        schedulePoll(error.retryAfterMs || nextDelay());
    }

    async function poll() {
        pollTimer = null;
        // Nothing to do while the embedding tab is hidden; visibilitychange
        // resumes with an immediate fetch.
        if (document.hidden) return;

        try {
            const data = await requestNowPlaying();
            failureStreak = 0;
            applyPayload(data);
            schedulePoll(nextDelay());
        } catch (error) {
            if (error.code === 'cancelled') return;   // Superseded deliberately.
            handleFailure(error);
        }
    }

    // --- Appearance (URL parameters) ----------------------------------------

    function applyAppearance() {
        const params = new URLSearchParams(window.location.search);

        if (params.get('theme') === 'light') {
            document.body.classList.add('light-theme');
        }

        const color = params.get('color');
        if (color && /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$|^[a-z]+$/i.test(color)) {
            // The config page always sends a hex value; tolerate a missing '#'
            // for anyone hand-writing the URL.
            const value = /^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : color;
            document.documentElement.style.setProperty('--accent-color', value);
        }

        const requested = params.get('variant');
        const variant = VARIANTS.includes(requested) ? requested : 'card';
        document.body.classList.add(`variant-${variant}`);
    }

    // --- Start ---------------------------------------------------------------

    applyAppearance();

    if (!userId) {
        // Nothing to poll for. Say so instead of fetching ?user=null and
        // silently hiding the widget when that 400s.
        setState('unconfigured');
        render();
        return;
    }

    setState('loading');
    render();
    schedulePoll(0);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling();
            stopTick();
            if (inFlight) inFlight.abort();
            return;
        }
        // Progress is derived from wall-clock time, so the bar is already
        // correct for however long we were away — no catch-up needed.
        if (view.state === 'playing') startTick();
        schedulePoll(0);
    });

    window.addEventListener('pagehide', () => {
        stopPolling();
        stopTick();
        if (inFlight) inFlight.abort();
    });
})();
