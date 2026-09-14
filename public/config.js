document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    let userId = urlParams.get('user');

    if (userId) {
        localStorage.setItem('tinyTuneUserId', userId);
        window.history.replaceState({}, document.title, '/config');
    } else {
        userId = localStorage.getItem('tinyTuneUserId');
    }

    const noUserNotice = document.getElementById('no-user-notice');
    const configContent = document.getElementById('config-content');

    if (!userId) {
        noUserNotice.hidden = false;
        return;
    }
    configContent.hidden = false;

    const variantBtns = document.querySelectorAll('.variant-option');
    const themeBtns = document.querySelectorAll('.btn-theme');
    const colorInput = document.getElementById('accent-color');
    const accentControl = document.getElementById('accent-control');
    const previewIframe = document.getElementById('preview-iframe');
    const widgetSnippet = document.getElementById('widget-snippet');
    const previewUrl = document.getElementById('preview-url');
    const copyBtn = document.getElementById('copy-btn');

    const previewHeights = { card: 150, compact: 90, minimal: 40 };
    const state = { variant: 'card', theme: 'dark', color: '#1db954' };

    // The live widget hides itself when no music is playing. Anywhere we are
    // showing it *as a preview* we ask it to stay visible regardless, so the
    // appearance can be chosen at any hour; the embed code never gets that flag.
    function buildWidgetUrl({ preview = false } = {}) {
        const params = new URLSearchParams({ user: userId });
        if (state.variant !== 'card') params.set('variant', state.variant);
        if (state.theme !== 'dark') params.set('theme', state.theme);
        if (state.color !== '#1db954') params.set('color', state.color);
        if (preview) params.set('preview', '1');
        return `${window.location.origin}/widget?${params.toString()}`;
    }

    function render() {
        const url = buildWidgetUrl();
        const previewSrc = buildWidgetUrl({ preview: true });
        const height = previewHeights[state.variant];

        previewIframe.src = previewSrc;
        previewIframe.height = height;

        // The second line is optional: without it the widget still disappears
        // when nothing is playing, but the iframe keeps holding its space.
        widgetSnippet.textContent =
            `<iframe src="${url}" width="350" height="${height}" frameborder="0" style="border-radius: 12px; overflow: hidden;"></iframe>\n`
            + `<script src="${window.location.origin}/embed.js" async></script>`;
        previewUrl.href = previewSrc;

        // Accent color only affects the card/compact chrome (progress bar,
        // live dot) — the minimal variant has nothing for it to color.
        accentControl.style.display = state.variant === 'minimal' ? 'none' : '';
    }

    variantBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            variantBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.variant = btn.dataset.variant;
            render();
        });
    });

    themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            themeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.theme = btn.dataset.theme;
            render();
        });
    });

    colorInput.addEventListener('input', (e) => {
        state.color = e.target.value;
        render();
    });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(widgetSnippet.textContent).then(() => {
            const original = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = original; }, 2000);
        }).catch(err => {
            console.error('Failed to copy: ', err);
        });
    });

    render();
});
