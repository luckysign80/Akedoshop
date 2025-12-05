// This code runs securely on the Vercel server.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// The 'handler' function processes all requests to /api/gemini
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: 'Server error: Key missing.' });
    }

    // Extract the model name and the prompt payload from the client request
    const { model, payload } = req.body;
    
    // Construct the full Google API URL using the SECRET key
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    try {
        // Forward the request (with the key) to Google
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const data = await geminiResponse.json();

        // Send Google's response back to your frontend
        res.status(geminiResponse.status).json(data);

    } catch (error) {
        console.error("Proxy Error:", error);
        res.status(500).json({ message: 'Internal Server Error.' });
    }
}