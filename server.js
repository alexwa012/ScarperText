// Install dependencies: npm install express axios node-html-parser cors
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { parse } = require("node-html-parser");

const app = express();
app.use(cors());
app.use(express.json());

app.post("/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0", // Pretend to be a browser
      },
    });

    const root = parse(data);
let paragraphs = root.querySelectorAll("div.Normal, ._s30J");
const articleText = paragraphs.map(p => p.text.trim()).join("\n\n");


    res.json({ text: articleText || "No article text found." });
  } catch (err) {
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
