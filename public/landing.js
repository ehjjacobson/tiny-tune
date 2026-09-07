document.addEventListener('DOMContentLoaded', () => {
    const buyBtns = document.querySelectorAll('.btn-primary, .btn-nav');
    const loginSection = document.getElementById('login-section');
    const snippetSection = document.getElementById('snippet-section');
    const widgetSnippet = document.getElementById('widget-snippet');
    const copyBtn = document.getElementById('copy-btn');
    const previewUrl = document.getElementById('preview-url');
    const configLink = document.getElementById('config-link');
    const closeModal = document.querySelector('.close-modal');

    // Check for payment success
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('payment') === 'success') {
        loginSection.classList.remove('hidden');
        // Clean URL
        window.history.replaceState({}, document.title, "/");
    }

    const themeBtns = document.querySelectorAll('.btn-theme');
    const colorInput = document.getElementById('accent-color');

    let currentTheme = 'dark';
    let currentColor = '#1db954';
    let currentUserId = null;

    function updateSnippet() {
        if (!currentUserId) return;

        let widgetUrl = `${window.location.origin}/widget?user=${currentUserId}`;
        if (currentTheme !== 'dark') widgetUrl += `&theme=${currentTheme}`;
        if (currentColor !== '#1db954') widgetUrl += `&color=${encodeURIComponent(currentColor)}`;

        const iframeCode = `<iframe src="${widgetUrl}" width="350" height="150" frameborder="0" style="border-radius: 12px; overflow: hidden;"></iframe>`;

        widgetSnippet.textContent = iframeCode;
        previewUrl.href = widgetUrl;
    }

    // Theme Toggle Logic
    themeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            themeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTheme = btn.dataset.theme;
            updateSnippet();
        });
    });

    // Color Picker Logic
    if (colorInput) {
        colorInput.addEventListener('input', (e) => {
            currentColor = e.target.value;
            updateSnippet();
        });
    }

    // Check for connected status (post-login)
    if (urlParams.get('status') === 'connected' && urlParams.get('user_id')) {
        currentUserId = urlParams.get('user_id');
        localStorage.setItem('tinyTuneUserId', currentUserId);
        if (configLink) configLink.href = `/config?user=${currentUserId}`;
        updateSnippet();
        snippetSection.classList.remove('hidden');

        // Clean URL
        window.history.replaceState({}, document.title, "/");
    }

    // Copy to clipboard logic
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const code = widgetSnippet.textContent;
            navigator.clipboard.writeText(code).then(() => {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy: ', err);
            });
        });
    }

    // Close modal logic
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            snippetSection.classList.add('hidden');
        });
    }

    // Initialize Stripe
    // Note: In a real app, you'd fetch the publishable key from the server
    // For this demo, we rely on the server-side redirect, but we need the Stripe.js library loaded
    const stripe = Stripe('pk_test_TYooMQauvdEDq54NiTphI7jx'); // Replace with your public key if needed, or just use server-side redirect

    buyBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();

            // If it's the "Get Access" nav button or hero button
            if (btn.textContent.includes('Get Access') || btn.textContent.includes('$5')) {
                try {
                    const response = await fetch('/create-checkout-session', {
                        method: 'POST',
                    });

                    const session = await response.json();

                    if (session.error) {
                        alert(session.error);
                        return;
                    }

                    if (session.mock) {
                        window.location.href = '/?payment=success';
                        return;
                    }

                    const result = await stripe.redirectToCheckout({
                        sessionId: session.id,
                    });

                    if (result.error) {
                        alert(result.error.message);
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('An error occurred. Please try again.');
                }
            }
        });
    });
});
