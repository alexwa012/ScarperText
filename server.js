const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
const Parser = require("rss-parser");
const cron = require("node-cron");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ---- Firebase Setup ----
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ---- RSS feeds ----
const rssFeeds = {
  Health: "https://timesofindia.indiatimes.com/rssfeeds/2886704.cms",
  Technology: "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms",
  Business: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",
  "Top Picks": "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
};

// ---- Scrape Endpoint ----
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const root = parse(data);
    const paragraphs = root.querySelectorAll("div.Normal, ._s30J, p");
    const articleText = paragraphs.map(p => p.text.trim()).join("\n\n");

    res.json({ text: articleText || "No article text found." });
  } catch (err) {
    console.error("Scrape error:", err.message);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

// ---- Clean Endpoint ----
app.post("/clean", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text input" });

  const prompt = `
From the following article text, generate a short, catchy title and a cleaned, readable description.
Return ONLY valid JSON:
{
  "title": "Generated title here",
  "description": "Cleaned description here"
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
        max_tokens: 800,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );

    let aiOutput = response.data.choices[0].message.content.trim();
    let parsed;
    try {
      parsed = JSON.parse(aiOutput);
    } catch (e) {
      console.error("⚠️ OpenAI returned non-JSON:", aiOutput);
      return res.status(500).json({ error: "Invalid JSON from AI", rawOutput: aiOutput });
    }

    res.json({ title: parsed.title || "Untitled", description: parsed.description || "" });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res.status(500).json({ error: "OpenAI request failed", details: err.message });
  }
});

// ---- Cron Job (Every 2 Hours) ----
const parser = new Parser();

cron.schedule("0 */2 * * *", async () => {
  console.log("⏰ Running RSS fetch job...");

  for (const [category, feedUrl] of Object.entries(rssFeeds)) {
    try {
      const feed = await parser.parseURL(feedUrl);

      for (const item of feed.items) {
        try {
          const url = item.link;
          const imageUrl = item.enclosure?.url || null; // Image from RSS feed
          const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

          // Skip if already exists
          const existing = await db.collection("articles").where("url", "==", url).get();
          if (!existing.empty) continue;

          // Step 1: Scrape
          const scrapeRes = await axios.post(`http://localhost:${process.env.PORT || 5000}/scrape`, { url });
          const rawText = scrapeRes.data.text;

          if (!rawText || rawText === "No article text found.") continue;

          // Step 2: Clean
          const cleanRes = await axios.post(`http://localhost:${process.env.PORT || 5000}/clean`, { text: rawText });
          const { title, description } = cleanRes.data;

          // Step 3: Save to Firestore
          await db.collection("articles").add({
            url,
            title,
            description,
            imageUrl,
            category,
            time: pubDate,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log(`✅ Saved article: ${title}`);
        } catch (err) {
          console.error(`❌ Error processing article: ${item.link}`, err.message);
        }
      }
    } catch (err) {
      console.error(`❌ Failed to fetch RSS for ${category}:`, err.message);
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
