// Install dependencies with:
// npm install express axios node-html-parser cors dotenv

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

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
    const articleText = paragraphs.map(p => p.text.trim()).join("\n\n");

    res.json({ text: articleText || "No article text found." });
  } catch (err) {
    console.error("Scrape error:", err.message);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

/**
 * POST /clean
 * Input: { text }
 * Output: { title, description }
 */
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});


