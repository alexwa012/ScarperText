// Install dependencies first:
// npm install express axios node-html-parser cors dotenv

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");
require("dotenv").config(); // Load variables from .env

const app = express();
app.use(cors());
app.use(express.json());

/**
 * POST /scrape
 * Input: { url }
 * Output: { text }
 * Description: Scrapes article content from a URL.
 */
app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
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
 * Output: { cleanedDescription }
 * Description: Cleans/simplifies article text using OpenAI.
 */
app.post("/clean", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text input" });

  try {
    const response = await axios.post(
      "https://api.chatanywhere.tech/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "user",
            content: `Clean and simplify the following article content. Make it more readable for general users:\n\n${text}`,
          },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const cleanedText = response.data.choices[0].message.content;
    res.json({ cleanedDescription: cleanedText });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res.status(500).json({ error: "OpenAI request failed", details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

