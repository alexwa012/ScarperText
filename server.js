// Install dependencies:
// npm install express axios node-html-parser cors dotenv firebase-admin

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
const admin = require("firebase-admin");
require("dotenv").config();

// =============================
// Firebase Admin Initialization
// =============================

// Get service account from environment variable (stringified JSON)
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
// Scraper Function
// =============================
async function scrapeArticle(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const root = parse(data);
    const paragraphs = root.querySelectorAll("div.Normal, ._s30J, p");
    const articleText = paragraphs.map((p) => p.text.trim()).join("\n\n");
    return articleText || null;
  } catch (err) {
    console.error("Scrape error:", err.message);
    return null;
  }
}

// =============================
// Title/Description Cleaning
// =============================
async function cleanTitleAndDescription(title, description, scrapedText) {
  try {
    const prompt = `
Rephrase the news so it is unique but keeps meaning.
If title is missing, generate one from the description or scraped text.

Title: ${title || "N/A"}
Description: ${description || scrapedText || "N/A"}

Return JSON with "title" and "description".
    `;

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

    let cleaned = response.data.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = {
        title: title || "Untitled News",
        description: description || scrapedText || "",
      };
    }

    return parsed;
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return {
      title: title || "Untitled News",
      description: description || scrapedText || "",
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
    // Scrape text
    const scrapedText = await scrapeArticle(url);

    // Clean or generate title & description
    const cleaned = await cleanTitleAndDescription(title, description, scrapedText);

    // Save to Firestore
    const docId = Buffer.from(url).toString("base64");
    const articleDoc = {
      url,
      title: cleaned.title,
      description: cleaned.description,
      imageUrl: imageUrl || null,
      publishedAt: publishedAt || new Date().toISOString(),
      source: source || "Unknown",
      scrapedText: scrapedText || "",
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
