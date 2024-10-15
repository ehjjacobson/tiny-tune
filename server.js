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

// Improved MongoDB connection handling
const connectToDB = async () => {
    try {
        await client.connect();  // Establish MongoDB connection
        const database = client.db('tinyTuneDB');
        usersCollection = database.collection('users');
        console.log("Connected to MongoDB");
    } catch (err) {
        console.error("Error connecting to MongoDB:", err);
        process.exit(1);  // Exit if MongoDB connection fails
    }
};

// Start the server only after MongoDB is fully connected
const startServer = async () => {
    try {
        await connectToDB();  // Ensure MongoDB is connected

        // Serve static files from the 'public' directory
        app.use(express.static('public'));

        // Serve the main page (login page)
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

        // Endpoint to initiate login
        app.get('/login', (req, res) => {
            const scopes = 'user-read-playback-state user-read-currently-playing user-read-email user-read-private';
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

                const access_token = response.data.access_token;
                const refresh_token = response.data.refresh_token;
                const expires_in = response.data.expires_in;
                const token_received_time = Math.floor(Date.now() / 1000);

                // Fetch the user's Spotify profile
                const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
                    headers: {
                        'Authorization': `Bearer ${access_token}`
                    }
                });

                const userProfile = profileResponse.data;
                const user = {
                    spotifyId: userProfile.id,
                    displayName: userProfile.display_name,
                    email: userProfile.email,
                    access_token,
                    refresh_token,
                    token_received_time,
                    expires_in
                };

                // Save user profile data and tokens in MongoDB
                await usersCollection.updateOne(
                    { spotifyId: userProfile.id },
                    { $set: user },
                    { upsert: true }
                );

                res.redirect(`/widget?user=${userProfile.id}`);
            } catch (error) {
                console.error('Error during authentication:', error.response ? error.response.data : error.message);
                res.status(500).send('Error during authentication');
            }
        });

        // Middleware to ensure the access token is valid
        const ensureAccessToken = async (req, res, next) => {
            try {
                const user = await usersCollection.findOne({ spotifyId: req.query.user });
                if (!user) {
                    return res.status(401).send('User not found');
                }

                const isTokenExpired = (user) => Date.now() / 1000 >= (user.token_received_time + user.expires_in);
                if (isTokenExpired(user)) await refreshAccessToken(user);
                req.user = user;
                next();
            } catch (error) {
                console.error('Error ensuring access token:', error.message);
                res.status(500).send('Authentication error, please try again.');
            }
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
                    user.access_token = response.data.access_token;
                    user.expires_in = response.data.expires_in || 1800; // Default to 1800 seconds if not provided
                    user.token_received_time = Math.floor(Date.now() / 1000);
                    user.refresh_token_last_used = user.token_received_time;

                    console.log('Access token refreshed:', user.access_token);

                    await usersCollection.updateOne(
                        { spotifyId: user.spotifyId },
                        { $set: user }
                    );
                } else {
                    console.error('Failed to refresh access token:', response.data);
                }
            } catch (error) {
                console.error('Error refreshing access token:', error.message);
            }
        };

        // Endpoint to refresh the access token
        app.get('/refresh_token', ensureAccessToken, async (req, res) => {
            try {
                await refreshAccessToken(req.user);
                res.json({ access_token: req.user.access_token });
            } catch (error) {
                res.status(500).send('Error refreshing access token');
            }
        });

        // Endpoint to get currently playing track
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

        // Endpoint to serve the widget HTML
        app.get('/widget', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'widget.html'));
        });

        // Logout endpoint
        app.get('/logout', async (req, res) => {
            try {
                const userId = req.query.user;
                if (!userId) {
                    return res.status(400).send('User ID is required');
                }

                // Clear the tokens for the specific user
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

    } catch (error) {
        console.error('Failed to start the server:', error);
    }
};

startServer();

module.exports = app;
