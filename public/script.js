let currentProgressMs = 0;
let intervalId;
let songEnded = false;
let lastPlayedTime = null;
let lastPlayedSong = null;

async function fetchNowPlaying() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('user');
        const response = await fetch(`/now-playing?user=${userId}`);

        // Check if the response is OK (status code 200-299)
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();

        if (data && data.item && data.is_playing) {
            // Update UI with the new song details
            document.getElementById('album-cover').src = data.item.album.images[0].url;
            document.querySelector('.album-cover').style.backgroundImage = `url(${data.item.album.images[0].url})`; // Set the album cover as the background image
            document.getElementById('track-title').textContent = data.item.name;
            document.getElementById('artist-name').textContent = data.item.artists[0].name;
            document.getElementById('spotify-link').href = data.item.external_urls.spotify;

            currentProgressMs = data.progress_ms;
            const duration = data.item.duration_ms;

            // Store last played song details
            lastPlayedSong = {
                title: data.item.name,
                artist: data.item.artists[0].name,
                albumCover: data.item.album.images[0].url,
                lastPlayedTime: new Date()
            };

            updateProgress(currentProgressMs, duration);

            // Reset and start interval for progress updates
            if (intervalId) clearInterval(intervalId);
            intervalId = setInterval(() => {
                currentProgressMs += 1000;
                if (currentProgressMs <= duration) {
                    updateProgress(currentProgressMs, duration);
                } else {
                    clearInterval(intervalId);
                    songEnded = true;
                    lastPlayedSong.lastPlayedTime = new Date();  // Update the last played timestamp
                    checkForNewSong();
                }
            }, 1000);
        } else {
            // If no song is playing, display the last played song with a timestamp
            if (lastPlayedSong) {
                const formattedTime = lastPlayedSong.lastPlayedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                document.getElementById('track-title').textContent = `${lastPlayedSong.title} (Last played at ${formattedTime})`;
                document.getElementById('artist-name').textContent = lastPlayedSong.artist;
                document.getElementById('album-cover').src = lastPlayedSong.albumCover;
                document.querySelector('.album-cover').style.backgroundImage = `url(${lastPlayedSong.albumCover})`;

                // Hide the progress bar when no song is playing
                document.getElementById('progress-bar').style.display = 'none';
                document.getElementById('progress-time').textContent = '';
                document.getElementById('track-duration').textContent = '';
            } else {
                // Default message if no song was played before
                document.getElementById('track-title').textContent = 'No song is currently playing';
                document.getElementById('artist-name').textContent = '';
                document.getElementById('album-cover').src = '';
                document.querySelector('.album-cover').style.backgroundImage = '';
                document.getElementById('progress-bar').style.display = 'none';
            }
            console.warn('No song is currently playing.');
            clearInterval(intervalId); // Stop the interval if no song is playing
        }
    } catch (error) {
        console.error('Error fetching now-playing data:', error);
        document.getElementById('now-playing').style.display = 'none';  // In case of an error, hide the widget
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

// Initial fetch when the script is loaded
fetchNowPlaying();
