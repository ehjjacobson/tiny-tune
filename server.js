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
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// MongoDB setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let usersCollection;
let dbReadyPromise = null;

// Refresh tokens this many seconds before Spotify's stated expiry, so a token
// cannot lapse midway through a request we have already started.
const TOKEN_EXPIRY_SKEW_S = 60;

// Raised when a user's Spotify authorization cannot be repaired on our side.
// The widget should ask them to reconnect rather than keep retrying.
class ReauthRequired extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReauthRequired';
    }
}

// Improved MongoDB connection handling with retry logic
const connectToDB = async (retries = 5, delay = 3000) => {
    while (retries) {
        try {
            await client.connect();  // Establish MongoDB connection
            const database = client.db('tinyTuneDB');
            usersCollection = database.collection('users');
            console.log("Connected to MongoDB");
            return usersCollection;  // Exit loop on success
        } catch (err) {
            console.error("Error connecting to MongoDB, retries left:", retries - 1, err);
            retries -= 1;
            if (retries === 0) {
                console.error("Exhausted retries, could not connect to MongoDB");
                throw err;  // Surface the failure so callers can react
            }
            await new Promise(res => setTimeout(res, delay));  // Wait before retrying
        }
    }
};

const ensureUsersCollection = async () => {
    if (usersCollection) return usersCollection;
    if (!dbReadyPromise) {
        dbReadyPromise = connectToDB().catch(err => {
            dbReadyPromise = null;  // Allow retries on next call
            throw err;
        });
    }
    return dbReadyPromise;
};

// Start the MongoDB connection but don't block serving static files
ensureUsersCollection();  // Call MongoDB connection in the background

// Serve static files from the 'public' directory (e.g. CSS, JS, etc.)
app.use(express.static('public'));

// Serve the login page (embedded in server.js)
// Serve the landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to initiate login
app.get('/login', (req, res) => {
    const scopes = 'user-read-playback-state user-read-currently-playing user-read-email user-read-private';
    const state = req.query.redirect === 'config' ? 'config' : '';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id,
            scope: scopes,
            redirect_uri,
            state
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
        const collection = await ensureUsersCollection();
        await collection.updateOne(
            { spotifyId: userProfile.id },
            { $set: user },
            { upsert: true }
        );

        const destination = req.query.state === 'config'
            ? `/config?user=${userProfile.id}`
            : `/?user_id=${userProfile.id}&status=connected`;
        res.redirect(destination);
    } catch (error) {
        console.error('Error during authentication:', error.response ? error.response.data : error.message);
        res.status(500).send('Error during authentication');
    }
});

// A token with no recorded lifetime is treated as expired rather than valid,
// so a half-written user document fails safe into a refresh.
const isTokenExpired = (user) => {
    if (typeof user.token_received_time !== 'number' || typeof user.expires_in !== 'number') {
        return true;
    }
    return Date.now() / 1000 >= (user.token_received_time + user.expires_in - TOKEN_EXPIRY_SKEW_S);
};

// Middleware to ensure the access token is valid
const ensureAccessToken = async (req, res, next) => {
    const spotifyId = req.query.user;
    if (!spotifyId) {
        return res.status(400).json({ error: 'missing_user' });
    }

    try {
        const collection = await ensureUsersCollection();
        const user = await collection.findOne({ spotifyId });
        if (!user) {
            return res.status(404).json({ error: 'unknown_user' });
        }
        // Logging out unsets the tokens, so a known user can still be disconnected.
        if (!user.access_token && !user.refresh_token) {
            throw new ReauthRequired('User has no stored tokens');
        }
        if (!user.access_token || isTokenExpired(user)) {
            await refreshAccessToken(user);
        }

        req.user = user;
        next();
    } catch (error) {
        if (error instanceof ReauthRequired) {
            console.warn(`Re-auth required for ${spotifyId}: ${error.message}`);
            return res.status(401).json({ error: 'reauth_required' });
        }
        // A refresh that failed for a transient reason is worth retrying, so
        // report it as unavailable instead of telling the widget to give up.
        console.error('Error ensuring access token:', error.message);
        res.status(503).json({ error: 'auth_unavailable' });
    }
};

// Refresh the access token in place. Throws on failure: callers must not be
// allowed to continue with a token they know to be expired, because Spotify
// would reject it and the widget would see an opaque server error.
const refreshAccessToken = async (user) => {
    if (!user.refresh_token) throw new ReauthRequired('No refresh token available');

    let response;
    try {
        response = await axios.post('https://accounts.spotify.com/api/token', querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: user.refresh_token,
            client_id,
            client_secret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
    } catch (error) {
        const details = error.response ? error.response.data : error.message;
        console.error('Error refreshing access token:', details);
        // invalid_grant means the user revoked access or the token was rotated
        // away from us — retrying can never fix it.
        if (error.response && error.response.data && error.response.data.error === 'invalid_grant') {
            throw new ReauthRequired('Spotify rejected the refresh token');
        }
        throw error;  // Transient; the caller may retry.
    }

    if (!response.data.access_token) {
        throw new ReauthRequired('Refresh response contained no access token');
    }

    user.access_token = response.data.access_token;
    user.expires_in = response.data.expires_in || 3600;
    user.token_received_time = Math.floor(Date.now() / 1000);
    user.refresh_token_last_used = user.token_received_time;
    // Spotify may hand back a rotated refresh token; keep the newest one.
    if (response.data.refresh_token) {
        user.refresh_token = response.data.refresh_token;
    }

    // Never log the token value itself — these logs are retained.
    console.log(`Access token refreshed for ${user.spotifyId}`);

    const collection = await ensureUsersCollection();
    await collection.updateOne(
        { spotifyId: user.spotifyId },
        {
            $set: {
                access_token: user.access_token,
                refresh_token: user.refresh_token,
                expires_in: user.expires_in,
                token_received_time: user.token_received_time,
                refresh_token_last_used: user.refresh_token_last_used
            }
        }
    );
};

// Endpoint to refresh the access token
app.get('/refresh_token', ensureAccessToken, async (req, res) => {
    try {
        await refreshAccessToken(req.user);
        // The token itself is never echoed back to the browser; the widget
        // talks to /now-playing and has no use for it.
        res.json({ refreshed: true, expires_in: req.user.expires_in });
    } catch (error) {
        if (error instanceof ReauthRequired) {
            return res.status(401).json({ error: 'reauth_required' });
        }
        console.error('Error refreshing access token:', error.message);
        res.status(503).json({ error: 'refresh_unavailable' });
    }
});

// Endpoint to get currently playing track
app.get('/now-playing', ensureAccessToken, async (req, res) => {
    try {
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${req.user.access_token}` }
        });

        if (response.data && response.data.is_playing) {
            res.json(response.data);
        } else {
            // If no song is playing, respond with last played information
            const lastPlayed = {
                message: 'No track currently playing',
                last_played_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            res.json(lastPlayed);
        }
    } catch (error) {
        console.error('Error fetching now-playing data:', error.message);
        res.status(500).send('Error fetching now-playing data');
    }
});

// Endpoint to serve the widget HTML
app.get('/widget', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

// Endpoint to serve the widget appearance config page
app.get('/config', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    try {
        // Mock payment session for verification
        console.log('Creating mock checkout session');
        res.json({ mock: true });

        /* 
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Tiny Tune Widget Access',
                    },
                    unit_amount: 500,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/`,
        });

        res.json({ id: session.id });
        */
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Payment Success Endpoint
app.get('/payment-success', (req, res) => {
    // In a real app, you might verify the session_id with Stripe here
    // For now, we just serve a success page or redirect to a success state on the landing page
    // We'll serve the index.html but with a query param to trigger the success state
    res.redirect('/?payment=success');
});

// Logout endpoint
app.get('/logout', async (req, res) => {
    try {
        const userId = req.query.user;
        if (!userId) {
            return res.status(400).send('User ID is required');
        }

        // Clear the tokens for the specific user
        const collection = await ensureUsersCollection();
        await collection.updateOne({ spotifyId: userId }, {
            $unset: { access_token: '', refresh_token: '', token_received_time: '', expires_in: '' }
        });

        res.redirect('/');
    } catch (error) {
        console.error('Error during logout:', error.message);
        res.status(500).send('Error during logout');
    }
});

// Start the server without blocking for MongoDB connection
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
