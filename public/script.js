let currentProgressMs = 0;
let intervalId;
let songEnded = false;
let lastPlayedTime = null;

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

            // Show the progress bar and hide the last played text
            document.querySelector('.progress-bar-container').style.display = 'flex';
            document.getElementById('last-played').style.display = 'none';

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
                    lastPlayedTime = new Date();  // Store the last played timestamp
                    checkForNewSong();
                }
            }, 1000);
        } else {
            // Handle when no song is currently playing
            if (lastPlayedTime) {
                const formattedTime = lastPlayedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                document.getElementById('track-title').textContent += ` (Last played at ${formattedTime})`;
                
                // Hide the progress bar and show the last played time
                document.querySelector('.progress-bar-container').style.display = 'none';
                document.getElementById('last-played').style.display = 'block';
            }
            console.warn('No song is currently playing.');
            clearInterval(intervalId); // Stop the interval if no song is playing
        }
    } catch (error) {
        console.error('Error fetching now-playing data:', error);
        document.getElementById('now-playing').style.display = 'none';  // In case of an error, still hide the widget
    }
}

// Initial fetch when the script is loaded
fetchNowPlaying();
