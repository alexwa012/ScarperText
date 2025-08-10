// Install dependencies:
// npm install express axios cors dotenv firebase-admin cheerio

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");
const cheerio = require("cheerio");
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const app = express();
app.use(cors());
app.use(express.json());

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
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// =============================
// Scrape Article Description
// =============================
async function scrapeDescriptionFromUrl(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);

    // Try common meta tags first
    let description =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="twitter:description"]').attr("content");

    if (!description) {
      // Fallback: grab first <p> block
      description = $("p").first().text();
    }

    return description?.trim() || "";
  } catch (err) {
    console.warn(`⚠️ Failed to scrape description for ${url}:`, err.message);
    return "";
  }
}

// =============================
// Clean Titles & Descriptions in Batch
// =============================
async function cleanArticlesInBatch(articles) {
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

  const cleaned = await retryOpenAIRequest(requestFn, 3, 1500);
  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn("⚠️ OpenAI returned non-JSON. Using fallback.");
    return articles;
  }
}

// =============================
// Helper: Deduplicate URLs
// =============================
function deduplicateUrls(urls) {
  return [...new Set(urls)];
}

// Helper: Filter URLs already in Firestore
async function filterUnprocessedUrls(urls) {
  const result = [];
  for (const url of urls) {
    const docId = Buffer.from(url).toString("base64");
    const doc = await db.collection("articles").doc(docId).get();
    if (!doc.exists) result.push(url);
  }
  return result;
}

// Helper: Split into batches
function createBatches(array, batchSize) {
  const batches = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

// =============================
// API Endpoint for Batch Processing
// =============================
app.post("/process-articles", async (req, res) => {
  const urls = req.body.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "Missing URLs array" });
  }

  try {
    // 1. Deduplicate and filter already processed
    const deduped = deduplicateUrls(urls);
    const unprocessed = await filterUnprocessedUrls(deduped);
    if (unprocessed.length === 0) {
      return res.json({ success: true, message: "No new articles to process" });
    }

    // 2. Split into batches (safe size for GPT-3.5)
    const batches = createBatches(unprocessed, 10); // adjust batch size if needed

    const allProcessed = [];

    // 3. Process each batch
    for (const batch of batches) {
      // 3a. Scrape descriptions for each URL
      const articlesWithContent = [];
      for (const url of batch) {
        const description = await scrapeDescriptionFromUrl(url);
        articlesWithContent.push({ title: "", description, url });
      }

      // 3b. Rephrase in one OpenAI call
      const cleanedArticles = await cleanArticlesInBatch(articlesWithContent);

      // 3c. Save each cleaned article to Firestore
      for (let i = 0; i < cleanedArticles.length; i++) {
        const originalUrl = batch[i];
        const cleaned = cleanedArticles[i];
        const docId = Buffer.from(originalUrl).toString("base64");

        const articleDoc = {
          url: originalUrl,
          title: cleaned.title || "Untitled News",
          description: cleaned.description || "",
          imageUrl: null, // you can scrape this if needed
          publishedAt: new Date().toISOString(),
          source: "Unknown",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection("articles").doc(docId).set(articleDoc);
        allProcessed.push(articleDoc);
      }
    }

    res.json({ success: true, processed: allProcessed.length, data: allProcessed });
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
