// Install deps:
// npm install express axios node-html-parser cors dotenv firebase-admin xml2js node-cron

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
const { parseStringPromise } = require("xml2js");
const cron = require("node-cron");
const admin = require("firebase-admin");
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

// ---------- HELPER: PROCESS ARTICLE ----------
async function processArticle(article, category) {
  try {
    const url = article.link[0];
    const titleRaw = article.title?.[0];
    const imageUrl = article.enclosure?.[0]?.$.url || null;
    const createdAt = article.pubDate?.[0] || new Date().toISOString();

    // ✅ Check if already in DB (avoid duplicates)
    const exists = await db.collection("articles").where("url", "==", url).get();
    if (!exists.empty) {
      console.log(`Skipping (already exists): ${url}`);
      return;
    }

    // 1️⃣ Scrape
    const scrapeRes = await axios.post(`http://localhost:${PORT}/scrape`, { url });
    const articleText = scrapeRes.data.text;

    if (!articleText || articleText === "No article text found.") {
      console.log(`⚠️ No text found for: ${url}`);
      return;
    }

    // 2️⃣ Clean
    const cleanRes = await axios.post(`http://localhost:${PORT}/clean`, { text: articleText });
    const { title, description } = cleanRes.data;

    // 3️⃣ Save to Firestore
    await db.collection("articles").add({
      url,
      title: title || titleRaw,
      description,
      imageUrl,
      createdAt,
      source: "Times of India",
      category,
      insertedAt: new Date().toISOString(),
    });

    console.log(`✅ Saved: ${title}`);
  } catch (err) {
    console.error("processArticle error:", err.message);
  }
}

// ---------- CRON JOB: RUN EVERY HOUR ----------
cron.schedule("0 * * * *", async () => {
  console.log("⏳ Fetching RSS feeds...");

  for (const [category, feedUrl] of Object.entries(RSS_FEEDS)) {
    try {
      const { data } = await axios.get(feedUrl);
      const result = await parseStringPromise(data);
      const items = result.rss.channel[0].item || [];

      for (const article of items.slice(0, 5)) { // limit to avoid rate-limit
        await processArticle(article, category);

        // small delay (avoid rate limits)
        await new Promise(res => setTimeout(res, 5000));
      }
    } catch (err) {
      console.error(`RSS fetch error (${category}):`, err.message);
    }
  }

  console.log("✅ Feed fetch complete");
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
