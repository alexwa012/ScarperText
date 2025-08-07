// Install dependencies first:
// npm install express axios node-html-parser cors

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");

const app = express();
app.use(cors());
app.use(express.json());

// GET API KEY from environment directly
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
        model: "gpt-3.5-turbo-0125",
        messages: [
          {
            role: "system",
            content: "Clean the article text to be readable, keep meaning.",
          },
          {
            role: "user",
            content: text,
          },
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
