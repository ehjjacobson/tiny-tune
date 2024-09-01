// Required modules and environment setup
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Validate required environment variables
const requiredEnv = ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'MONGODB_URI'];
requiredEnv.forEach(env => {
    if (!process.env[env]) {
        throw new Error(`Missing required environment variable: ${env}`);
    }
});

const app = express();
const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;
const mongoUri = process.env.MONGODB_URI;

let usersCollection;

// Connect to MongoDB
const connectToDB = async () => {
    try {
        const client = new MongoClient(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        await client.connect();
        const database = client.db('tinyTuneDB');
        usersCollection = database.collection('users');
        console.log("Connected to MongoDB");
    } catch (err) {
        console.error("Error connecting to MongoDB:", err);
        throw err; // Propagate error to stop server start
    }
};

// Token management functions
const isTokenExpired = user => Date.now() / 1000 >= (user.token_received_time + user.expires_in);

const refreshAccessToken = async user => {
    if (!user.refresh_token) throw new Error('No refresh token available');
    
    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: user.refresh_token,
            client_id,
            client_secret,
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        if (response.data.access_token) {
            user.access_token = response.data.access_token;
            user.expires_in = response.data.expires_in || 1800;
            user.token_received_time = Math.floor(Date.now() / 1000);

            await usersCollection.updateOne(
                { spotifyId: user.spotifyId },
                { $set: user }
            );
            console.log('Access token refreshed:', user.access_token);
        } else {
            console.error('Failed to refresh access token:', response.data);
        }
    } catch (error) {
        console.error('Error refreshing access token:', error.message);
        throw error; // Re-throw to allow upstream handling
    }
};

// Middleware to ensure a valid access token
const ensureAccessToken = async (req, res, next) => {
    try {
        const user = await usersCollection.findOne({ spotifyId: req.query.user });
        if (!user) return res.status(404).send('User not found');

        if (isTokenExpired(user)) {
            await refreshAccessToken(user);
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Error in ensureAccessToken:', error.message);
        res.status(500).send('Authentication error, please try again.');
    }
};

// Routes
app.use(express.static('public'));

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
        </body>
        </html>
    `);
});

app.get('/login', (req, res) => {
    const scopes = 'user-read-playback-state user-read-currently-playing user-read-email user-read-private';
    const query = querystring.stringify({
        response_type: 'code',
        client_id,
        scope: scopes,
        redirect_uri,
    });
    res.redirect(`https://accounts.spotify.com/authorize?${query}`);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    try {
        console.log("Received code:", code);
        const response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri,
            client_id,
            client_secret,
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const { access_token, refresh_token, expires_in } = response.data;
        const token_received_time = Math.floor(Date.now() / 1000);

        const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });

        const userProfile = profileResponse.data;
        const user = {
            spotifyId: userProfile.id,
            displayName: userProfile.display_name,
            email: userProfile.email,
            access_token,
            refresh_token,
            token_received_time,
            expires_in,
        };

        await usersCollection.updateOne(
            { spotifyId: userProfile.id },
            { $set: user },
            { upsert: true }
        );

        res.redirect(`/widget?user=${userProfile.id}`);
    } catch (error) {
        console.error('Error during authentication:', error.message);
        res.status(500).send('Authentication error, please try again.');
    }
});

app.get('/refresh_token', ensureAccessToken, async (req, res) => {
    try {
        await refreshAccessToken(req.user);
        res.json({ access_token: req.user.access_token });
    } catch (error) {
        res.status(500).send('Error refreshing access token');
    }
});

app.get('/now-playing', ensureAccessToken, async (req, res) => {
    try {
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${req.user.access_token}` }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching now-playing data:', error.message);
        res.status(500).send('Error fetching now-playing data');
    }
});

app.get('/widget', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

app.get('/logout', async (req, res) => {
    try {
        const userId = req.query.user;
        if (!userId) return res.status(400).send('User ID is required');

        await usersCollection.updateOne({ spotifyId: userId }, {
            $unset: { access_token: '', refresh_token: '', token_received_time: '', expires_in: '' }
        });

        res.redirect('/');
    } catch (error) {
        console.error('Error during logout:', error.message);
        res.status(500).send('Error during logout');
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Start the server
startServer();

module.exports = app;
