// Install dependencies:
// npm install express axios cors dotenv firebase-admin node-html-parser

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");
const { parse } = require("node-html-parser");
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
// Helper: Scrape Article Content
// =============================
async function scrapeDescriptionFromUrl(url) {
  try {
    console.log(`🌐 Scraping description from: ${url}`);
    const { data } = await axios.get(url, { timeout: 10000 });
    const root = parse(data);

    // Try meta description first
    let description =
      root.querySelector("meta[name='description']")?.getAttribute("content") ||
      root.querySelector("meta[property='og:description']")?.getAttribute("content") ||
      "";

    // Fallback: grab first paragraph
    if (!description) {
      const firstParagraph = root.querySelector("p");
      if (firstParagraph) description = firstParagraph.text.trim();
    }

    return description || "";
  } catch (err) {
    console.error(`❌ Failed to scrape ${url}:`, err.message);
    return "";
  }
}

// =============================
// Retry Helper for OpenAI Calls
// =============================
async function retryOpenAIRequest(requestFn, retries = 3, delay = 1000, batchIndex = 0) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🔹 [Batch ${batchIndex}] OpenAI attempt ${i + 1}/${retries}...`);
      return await requestFn();
    } catch (err) {
      if (err.response?.status === 429 && i < retries - 1) {
        console.warn(`⚠️ [Batch ${batchIndex}] Rate limited. Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2; // exponential backoff
      } else {
        console.error(`❌ [Batch ${batchIndex}] OpenAI request failed:`, err.message);
        throw err;
      }
    }
  }
}

// =============================
// OpenAI Batch Cleaner
// =============================
async function cleanArticlesInBatch(articles, batchIndex) {
  const prompt = `
Rephrase the following news articles' titles and descriptions so they are unique but keep the meaning.
If a title is missing, create one from the description.

Return a JSON array where each object has "title" and "description".

Articles:
${JSON.stringify(articles, null, 2)}
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
        max_tokens: 2000,
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

  const cleaned = await retryOpenAIRequest(requestFn, 3, 1500, batchIndex);
  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn(`⚠️ [Batch ${batchIndex}] OpenAI returned non-JSON. Using fallback.`);
    return articles;
  }
}

// =============================
// API Endpoint (Batch Processing)
// =============================
app.post("/process-articles", async (req, res) => {
  const { urls, batchSize = 5 } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Missing or invalid 'urls' array" });
  }

  console.log(`📦 Received ${urls.length} URLs to process in batches of ${batchSize}`);

  try {
    // Split into batches
    const batches = [];
    for (let i = 0; i < urls.length; i += batchSize) {
      batches.push(urls.slice(i, i + batchSize));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`🚀 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} URLs)`);

      // 1. Scrape descriptions for each URL
      const articlesWithContent = [];
      for (const url of batch) {
        const description = await scrapeDescriptionFromUrl(url);
        articlesWithContent.push({ title: "", description, url });
      }

      // 2. Rephrase in bulk using OpenAI
      const cleanedArticles = await cleanArticlesInBatch(articlesWithContent, batchIndex);

      // 3. Save results in Firestore
      for (let i = 0; i < cleanedArticles.length; i++) {
        const originalUrl = batch[i];
        const cleaned = cleanedArticles[i];
        const docId = Buffer.from(originalUrl).toString("base64");

        const articleDoc = {
          url: originalUrl,
          title: cleaned.title || "Untitled News",
          description: cleaned.description || "",
          imageUrl: null,
          publishedAt: new Date().toISOString(),
          source: "Unknown",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection("articles").doc(docId).set(articleDoc);
      }

      console.log(`✅ Finished batch ${batchIndex + 1}`);

      // 4. Wait before next batch to avoid hitting rate limit
      if (batchIndex < batches.length - 1) {
        console.log(`⏳ Waiting 3 seconds before next batch...`);
        await new Promise((res) => setTimeout(res, 3000));
      }
    }

    res.json({ success: true, message: "All articles processed successfully" });
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
