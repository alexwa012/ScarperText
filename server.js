// Install deps first:
// npm install express axios node-html-parser cors dotenv firebase-admin xml2js crypto
//Deploy

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
const { parseStringPromise } = require("xml2js");
const admin = require("firebase-admin");
const cron = require("node-cron");   

const crypto = require("crypto");
require("dotenv").config();

// ---------- FIREBASE INIT ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ---------- EXPRESS APP ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- SCRAPE ENDPOINT ----------
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const root = parse(data);
    const paragraphs = root.querySelectorAll("div.Normal, ._s30J, p");
    const articleText = paragraphs.map(p => p.text.trim()).join("\n\n");

    res.json({ text: articleText || "No article text found." });
  } catch (err) {
    console.error("Scrape error:", err.message);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

// ---------- CLEAN ENDPOINT ----------
app.post("/clean", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text input" });

  const prompt = `
From the following article text, generate a short, catchy title and a cleaned, readable description.

Requirements:
- Title: maximum 12 words, catchy but concise.
- Description: must be between 150–250 words, well-structured, coherent, and reader-friendly.
- Avoid repetition, filler words, or adding unrelated content.
- Do NOT include any Markdown formatting, code blocks, or backticks.
- Return ONLY valid raw JSON (no extra text, no explanation).

Format:
{
  "title": "Generated title here",
  "description": "Cleaned description here (150–250 words)"
}

Article text:
${text}
`;

  try {
    const response = await axios.post(
      "https://api.chatanywhere.tech/v1/chat/completions",
      {
        model: "gpt-3.5-turbo-0125",
        messages: [
          { role: "system", content: "You are a news content rewriter." },
          { role: "user", content: prompt },
        ],
        temperature: 0.5,
        max_tokens: 1200,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let aiOutput = response.data.choices[0].message.content.trim();
    let parsed;

    try {
      parsed = JSON.parse(aiOutput);
    } catch (e) {
      console.error("⚠️ OpenAI returned non-JSON:", aiOutput);
      return res.status(500).json({
        error: "Invalid JSON from AI",
        rawOutput: aiOutput,
      });
    }

    res.json({
      title: parsed.title || "Untitled",
      description: parsed.description || "",
    });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res.status(500).json({ error: "OpenAI request failed", details: err.message });
  }
});

// ---------- RSS FEEDS ----------
const RSS_FEEDS = {
  Health: "https://timesofindia.indiatimes.com/rssfeeds/2886704.cms",
  Technology: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms",
  Business: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",
  "Top Picks": "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
};

// ---------- HELPERS ----------
function getDocIdFromUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

// ---------- PROCESS ARTICLE ----------
async function processArticle(article, category) {
  try {
    const urlRaw = article.link?.[0];
    if (!urlRaw) return;

    const url = urlRaw.trim();
    const titleRaw = article.title?.[0];
    const imageUrl = article.enclosure?.[0]?.$.url || null;
    const createdAt = article.pubDate?.[0] || new Date().toISOString();

    const docId = getDocIdFromUrl(url);
    const docRef = db.collection("articles").doc(docId);

    // ✅ Step 1: Check Firestore first
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      const data = docSnap.data();
      if (data.description && data.description.length > 0) {
        console.log(`⏭ Already exists, skipping API: ${url}`);
        return; // already processed fully
      } else {
        console.log(`✏️ Exists but missing description → will update: ${url}`);
      }
    }

    // ✅ Step 2: Scrape
    const scrapeRes = await axios.post(`http://localhost:${PORT}/scrape`, { url });
    const articleText = scrapeRes.data.text;
    if (!articleText || articleText === "No article text found.") {
      console.log(`⚠️ No text found for: ${url}`);
      return;
    }

    // ✅ Step 3: Clean with OpenAI
    const cleanRes = await axios.post(`http://localhost:${PORT}/clean`, { text: articleText });
    const { title, description } = cleanRes.data;

    // ✅ Step 4: Save or Update
    await docRef.set(
      {
        url,
        title: title || titleRaw,
        description,
        imageUrl,
        createdAt,
        source: "Times of India",
        category,
        insertedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(`✅ Saved: ${title}`);
  } catch (err) {
    console.error("processArticle error:", err.message);
  }
}

// ---------- CLEANUP OLD ARTICLES ----------
async function cleanupOldArticles() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 5); // keep last 5 days
    const cutoffIso = cutoffDate.toISOString();

    const snapshot = await db.collection("articles")
      .where("insertedAt", "<", cutoffIso)
      .get();

    if (snapshot.empty) {
      console.log("🧹 No old articles to delete");
      return;
    }

    const batch = db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    console.log(`🧹 Deleted ${snapshot.size} old articles (before ${cutoffIso})`);
  } catch (err) {
    console.error("cleanupOldArticles error:", err.message);
  }
}


// ---------- TRIGGER FUNCTION ----------
async function runJob() {
  console.log("⏳ Fetching RSS feeds...");

  for (const [category, feedUrl] of Object.entries(RSS_FEEDS)) {
    try {
      const { data } = await axios.get(feedUrl);
      const result = await parseStringPromise(data);
      const items = result.rss.channel[0].item || [];

      for (const article of items.slice(0, 5)) { // limit to 5 per feed
        await processArticle(article, category);

        // small delay (avoid rate limits)
        await new Promise(res => setTimeout(res, 5000));
      }
    } catch (err) {
      console.error(`RSS fetch error (${category}):`, err.message);
    }
  }

  console.log("✅ Feed fetch complete");
}

// ---------- MANUAL TRIGGER ENDPOINT ----------
app.get("/run-job-now", async (req, res) => {
  try {
    // respond immediately
    res.json({ success: true, message: "Job started" });

    // run job asynchronously (not blocking response)
    runJob().catch(err => {
      console.error("Background job error:", err.message);
    });
  } catch (err) {
    console.error("Manual job trigger error:", err.message);
    res.status(500).json({ error: "Failed to start job", details: err.message });
  }
});

// ---------- CLEANUP ENDPOINT ----------
app.get("/cleanup", async (req, res) => {
  try {
    await cleanupOldArticles();
    res.json({ success: true, message: "Cleanup complete" });
  } catch (err) {
    console.error("Cleanup endpoint error:", err.message);
    res.status(500).json({ error: "Cleanup failed", details: err.message });
  }
});

// app.get("/run-job-now", async (req, res) => {
//   try {
//     await runJob();
//     res.json({ success: true, message: "Job executed successfully" });
//   } catch (err) {
//     console.error("Manual job error:", err.message);
//     res.status(500).json({ error: "Job execution failed", details: err.message });
//   }
// });

// ---------- AUTO CRON JOB (runs every 60 min) ----------
// cron.schedule("0 * * * *", () => {
//   console.log("⏰ Running scheduled RSS job...");
//   runJob().catch(err => console.error("Cron job error:", err.message));
// });


// ---------- START SERVER ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});





