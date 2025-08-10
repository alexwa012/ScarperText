// Install dependencies with:
// npm install express axios node-html-parser cors dotenv firebase-admin

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Firestore Initialization (if you want storage)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

/**
 * POST /scrape
 * Input: { url }
 * Output: { text }
 */
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const root = parse(data);
    const paragraphs = root.querySelectorAll("div.Normal, ._s30J, p");
    const articleText = paragraphs.map((p) => p.text.trim()).join("\n\n");

    res.json({ text: articleText || "No article text found." });
  } catch (err) {
    console.error("Scrape error:", err.message);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

/**
 * POST /clean
 * Input: { title, text }
 * Output: { cleanedTitle, cleanedDescription }
 */
app.post("/clean", async (req, res) => {
  const { title, text } = req.body;
  if (!title && !text) {
    return res.status(400).json({ error: "Missing title and text input" });
  }

  try {
    const prompt = `
Rephrase the following news article title and description so they are unique but keep the meaning.
If the title is missing, create one from the description.

Title: ${title || "N/A"}
Description: ${text || "N/A"}

Return JSON with exactly two keys: "title" and "description".
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
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let cleaned;
    try {
      cleaned = JSON.parse(response.data.choices[0].message.content);
    } catch (err) {
      console.warn("⚠️ OpenAI returned non-JSON, using fallback.");
      cleaned = { title: title || "Untitled", description: text || "" };
    }

    // ✅ Store to Firestore
    const docId = Buffer.from(cleaned.title).toString("base64");
    await db.collection("articles").doc(docId).set({
      title: cleaned.title,
      description: cleaned.description,
      createdAt: new Date().toISOString(),
    });

    res.json({
      cleanedTitle: cleaned.title,
      cleanedDescription: cleaned.description,
    });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res
      .status(500)
      .json({ error: "OpenAI request failed", details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
