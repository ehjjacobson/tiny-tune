// Required modules and environment setup
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const path = require('path');
require('dotenv').config();
const { MongoClient } = require('mongodb');

const app = express();
const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;

// MongoDB setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let usersCollection;

const connectToDB = async () => {
    try {
        await client.connect();
        const database = client.db('tinyTuneDB');
        usersCollection = database.collection('users');
        console.log("Connected to MongoDB");
    } catch (err) {
        console.error("Error connecting to MongoDB:", err);
    }
};

connectToDB();

// Function to check if the token is expired
const isTokenExpired = (token_received_time, expires_in) => {
    return Date.now() / 1000 >= (token_received_time + expires_in);
};

// Function to refresh the access token
const refreshAccessToken = async (user) => {
    try {
        if (!user.refresh_token) throw new Error('No refresh token available');

        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: user.refresh_token,
            client_id,
            client_secret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.access_token) {
            const newAccessToken = response.data.access_token;
            const newExpiresIn = response.data.expires_in || 1800;
            const newTokenReceivedTime = Math.floor(Date.now() / 1000);

            console.log('Access token refreshed for user:', user.spotifyId);

            await usersCollection.updateOne(
                { spotifyId: user.spotifyId },
                {
                    $set: {
                        access_token: newAccessToken,
                        expires_in: newExpiresIn,
                        token_received_time: newTokenReceivedTime
                    }
                }
            );

            return newAccessToken;
        } else {
            console.error('Failed to refresh access token:', response.data);
        }
    } catch (error) {
        console.error('Error refreshing access token:', error.message);
    }
    return null;
};

// Middleware to ensure the access token is valid for the given user
const ensureAccessToken = async (req, res, next) => {
    try {
        const userId = req.query.user;
        const user = await usersCollection.findOne({ spotifyId: userId });

        if (!user) {
            return res.status(400).send('User not found.');
        }

        if (isTokenExpired(user.token_received_time, user.expires_in)) {
            const newAccessToken = await refreshAccessToken(user);
            if (newAccessToken) {
                req.access_token = newAccessToken;
            } else {
                return res.status(500).send('Failed to refresh access token.');
            }
        } else {
            req.access_token = user.access_token;
        }

        next();
    } catch (error) {
        console.error('Error ensuring access token:', error.message);
        res.status(500).send('Authentication error, please try again.');
    }
};

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Serve the main page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Welcome to Tiny Tune</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f4f4f4; }
                h1 { color: #333; }
                p { font-size: 18px; color: #666; }
                .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; font-size: 16px; background-color: #1db954; color: white; text-decoration: none; border-radius: 5px; }
                .btn:hover { background-color: #1aa34a; }
                .loading { display: none; font-size: 18px; color: #666; }
            </style>
        </head>
        <body>
            <h1>Welcome to Tiny Tune</h1>
            <div class="loading" id="loading">Processing authentication...</div>
            <p>See what you're currently playing on Spotify!</p>
            <a href="/login" class="btn" id="login-button">Login with Spotify</a>
            <script src="/public/script.js"></script>
        </body>
        </html>
    `);
});

// Endpoint to initiate login
app.get('/login', (req, res) => {
    const scopes = 'user-read-playback-state user-read-currently-playing';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id,
            scope: scopes,
            redirect_uri
        }));
});

// Callback endpoint for Spotify authentication
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri,
            client_id,
            client_secret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const access_token = response.data.access_token;
        const refresh_token = response.data.refresh_token;
        const expires_in = response.data.expires_in;
        const token_received_time = Math.floor(Date.now() / 1000);

        const userProfileResponse = await axios.get('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });

        const { id: spotifyId, display_name: displayName, email } = userProfileResponse.data;

        await usersCollection.updateOne(
            { spotifyId },
            {
                $set: {
                    spotifyId,
                    displayName,
                    email,
                    access_token,
                    refresh_token,
                    expires_in,
                    token_received_time
                }
            },
            { upsert: true }
        );

        res.redirect(`/widget?user=${spotifyId}`);
    } catch (error) {
        console.error('Error during authentication:', error.response ? error.response.data : error.message);
        res.status(500).send('Error during authentication');
    }
});

// Endpoint to get currently playing track
app.get('/now-playing', ensureAccessToken, async (req, res) => {
    try {
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${req.access_token}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching now-playing data:', error.message);
        res.status(500).send('Error fetching now-playing data');
    }
});

// Endpoint to serve the widget HTML
app.get('/widget', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

// Logout endpoint
app.get('/logout', async (req, res) => {
    try {
        const userId = req.query.user;
        await usersCollection.updateOne(
            { spotifyId: userId },
            {
                $set: {
                    access_token: '',
                    refresh_token: '',
                    token_received_time: 0,
                    expires_in: 0
                }
            }
        );
        res.redirect('/');
    } catch (error) {
        console.error('Error during logout:', error.message);
        res.status(500).send('Error during logout');
    }
});

// Start the server
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});

module.exports = app;
