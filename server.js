// Install dependencies:
// npm install express axios cors dotenv firebase-admin

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();

// =============================
// Firebase Admin Initialization
// =============================
if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_KEY env variable");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// =============================
// Express App Setup
// =============================
const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// =============================
// Retry Helper for OpenAI Calls
// =============================
async function retryOpenAIRequest(requestFn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestFn();
    } catch (err) {
      if (err.response?.status === 429 && i < retries - 1) {
        console.warn(`⚠️ Rate limited. Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2; // exponential backoff
      } else {
        throw err;
      }
    }
  }
}

// =============================
// Title/Description Cleaning
// =============================
async function cleanTitleAndDescription(title, description) {
  const prompt = `
Rephrase the following news article title and description so they are unique but keep the meaning.
If the title is missing, create one from the description.

Title: ${title || "N/A"}
Description: ${description || "N/A"}

Return JSON with exactly two keys: "title" and "description".
  `;

  const requestFn = async () => {
    const response = await axios.post(
      "https://api.chatanywhere.tech/v1/chat/completions",
      {
        model: "gpt-3.5-turbo-0125",
        messages: [
          { role: "system", content: "You are a news content rewriter." },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
        max_tokens: 600,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0].message.content;
  };

  try {
    const cleaned = await retryOpenAIRequest(requestFn, 3, 1500);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn("⚠️ OpenAI returned non-JSON. Using fallback.");
      parsed = {
        title: title || "Untitled News",
        description: description || "",
      };
    }
    return parsed;
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return {
      title: title || "Untitled News",
      description: description || "",
    };
  }
}

// =============================
// API Endpoint
// =============================
app.post("/process-article", async (req, res) => {
  const { title, description, imageUrl, publishedAt, source, url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing article URL" });

  try {
    // 1. Clean or generate title & description
    const cleaned = await cleanTitleAndDescription(title, description);

    // 2. Save both AI-rephrased title & description
    const docId = Buffer.from(url).toString("base64");
    const articleDoc = {
      url,
      title: cleaned.title, // AI-written title
      description: cleaned.description, // AI-written description
      imageUrl: imageUrl || null,
      publishedAt: publishedAt || new Date().toISOString(),
      source: source || "Unknown",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection("articles").doc(docId).set(articleDoc);

    res.json({ success: true, data: articleDoc });
  } catch (err) {
    console.error("Processing failed:", err.message);
    res.status(500).json({ error: "Processing failed", details: err.message });
  }
});

// =============================
// Start Server
// =============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
