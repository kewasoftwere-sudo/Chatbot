const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require("firebase-admin");

// Firebase Admin initialization (Netlify Environment Variables se credentials lenge)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Netlify me private key ki formatting maintain rakhne ke liye replace use hota hai
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
        })
    });
}
const db = admin.firestore();

exports.handler = async function(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { prompt } = JSON.parse(event.body);
        if (!prompt) {
            return { statusCode: 400, body: JSON.stringify({ success: false, message: "Prompt is required." }) };
        }

        const sanitizedPrompt = prompt.trim().toLowerCase();

        // Step 1: Pehle Firestore Database me check karo ki kya ye sawal pehle pucha gaya hai?
        const querySnapshot = await db.collection("chat_logs")
            .where("sanitizedPrompt", "==", sanitizedPrompt)
            .limit(1)
            .get();

        if (!querySnapshot.empty) {
            // Cache hit! Matlab answer database me pehle se hi pada hai, Gemini API hit nahi karni padi!
            const cachedData = querySnapshot.docs[0].data();
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    success: true, 
                    answer: cachedData.response + " (⚡ served from cache/DB)", 
                    type: 'text' 
                })
            };
        }

        // Step 2: Agar DB me nahi hai, tab Gemini API ko call karo (jab tak limit bachi hai)
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        // Step 3: Naye answer ko Firestore me save kar do taaki agli baar DB se hi mil jaye
        await db.collection("chat_logs").add({
            prompt: prompt,
            sanitizedPrompt: sanitizedPrompt,
            response: responseText,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, answer: responseText, type: 'text' })
        };

    } catch (error) {
        console.error("Backend Error:", error);
        
        // Bonus safety: Agar Gemini API ki limit khatam ho gayi (Quota error), toh DB se koi bhi purana ya closest match nikalne ki koshish karo
        try {
            const fallbackSnapshot = await db.collection("chat_logs").limit(1).get();
            if (!fallbackSnapshot.empty) {
                const fallbackData = fallbackSnapshot.docs[0].data();
                return {
                    statusCode: 200,
                    body: JSON.stringify({ 
                        success: true, 
                        answer: fallbackData.response + " (⚠️ API limit reached. Serving fallback from database)", 
                        type: 'text' 
                    })
                };
            }
        } catch (dbError) {
            console.error("Fallback failed:", dbError);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, message: "API limit exceeded and no cache available: " + error.message })
        };
    }
};
