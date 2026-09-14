/**
 * Tiny Tune embed helper — optional.
 *
 * The widget hides itself whenever no music is playing, but an <iframe> still
 * reserves its box, so the page is left with a gap where the player would be.
 * Drop this script in next to the iframe and that space collapses while there
 * is nothing to show, then comes back when a track starts:
 *
 *   <iframe src="https://your-tiny-tune/widget?user=…" width="350" height="150"></iframe>
 *   <script src="https://your-tiny-tune/embed.js" async></script>
 *
 * It only ever touches iframes that talk to it, and only listens to the origin
 * it was itself served from. Without it the widget still disappears; the
 * reserved space just stays.
 */
(() => {
    'use strict';

    const script = document.currentScript;
    if (!script || !script.src) return;

    // Messages are only trusted from wherever this script came from — i.e. the
    // Tiny Tune server — so another embedded frame cannot resize the page.
    const widgetOrigin = new URL(script.src, window.location.href).origin;

    // Remembered per frame so expanding restores exactly what the author wrote,
    // rather than a height this script invented.
    const originalStyles = new WeakMap();

    function findFrame(source) {
        const frames = document.getElementsByTagName('iframe');
        for (let i = 0; i < frames.length; i += 1) {
            if (frames[i].contentWindow === source) return frames[i];
        }
        return null;
    }

    function collapse(frame) {
        if (!originalStyles.has(frame)) {
            originalStyles.set(frame, {
                height: frame.style.height,
                display: frame.style.display,
                border: frame.style.border
            });
        }

        // Zero height alone would still leave an inline line box roughly a line
        // tall, so take the frame out of inline flow while it is empty.
        frame.style.height = '0px';
        frame.style.display = 'block';
        frame.style.border = '0';
    }

    function expand(frame) {
        const original = originalStyles.get(frame);
        if (!original) return;   // Never collapsed; leave the author's layout alone.

        frame.style.height = original.height;
        frame.style.display = original.display;
        frame.style.border = original.border;
    }

    window.addEventListener('message', (event) => {
        if (event.origin !== widgetOrigin) return;

        const data = event.data;
        if (!data || data.source !== 'tiny-tune' || data.type !== 'visibility') return;

        const frame = findFrame(event.source);
        if (!frame) return;

        if (data.visible) {
            expand(frame);
        } else {
            collapse(frame);
        }
    });
})();
