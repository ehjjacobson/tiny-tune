let currentProgressMs = 0;
let intervalId;
let songEnded = false;

async function fetchNowPlaying() {
    try {
        const response = await fetch('/now-playing');
        const data = await response.json();

        if (data && data.item) {
            // Check if the song is playing
            if (data.is_playing) {
                // Update UI with the new song details
                document.getElementById('album-cover').src = data.item.album.images[0].url;
                document.getElementById('track-title').textContent = data.item.name;
                document.getElementById('artist-name').textContent = data.item.artists[0].name;
                document.getElementById('spotify-link').href = data.item.external_urls.spotify;

                currentProgressMs = data.progress_ms;
                const duration = data.item.duration_ms;

                updateProgress(currentProgressMs, duration);

                // Clear any existing interval and start a new one
                if (intervalId) clearInterval(intervalId);
                intervalId = setInterval(() => {
                    currentProgressMs += 1000;
                    if (currentProgressMs <= duration) {
                        updateProgress(currentProgressMs, duration);
                    } else {
                        clearInterval(intervalId);
                        songEnded = true;
                        checkForNewSong();
                    }
                }, 1000);
            } else {
                // Handle paused state
                clearInterval(intervalId);
                document.getElementById('progress-bar').style.width = '0%';
                document.getElementById('progress-time').textContent = 'Paused';
            }
        } else {
            document.getElementById('now-playing').style.display = 'none';
        }
    } catch (error) {
        console.error('Error fetching now-playing data:', error);
        document.getElementById('now-playing').style.display = 'none';
    }
}

function updateProgress(progressMs, durationMs) {
    const progress = Math.floor(progressMs / 1000);
    const duration = Math.floor(durationMs / 1000);

    document.getElementById('progress-time').textContent = `${Math.floor(progress / 60)}:${progress % 60 < 10 ? '0' : ''}${progress % 60}`;
    document.getElementById('track-duration').textContent = `${Math.floor(duration / 60)}:${duration % 60 < 10 ? '0' : ''}${duration % 60}`;

    const progressPercentage = (progressMs / durationMs) * 100;
    document.getElementById('progress-bar').style.width = `${progressPercentage}%`;
}

async function checkForNewSong() {
    if (songEnded) {
        try {
            await fetchNowPlaying(); // Fetch new song data
            songEnded = false;
        } catch (error) {
            console.error('Error checking for new song:', error);
        }
    }
}

fetchNowPlaying();
