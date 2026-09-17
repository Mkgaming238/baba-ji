// api/gemini-proxy.js
// -----------------------------------------------------------------------------
// Server-side proxy for the Gemini API. The browser NEVER sees GEMINI_API_KEY.
// Deploy target: Vercel (or any Node-based serverless platform with minimal
// changes to the export signature — see DEPLOYMENT.md for alternatives).
//
// Required setup: set an environment variable named GEMINI_API_KEY in your
// hosting platform's dashboard (Vercel: Project -> Settings -> Environment
// Variables). Never put the key in this file or in any file served to the
// browser.
// -----------------------------------------------------------------------------

// Best-effort in-memory rate limit. NOTE: this resets whenever the serverless
// function cold-starts and does not share state across multiple instances —
// it is a basic abuse deterrent, not a strict guarantee. For real rate
// limiting under load, use a shared store (Vercel KV, Upstash Redis, etc.).
const requestLog = new Map(); // ip -> [timestamps]
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const MAX_BODY_BYTES = 60 * 1000; // ~60KB is generous for a chat/interpretation payload
const ALLOWED_MODELS = ['gemini-3.8-flash']; // allow-list, so the client can't ask the proxy to hit an arbitrary model

function checkRateLimit(ip) {
    const now = Date.now();
    const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    requestLog.set(ip, timestamps);
    return timestamps.length <= RATE_LIMIT_MAX_REQUESTS;
}

export default async function handler(req, res) {
    // CORS: adjust origin as needed once you know your deployed domain.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        // Server misconfiguration — never mention or hint at the key's value.
        console.error('Gemini proxy: GEMINI_API_KEY is not set in the server environment.');
        return res.status(500).json({ error: 'AI service is not configured on the server yet.' });
    }

    // --- basic rate limiting ---
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }

    // --- request-size protection ---
    let bodyStr;
    try {
        bodyStr = JSON.stringify(req.body || {});
    } catch (e) {
        return res.status(400).json({ error: 'Invalid request body.' });
    }
    if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'Request payload too large.' });
    }

    // --- input validation ---
    const body = req.body || {};
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
        return res.status(400).json({ error: 'Request must include a non-empty "contents" array.' });
    }

    const requestedModel = (req.query && req.query.model) || 'gemini-3.8-flash';
    if (!ALLOWED_MODELS.includes(requestedModel)) {
        return res.status(400).json({ error: 'Requested model is not allowed.' });
    }

    try {
        const upstream = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey, // stays server-side; never sent to the browser
                },
                body: bodyStr,
            }
        );

        const data = await upstream.json().catch(() => null);

        if (!upstream.ok) {
            // Pass through a controlled, generic error — never the raw upstream body,
            // which could in rare cases echo request details back.
            console.error('Gemini upstream error, status:', upstream.status);
            return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
                .json({ error: 'The AI service returned an error. Please try again.' });
        }

        if (!data) {
            return res.status(502).json({ error: 'The AI service returned an unreadable response.' });
        }

        return res.status(200).json(data);
    } catch (err) {
        // Log only the error message, never headers/keys/request body.
        console.error('Gemini proxy network error:', err.message);
        return res.status(502).json({ error: 'Could not reach the AI service. Please try again shortly.' });
    }
}
