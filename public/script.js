async function fetchNowPlaying() {
    try {
        const response = await fetch('/now-playing');
        const data = await response.json();

        if (data && data.item) {
            document.getElementById('album-cover').src = data.item.album.images[0].url;
            document.getElementById('track-title').textContent = data.item.name;
            document.getElementById('artist-name').textContent = data.item.artists[0].name;
            document.getElementById('spotify-link').href = data.item.external_urls.spotify;

            const progress = Math.floor(data.progress_ms / 1000);
            const duration = Math.floor(data.item.duration_ms / 1000);

            document.getElementById('progress-time').textContent = `${Math.floor(progress / 60)}:${progress % 60 < 10 ? '0' : ''}${progress % 60}`;
            document.getElementById('track-duration').textContent = `${Math.floor(duration / 60)}:${duration % 60 < 10 ? '0' : ''}${duration % 60}`;

            document.getElementById('progress-bar').style.width = `${(data.progress_ms / data.item.duration_ms) * 100}%`;

            // Hide the skeleton loader and show the player
            document.getElementById('loading-skeleton').style.display = 'none';
            document.getElementById('now-playing').style.display = 'block';

            // Update progress every second
            setInterval(() => {
                data.progress_ms += 1000;
                if (data.progress_ms < data.item.duration_ms) {
                    const currentProgress = Math.floor(data.progress_ms / 1000);
                    document.getElementById('progress-time').textContent = `${Math.floor(currentProgress / 60)}:${currentProgress % 60 < 10 ? '0' : ''}${currentProgress % 60}`;
                    document.getElementById('progress-bar').style.width = `${(data.progress_ms / data.item.duration_ms) * 100}%`;
                } else {
                    fetchNowPlaying();
                }
            }, 1000);
        } else {
            // Hide the skeleton loader if there's no data
            document.getElementById('loading-skeleton').style.display = 'none';
            document.getElementById('now-playing').style.display = 'none';
        }
    } catch (error) {
        console.error('Error fetching now-playing data:', error);
        // Hide the skeleton loader if an error occurs
        document.getElementById('loading-skeleton').style.display = 'none';
        document.getElementById('now-playing').style.display = 'none';
    }
}

fetchNowPlaying();
setInterval(fetchNowPlaying, 60000);
