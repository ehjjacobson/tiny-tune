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
let tokensCollection;

// Initialize token variables
let access_token = '';
let refresh_token = '';
let expires_in = 1800;
let token_received_time = 0;

const connectToDB = async () => {
    try {
        await client.connect();
        const database = client.db('tinyTuneDB');
        tokensCollection = database.collection('tokens');
        console.log("Connected to MongoDB");

        // Retrieve stored tokens from the database if available
        const storedTokens = await tokensCollection.findOne({});
        if (storedTokens) {
            ({ access_token, refresh_token, token_received_time, expires_in } = storedTokens);
        }
    } catch (err) {
        console.error("Error connecting to MongoDB:", err);
    }
};

connectToDB();

// Function to check if the token is expired
const isTokenExpired = () => Date.now() / 1000 >= (token_received_time + expires_in);

// Function to refresh the access token
const refreshAccessToken = async () => {
    try {
        if (!refresh_token) throw new Error('No refresh token available');

        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token,
            client_id,
            client_secret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.access_token) {
            access_token = response.data.access_token;
            expires_in = response.data.expires_in || 1800;
            token_received_time = Math.floor(Date.now() / 1000);
            console.log('Access token refreshed:', access_token);

            await tokensCollection.updateOne({}, { $set: { access_token, refresh_token, token_received_time, expires_in } }, { upsert: true });
        } else {
            console.error('Failed to refresh access token:', response.data);
        }
    } catch (error) {
        console.error('Error refreshing access token:', error.message);
    }
};

// Middleware to ensure the access token is valid
const ensureAccessToken = async (req, res, next) => {
    try {
        if (isTokenExpired()) await refreshAccessToken();
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
    const isAuthenticated = access_token && !isTokenExpired();
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
            ${isAuthenticated ? `
                <p>You are logged in with Spotify.</p>
                <p>Enjoy exploring your music and see what you're currently playing!</p>
                <a href="/logout" class="btn">Logout</a>
            ` : `
                <p>See what you're currently playing on Spotify!</p>
                <a href="/login" class="btn" id="login-button">Login with Spotify</a>
            `}
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
        console.log("Received code:", code);
        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri,
            client_id,
            client_secret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        console.log("Spotify token response:", response.data);

        access_token = response.data.access_token;
        refresh_token = response.data.refresh_token;
        expires_in = response.data.expires_in;
        token_received_time = Math.floor(Date.now() / 1000);

        await tokensCollection.updateOne({}, { $set: { access_token, refresh_token, token_received_time, expires_in } }, { upsert: true });

        res.redirect('/');
    } catch (error) {
        console.error('Error during authentication:', error.response ? error.response.data : error.message);
        res.status(500).send('Error during authentication');
    }
});

// Endpoint to refresh the access token
app.get('/refresh_token', async (req, res) => {
    try {
        await refreshAccessToken();
        res.json({ access_token });
    } catch (error) {
        res.status(500).send('Error refreshing access token');
    }
});

// Endpoint to get currently playing track
app.get('/now-playing', ensureAccessToken, async (req, res) => {
    try {
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${access_token}` }
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
        // Clear the tokens from memory
        access_token = '';
        refresh_token = '';
        token_received_time = 0;
        expires_in = 0;

        // Clear the tokens from the database
        await tokensCollection.updateOne({}, { $set: { access_token: '', refresh_token: '', token_received_time: 0, expires_in: 0 } });

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
